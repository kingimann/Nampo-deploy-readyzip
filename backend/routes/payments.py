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

from core import db, get_current_user

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
    kind: str            # "tip" | "subscription"
    creator_id: str
    amount: float = 0    # dollars (net the creator should receive); tips only


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
    """Create a Stripe Checkout session that pays the creator's connected
    account (destination charge). Returns a hosted checkout URL."""
    _require_stripe()
    me = await get_current_user(authorization)
    if body.creator_id == me["user_id"]:
        raise HTTPException(status_code=400, detail="You can't pay yourself")
    creator = await db.users.find_one({"user_id": body.creator_id}, {"_id": 0})
    if not creator:
        raise HTTPException(status_code=404, detail="Creator not found")
    dest = creator.get("stripe_account_id")
    if not dest:
        raise HTTPException(status_code=400, detail="This creator hasn't set up payouts yet")

    if body.kind == "subscription":
        net = round(float(creator.get("sub_price", 4.99) or 0), 2)
        label = f"Subscription to {creator.get('name', 'creator')}"
    else:
        net = round(float(body.amount or 0), 2)
        label = f"Tip to {creator.get('name', 'creator')}"
    if net <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than 0")

    gross_cents = int(round(net * 100))
    fee_cents = int(round(gross_cents * PLATFORM_FEE_PERCENT / 100.0))

    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[{
            "price_data": {
                "currency": "usd",
                "product_data": {"name": label},
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
        metadata={
            "kind": body.kind, "creator_id": body.creator_id,
            "buyer_id": me["user_id"], "buyer_name": me.get("name", "Someone"),
            "net": str(net),
        },
    )
    return {"url": session["url"], "id": session["id"]}


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
        if creator_id and net > 0:
            await db.earnings.insert_one({
                "id": str(uuid.uuid4()), "user_id": creator_id, "amount": net,
                "kind": "subscription" if kind == "subscription" else "tip",
                "from_user_id": buyer_id or "", "from_name": meta.get("buyer_name", "Someone"),
                "source": "stripe", "created_at": now,
            })
            if kind == "subscription" and buyer_id:
                await db.subscriptions.insert_one({
                    "id": str(uuid.uuid4()), "subscriber_id": buyer_id, "creator_id": creator_id,
                    "amount": net, "status": "active", "source": "stripe",
                    "started_at": now, "renews_at": now + timedelta(days=30), "created_at": now,
                })
    return {"ok": True}
