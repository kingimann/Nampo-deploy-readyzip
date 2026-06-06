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
    API_OVERAGE_PACKS, API_OVERAGE_BY_ID, USAGE_PERIOD_DAYS,
)

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
WEB_APP_URL = (os.environ.get("WEB_APP_URL", "https://nampo-web.onrender.com") or "").rstrip("/")

if stripe and STRIPE_SECRET_KEY:
    stripe.api_key = STRIPE_SECRET_KEY


def stripe_enabled() -> bool:
    return bool(stripe and STRIPE_SECRET_KEY)


async def test_payments_on() -> bool:
    """Admin override: force simulated/test payments even when Stripe is configured."""
    doc = await db.app_settings.find_one({"key": "test_payments"}, {"_id": 0, "value": 1})
    return bool(doc and doc.get("value"))


async def payments_live() -> bool:
    """Real Stripe payments are in effect: Stripe is configured AND an admin
    hasn't forced test mode."""
    return stripe_enabled() and not await test_payments_on()


def _require_stripe():
    if not stripe_enabled():
        raise HTTPException(status_code=503, detail="Stripe is not configured on this server")


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
        "platform_fee_percent": PLATFORM_FEE_PERCENT,
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
        acct_id = user.get("stripe_account_id")
        if not acct_id:
            acct = stripe.Account.create(
                type="express",
                email=user.get("email"),
                metadata={"user_id": user["user_id"]},
                # Request card_payments too: a standard Express account that doesn't
                # need the special "transfers without card_payments" approval.
                capabilities={"transfers": {"requested": True}, "card_payments": {"requested": True}},
            )
            acct_id = acct["id"]
            await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"stripe_account_id": acct_id}})
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
    # Whether a payout method (bank/debit card) is on file at all.
    has_external = bool((acct.get("external_accounts", {}) or {}).get("total_count", 0))
    return {
        "enabled": True,
        "connected": True,
        "payouts_enabled": bool(acct.get("payouts_enabled")),
        "charges_enabled": bool(acct.get("charges_enabled")),
        "details_submitted": bool(acct.get("details_submitted")),
        "has_external_account": has_external,
        # What Stripe still needs (so the UI can explain why setup won't finish).
        "requirements_due": due,
        "requirements_eventually": eventually,
        "requirements_pending": pending,
        "disabled_reason": reqs.get("disabled_reason"),
    }


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
                "application_fee_percent": PLATFORM_FEE_PERCENT,
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
    fee_cents = int(round(gross_cents * PLATFORM_FEE_PERCENT / 100.0))
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
    try:
        if STRIPE_WEBHOOK_SECRET:
            event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
        else:  # dev: trust the body (configure the secret in production)
            import json
            event = json.loads(payload)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid webhook signature")

    # An abandoned/expired Checkout — mark a pending wallet top-up as failed.
    if event.get("type") == "checkout.session.expired":
        obj = event.get("data", {}).get("object", {}) or {}
        if (obj.get("metadata") or {}).get("kind") == "wallet_topup" and obj.get("id"):
            from routes.money import _mark_topup_failed
            await _mark_topup_failed(obj["id"])
        return {"ok": True}

    if event.get("type") == "checkout.session.completed":
        meta = (event.get("data", {}).get("object", {}) or {}).get("metadata", {}) or {}
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
                               f"{'subscription' if kind == 'subscription' else 'tip'} on Nami. It's in your balance.")
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


# ── Embedded Connect onboarding (renders payout setup inside the site) ────────
@router.post("/payments/payouts/account-session")
async def payout_account_session(authorization: Optional[str] = Header(None)):
    """Create an Account Session for Stripe's embedded onboarding component."""
    _require_stripe()
    user = await get_current_user(authorization)
    try:
        acct_id = user.get("stripe_account_id")
        if not acct_id:
            acct = stripe.Account.create(
                type="express", email=user.get("email"),
                metadata={"user_id": user["user_id"]},
                capabilities={"transfers": {"requested": True}, "card_payments": {"requested": True}},
            )
            acct_id = acct["id"]
            await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"stripe_account_id": acct_id}})
        sess = stripe.AccountSession.create(
            account=acct_id,
            components={"account_onboarding": {"enabled": True}},
        )
        return {"client_secret": sess["client_secret"], "publishable_key": STRIPE_PUBLISHABLE_KEY}
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


@router.post("/admin/test-payments")
async def admin_set_test_payments(body: TestPaymentsBody, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    _admin_only(me)
    val = bool(body.enabled)
    existing = await db.app_settings.find_one({"key": "test_payments"}, {"_id": 0, "key": 1})
    if existing:
        await db.app_settings.update_one({"key": "test_payments"}, {"$set": {"value": val}})
    else:
        await db.app_settings.insert_one({"key": "test_payments", "value": val})
    return {"test_payments": val}


@router.post("/admin/reset/money")
async def admin_reset_money(authorization: Optional[str] = Header(None)):
    """Wipe wallet/money data (earnings, tips, subs, payouts, transfers, requests)
    and zero ad balances. For clearing test/fake money."""
    me = await get_current_user(authorization)
    _admin_only(me)
    for coll in ("earnings", "tips", "subscriptions", "payouts", "money_transfers",
                 "money_requests", "wallet_topups", "ad_topups"):
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
