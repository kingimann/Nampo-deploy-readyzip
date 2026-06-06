"""Automated creator payouts.

A creator's available balance = all earnings (tips, subscriptions, ad/view
revenue) minus everything already paid out. On the creator's cadence
(bi-weekly / monthly) a scheduled job batches the balance into a payout — a real
Stripe transfer to their connected account when Stripe is configured, otherwise
a simulated payout (test mode). Payout history is exposed per user.
"""
import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Header, HTTPException

from core import db, get_current_user, is_admin, _norm_dt

try:
    import stripe  # type: ignore
except Exception:
    stripe = None  # type: ignore

router = APIRouter()

MIN_PAYOUT = float(os.environ.get("MIN_PAYOUT", "25") or 25)   # Google-style floor — no dust payouts
CRON_SECRET = os.environ.get("CRON_SECRET", "")
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")


def _interval_days(freq: str) -> int:
    return {"weekly": 7, "biweekly": 14, "monthly": 30}.get(freq, 7)


async def _sums(collection, field="amount") -> dict:
    out: dict = {}
    rows = await getattr(db, collection).find({}, {"_id": 0, "user_id": 1, field: 1}).to_list(50000)
    for r in rows:
        out[r.get("user_id")] = out.get(r.get("user_id"), 0) + float(r.get(field, 0) or 0)
    return out


async def process_payouts(only_due: bool = True) -> dict:
    """Create payouts for creators whose balance is due. Idempotent per cadence."""
    now = datetime.now(timezone.utc)
    earned = await _sums("earnings")
    paid = await _sums("payouts")
    created, total = 0, 0.0
    for uid, total_earned in earned.items():
        if not uid:
            continue
        balance = round(total_earned - paid.get(uid, 0), 2)
        user = await db.users.find_one({"user_id": uid}, {"_id": 0})
        if not user:
            continue
        # Per-creator threshold: hold earnings until the balance reaches it.
        threshold = max(MIN_PAYOUT, float(user.get("payout_threshold", 0) or 0))
        if balance < threshold:
            continue
        if only_due:
            last = await db.payouts.find_one({"user_id": uid}, {"_id": 0}, sort=[("created_at", -1)])
            if last and last.get("created_at"):
                try:
                    if (now - _norm_dt(last["created_at"])).days < _interval_days(user.get("payout_frequency", "weekly")):
                        continue
                except Exception:
                    pass
        # Try a real Stripe transfer; fall back to a simulated payout.
        status, transfer_id = "simulated", None
        acct = user.get("stripe_account_id")
        if stripe and STRIPE_SECRET_KEY and acct:
            try:
                stripe.api_key = STRIPE_SECRET_KEY
                tr = stripe.Transfer.create(amount=int(round(balance * 100)), currency="usd", destination=acct)
                status, transfer_id = "paid", tr["id"]
            except Exception:
                status = "failed"
        if status == "failed":
            continue
        await db.payouts.insert_one({
            "id": str(uuid.uuid4()), "user_id": uid, "amount": balance,
            "status": status, "stripe_transfer_id": transfer_id,
            "frequency": user.get("payout_frequency", "weekly"), "created_at": now,
        })
        # Receipt: in-app notification (always) + best-effort email.
        try:
            from routes.notifications import emit_notification
            await emit_notification(user_id=uid, actor_id=None, ntype="payout",
                                    message=f"Payout sent: ${balance:.2f}")
        except Exception:
            pass
        try:
            from services.email import send_email
            if user.get("email"):
                where = "your connected account" if status == "paid" else "your balance (test mode)"
                send_email(
                    user["email"], f"You've been paid ${balance:.2f}",
                    f"Hi {user.get('name', 'there')},\n\n"
                    f"A payout of ${balance:.2f} was sent to {where}.\n"
                    f"Schedule: {user.get('payout_frequency', 'weekly')}.\n\n"
                    f"Thanks for creating on Nami.",
                )
        except Exception:
            pass
        created += 1
        total += balance
    return {"payouts_created": created, "total_paid": round(total, 2)}


@router.get("/payouts")
async def my_payouts(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    uid = user["user_id"]
    earned = sum(
        float(e.get("amount", 0) or 0)
        for e in await db.earnings.find({"user_id": uid}, {"_id": 0, "amount": 1}).to_list(20000)
    )
    paid_rows = await db.payouts.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(100)
    paid = sum(float(p.get("amount", 0) or 0) for p in paid_rows)
    freq = user.get("payout_frequency", "weekly")
    last = paid_rows[0]["created_at"] if paid_rows else None
    next_due = None
    try:
        base = _norm_dt(last) if last else None
        if base:
            next_due = (base + timedelta(days=_interval_days(freq))).isoformat()
    except Exception:
        pass
    # Payout frequency can only be changed once a month.
    freq_changed = user.get("payout_frequency_changed_at")
    freq_locked_until = None
    try:
        if freq_changed:
            nxt = _norm_dt(freq_changed) + timedelta(days=30)
            if datetime.now(timezone.utc) < nxt:
                freq_locked_until = nxt.isoformat()
    except Exception:
        pass
    return {
        "balance": round(earned - paid, 2),
        "total_paid_out": round(paid, 2),
        "frequency": freq,
        "frequency_locked_until": freq_locked_until,
        "next_payout": next_due,
        "history": [
            {"id": p["id"], "amount": round(float(p.get("amount", 0) or 0), 2),
             "status": p.get("status", "simulated"), "created_at": p.get("created_at")}
            for p in paid_rows
        ],
    }


@router.post("/payouts/run")
async def run_payouts(authorization: Optional[str] = Header(None), x_cron_key: Optional[str] = Header(None)):
    """Trigger the payout batch. Allowed for admins, or via the cron secret
    header (so a Render Cron Job / external scheduler can call it)."""
    if CRON_SECRET and x_cron_key == CRON_SECRET:
        return await process_payouts(only_due=True)
    user = await get_current_user(authorization)
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Admins only")
    return await process_payouts(only_due=True)


def start_scheduler():
    """Background loop — wakes hourly and runs due payouts (best-effort)."""
    async def _loop():
        while True:
            await asyncio.sleep(3600)
            try:
                await process_payouts(only_due=True)
            except Exception:
                pass
    try:
        asyncio.create_task(_loop())
    except Exception:
        pass
