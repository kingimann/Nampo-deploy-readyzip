"""Stripe Connect payouts + checkout (feature-flagged).

This is a real-payment scaffold layered alongside the existing test/fake payment
flow. It only activates when STRIPE_SECRET_KEY is set; otherwise every endpoint
reports `enabled: false` and the app keeps using test payments.

Flow:
  - Creators "set up payouts" → a Stripe Connect *Express* account + a hosted
    onboarding link. Their account id is stored on their user doc.
  - Buyers pay via Stripe Checkout (a destination charge to the creator's
    connected account, with an optional platform fee).
  - A webhook credits the creator's in-app wallet on success so the Wallet UI
    matches the test-mode behaviour.
"""
import os
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from core import (
    db, get_current_user, API_PLANS, API_PLANS_BY_ID, _active_plan,
    API_OVERAGE_PACKS, API_OVERAGE_BY_ID, USAGE_PERIOD_DAYS, _norm_dt,
)
from db import DuplicateKeyError

# Anti-fraud: after changing direct-deposit (bank/debit card), hold withdrawals
# and outgoing money transfers for this many business days.
DD_HOLD_BUSINESS_DAYS = 7


def _add_business_days(start: datetime, n: int) -> datetime:
    d = start
    added = 0
    while added < n:
        d = d + timedelta(days=1)
        if d.weekday() < 5:   # Mon–Fri
            added += 1
    return d


def payout_hold_until(user: dict):
    """When the post-direct-deposit-change hold lifts, or None if not on hold."""
    changed = user.get("direct_deposit_changed_at")
    if not changed:
        return None
    try:
        until = _add_business_days(_norm_dt(changed), DD_HOLD_BUSINESS_DAYS)
    except Exception:
        return None
    return until if until > datetime.now(timezone.utc) else None

try:  # Stripe is optional — the app runs fine without it (test payments only).
    import stripe  # type: ignore
except Exception:  # pragma: no cover
    stripe = None  # type: ignore

router = APIRouter()

STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_PUBLISHABLE_KEY = os.environ.get("STRIPE_PUBLISHABLE_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
# Platform cut of each transaction, in percent (0 = creator gets everything).
PLATFORM_FEE_PERCENT = float(os.environ.get("PLATFORM_FEE_PERCENT", "0") or 0)
# Where Stripe sends users back after hosted onboarding / checkout.
WEB_APP_URL = (os.environ.get("WEB_APP_URL", "https://okayspace.ca") or "").rstrip("/")

if stripe and STRIPE_SECRET_KEY:
    stripe.api_key = STRIPE_SECRET_KEY


def stripe_enabled() -> bool:
    return bool(stripe and STRIPE_SECRET_KEY)


async def test_payments_on() -> bool:
    """Admin override: force simulated/test payments even when Stripe is configured."""
    doc = await db.app_settings.find_one({"key": "test_payments"}, {"_id": 0, "value": 1})
    return bool(doc and doc.get("value"))


# Default flat per-transaction fee (cents) the platform keeps when a user pays.
DEFAULT_TRANSACTION_FEE_CENTS = 10


async def _setting(key: str, default):
    doc = await db.app_settings.find_one({"key": key}, {"_id": 0, "value": 1})
    return doc.get("value") if doc and doc.get("value") is not None else default


async def platform_fee_percent() -> float:
    """The platform's cut of creator payments (subscriptions/tips), e.g. 30 means
    a 70/30 split. Admin-controlled; falls back to the PLATFORM_FEE_PERCENT env."""
    try:
        return max(0.0, min(100.0, float(await _setting("platform_fee_percent", PLATFORM_FEE_PERCENT))))
    except Exception:
        return PLATFORM_FEE_PERCENT


async def transaction_fee_cents() -> int:
    """Flat fee (in cents) charged when a user pays. Admin-controlled."""
    try:
        return max(0, int(round(float(await _setting("transaction_fee_cents", DEFAULT_TRANSACTION_FEE_CENTS)))))
    except Exception:
        return DEFAULT_TRANSACTION_FEE_CENTS


async def payments_live() -> bool:
    """Real Stripe payments are in effect: Stripe is configured AND an admin
    hasn't forced test mode."""
    return stripe_enabled() and not await test_payments_on()


def _require_stripe():
    if not stripe_enabled():
        raise HTTPException(status_code=503, detail="Stripe is not configured on this server")


# Fully-embedded Connect: the platform owns the dashboard, so the embedded
# payouts / account-management components render inside our site (no Stripe
# Express dashboard, no leaving the app). New accounts are created this way.
CONNECT_CONTROLLER = {
    "stripe_dashboard": {"type": "none"},
    "fees": {"payer": "application"},
    "losses": {"payments": "application"},
    "requirement_collection": "application",
}


async def _ensure_connect_account(user: dict) -> str:
    """Return the user's Stripe Connect account id, creating a platform-controlled
    (embedded-dashboard) account on first use so payout management stays in-app.

    A legacy Express account (which can't render the embedded payouts dashboard) is
    transparently replaced with a platform-controlled one — but only while payouts
    aren't enabled yet, so we never strand a balance on the old account."""
    acct_id = user.get("stripe_account_id")
    if acct_id:
        try:
            acct = stripe.Account.retrieve(acct_id)
            dash = ((acct.get("controller") or {}).get("stripe_dashboard") or {}).get("type")
            is_express = acct.get("type") == "express" or dash == "express"
            if not (is_express and not acct.get("payouts_enabled")):
                return acct_id
            # else: fall through and create a fresh platform-controlled account.
        except Exception:
            return acct_id
    acct = stripe.Account.create(
        controller=CONNECT_CONTROLLER,
        email=user.get("email"),
        metadata={"user_id": user["user_id"]},
        capabilities={"transfers": {"requested": True}, "card_payments": {"requested": True}},
    )
    acct_id = acct["id"]
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"stripe_account_id": acct_id}})
    return acct_id


def _account_supports_embedded_mgmt(acct_id: str) -> bool:
    """Embedded payouts/account-management components only work on accounts where
    the platform controls the dashboard (controller-based). Legacy Express accounts
    (which have the Stripe-hosted Express dashboard) only support embedded onboarding."""
    try:
        acct = stripe.Account.retrieve(acct_id)
    except Exception:
        return False
    if acct.get("type") == "express":
        return False
    dash = ((acct.get("controller") or {}).get("stripe_dashboard") or {}).get("type")
    return dash != "express"


class CheckoutCreate(BaseModel):
    kind: str            # "tip" | "subscription" | "promote"
    creator_id: Optional[str] = None
    amount: float = 0    # dollars
    post_id: Optional[str] = None          # promote
    days: Optional[int] = None             # promote
    conversation_id: Optional[str] = None  # tip sent from a DM
    note: Optional[str] = None             # tip message
    tier: Optional[str] = None             # subscription tier id
    budget: Optional[float] = None         # promote: pay-per-click budget
    cpc: Optional[float] = None            # promote: cost per click
    embedded: Optional[bool] = False       # render Stripe Checkout inside the site (web)


def _ui_kwargs(embedded: bool, base_path: str) -> dict:
    """Embedded checkout returns a client_secret + uses return_url; hosted uses
    success/cancel URLs (unchanged behaviour when embedded is False)."""
    if embedded:
        return {"ui_mode": "embedded", "return_url": f"{WEB_APP_URL}{base_path}?stripe_return=1&session_id={{CHECKOUT_SESSION_ID}}"}
    return {"success_url": f"{WEB_APP_URL}{base_path}?pay=success", "cancel_url": f"{WEB_APP_URL}{base_path}?pay=cancel"}


def _checkout_response(session, embedded: bool) -> dict:
    if embedded:
        return {"client_secret": session.get("client_secret"), "id": session["id"], "embedded": True}
    return {"url": session["url"], "id": session["id"]}


@router.get("/payments/config")
async def payments_config():
    """Tell the client whether real payments are available.

    Test/simulated payments are OFF by default: real Stripe is used whenever
    Stripe is configured and an admin hasn't explicitly forced test mode. The
    app only falls back to simulated payments when Stripe isn't configured
    (i.e. it's down / not set up) or an admin turns test mode on.
    """
    configured = stripe_enabled()
    test_override = await test_payments_on()
    live = configured and not test_override
    return {
        "enabled": live,
        "platform_fee_percent": await platform_fee_percent(),
        "transaction_fee_cents": await transaction_fee_cents(),
        "cashout_min": MIN_CASHOUT,
        "cashout_fee": CASHOUT_FEE,
        "publishable_key": STRIPE_PUBLISHABLE_KEY if live else "",
        # Why payments may be simulated, so the admin can tell the difference
        # between "Stripe isn't configured/down" and "an admin forced test mode".
        "stripe_configured": configured,
        "test_mode": (not live),
        "test_override": test_override,
    }


@router.post("/payments/payouts/setup")
async def setup_payouts(authorization: Optional[str] = Header(None)):
    """Create (or reuse) the user's Stripe Connect account and return a hosted
    onboarding link where they choose how they want to get paid."""
    _require_stripe()
    user = await get_current_user(authorization)
    try:
        acct_id = await _ensure_connect_account(user)
        link = stripe.AccountLink.create(
            account=acct_id,
            refresh_url=f"{WEB_APP_URL}/wallet?payouts=refresh",
            return_url=f"{WEB_APP_URL}/wallet?payouts=done",
            type="account_onboarding",
        )
        return {"url": link["url"]}
    except Exception as e:
        msg = getattr(e, "user_message", None) or getattr(e, "_message", None) or str(e)
        raise HTTPException(status_code=400, detail={"code": "stripe_setup_failed", "message": f"Stripe payout setup failed: {msg}"})


@router.get("/payments/payouts/status")
async def payouts_status(authorization: Optional[str] = Header(None)):
    """Current payout-account state for the creator's Wallet screen."""
    user = await get_current_user(authorization)
    if not stripe_enabled():
        return {"enabled": False, "connected": False, "payouts_enabled": False, "details_submitted": False}
    acct_id = user.get("stripe_account_id")
    if not acct_id:
        return {"enabled": True, "connected": False, "payouts_enabled": False, "details_submitted": False}
    try:
        acct = stripe.Account.retrieve(acct_id)
    except Exception:
        return {"enabled": True, "connected": False, "payouts_enabled": False, "details_submitted": False}
    reqs = acct.get("requirements", {}) or {}
    due = list(reqs.get("currently_due", []) or []) + list(reqs.get("past_due", []) or [])
    pending = list(reqs.get("pending_verification", []) or [])
    # Needed before payouts turn on but not "due" yet (e.g. external_account / bank).
    eventually = [r for r in (reqs.get("eventually_due", []) or []) if r not in due]
    # Whether a payout method (bank/debit card) is on file at all, and specifically
    # whether an eligible debit *card* is on file (required for instant cash-out).
    ext_accounts = (acct.get("external_accounts", {}) or {})
    has_external = bool(ext_accounts.get("total_count", 0))
    cards = [e for e in (ext_accounts.get("data") or []) if e.get("object") == "card"]
    banks = [e for e in (ext_accounts.get("data") or []) if e.get("object") == "bank_account"]
    has_debit_card = bool(cards)
    debit_card = {"brand": cards[0].get("brand"), "last4": cards[0].get("last4")} if cards else None
    bank_account = {"bank": banks[0].get("bank_name"), "last4": banks[0].get("last4")} if banks else None
    caps = acct.get("capabilities", {}) or {}
    payouts_enabled = bool(acct.get("payouts_enabled"))

    # Government-ID verification: Stripe verifies the person's identity (KYC) before
    # enabling payouts. Treat that as the user being ID-verified and persist it so
    # it can show as a trust badge in the marketplace.
    indiv = acct.get("individual", {}) or {}
    veri_status = ((indiv.get("verification") or {}).get("status"))
    id_verified = bool(user.get("id_verified") or payouts_enabled or veri_status == "verified")
    # Set-only: once verified (by payouts or by standalone Stripe Identity), stays
    # verified — losing payout eligibility shouldn't drop the ID badge.
    if id_verified and not user.get("id_verified"):
        await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"id_verified": True}})

    # When payouts aren't on and nothing is "due", the blocker is usually upstream:
    # the transfers capability is still being activated, or the PLATFORM Stripe
    # account itself isn't fully set up (which blocks payouts for everyone).
    platform = None
    if not payouts_enabled:
        try:
            p = stripe.Account.retrieve()   # the platform account (API key owner)
            preq = (p.get("requirements") or {})
            pdue = list(preq.get("currently_due", []) or []) + list(preq.get("past_due", []) or [])
            platform = {
                "charges_enabled": bool(p.get("charges_enabled")),
                "payouts_enabled": bool(p.get("payouts_enabled")),
                "details_submitted": bool(p.get("details_submitted")),
                "requirements_due": pdue,
                "disabled_reason": preq.get("disabled_reason"),
            }
        except Exception:
            platform = None

    return {
        "enabled": True,
        "connected": True,
        "payouts_enabled": payouts_enabled,
        "id_verified": id_verified,
        "hold_until": (lambda h: h.isoformat() if h else None)(payout_hold_until(user)),
        "charges_enabled": bool(acct.get("charges_enabled")),
        "details_submitted": bool(acct.get("details_submitted")),
        "has_external_account": has_external,
        "has_debit_card": has_debit_card,
        "debit_card": debit_card,
        "bank_account": bank_account,
        "account_id": acct_id,
        "account_currency": (acct.get("default_currency") or "").lower(),
        "country": acct.get("country"),
        "capabilities": {"transfers": caps.get("transfers"), "card_payments": caps.get("card_payments")},
        # What Stripe still needs (so the UI can explain why setup won't finish).
        "requirements_due": due,
        "requirements_eventually": eventually,
        "requirements_pending": pending,
        "disabled_reason": reqs.get("disabled_reason"),
        "platform": platform,
    }


# Instant cash-out: floor and flat fee (USD) — DoorDash Fast Pay-style.
MIN_CASHOUT = 5.0
CASHOUT_FEE = 1.99


class CashoutBody(BaseModel):
    amount: Optional[float] = None   # None = cash out the whole balance


@router.post("/payments/payouts/cashout")
async def cashout_to_card(body: CashoutBody, authorization: Optional[str] = Header(None)):
    """Instant cash-out of the in-app wallet balance to the user's debit card
    (Stripe Instant Payouts, DoorDash-style). Moves platform funds to the user's
    connected account and instantly pays out to their debit card."""
    _require_stripe()
    if await test_payments_on():
        raise HTTPException(status_code=400, detail={"code": "test_mode", "message": "Cash out isn't available in test mode."})
    user = await get_current_user(authorization)
    hold = payout_hold_until(user)
    if hold:
        raise HTTPException(status_code=403, detail={
            "code": "payout_hold",
            "message": f"For your security, cash-out is paused until {hold.date().isoformat()} ({DD_HOLD_BUSINESS_DAYS} business days after changing your direct-deposit details).",
        })
    acct_id = user.get("stripe_account_id")
    if not acct_id:
        raise HTTPException(status_code=400, detail={"code": "no_payout_account", "message": "Set up payouts first to cash out."})
    try:
        acct = stripe.Account.retrieve(acct_id)
    except Exception:
        raise HTTPException(status_code=400, detail={"code": "account_error", "message": "Couldn't reach your payout account."})
    if not acct.get("payouts_enabled"):
        raise HTTPException(status_code=400, detail={"code": "payouts_not_ready", "message": "Finish payout setup before cashing out."})

    # Instant cash-out needs an eligible debit card on file — block early with a
    # clear message instead of attempting a payout that Stripe would reject.
    ext_data = (acct.get("external_accounts", {}) or {}).get("data") or []
    if not any(e.get("object") == "card" for e in ext_data):
        raise HTTPException(status_code=400, detail={
            "code": "no_debit_card",
            "message": "Add a debit card in Manage payouts first — instant cash-out needs an eligible debit card.",
        })

    bal = round(float(user.get("wallet_balance", 0) or 0), 2)
    amount = round(float(body.amount if body.amount is not None else bal), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Enter an amount to cash out")
    if amount < MIN_CASHOUT - 1e-9:
        raise HTTPException(status_code=400, detail={
            "code": "below_minimum",
            "message": f"The minimum cash-out is ${MIN_CASHOUT:.0f}. A ${CASHOUT_FEE:.0f} flat fee applies to each instant cash-out.",
        })
    if amount > bal + 1e-9:
        raise HTTPException(status_code=400, detail={"code": "insufficient_balance", "message": "That's more than your wallet balance."})

    # A flat fee is kept by the platform; the user receives the remainder on their card.
    net = round(amount - CASHOUT_FEE, 2)

    # Wallet amounts are USD, but a payout has to be in the connected account's
    # settlement currency (e.g. a Canadian account pays out in CAD). Convert and
    # use that currency for both the transfer and the instant payout.
    from core import CURRENCIES
    acct_ccy = (acct.get("default_currency") or "usd").lower()
    rate_meta = CURRENCIES.get(acct_ccy.upper())
    if not rate_meta and acct_ccy != "usd":
        # No known rate — don't silently fall back to 1.0 and send the USD amount
        # as if it were the foreign currency (massively under/over-paying).
        raise HTTPException(status_code=400, detail={
            "code": "unsupported_currency",
            "message": "Cash-out to this account's currency isn't supported yet.",
        })
    rate = float(rate_meta["rate"]) if rate_meta else 1.0
    local_amount = round(net * rate, 2)
    # Zero-decimal currencies (e.g. JPY) take whole-unit amounts, not cents.
    ZERO_DECIMAL = {"jpy", "krw", "vnd", "clp", "bif", "djf", "gnf", "kmf",
                    "mga", "pyg", "rwf", "ugx", "vuv", "xaf", "xof", "xpf"}
    units = int(round(local_amount)) if acct_ccy in ZERO_DECIMAL else int(round(local_amount * 100))

    # Atomically debit only if the balance still covers it — the conditional
    # filter + matched_count stops two concurrent cash-outs from both passing the
    # check above and both moving real money to Stripe (overdraft). Refund on any
    # failure so balances can't be lost.
    debit = await db.users.update_one(
        {"user_id": user["user_id"], "wallet_balance": {"$gte": amount - 1e-9}},
        {"$inc": {"wallet_balance": -amount}},
    )
    if getattr(debit, "matched_count", 0) != 1:
        raise HTTPException(status_code=400, detail={"code": "insufficient_balance", "message": "That's more than your wallet balance."})
    # Idempotency keys guard against the SDK retrying a single call; cross-request
    # retries are already blocked by the atomic debit above (the retry can't win).
    cashout_id = str(uuid.uuid4())
    try:
        stripe.Transfer.create(
            amount=units, currency=acct_ccy, destination=acct_id,
            metadata={"kind": "cashout", "user_id": user["user_id"]},
            idempotency_key=f"cashout-transfer-{cashout_id}",
        )
        payout = stripe.Payout.create(
            amount=units, currency=acct_ccy, method="instant",
            stripe_account=acct_id,
            metadata={"kind": "cashout", "user_id": user["user_id"]},
            idempotency_key=f"cashout-payout-{cashout_id}",
        )
    except Exception as e:
        await db.users.update_one({"user_id": user["user_id"]}, {"$inc": {"wallet_balance": amount}})
        msg = getattr(e, "user_message", None) or getattr(e, "_message", None) or str(e)
        raise HTTPException(status_code=400, detail={
            "code": "cashout_failed",
            "message": f"Instant cash out failed: {msg}. Add a debit card as your payout method in Manage payouts — instant payouts need an eligible debit card (a bank account alone won't work).",
        })

    now = datetime.now(timezone.utc)
    await db.payouts.insert_one({
        "id": cashout_id, "user_id": user["user_id"], "amount": net, "gross": amount, "fee": CASHOUT_FEE,
        "currency": acct_ccy, "local_amount": local_amount,
        "status": "instant", "method": "instant_card",
        "stripe_payout_id": (payout or {}).get("id"), "created_at": now,
    })
    # Book the cash-out fee as platform revenue.
    try:
        await db.platform_revenue.insert_one({
            "id": str(uuid.uuid4()), "amount": CASHOUT_FEE, "source": "cashout_fee",
            "from_user_id": user["user_id"], "ref_id": (payout or {}).get("id"), "created_at": now,
        })
    except Exception:
        pass
    fresh = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0, "wallet_balance": 1})
    return {
        "ok": True, "amount": net, "gross": amount, "fee": CASHOUT_FEE,
        "currency": acct_ccy.upper(), "local_amount": local_amount,
        "balance": round(float((fresh or {}).get("wallet_balance", 0) or 0), 2),
    }


class DebitCardBody(BaseModel):
    token: str   # Stripe.js card token (tok_...) created on the connected account


@router.post("/payments/payouts/debit-card")
async def add_debit_card(body: DebitCardBody, authorization: Optional[str] = Header(None)):
    """Attach a debit card to the user's connected account as their payout method
    (for instant cash-out). The card is tokenized in the app via Stripe.js — raw
    card data never touches our server — and only the token is sent here."""
    _require_stripe()
    user = await get_current_user(authorization)
    acct_id = await _ensure_connect_account(user)
    if not body.token:
        raise HTTPException(status_code=400, detail={"code": "no_token", "message": "Card details were missing — please try again."})
    try:
        ext = stripe.Account.create_external_account(
            acct_id, external_account=body.token, default_for_currency=True,
        )
    except Exception as e:
        msg = getattr(e, "user_message", None) or getattr(e, "_message", None) or str(e)
        raise HTTPException(status_code=400, detail={
            "code": "card_failed",
            "message": f"Couldn't add that card: {msg} Use a debit card eligible for instant payouts (credit cards and most prepaid cards won't work).",
        })
    # Only a debit card works for instant payouts — reject a non-card just in case.
    if ext.get("object") != "card":
        raise HTTPException(status_code=400, detail={
            "code": "not_a_card",
            "message": "That wasn't a debit card. Please add a debit card for instant cash-out.",
        })
    # Start the anti-fraud hold on withdrawals/transfers.
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"direct_deposit_changed_at": datetime.now(timezone.utc)}})
    hold = payout_hold_until({"direct_deposit_changed_at": datetime.now(timezone.utc)})
    return {"ok": True, "has_debit_card": True, "brand": ext.get("brand"), "last4": ext.get("last4"),
            "hold_until": hold.isoformat() if hold else None, "hold_days": DD_HOLD_BUSINESS_DAYS}


@router.post("/payments/payouts/bank-account")
async def add_bank_account(body: DebitCardBody, authorization: Optional[str] = Header(None)):
    """Attach a bank account (direct deposit) to the user's connected account.
    The bank details are tokenized in the app via Stripe.js — only the token is
    sent here, never raw account numbers."""
    _require_stripe()
    user = await get_current_user(authorization)
    acct_id = await _ensure_connect_account(user)
    if not body.token:
        raise HTTPException(status_code=400, detail={"code": "no_token", "message": "Bank details were missing — please try again."})
    try:
        ext = stripe.Account.create_external_account(
            acct_id, external_account=body.token, default_for_currency=True,
        )
    except Exception as e:
        msg = getattr(e, "user_message", None) or getattr(e, "_message", None) or str(e)
        raise HTTPException(status_code=400, detail={
            "code": "bank_failed",
            "message": f"Couldn't add that bank account: {msg}",
        })
    if ext.get("object") != "bank_account":
        raise HTTPException(status_code=400, detail={
            "code": "not_a_bank",
            "message": "That wasn't a bank account. Please check the details and try again.",
        })
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"direct_deposit_changed_at": datetime.now(timezone.utc)}})
    hold = payout_hold_until({"direct_deposit_changed_at": datetime.now(timezone.utc)})
    return {"ok": True, "has_bank_account": True, "bank": ext.get("bank_name"), "last4": ext.get("last4"),
            "hold_until": hold.isoformat() if hold else None, "hold_days": DD_HOLD_BUSINESS_DAYS}


# ── Standalone ID verification via Stripe Identity (not tied to payouts) ──────
@router.post("/payments/identity/start")
async def start_identity(authorization: Optional[str] = Header(None)):
    """Begin Stripe Identity verification: the user uploads a government ID +
    selfie on a Stripe-hosted page. On success a webhook (and the status
    endpoint) marks them `id_verified`. Works even if they never set up payouts."""
    _require_stripe()
    user = await get_current_user(authorization)
    if user.get("id_verified"):
        return {"already_verified": True}
    try:
        session = stripe.identity.VerificationSession.create(
            type="document",
            metadata={"user_id": user["user_id"]},
            return_url=f"{WEB_APP_URL}/account?identity=done",
            options={"document": {"require_matching_selfie": True}},
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail={
            "code": "identity_error",
            "message": f"Couldn't start ID verification: {str(e)[:160]}",
        })
    await db.users.update_one(
        {"user_id": user["user_id"]}, {"$set": {"identity_session_id": session.get("id")}}
    )
    return {"url": session.get("url"), "client_secret": session.get("client_secret"), "id": session.get("id")}


@router.get("/payments/identity/status")
async def identity_status(authorization: Optional[str] = Header(None)):
    """Where the user's standalone ID verification stands. Also flips the stored
    `id_verified` flag if Stripe now reports the session as verified."""
    user = await get_current_user(authorization)
    if user.get("id_verified"):
        return {"status": "verified", "id_verified": True}
    if not stripe_enabled():
        return {"status": "unsupported", "id_verified": False}
    sid = user.get("identity_session_id")
    if not sid:
        return {"status": "none", "id_verified": False}
    try:
        s = stripe.identity.VerificationSession.retrieve(sid)
    except Exception:
        return {"status": "error", "id_verified": False}
    verified = s.get("status") == "verified"
    if verified:
        await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"id_verified": True}})
    return {"status": s.get("status"), "id_verified": verified}


# ── Inline identity verification (KYC collected in-app, submitted via API) ─────
def _doc_needed(reqs: dict) -> bool:
    pool = list(reqs.get("currently_due") or []) + list(reqs.get("eventually_due") or []) + list(reqs.get("past_due") or [])
    return any("verification.document" in r for r in pool)


@router.get("/payments/payouts/requirements")
async def payout_requirements(authorization: Optional[str] = Header(None)):
    """What Stripe still needs to enable payouts, plus any details already on file
    so the in-app verification form can prefill. No Stripe-hosted screen involved."""
    _require_stripe()
    user = await get_current_user(authorization)
    acct_id = await _ensure_connect_account(user)
    acct = stripe.Account.retrieve(acct_id)
    reqs = acct.get("requirements") or {}
    ind = acct.get("individual") or {}
    addr = ind.get("address") or {}
    dob = ind.get("dob") or {}
    due = list(reqs.get("currently_due") or []) + list(reqs.get("past_due") or [])
    return {
        "country": acct.get("country"),
        "default_currency": (acct.get("default_currency") or "").lower(),
        "payouts_enabled": bool(acct.get("payouts_enabled")),
        "details_submitted": bool(acct.get("details_submitted")),
        "currently_due": due,
        "needs_document": _doc_needed(reqs),
        "tos_accepted": bool((acct.get("tos_acceptance") or {}).get("date")),
        "prefill": {
            "first_name": ind.get("first_name"), "last_name": ind.get("last_name"),
            "email": ind.get("email") or user.get("email"), "phone": ind.get("phone"),
            "line1": addr.get("line1"), "line2": addr.get("line2"), "city": addr.get("city"),
            "state": addr.get("state"), "postal_code": addr.get("postal_code"),
            "dob_day": dob.get("day"), "dob_month": dob.get("month"), "dob_year": dob.get("year"),
        },
    }


class VerificationBody(BaseModel):
    first_name: str
    last_name: str
    dob_day: int
    dob_month: int
    dob_year: int
    line1: str
    line2: Optional[str] = None
    city: str
    state: Optional[str] = None
    postal_code: str
    country: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    id_number: Optional[str] = None     # full SSN/SIN when required
    ssn_last_4: Optional[str] = None    # US: last 4 only
    accept_tos: bool = False


@router.post("/payments/payouts/verification")
async def submit_verification(body: VerificationBody, request: Request, authorization: Optional[str] = Header(None)):
    """Submit identity details collected by our own in-app form to Stripe via the
    API. Replaces Stripe's hosted/embedded onboarding — nothing opens externally."""
    _require_stripe()
    user = await get_current_user(authorization)
    acct_id = await _ensure_connect_account(user)
    acct = stripe.Account.retrieve(acct_id)
    country = (body.country or acct.get("country") or "US").upper()

    individual: dict = {
        "first_name": body.first_name.strip(),
        "last_name": body.last_name.strip(),
        "dob": {"day": int(body.dob_day), "month": int(body.dob_month), "year": int(body.dob_year)},
        "address": {"line1": body.line1.strip(), "city": body.city.strip(),
                    "postal_code": body.postal_code.strip(), "country": country},
    }
    if body.line2:
        individual["address"]["line2"] = body.line2.strip()
    if body.state:
        individual["address"]["state"] = body.state.strip()
    if body.email:
        individual["email"] = body.email.strip()
    if body.phone:
        individual["phone"] = body.phone.strip()
    if body.id_number:
        individual["id_number"] = body.id_number.replace(" ", "").replace("-", "")
    if body.ssn_last_4:
        individual["ssn_last_4"] = body.ssn_last_4.strip()[-4:]

    update: dict = {
        "business_type": "individual",
        "individual": individual,
        "business_profile": {"product_description": "Creator tips, subscriptions and payouts on OkaySpace", "mcc": "5815"},
    }
    if body.accept_tos:
        ip = (request.client.host if request.client else None) or "0.0.0.0"
        update["tos_acceptance"] = {"date": int(datetime.now(timezone.utc).timestamp()), "ip": ip}
    try:
        acct = stripe.Account.update(acct_id, **update)
    except Exception as e:
        msg = getattr(e, "user_message", None) or getattr(e, "_message", None) or str(e)
        raise HTTPException(status_code=400, detail={"code": "verification_failed", "message": f"Couldn't submit your details: {msg}"})
    reqs = acct.get("requirements") or {}
    return {
        "ok": True,
        "payouts_enabled": bool(acct.get("payouts_enabled")),
        "details_submitted": bool(acct.get("details_submitted")),
        "currently_due": list(reqs.get("currently_due") or []) + list(reqs.get("past_due") or []),
        "needs_document": _doc_needed(reqs),
    }


class DocBody(BaseModel):
    front: str            # base64 (data URL or raw)
    back: Optional[str] = None


@router.post("/payments/payouts/verification-document")
async def upload_verification_document(body: DocBody, authorization: Optional[str] = Header(None)):
    """Upload an ID photo (captured in-app) to Stripe and attach it for verification."""
    _require_stripe()
    import base64
    import io
    user = await get_current_user(authorization)
    acct_id = await _ensure_connect_account(user)

    def _upload(b64: str) -> str:
        raw = b64.split(",", 1)[1] if "," in b64 else b64
        data = base64.b64decode(raw)
        bio = io.BytesIO(data)
        bio.name = "id.jpg"
        f = stripe.File.create(purpose="identity_document", file=bio, stripe_account=acct_id)
        return f["id"]

    try:
        doc: dict = {"front": _upload(body.front)}
        if body.back:
            doc["back"] = _upload(body.back)
        stripe.Account.update(acct_id, individual={"verification": {"document": doc}})
    except Exception as e:
        msg = getattr(e, "user_message", None) or getattr(e, "_message", None) or str(e)
        raise HTTPException(status_code=400, detail={"code": "document_failed", "message": f"Couldn't upload that photo: {msg}"})
    acct = stripe.Account.retrieve(acct_id)
    reqs = acct.get("requirements") or {}
    return {"ok": True, "payouts_enabled": bool(acct.get("payouts_enabled")), "needs_document": _doc_needed(reqs)}


@router.post("/payments/checkout")
async def create_checkout(body: CheckoutCreate, authorization: Optional[str] = Header(None)):
    """Create a Stripe Checkout session and return a hosted checkout URL.
    - tip:          one-time destination charge to the creator's account
    - subscription: auto-renewing monthly destination charge to the creator
    - promote:      one-time charge to the platform (boost your own post)"""
    _require_stripe()
    me = await get_current_user(authorization)

    # ── Promote: pays the platform (no connected account / transfer) ──
    if body.kind == "promote":
        days = max(1, min(30, int(body.days or 7)))
        net = round(float(body.amount or 0), 2)
        if net <= 0 or not body.post_id:
            raise HTTPException(status_code=400, detail="post_id and amount required")
        session = stripe.checkout.Session.create(
            mode="payment",
            line_items=[{
                "price_data": {
                    "currency": "usd",
                    "product_data": {"name": f"Promote post · {days} days"},
                    "unit_amount": int(round(net * 100)),
                },
                "quantity": 1,
            }],
            **_ui_kwargs(bool(body.embedded), "/advertise"),
            metadata={
                "kind": "promote", "post_id": body.post_id, "days": str(days), "buyer_id": me["user_id"],
                **({"budget": str(round(float(body.budget), 2))} if body.budget else {}),
                **({"cpc": str(round(float(body.cpc), 2))} if body.cpc else {}),
            },
        )
        return _checkout_response(session, bool(body.embedded))

    # ── Tip / subscription: pays a creator's connected account ──
    if not body.creator_id or body.creator_id == me["user_id"]:
        raise HTTPException(status_code=400, detail="Invalid recipient")
    creator = await db.users.find_one({"user_id": body.creator_id}, {"_id": 0})
    if not creator:
        raise HTTPException(status_code=404, detail="Creator not found")
    dest = creator.get("stripe_account_id")
    if not dest:
        raise HTTPException(status_code=400, detail="This creator hasn't set up payouts yet")

    meta = {
        "kind": body.kind, "creator_id": body.creator_id,
        "buyer_id": me["user_id"], "buyer_name": me.get("name", "Someone"),
    }

    if body.kind == "subscription":
        from core import SUBSCRIPTION_TIERS_BY_ID
        tier = SUBSCRIPTION_TIERS_BY_ID.get(body.tier or "plus")
        if not tier:
            raise HTTPException(status_code=400, detail="Choose a valid subscription tier")
        net = round(float(tier["price"]), 2)
        meta["net"] = str(net)
        meta["tier"] = tier["id"]
        session = stripe.checkout.Session.create(
            mode="subscription",
            line_items=[{
                "price_data": {
                    "currency": "usd",
                    "product_data": {"name": f"{tier['name']} subscription to {creator.get('name', 'creator')}"},
                    "unit_amount": int(round(net * 100)),
                    "recurring": {"interval": "month"},
                },
                "quantity": 1,
            }],
            subscription_data={
                "application_fee_percent": await platform_fee_percent(),
                "transfer_data": {"destination": dest},
            },
            **_ui_kwargs(bool(body.embedded), "/wallet"),
            metadata=meta,
        )
        return _checkout_response(session, bool(body.embedded))

    # tip (one-time)
    net = round(float(body.amount or 0), 2)
    if net <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than 0")
    meta["net"] = str(net)
    # If the tip was sent from a DM, carry the conversation so the webhook can
    # post an inline tip receipt once payment confirms.
    if body.conversation_id:
        conv = await db.conversations.find_one({"id": body.conversation_id}, {"_id": 0, "participant_ids": 1})
        if conv and me["user_id"] in conv.get("participant_ids", []):
            meta["conversation_id"] = body.conversation_id
            if body.note:
                meta["note"] = body.note[:200]
    gross_cents = int(round(net * 100))
    # Platform's cut: the admin-set percent plus the flat per-transaction fee,
    # capped just under the gross so the creator still receives something.
    fee_cents = int(round(gross_cents * (await platform_fee_percent()) / 100.0)) + (await transaction_fee_cents())
    fee_cents = max(0, min(fee_cents, gross_cents - 1))
    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[{
            "price_data": {
                "currency": "usd",
                "product_data": {"name": f"Tip to {creator.get('name', 'creator')}"},
                "unit_amount": gross_cents,
            },
            "quantity": 1,
        }],
        payment_intent_data={
            "application_fee_amount": fee_cents,
            "transfer_data": {"destination": dest},
        },
        **_ui_kwargs(bool(body.embedded), "/wallet"),
        metadata=meta,
    )
    return _checkout_response(session, bool(body.embedded))


# ── Inline card payments (tip / promote / subscription) — no hosted/embedded UI ─
async def _ensure_customer(user: dict) -> str:
    cid = user.get("stripe_customer_id")
    if cid:
        return cid
    c = stripe.Customer.create(email=user.get("email"), name=user.get("name"),
                               metadata={"user_id": user["user_id"]})
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"stripe_customer_id": c["id"]}})
    return c["id"]


async def _already_fulfilled(ref_id: str) -> bool:
    """Idempotency guard so a payment is fulfilled exactly once.

    Race-safe: relies on the unique index on payments_fulfilled.ref_id (see
    core._UNIQUE_INDEXES). We insert first and treat a DuplicateKeyError as
    "already fulfilled", so two concurrent callers (e.g. the webhook arriving
    alongside an inline confirm, or a duplicated Stripe retry) can never both
    win — only the first insert succeeds.
    """
    if not ref_id:
        return False
    try:
        await db.payments_fulfilled.insert_one({"ref_id": ref_id, "created_at": datetime.now(timezone.utc)})
        return False
    except DuplicateKeyError:
        return True


@router.post("/payments/pay-intent")
async def create_pay_intent(body: CheckoutCreate, authorization: Optional[str] = Header(None)):
    """Create a PaymentIntent (tip/promote) or Subscription (subscription) for an
    inline, in-app card form. Returns a client_secret the app confirms with the
    card field — no hosted or embedded Stripe checkout."""
    _require_stripe()
    if not await payments_live():
        raise HTTPException(status_code=400, detail={"code": "not_live", "message": "Card payments aren't enabled right now."})
    me = await get_current_user(authorization)

    if body.kind == "promote":
        days = max(1, min(30, int(body.days or 7)))
        net = round(float(body.amount or 0), 2)
        if net <= 0 or not body.post_id:
            raise HTTPException(status_code=400, detail="post_id and amount required")
        meta = {"kind": "promote", "post_id": body.post_id, "days": str(days), "buyer_id": me["user_id"]}
        if body.budget:
            meta["budget"] = str(round(float(body.budget), 2))
        if body.cpc:
            meta["cpc"] = str(round(float(body.cpc), 2))
        pi = stripe.PaymentIntent.create(amount=int(round(net * 100)), currency="usd",
                                         payment_method_types=["card"], metadata=meta)
        return {"client_secret": pi["client_secret"], "intent_id": pi["id"], "kind": "promote", "publishable_key": STRIPE_PUBLISHABLE_KEY}

    if not body.creator_id or body.creator_id == me["user_id"]:
        raise HTTPException(status_code=400, detail="Invalid recipient")
    creator = await db.users.find_one({"user_id": body.creator_id}, {"_id": 0})
    if not creator:
        raise HTTPException(status_code=404, detail="Creator not found")
    dest = creator.get("stripe_account_id")
    if not dest:
        raise HTTPException(status_code=400, detail="This creator hasn't set up payouts yet")

    if body.kind == "subscription":
        from core import SUBSCRIPTION_TIERS_BY_ID
        tier = SUBSCRIPTION_TIERS_BY_ID.get(body.tier or "plus")
        if not tier:
            raise HTTPException(status_code=400, detail="Choose a valid subscription tier")
        net = round(float(tier["price"]), 2)
        customer = await _ensure_customer(me)
        price = stripe.Price.create(
            unit_amount=int(round(net * 100)), currency="usd",
            recurring={"interval": "month"},
            product_data={"name": f"{tier['name']} subscription to {creator.get('name', 'creator')}"},
        )
        sub = stripe.Subscription.create(
            customer=customer,
            items=[{"price": price["id"]}],
            payment_behavior="default_incomplete",
            payment_settings={"save_default_payment_method": "on_subscription", "payment_method_types": ["card"]},
            application_fee_percent=await platform_fee_percent(),
            transfer_data={"destination": dest},
            expand=["latest_invoice.payment_intent"],
            metadata={"kind": "subscription", "creator_id": body.creator_id, "buyer_id": me["user_id"],
                      "buyer_name": me.get("name", "Someone"), "tier": tier["id"], "net": str(net)},
        )
        pi = (sub.get("latest_invoice") or {}).get("payment_intent") or {}
        return {"client_secret": pi.get("client_secret"), "subscription_id": sub["id"], "kind": "subscription", "publishable_key": STRIPE_PUBLISHABLE_KEY}

    # tip (one-time)
    net = round(float(body.amount or 0), 2)
    if net <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than 0")
    gross_cents = int(round(net * 100))
    fee_cents = int(round(gross_cents * (await platform_fee_percent()) / 100.0)) + (await transaction_fee_cents())
    fee_cents = max(0, min(fee_cents, gross_cents - 1))
    meta = {"kind": "tip", "creator_id": body.creator_id, "buyer_id": me["user_id"],
            "buyer_name": me.get("name", "Someone"), "net": str(net)}
    if body.conversation_id:
        conv = await db.conversations.find_one({"id": body.conversation_id}, {"_id": 0, "participant_ids": 1})
        if conv and me["user_id"] in conv.get("participant_ids", []):
            meta["conversation_id"] = body.conversation_id
            if body.note:
                meta["note"] = body.note[:200]
    pi = stripe.PaymentIntent.create(
        amount=gross_cents, currency="usd", payment_method_types=["card"],
        application_fee_amount=fee_cents, transfer_data={"destination": dest}, metadata=meta,
    )
    return {"client_secret": pi["client_secret"], "intent_id": pi["id"], "kind": "tip", "publishable_key": STRIPE_PUBLISHABLE_KEY}


class PayConfirm(BaseModel):
    intent_id: Optional[str] = None
    subscription_id: Optional[str] = None


@router.post("/payments/pay-intent/confirm")
async def confirm_pay_intent(body: PayConfirm, authorization: Optional[str] = Header(None)):
    """Fulfill an inline card payment after the card field confirms it (idempotent)."""
    _require_stripe()
    me = await get_current_user(authorization)
    now = datetime.now(timezone.utc)

    meta: dict = {}
    ref_id = ""
    paid = False
    if body.subscription_id:
        sub = stripe.Subscription.retrieve(body.subscription_id, expand=["latest_invoice.payment_intent"])
        meta = sub.get("metadata") or {}
        ref_id = sub["id"]
        paid = sub.get("status") in ("active", "trialing")
    elif body.intent_id:
        pi = stripe.PaymentIntent.retrieve(body.intent_id)
        meta = pi.get("metadata") or {}
        ref_id = pi["id"]
        paid = pi.get("status") == "succeeded"
    else:
        raise HTTPException(status_code=400, detail="Nothing to confirm")

    if meta.get("buyer_id") and meta.get("buyer_id") != me["user_id"]:
        raise HTTPException(status_code=403, detail="This payment isn't yours")
    if not paid:
        return {"ok": False, "paid": False}
    if await _already_fulfilled(ref_id):
        return {"ok": True, "paid": True, "already": True}

    await _fulfill_payment(meta, now)
    return {"ok": True, "paid": True}


async def _fulfill_payment(meta: dict, now):
    """Credit/record an inline payment — same effects as the Checkout webhook."""
    kind = meta.get("kind", "tip")
    creator_id = meta.get("creator_id")
    buyer_id = meta.get("buyer_id")
    net = round(float(meta.get("net") or 0), 2)
    if kind == "form_payment" and meta.get("pending_id"):
        try:
            from routes.forms import finalize_form_payment
            await finalize_form_payment(meta["pending_id"])
        except Exception:
            pass
    elif kind == "promote" and meta.get("post_id"):
        days = max(1, min(30, int(meta.get("days") or 7)))
        promo: dict = {"promoted_until": now + timedelta(days=days)}
        if meta.get("budget"):
            promo["ad_budget"] = round(float(meta["budget"]), 2)
        if meta.get("cpc"):
            promo["ad_cpc"] = round(float(meta["cpc"]), 2)
        await db.posts.update_one({"id": meta["post_id"]}, {"$set": promo})
        return
    if creator_id and net > 0:
        await db.earnings.insert_one({
            "id": str(uuid.uuid4()), "user_id": creator_id, "amount": net,
            "kind": "subscription" if kind == "subscription" else "tip",
            "from_user_id": buyer_id or "", "from_name": meta.get("buyer_name", "Someone"),
            "message": meta.get("note", "") if kind != "subscription" else "",
            "source": "stripe", "created_at": now,
        })
        if kind == "subscription" and buyer_id:
            await db.subscriptions.insert_one({
                "id": str(uuid.uuid4()), "subscriber_id": buyer_id, "creator_id": creator_id,
                "amount": net, "tier": meta.get("tier"), "status": "active", "source": "stripe",
                "started_at": now, "renews_at": now + timedelta(days=30), "created_at": now,
            })
        try:
            from routes.notifications import emit_notification
            await emit_notification(user_id=creator_id, actor_id=buyer_id,
                                    ntype="subscribe" if kind == "subscription" else "tip",
                                    message=f"${net:.2f} {'subscription' if kind == 'subscription' else 'tip'} received")
        except Exception:
            pass
        conv_id = meta.get("conversation_id")
        if kind == "tip" and conv_id and buyer_id:
            await db.messages.insert_one({
                "id": str(uuid.uuid4()), "conversation_id": conv_id, "sender_id": buyer_id,
                "type": "tip", "text": (meta.get("note") or ""), "amount": net,
                "media": [], "reactions": {}, "deleted": False, "created_at": now,
            })
            await db.conversations.update_one({"id": conv_id}, {"$set": {"last_message_at": now}})


# ── Developer API plans (tiered, paid) ───────────────────────────────────────
class ApiPlanBuy(BaseModel):
    plan: str


@router.get("/payments/api-plan")
async def api_plan_status(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    active = _active_plan(user)
    return {
        "plans": API_PLANS,
        "stripe_enabled": stripe_enabled(),
        "current": {
            "plan": (active or {}).get("id"),
            "name": (active or {}).get("name"),
            "active": bool(active),
            "until": user.get("api_access_until"),
        },
    }


def _grant_plan_doc(plan_id: str):
    now = datetime.now(timezone.utc)
    return {"$set": {"api_plan": plan_id, "api_access_until": now + timedelta(days=30)}}


@router.post("/payments/api-plan/checkout")
async def api_plan_checkout(body: ApiPlanBuy, authorization: Optional[str] = Header(None)):
    """Buy/upgrade a Developer API plan via Stripe (charges the platform)."""
    _require_stripe()
    me = await get_current_user(authorization)
    plan = API_PLANS_BY_ID.get(body.plan)
    if not plan:
        raise HTTPException(status_code=400, detail="Unknown plan")
    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[{
            "price_data": {
                "currency": "usd",
                "product_data": {"name": f"Developer API · {plan['name']} (30 days)"},
                "unit_amount": int(round(plan["price"] * 100)),
            },
            "quantity": 1,
        }],
        success_url=f"{WEB_APP_URL}/developer?plan=success",
        cancel_url=f"{WEB_APP_URL}/developer?plan=cancel",
        metadata={"kind": "api_plan", "plan": plan["id"], "buyer_id": me["user_id"]},
    )
    return {"url": session["url"], "id": session["id"]}


@router.post("/payments/api-plan/activate")
async def api_plan_activate(body: ApiPlanBuy, authorization: Optional[str] = Header(None)):
    """Test-mode activation (no Stripe configured). Mirrors the fake-payment flow."""
    if stripe_enabled():
        raise HTTPException(status_code=400, detail="Use checkout — real payments are enabled")
    me = await get_current_user(authorization)
    plan = API_PLANS_BY_ID.get(body.plan)
    if not plan:
        raise HTTPException(status_code=400, detail="Unknown plan")
    await db.users.update_one({"user_id": me["user_id"]}, _grant_plan_doc(plan["id"]))
    return {"ok": True, "plan": plan["id"]}


# ── Usage metering + pay-as-you-go ───────────────────────────────────────────
class UsageBuy(BaseModel):
    pack: str


@router.get("/payments/api-usage")
async def api_usage(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    plan = _active_plan(user)
    used = int(user.get("api_usage_count", 0) or 0)
    extra = int(user.get("api_extra_credits", 0) or 0)
    quota = int(plan.get("monthly_quota", 0)) if plan else 0
    start = user.get("api_usage_period_start")
    resets_at = None
    if start:
        try:
            resets_at = (start + timedelta(days=USAGE_PERIOD_DAYS)).isoformat() if hasattr(start, "isoformat") else None
        except Exception:
            resets_at = None
    return {
        "plan": (plan or {}).get("id"),
        "used": used, "quota": quota, "extra_credits": extra,
        "limit": quota + extra, "resets_at": resets_at,
        "packs": API_OVERAGE_PACKS, "stripe_enabled": stripe_enabled(),
    }


@router.post("/payments/api-usage/buy")
async def buy_usage(body: UsageBuy, authorization: Optional[str] = Header(None)):
    """Pay-as-you-go: buy an overage pack via Stripe (charges the platform)."""
    _require_stripe()
    me = await get_current_user(authorization)
    pack = API_OVERAGE_BY_ID.get(body.pack)
    if not pack:
        raise HTTPException(status_code=400, detail="Unknown pack")
    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[{
            "price_data": {
                "currency": "usd",
                "product_data": {"name": f"API requests · {pack['name']}"},
                "unit_amount": int(round(pack["price"] * 100)),
            },
            "quantity": 1,
        }],
        success_url=f"{WEB_APP_URL}/developer?usage=success",
        cancel_url=f"{WEB_APP_URL}/developer?usage=cancel",
        metadata={"kind": "api_usage", "pack": pack["id"], "buyer_id": me["user_id"]},
    )
    return {"url": session["url"], "id": session["id"]}


@router.post("/payments/api-usage/activate")
async def activate_usage(body: UsageBuy, authorization: Optional[str] = Header(None)):
    """Test-mode pay-as-you-go (no Stripe). Adds request credits immediately."""
    if stripe_enabled():
        raise HTTPException(status_code=400, detail="Use checkout — real payments are enabled")
    me = await get_current_user(authorization)
    pack = API_OVERAGE_BY_ID.get(body.pack)
    if not pack:
        raise HTTPException(status_code=400, detail="Unknown pack")
    await db.users.update_one({"user_id": me["user_id"]}, {"$inc": {"api_extra_credits": pack["requests"]}})
    return {"ok": True, "added": pack["requests"]}


@router.post("/payments/webhook")
async def stripe_webhook(request: Request):
    """Credit the creator's in-app wallet when a Checkout payment completes."""
    if not stripe_enabled():
        return {"ok": True}
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    # Outside of an explicit test key we must verify the Stripe signature —
    # otherwise anyone could POST a forged event and credit wallets / grant plans.
    # Only a *_test_* key (sk_test_/rk_test_) may trust an unsigned body; this also
    # covers restricted live keys (rk_live_) which don't start with "sk_live_".
    if not STRIPE_WEBHOOK_SECRET and "_test_" not in STRIPE_SECRET_KEY:
        raise HTTPException(status_code=400, detail="Webhook signature verification required")
    try:
        if STRIPE_WEBHOOK_SECRET:
            event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
        else:  # dev/test: trust the body (configure STRIPE_WEBHOOK_SECRET in production)
            import json
            event = json.loads(payload)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid webhook signature")

    # An abandoned/expired Checkout — mark a pending wallet top-up as failed.
    # Inline (Elements) card top-up succeeded — credit it (idempotent backup to
    # the client-side confirm-intent call).
    if event.get("type") == "payment_intent.succeeded":
        obj = event.get("data", {}).get("object", {}) or {}
        meta = obj.get("metadata", {}) or {}
        if meta.get("kind") == "wallet_topup" and meta.get("buyer_id") and obj.get("id"):
            amt = round(float(meta.get("amount") or 0), 2)
            from routes.money import _apply_wallet_topup
            await _apply_wallet_topup(meta["buyer_id"], amt, "stripe", obj["id"])
        return {"ok": True}

    if event.get("type") == "checkout.session.expired":
        obj = event.get("data", {}).get("object", {}) or {}
        if (obj.get("metadata") or {}).get("kind") == "wallet_topup" and obj.get("id"):
            from routes.money import _mark_topup_failed
            await _mark_topup_failed(obj["id"])
        return {"ok": True}

    # Stripe Identity finished verifying a government ID → mark the user id_verified.
    if event.get("type") == "identity.verification_session.verified":
        obj = event.get("data", {}).get("object", {}) or {}
        uid = (obj.get("metadata") or {}).get("user_id")
        if uid:
            await db.users.update_one({"user_id": uid}, {"$set": {"id_verified": True}})
        return {"ok": True}

    # A reversed payment (chargeback/dispute) → ban the account. Reversing a
    # transaction isn't allowed; it's a common bot/fraud pattern.
    if event.get("type") == "charge.dispute.created":
        obj = event.get("data", {}).get("object", {}) or {}
        uid = None
        try:
            pi_id = obj.get("payment_intent")
            if pi_id:
                pi = stripe.PaymentIntent.retrieve(pi_id)
                uid = (pi.get("metadata") or {}).get("buyer_id")
            if not uid and obj.get("charge"):
                ch = stripe.Charge.retrieve(obj["charge"])
                uid = (ch.get("metadata") or {}).get("buyer_id")
        except Exception:
            uid = None
        if uid:
            await db.users.update_one({"user_id": uid}, {"$set": {
                "banned": True,
                "ban_reason": "Reversed a transaction (payment dispute / chargeback).",
                "roadside_verified": False,
            }})
            try:
                from routes.notifications import emit_notification
                await emit_notification(
                    user_id=uid, actor_id=None, ntype="support",
                    message="Your account was banned: reversing a transaction (chargeback) isn't allowed.",
                )
            except Exception:
                pass
        return {"ok": True}

    if event.get("type") == "checkout.session.completed":
        obj = (event.get("data", {}).get("object", {}) or {})
        # Idempotency: Stripe delivers webhooks at-least-once (retries until 2xx,
        # and the same session can arrive more than once). Fulfill each completed
        # session exactly once so tips/subscriptions/promotes can't double-credit.
        session_id = obj.get("id")
        if session_id and await _already_fulfilled(f"cs:{session_id}"):
            return {"ok": True}
        meta = obj.get("metadata", {}) or {}
        kind = meta.get("kind", "tip")
        creator_id = meta.get("creator_id")
        buyer_id = meta.get("buyer_id")
        net = round(float(meta.get("net") or 0), 2)
        now = datetime.now(timezone.utc)
        if kind == "promote" and meta.get("post_id"):
            days = max(1, min(30, int(meta.get("days") or 7)))
            promo: dict = {"promoted_until": now + timedelta(days=days)}
            if meta.get("budget"):
                promo["ad_budget"] = round(float(meta["budget"]), 2)
            if meta.get("cpc"):
                promo["ad_cpc"] = round(float(meta["cpc"]), 2)
            await db.posts.update_one({"id": meta["post_id"]}, {"$set": promo})
        elif kind == "api_plan" and meta.get("buyer_id") and meta.get("plan"):
            await db.users.update_one(
                {"user_id": meta["buyer_id"]},
                {"$set": {"api_plan": meta["plan"], "api_access_until": now + timedelta(days=30)}},
            )
        elif kind == "ad_topup" and meta.get("buyer_id"):
            amt = round(float(meta.get("amount") or 0), 2)
            if amt > 0:
                from routes.ads import _apply_ad_topup
                await _apply_ad_topup(meta["buyer_id"], amt, "stripe")
        elif kind == "wallet_topup" and meta.get("buyer_id"):
            amt = round(float(meta.get("amount") or 0), 2)
            session_id = (event.get("data", {}).get("object", {}) or {}).get("id")
            from routes.money import _apply_wallet_topup
            credited = await _apply_wallet_topup(meta["buyer_id"], amt, "stripe", session_id)
            if credited:
                try:
                    from routes.notifications import emit_notification
                    await emit_notification(user_id=meta["buyer_id"], actor_id=meta["buyer_id"],
                                            ntype="wallet_topup", message=f"${amt:.2f} added to your wallet")
                except Exception:
                    pass
        elif kind == "api_usage" and meta.get("buyer_id") and meta.get("pack"):
            pack = API_OVERAGE_BY_ID.get(meta["pack"])
            if pack:
                await db.users.update_one(
                    {"user_id": meta["buyer_id"]},
                    {"$inc": {"api_extra_credits": pack["requests"]}},
                )
        elif creator_id and net > 0:
            await db.earnings.insert_one({
                "id": str(uuid.uuid4()), "user_id": creator_id, "amount": net,
                "kind": "subscription" if kind == "subscription" else "tip",
                "from_user_id": buyer_id or "", "from_name": meta.get("buyer_name", "Someone"),
                "message": meta.get("note", "") if kind != "subscription" else "",
                "source": "stripe", "created_at": now,
            })
            if kind == "subscription" and buyer_id:
                await db.subscriptions.insert_one({
                    "id": str(uuid.uuid4()), "subscriber_id": buyer_id, "creator_id": creator_id,
                    "amount": net, "tier": meta.get("tier"), "status": "active", "source": "stripe",
                    "started_at": now, "renews_at": now + timedelta(days=30), "created_at": now,
                })
            # Receipt to the creator (in-app + email).
            try:
                from routes.notifications import emit_notification
                await emit_notification(user_id=creator_id, actor_id=buyer_id,
                                        ntype="subscribe" if kind == "subscription" else "tip",
                                        message=f"${net:.2f} {'subscription' if kind == 'subscription' else 'tip'} received")
            except Exception:
                pass
            try:
                from services.email import send_email
                cre = await db.users.find_one({"user_id": creator_id}, {"_id": 0, "email": 1, "name": 1})
                if cre and cre.get("email"):
                    send_email(cre["email"], f"You received ${net:.2f}",
                               f"Hi {cre.get('name', 'there')},\n\nYou received a ${net:.2f} "
                               f"{'subscription' if kind == 'subscription' else 'tip'} on OkaySpace. It's in your balance.")
            except Exception:
                pass
            # DM tip → drop an inline tip receipt into the conversation.
            conv_id = meta.get("conversation_id")
            if kind == "tip" and conv_id and buyer_id:
                await db.messages.insert_one({
                    "id": str(uuid.uuid4()), "conversation_id": conv_id, "sender_id": buyer_id,
                    "type": "tip", "text": (meta.get("note") or ""), "amount": net,
                    "media": [], "reactions": {}, "deleted": False, "created_at": now,
                })
                await db.conversations.update_one(
                    {"id": conv_id},
                    {"$set": {"last_message_at": now}},
                )
    return {"ok": True}


# ── Embedded Connect onboarding + payout management (rendered inside the site) ─
@router.post("/payments/payouts/account-session")
async def payout_account_session(authorization: Optional[str] = Header(None)):
    """Create an Account Session for Stripe's embedded components.

    Returns the list of enabled `components` so the client knows whether it can
    render the full embedded **payouts** dashboard (platform-controlled accounts)
    or just the embedded onboarding/account-update view (legacy Express accounts).
    Either way the panel renders inside the site — the user never leaves the app.
    """
    _require_stripe()
    user = await get_current_user(authorization)
    try:
        acct_id = await _ensure_connect_account(user)

        components: dict = {"account_onboarding": {"enabled": True}}
        if _account_supports_embedded_mgmt(acct_id):
            # Full DoorDash-style payout management embedded in the site: balance,
            # payout history/schedule, change bank/debit card, instant cash-out.
            components["payouts"] = {
                "enabled": True,
                "features": {
                    "instant_payouts": True,
                    "standard_payouts": True,
                    "edit_payout_schedule": True,
                },
            }
            components["account_management"] = {
                "enabled": True,
                "features": {"external_account_collection": True},
            }
            components["notification_banner"] = {
                "enabled": True,
                "features": {"external_account_collection": True},
            }

        try:
            sess = stripe.AccountSession.create(account=acct_id, components=components)
        except Exception:
            # If a management component isn't allowed for this account, still return
            # a working onboarding session so the embedded panel renders in-site.
            components = {"account_onboarding": {"enabled": True}}
            sess = stripe.AccountSession.create(account=acct_id, components=components)

        return {
            "client_secret": sess["client_secret"],
            "publishable_key": STRIPE_PUBLISHABLE_KEY,
            "components": list(components.keys()),
        }
    except Exception as e:
        msg = getattr(e, "user_message", None) or getattr(e, "_message", None) or str(e)
        raise HTTPException(status_code=400, detail={"code": "stripe_setup_failed", "message": f"Stripe setup failed: {msg}"})


# ── Admin: test-payments toggle + reset fake money/analytics ──────────────────
class TestPaymentsBody(BaseModel):
    enabled: bool


def _admin_only(me: dict):
    from core import is_admin
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")


@router.get("/admin/test-payments")
async def admin_get_test_payments(authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    _admin_only(me)
    return {"test_payments": await test_payments_on(), "stripe_configured": stripe_enabled()}


async def _set_setting(key: str, value):
    existing = await db.app_settings.find_one({"key": key}, {"_id": 0, "key": 1})
    if existing:
        await db.app_settings.update_one({"key": key}, {"$set": {"value": value}})
    else:
        await db.app_settings.insert_one({"key": key, "value": value})


@router.post("/admin/test-payments")
async def admin_set_test_payments(body: TestPaymentsBody, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    _admin_only(me)
    val = bool(body.enabled)
    await _set_setting("test_payments", val)
    return {"test_payments": val}


class ToggleBody(BaseModel):
    enabled: bool


@router.get("/admin/mobile-only")
async def admin_get_mobile_only(authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    _admin_only(me)
    return {"mobile_only": bool(await _setting("mobile_only", True))}


@router.post("/admin/mobile-only")
async def admin_set_mobile_only(body: ToggleBody, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    _admin_only(me)
    await _set_setting("mobile_only", bool(body.enabled))
    return {"mobile_only": bool(body.enabled)}


class WebBuildBody(BaseModel):
    build: Optional[str] = None   # explicit token; blank → auto-bump to a timestamp


@router.get("/admin/web-build")
async def admin_get_web_build(authorization: Optional[str] = Header(None)):
    """Current web-update kill-switch token (and any admin override)."""
    me = await get_current_user(authorization)
    _admin_only(me)
    from routes.meta import resolve_web_build
    override = await _setting("web_build", None)
    return {"web_build": resolve_web_build(override), "override": override}


@router.post("/admin/web-build")
async def admin_set_web_build(body: WebBuildBody, authorization: Optional[str] = Header(None)):
    """Bump the kill-switch token so every open web client hard-refreshes to the
    latest deploy. Pass a `build` string to set it explicitly, or omit it to
    auto-bump to the current timestamp."""
    me = await get_current_user(authorization)
    _admin_only(me)
    import time
    val = (body.build or "").strip() or str(int(time.time()))
    await _set_setting("web_build", val)
    from routes.meta import resolve_web_build
    return {"web_build": resolve_web_build(val), "override": val}


class FeesBody(BaseModel):
    platform_fee_percent: Optional[float] = None   # platform's cut of subscriptions/tips
    transaction_fee_cents: Optional[int] = None    # flat per-payment fee


@router.get("/admin/fees")
async def admin_get_fees(authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    _admin_only(me)
    pct = await platform_fee_percent()
    return {
        "platform_fee_percent": pct,
        "creator_share_percent": round(100 - pct, 2),
        "transaction_fee_cents": await transaction_fee_cents(),
    }


@router.post("/admin/fees")
async def admin_set_fees(body: FeesBody, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    _admin_only(me)
    if body.platform_fee_percent is not None:
        await _set_setting("platform_fee_percent", max(0.0, min(100.0, float(body.platform_fee_percent))))
    if body.transaction_fee_cents is not None:
        await _set_setting("transaction_fee_cents", max(0, int(round(float(body.transaction_fee_cents)))))
    pct = await platform_fee_percent()
    return {
        "platform_fee_percent": pct,
        "creator_share_percent": round(100 - pct, 2),
        "transaction_fee_cents": await transaction_fee_cents(),
    }


@router.get("/admin/revenue")
async def admin_revenue(authorization: Optional[str] = Header(None)):
    """Platform revenue from in-app fees — read from the platform_revenue ledger,
    so it includes every recorded fee: per-payment transaction fees on sends, and
    the flat instant cash-out fee. (The % cut on tips/subscriptions is collected by
    Stripe and shows in your Stripe Dashboard.)"""
    me = await get_current_user(authorization)
    _admin_only(me)
    rows = await db.platform_revenue.find({}, {"_id": 0, "amount": 1, "source": 1}).limit(50000).to_list(50000)
    by_source: dict = {}
    counts: dict = {}
    for r in rows:
        src = r.get("source", "other")
        by_source[src] = round(by_source.get(src, 0) + float(r.get("amount", 0) or 0), 2)
        counts[src] = counts.get(src, 0) + 1
    total = round(sum(by_source.values()), 2)
    payouts = await db.payouts.find({}, {"_id": 0, "amount": 1}).limit(20000).to_list(20000)
    total_paid_out = round(sum(float(p.get("amount", 0) or 0) for p in payouts), 2)
    return {
        "total": total,
        "count": len(rows),
        "by_source": by_source,
        "transfer_fees": by_source.get("transfer_fee", 0.0) + by_source.get("request_fee", 0.0),
        "cashout_fees": by_source.get("cashout_fee", 0.0),
        "cashout_count": counts.get("cashout_fee", 0),
        "total_paid_out": total_paid_out,
        "platform_fee_percent": await platform_fee_percent(),
        "transaction_fee_cents": await transaction_fee_cents(),
        "cashout_fee": CASHOUT_FEE,
        "cashout_min": MIN_CASHOUT,
    }


@router.post("/admin/reset/money")
async def admin_reset_money(authorization: Optional[str] = Header(None)):
    """Wipe wallet/money data (earnings, tips, subs, payouts, transfers, requests)
    and zero ad balances. For clearing test/fake money."""
    me = await get_current_user(authorization)
    _admin_only(me)
    for coll in ("earnings", "tips", "subscriptions", "payouts", "money_transfers",
                 "money_requests", "wallet_topups", "ad_topups", "platform_revenue"):
        await getattr(db, coll).delete_many({})
    await db.users.update_many({}, {"$set": {"ad_balance": 0, "wallet_balance": 0}})
    return {"ok": True}


@router.post("/admin/reset/analytics")
async def admin_reset_analytics(authorization: Optional[str] = Header(None)):
    """Zero ad + view analytics (impressions/clicks/spend, profile views, events)."""
    me = await get_current_user(authorization)
    _admin_only(me)
    await db.posts.update_many({}, {"$set": {"ad_impressions": 0, "ad_clicks": 0, "ad_comments": 0, "ad_spent": 0, "views_count": 0}})
    await db.link_ads.update_many({}, {"$set": {"ad_impressions": 0, "ad_clicks": 0, "ad_spent": 0}})
    await db.ad_sites.update_many({}, {"$set": {"impressions": 0, "clicks": 0, "earned": 0}})
    await db.users.update_many({}, {"$set": {"profile_views": 0}})
    await db.ad_events.delete_many({})
    await db.post_views.delete_many({})
    await db.bot_seen.delete_many({})
    return {"ok": True}
