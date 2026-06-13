"""Stripe-native wallet (`/stripe/*`).

A thin, Stripe Connect-backed surface that treats each user's *connected-account
balance* as their wallet — the eventual replacement for the custom ledger in
`money.py`. It's added alongside that ledger (which keeps working): nothing here
reads or writes `wallet_balance`/`earnings` except where a transfer is funded.

Five endpoints + a Connect webhook:
  - POST /stripe/account       create/fetch the Express account + onboarding link
  - GET  /stripe/balance       the connected account's Stripe balance
  - POST /stripe/transfer      platform-mediated user→user send (Transfer)
  - POST /stripe/payout        cash the Stripe balance out to the bank/card
  - GET  /stripe/transactions  the account's Stripe balance-transaction history
  - POST /stripe/webhook       account/payout/transfer status sync (Connect events)

Everything is feature-flagged on STRIPE_SECRET_KEY: with Stripe unconfigured the
endpoints report 503 and the app keeps using the test/ledger wallet.
"""
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from core import db, get_current_user, MONEY_MAX_SEND
from db import DuplicateKeyError
from routes.payments import (
    stripe,
    stripe_enabled,
    _require_stripe,
    _ensure_connect_account,
    test_payments_on,
    STRIPE_WEBHOOK_SECRET,
    STRIPE_SECRET_KEY,
)

router = APIRouter()

# Connect events are delivered to a *separate* webhook endpoint in the Stripe
# dashboard, so they can carry their own signing secret. Fall back to the main
# webhook secret if only one is configured.
STRIPE_CONNECT_WEBHOOK_SECRET = (
    os.environ.get("STRIPE_CONNECT_WEBHOOK_SECRET", "") or STRIPE_WEBHOOK_SECRET
)

# Currencies Stripe takes in whole units (no cents) — amounts must not be ×100.
ZERO_DECIMAL = {"jpy", "krw", "vnd", "clp", "bif", "djf", "gnf", "kmf",
                "mga", "pyg", "rwf", "ugx", "vuv", "xaf", "xof", "xpf"}


def _to_minor(amount: float, currency: str) -> int:
    """Dollars → Stripe's smallest-unit integer (cents, or whole units for JPY etc.)."""
    return int(round(amount)) if currency.lower() in ZERO_DECIMAL else int(round(amount * 100))


def _from_minor(units: int, currency: str) -> float:
    """Stripe smallest-unit integer → a human amount."""
    if currency.lower() in ZERO_DECIMAL:
        return float(units)
    return round(units / 100.0, 2)


def _stripe_error(e: Exception) -> str:
    return getattr(e, "user_message", None) or getattr(e, "_message", None) or str(e)


def _iso(ts) -> Optional[str]:
    """A Stripe unix timestamp → ISO-8601, or None."""
    if not ts:
        return None
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()
    except Exception:
        return None


# --- Idempotency-Key support for money POSTs --------------------------------
# Built on the existing unique index on payments_fulfilled.ref_id, so a client
# that times out and retries a transfer/payout with the same Idempotency-Key
# can't move money twice. Claim AFTER input validation and BEFORE moving money;
# store the response on success; release the claim on failure so a genuine retry
# isn't blocked forever.
async def _idem_claim(scope: str, user_id: str, key: Optional[str]):
    """Returns (ref_id, cached_response):
      (None, None)   no key supplied — proceed without dedup
      (ref_id, None) freshly claimed — proceed, then call _idem_store(ref_id, ...)
      (ref_id, dict) a prior attempt's stored response — return it (replay)
    Raises 409 if a matching attempt is still in flight (claimed, no response yet)."""
    if not key:
        return None, None
    ref_id = f"idem:{scope}:{user_id}:{key}"
    try:
        await db.payments_fulfilled.insert_one({
            "ref_id": ref_id, "scope": scope, "user_id": user_id,
            "created_at": datetime.now(timezone.utc),
        })
        return ref_id, None
    except DuplicateKeyError:
        prior = await db.payments_fulfilled.find_one({"ref_id": ref_id}, {"_id": 0, "response": 1})
        if prior and prior.get("response") is not None:
            return ref_id, prior["response"]
        raise HTTPException(status_code=409, detail={
            "code": "in_progress",
            "message": "A request with this Idempotency-Key is already being processed. Retry shortly.",
        })


async def _idem_store(ref_id: Optional[str], response: dict) -> dict:
    if ref_id:
        try:
            await db.payments_fulfilled.update_one({"ref_id": ref_id}, {"$set": {"response": response}})
        except Exception:
            pass
    return response


async def _idem_release(ref_id: Optional[str]) -> None:
    if ref_id:
        try:
            await db.payments_fulfilled.delete_one({"ref_id": ref_id})
        except Exception:
            pass


def _account_public(acct: dict) -> dict:
    """The onboarding/status fields the client cares about."""
    return {
        "account_id": acct.get("id"),
        "charges_enabled": bool(acct.get("charges_enabled")),
        "payouts_enabled": bool(acct.get("payouts_enabled")),
        "details_submitted": bool(acct.get("details_submitted")),
        "default_currency": (acct.get("default_currency") or "usd").lower(),
        "country": acct.get("country"),
    }


async def _cache_account_state(user_id: str, acct: dict) -> None:
    """Mirror the onboarding flags onto the user doc so other code can read them
    without a Stripe round-trip (kept fresh by /stripe/account and the webhook)."""
    try:
        await db.users.update_one(
            {"user_id": user_id},
            {"$set": {
                "stripe_payouts_enabled": bool(acct.get("payouts_enabled")),
                "stripe_charges_enabled": bool(acct.get("charges_enabled")),
                "stripe_details_submitted": bool(acct.get("details_submitted")),
            }},
        )
    except Exception:
        pass


# --- Response models (§1: declared shapes so the OpenAPI spec is complete and
# SDK codegen produces typed clients). extra="allow" means a field is never
# dropped from the response, so adding keys later stays backward-compatible. ---
class _Out(BaseModel):
    model_config = ConfigDict(extra="allow")


class StripeAccountOut(_Out):
    account_id: Optional[str] = None
    charges_enabled: bool = False
    payouts_enabled: bool = False
    details_submitted: bool = False
    default_currency: Optional[str] = None
    country: Optional[str] = None
    onboarding_url: Optional[str] = None  # present until onboarding is complete


class CurrencyBalanceOut(_Out):
    currency: str
    available: float
    pending: float


class StripeBalanceOut(_Out):
    connected: bool
    currency: str = "usd"
    available: float = 0
    pending: float = 0
    by_currency: list[CurrencyBalanceOut] = []


class StripeTransferOut(_Out):
    ok: bool
    amount: float
    transfer_id: Optional[str] = None
    balance: float  # sender's remaining in-app balance


class StripePayoutOut(_Out):
    ok: bool
    amount: float
    currency: str
    payout_id: Optional[str] = None
    status: Optional[str] = None
    arrival_date: Optional[str] = None  # ISO-8601


class BalanceTxnOut(_Out):
    id: Optional[str] = None
    type: Optional[str] = None         # charge | payout | transfer | payment | …
    amount: float
    net: float
    fee: float
    currency: str
    status: Optional[str] = None       # available | pending
    description: Optional[str] = None
    created: Optional[str] = None       # ISO-8601


class StripeTransactionsOut(_Out):
    connected: bool
    transactions: list[BalanceTxnOut] = []   # legacy key (kept for back-compat)
    data: list[BalanceTxnOut] = []           # §6 canonical list accessor
    has_more: bool = False


class WebhookAck(_Out):
    received: bool


# ---------------------------------------------------------------------------
# 1. POST /stripe/account — create/fetch the Express account + onboarding link
# ---------------------------------------------------------------------------
@router.post("/stripe/account", response_model=StripeAccountOut)
async def stripe_account(user: dict = Depends(get_current_user)):
    """Create (or reuse) the caller's Stripe Connect account and return its
    status plus a hosted onboarding link to finish (or update) setup."""
    _require_stripe()
    try:
        acct_id = await _ensure_connect_account(user)
        acct = stripe.Account.retrieve(acct_id)
        await _cache_account_state(user["user_id"], acct)
        out = _account_public(acct)
        # Always hand back a fresh onboarding link; the client can ignore it once
        # details_submitted/payouts_enabled are both true.
        if not (acct.get("payouts_enabled") and acct.get("details_submitted")):
            link = stripe.AccountLink.create(
                account=acct_id,
                refresh_url=f"{_web()}/wallet?stripe=refresh",
                return_url=f"{_web()}/wallet?stripe=done",
                type="account_onboarding",
            )
            out["onboarding_url"] = link["url"]
        return out
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail={
            "code": "stripe_account_failed",
            "message": f"Couldn't set up your Stripe account: {_stripe_error(e)}",
        })


def _web() -> str:
    from routes.payments import WEB_APP_URL
    return WEB_APP_URL


# ---------------------------------------------------------------------------
# 2. GET /stripe/balance — the connected account's balance (replaces the ledger)
# ---------------------------------------------------------------------------
@router.get("/stripe/balance", response_model=StripeBalanceOut)
async def stripe_balance(user: dict = Depends(get_current_user)):
    """The caller's spendable + pending Stripe balance. Returns `connected: false`
    (zeros) when they haven't started onboarding yet."""
    _require_stripe()
    acct_id = user.get("stripe_account_id")
    if not acct_id:
        return {"connected": False, "available": 0.0, "pending": 0.0, "currency": "usd", "by_currency": []}
    try:
        bal = stripe.Balance.retrieve(stripe_account=acct_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail={"code": "balance_error", "message": _stripe_error(e)})

    def _bucket(rows):
        out = {}
        for r in rows or []:
            ccy = (r.get("currency") or "usd").lower()
            out[ccy] = out.get(ccy, 0) + int(r.get("amount") or 0)
        return out

    avail = _bucket(bal.get("available"))
    pending = _bucket(bal.get("pending"))
    currencies = sorted(set(avail) | set(pending))
    primary = currencies[0] if currencies else "usd"
    by_currency = [{
        "currency": c,
        "available": _from_minor(avail.get(c, 0), c),
        "pending": _from_minor(pending.get(c, 0), c),
    } for c in currencies]
    return {
        "connected": True,
        "currency": primary,
        "available": _from_minor(avail.get(primary, 0), primary),
        "pending": _from_minor(pending.get(primary, 0), primary),
        "by_currency": by_currency,
    }


# ---------------------------------------------------------------------------
# 3. POST /stripe/transfer — platform-mediated user → user send
# ---------------------------------------------------------------------------
class TransferBody(BaseModel):
    to_user_id: str
    amount: float          # dollars (USD, the platform settlement currency)
    note: Optional[str] = None


@router.post("/stripe/transfer", response_model=StripeTransferOut)
async def stripe_transfer(
    body: TransferBody,
    sender: dict = Depends(get_current_user),
    idempotency_key: Optional[str] = Header(None),
):
    """Send money to another user. Stripe can't move funds connected→connected
    directly, so this is platform-mediated: the sender's in-app balance funds the
    move, then the platform creates a Stripe Transfer into the recipient's
    connected account (their Stripe balance is their wallet)."""
    _require_stripe()
    if await test_payments_on():
        raise HTTPException(status_code=400, detail={"code": "test_mode", "message": "Transfers aren't available in test mode."})
    amount = round(float(body.amount or 0), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Enter an amount to send")
    if amount > MONEY_MAX_SEND:
        raise HTTPException(status_code=400, detail={"code": "amount_too_large", "message": f"That's over the ${MONEY_MAX_SEND:,.0f} limit for a single transfer."})
    if body.to_user_id == sender["user_id"]:
        raise HTTPException(status_code=400, detail="You can't send money to yourself")
    from routes.money import enforce_send_velocity
    await enforce_send_velocity(sender["user_id"], amount)

    recipient = await db.users.find_one({"user_id": body.to_user_id}, {"_id": 0, "user_id": 1, "stripe_account_id": 1, "name": 1})
    if not recipient:
        raise HTTPException(status_code=404, detail="Recipient not found")
    dest = recipient.get("stripe_account_id")
    if not dest:
        raise HTTPException(status_code=400, detail={"code": "recipient_no_account", "message": "That user hasn't set up payments yet, so they can't receive transfers."})
    try:
        dest_acct = stripe.Account.retrieve(dest)
    except Exception:
        raise HTTPException(status_code=400, detail={"code": "recipient_account_error", "message": "Couldn't reach the recipient's payout account."})
    if ((dest_acct.get("capabilities") or {}).get("transfers") != "active"):
        raise HTTPException(status_code=400, detail={"code": "recipient_not_ready", "message": "That user can't receive transfers yet — they need to finish payout setup."})

    # Claim the Idempotency-Key now that the request is valid but before any money
    # moves — a replayed key returns the stored response instead of debiting again.
    ref_id, cached = await _idem_claim("transfer", sender["user_id"], idempotency_key)
    if cached is not None:
        return cached
    try:
        # Sender funds the move from their in-app balance. Atomic conditional debit
        # so two concurrent sends can't both pass and overdraw (mirrors cashout).
        debit = await db.users.update_one(
            {"user_id": sender["user_id"], "wallet_balance": {"$gte": amount - 1e-9}},
            {"$inc": {"wallet_balance": -amount}},
        )
        if getattr(debit, "matched_count", 0) != 1:
            raise HTTPException(status_code=400, detail={"code": "insufficient_balance", "message": "That's more than your wallet balance. Top up first."})

        transfer_id = str(uuid.uuid4())
        try:
            tr = stripe.Transfer.create(
                amount=_to_minor(amount, "usd"),
                currency="usd",
                destination=dest,
                metadata={"kind": "p2p_transfer", "from_user_id": sender["user_id"], "to_user_id": body.to_user_id, "ref": transfer_id},
                idempotency_key=idempotency_key or f"stripe-transfer-{transfer_id}",
            )
        except Exception as e:
            # Refund the sender on any failure so balances can't be lost.
            await db.users.update_one({"user_id": sender["user_id"]}, {"$inc": {"wallet_balance": amount}})
            raise HTTPException(status_code=400, detail={"code": "transfer_failed", "message": f"Transfer failed: {_stripe_error(e)}"})

        now = datetime.now(timezone.utc)
        # Audit trail in a dedicated collection — deliberately NOT `earnings`, so the
        # scheduled payout processor (which sums earnings) can't double-pay funds that
        # already landed in the recipient's Stripe balance.
        try:
            await db.stripe_transfers.insert_one({
                "id": transfer_id, "stripe_transfer_id": tr.get("id"),
                "from_user_id": sender["user_id"], "to_user_id": body.to_user_id,
                "amount": amount, "currency": "usd", "note": (body.note or "")[:280],
                "created_at": now,
            })
        except Exception:
            pass

        # Defensive: never let a read failure after the money moved bubble up and
        # trigger the claim release (which would let a retry re-debit the sender).
        try:
            fresh = await db.users.find_one({"user_id": sender["user_id"]}, {"_id": 0, "wallet_balance": 1})
        except Exception:
            fresh = None
        return await _idem_store(ref_id, {
            "ok": True,
            "amount": amount,
            "transfer_id": tr.get("id"),
            "balance": round(float((fresh or {}).get("wallet_balance", 0) or 0), 2),
        })
    except BaseException:
        # The attempt failed (no money net-moved): drop the claim so a genuine
        # retry with the same key can proceed instead of 409-ing forever.
        await _idem_release(ref_id)
        raise


# ---------------------------------------------------------------------------
# 4. POST /stripe/payout — cash the Stripe balance out to the external account
# ---------------------------------------------------------------------------
class PayoutBody(BaseModel):
    amount: Optional[float] = None   # dollars; omit to pay out the full available balance
    instant: bool = False            # instant payout to an eligible debit card (else standard)


@router.post("/stripe/payout", response_model=StripePayoutOut)
async def stripe_payout(
    body: PayoutBody,
    user: dict = Depends(get_current_user),
    idempotency_key: Optional[str] = Header(None),
):
    """Pay the connected account's available Stripe balance out to the user's bank
    account (standard) or debit card (instant). Operates on the account's own
    balance — the Stripe-native counterpart of the ledger cash-out."""
    _require_stripe()
    if await test_payments_on():
        raise HTTPException(status_code=400, detail={"code": "test_mode", "message": "Payouts aren't available in test mode."})
    acct_id = user.get("stripe_account_id")
    if not acct_id:
        raise HTTPException(status_code=400, detail={"code": "no_account", "message": "Set up your Stripe account first."})
    try:
        acct = stripe.Account.retrieve(acct_id)
    except Exception:
        raise HTTPException(status_code=400, detail={"code": "account_error", "message": "Couldn't reach your payout account."})
    if not acct.get("payouts_enabled"):
        raise HTTPException(status_code=400, detail={"code": "payouts_not_ready", "message": "Finish payout setup before cashing out."})

    ccy = (acct.get("default_currency") or "usd").lower()
    try:
        bal = stripe.Balance.retrieve(stripe_account=acct_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail={"code": "balance_error", "message": _stripe_error(e)})
    available = next((int(r.get("amount") or 0) for r in (bal.get("available") or []) if (r.get("currency") or "").lower() == ccy), 0)

    units = _to_minor(body.amount, ccy) if body.amount is not None else available
    if units <= 0:
        raise HTTPException(status_code=400, detail={"code": "nothing_to_pay_out", "message": "You don't have an available balance to pay out yet."})
    if units > available:
        raise HTTPException(status_code=400, detail={"code": "insufficient_balance", "message": "That's more than your available Stripe balance."})

    # Claim the Idempotency-Key before creating the payout; a replay returns the
    # stored response. The key is also passed to Stripe so the Payout itself is
    # deduped even if our claim is bypassed.
    ref_id, cached = await _idem_claim("payout", user["user_id"], idempotency_key)
    if cached is not None:
        return cached
    try:
        payout_id = str(uuid.uuid4())
        kwargs = {
            "amount": units, "currency": ccy, "stripe_account": acct_id,
            "metadata": {"kind": "stripe_payout", "user_id": user["user_id"], "ref": payout_id},
            "idempotency_key": idempotency_key or f"stripe-payout-{payout_id}",
        }
        if body.instant:
            kwargs["method"] = "instant"
        try:
            payout = stripe.Payout.create(**kwargs)
        except Exception as e:
            raise HTTPException(status_code=400, detail={
                "code": "payout_failed",
                "message": f"Payout failed: {_stripe_error(e)}" + (" Instant payouts need an eligible debit card." if body.instant else ""),
            })

        amount = _from_minor(units, ccy)
        try:
            await db.payouts.insert_one({
                "id": payout_id, "user_id": user["user_id"], "amount": amount, "gross": amount, "fee": 0,
                "currency": ccy, "status": payout.get("status") or "pending",
                "method": "instant_card" if body.instant else "standard",
                "stripe_payout_id": payout.get("id"), "source": "stripe_balance",
                "created_at": datetime.now(timezone.utc),
            })
        except Exception:
            pass
        return await _idem_store(ref_id, {
            "ok": True, "amount": amount, "currency": ccy.upper(),
            "payout_id": payout.get("id"), "status": payout.get("status"),
            "arrival_date": _iso(payout.get("arrival_date")),
        })
    except BaseException:
        await _idem_release(ref_id)
        raise


# ---------------------------------------------------------------------------
# 5. GET /stripe/transactions — the account's balance-transaction history
# ---------------------------------------------------------------------------
@router.get("/stripe/transactions", response_model=StripeTransactionsOut)
async def stripe_transactions(
    limit: int = 25,
    starting_after: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """The connected account's Stripe balance transactions (the Stripe-native
    replacement for the ledger's history). Cursor-paginated via `starting_after`."""
    _require_stripe()
    acct_id = user.get("stripe_account_id")
    if not acct_id:
        return {"connected": False, "transactions": [], "has_more": False}
    limit = max(1, min(100, int(limit or 25)))
    params = {"limit": limit, "stripe_account": acct_id}
    if starting_after:
        params["starting_after"] = starting_after
    try:
        res = stripe.BalanceTransaction.list(**params)
    except Exception as e:
        raise HTTPException(status_code=400, detail={"code": "transactions_error", "message": _stripe_error(e)})
    txns = [{
        "id": t.get("id"),
        "type": t.get("type"),                       # charge | payout | transfer | payment | ...
        "amount": _from_minor(int(t.get("amount") or 0), t.get("currency") or "usd"),
        "net": _from_minor(int(t.get("net") or 0), t.get("currency") or "usd"),
        "fee": _from_minor(int(t.get("fee") or 0), t.get("currency") or "usd"),
        "currency": (t.get("currency") or "usd").lower(),
        "status": t.get("status"),                   # available | pending
        "description": t.get("description"),
        "created": _iso(t.get("created")),
    } for t in (res.get("data") or [])]
    # §6: canonical `data` alongside the legacy `transactions` key.
    return {"connected": True, "transactions": txns, "data": txns, "has_more": bool(res.get("has_more"))}


# ---------------------------------------------------------------------------
# 6. POST /stripe/webhook — Connect event sync (account/payout/transfer)
# ---------------------------------------------------------------------------
async def _user_for_account(acct_id: Optional[str], meta_user_id: Optional[str]) -> Optional[dict]:
    if meta_user_id:
        u = await db.users.find_one({"user_id": meta_user_id}, {"_id": 0, "user_id": 1})
        if u:
            return u
    if acct_id:
        return await db.users.find_one({"stripe_account_id": acct_id}, {"_id": 0, "user_id": 1})
    return None


@router.post("/stripe/webhook", response_model=WebhookAck)
async def stripe_connect_webhook(request: Request):
    """Connect webhook: keep cached onboarding flags and payout records in sync.

    Register this URL in the Stripe dashboard (Developers → Webhooks, *Connect*
    endpoint) and put its signing secret in STRIPE_CONNECT_WEBHOOK_SECRET."""
    if not stripe_enabled():
        raise HTTPException(status_code=503, detail="Stripe is not configured")
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    secret = STRIPE_CONNECT_WEBHOOK_SECRET
    try:
        if secret:
            event = stripe.Webhook.construct_event(payload, sig, secret)
        elif "_test_" in STRIPE_SECRET_KEY:  # dev/test: trust the body (set the secret in prod)
            import json
            event = json.loads(payload)
        else:
            raise HTTPException(status_code=400, detail="Webhook signing secret not configured")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid webhook signature")

    # Dedupe by Stripe event id (at-least-once delivery → process each event once).
    _evt_id = event.get("id")
    if _evt_id:
        try:
            await db.payments_fulfilled.insert_one({"ref_id": f"cevt:{_evt_id}", "created_at": datetime.now(timezone.utc)})
        except DuplicateKeyError:
            return {"received": True}

    etype = event.get("type")
    obj = (event.get("data") or {}).get("object") or {}
    acct_id = event.get("account") or obj.get("account")

    try:
        if etype == "account.updated":
            user = await _user_for_account(obj.get("id"), (obj.get("metadata") or {}).get("user_id"))
            if user:
                await _cache_account_state(user["user_id"], obj)
        elif etype in ("payout.paid", "payout.failed", "payout.canceled"):
            status = {"payout.paid": "paid", "payout.failed": "failed", "payout.canceled": "canceled"}[etype]
            await db.payouts.update_one(
                {"stripe_payout_id": obj.get("id")},
                {"$set": {"status": status, "updated_at": datetime.now(timezone.utc)}},
            )
            if etype == "payout.paid":
                # Tell the user the cash-out landed (in-app + push via emit_notification).
                try:
                    uid = (obj.get("metadata") or {}).get("user_id")
                    if not uid:
                        rec = await db.payouts.find_one({"stripe_payout_id": obj.get("id")}, {"_id": 0, "user_id": 1})
                        uid = (rec or {}).get("user_id")
                    if uid:
                        ccy = (obj.get("currency") or "usd").lower()
                        amt = _from_minor(int(obj.get("amount") or 0), ccy)
                        from routes.notifications import emit_notification
                        await emit_notification(
                            user_id=uid, actor_id=None, ntype="payout",
                            message=f"${amt:.2f} {ccy.upper()} landed in your account",
                        )
                except Exception:
                    pass
        # transfer.created / balance.available need no action — balance & history
        # are read live from Stripe — but we ack them so Stripe stops retrying.
    except Exception:
        # Never 500 a webhook for a bookkeeping miss; Stripe would retry forever.
        pass

    return {"received": True}
