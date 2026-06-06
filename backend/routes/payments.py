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
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
# Platform cut of each transaction, in percent (0 = creator gets everything).
PLATFORM_FEE_PERCENT = float(os.environ.get("PLATFORM_FEE_PERCENT", "0") or 0)
# Where Stripe sends users back after hosted onboarding / checkout.
WEB_APP_URL = (os.environ.get("WEB_APP_URL", "https://nampo-web.onrender.com") or "").rstrip("/")

if stripe and STRIPE_SECRET_KEY:
    stripe.api_key = STRIPE_SECRET_KEY


def stripe_enabled() -> bool:
    return bool(stripe and STRIPE_SECRET_KEY)


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


@router.get("/payments/config")
async def payments_config():
    """Tell the client whether real payments are available."""
    return {"enabled": stripe_enabled(), "platform_fee_percent": PLATFORM_FEE_PERCENT}


@router.post("/payments/payouts/setup")
async def setup_payouts(authorization: Optional[str] = Header(None)):
    """Create (or reuse) the user's Stripe Connect account and return a hosted
    onboarding link where they choose how they want to get paid."""
    _require_stripe()
    user = await get_current_user(authorization)
    acct_id = user.get("stripe_account_id")
    if not acct_id:
        acct = stripe.Account.create(
            type="express",
            email=user.get("email"),
            metadata={"user_id": user["user_id"]},
            capabilities={"transfers": {"requested": True}},
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
    return {
        "enabled": True,
        "connected": True,
        "payouts_enabled": bool(acct.get("payouts_enabled")),
        "charges_enabled": bool(acct.get("charges_enabled")),
        "details_submitted": bool(acct.get("details_submitted")),
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
            success_url=f"{WEB_APP_URL}/advertise?pay=success",
            cancel_url=f"{WEB_APP_URL}/advertise?pay=cancel",
            metadata={
                "kind": "promote", "post_id": body.post_id, "days": str(days), "buyer_id": me["user_id"],
                **({"budget": str(round(float(body.budget), 2))} if body.budget else {}),
                **({"cpc": str(round(float(body.cpc), 2))} if body.cpc else {}),
            },
        )
        return {"url": session["url"], "id": session["id"]}

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
            success_url=f"{WEB_APP_URL}/wallet?pay=success",
            cancel_url=f"{WEB_APP_URL}/wallet?pay=cancel",
            metadata=meta,
        )
        return {"url": session["url"], "id": session["id"]}

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
        success_url=f"{WEB_APP_URL}/wallet?pay=success",
        cancel_url=f"{WEB_APP_URL}/wallet?pay=cancel",
        metadata=meta,
    )
    return {"url": session["url"], "id": session["id"]}


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
