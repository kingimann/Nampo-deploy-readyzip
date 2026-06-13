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
from db import DuplicateKeyError

try:
    import stripe  # type: ignore
except Exception:
    stripe = None  # type: ignore

router = APIRouter()

# Serialize payout batches so the hourly loop, the admin "run", and the cron
# trigger can't run concurrently and double-pay (single-process deployment).
_payout_lock = asyncio.Lock()


def _payout_period_key(uid: str, freq: str, now: datetime) -> str:
    """A stable per-cadence-period key so a creator is paid at most once per
    period, even across overlapping/retried runs."""
    if freq == "monthly":
        bucket = now.strftime("%Y-%m")
    elif freq == "biweekly":
        iso = now.isocalendar()
        # Pair up ISO weeks 1&2, 3&4, … so each biweekly period maps to one
        # bucket. `iso[1] // 2` would split weeks 1 and 2 (1//2=0, 2//2=1),
        # leaving a 1-week period at the start of every year.
        bucket = f"{iso[0]}-bw{(iso[1] - 1) // 2}"
    else:
        iso = now.isocalendar()
        bucket = f"{iso[0]}-w{iso[1]}"
    return f"{uid}:{freq}:{bucket}"

MIN_PAYOUT = float(os.environ.get("MIN_PAYOUT", "25") or 25)   # Google-style floor — no dust payouts
CRON_SECRET = os.environ.get("CRON_SECRET", "")
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")


def _interval_days(freq: str) -> int:
    return {"weekly": 7, "biweekly": 14, "monthly": 30}.get(freq, 7)


# Earning sources whose money is also credited to the spendable in-app wallet.
# That money is withdrawn via instant cash-out (which draws down wallet_balance),
# NOT the scheduled bank-payout rail. Counting it here too would pay the same
# dollar twice — once to the wallet (spend / instant cash-out) and again to the
# connected bank account — so it's excluded from the scheduled balance.
WALLET_BACKED_SOURCES = {"transfer", "wallet", "roadside", "admin"}


def _is_instant_cashout(row: dict) -> bool:
    """An instant wallet cash-out (debits wallet_balance) rather than a scheduled
    earnings payout. These must not offset the earnings rail."""
    return row.get("method") == "instant_card" or row.get("status") == "instant"


async def _sums(collection, field="amount", *, extra=None, keep=None) -> dict:
    out: dict = {}
    proj = {"_id": 0, "user_id": 1, field: 1}
    for f in (extra or ()):
        proj[f] = 1
    rows = await getattr(db, collection).find({}, proj).to_list(50000)
    for r in rows:
        if keep is not None and not keep(r):
            continue
        out[r.get("user_id")] = out.get(r.get("user_id"), 0) + float(r.get(field, 0) or 0)
    return out


async def process_payouts(only_due: bool = True) -> dict:
    """Create payouts for creators whose balance is due. Idempotent per cadence
    and serialized so overlapping triggers can't double-pay."""
    async with _payout_lock:
        return await _process_payouts_impl(only_due)


async def _process_payouts_impl(only_due: bool = True) -> dict:
    now = datetime.now(timezone.utc)
    # Scheduled-rail basis only: external (non-wallet) earnings minus scheduled
    # payouts. Wallet-backed earnings and instant cash-outs belong to the wallet
    # rail and are settled there, so they must not appear here.
    earned = await _sums("earnings", extra=("source",),
                         keep=lambda r: r.get("source") not in WALLET_BACKED_SOURCES)
    paid = await _sums("payouts", extra=("method", "status"),
                       keep=lambda r: not _is_instant_cashout(r))
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
            last = await db.payouts.find_one(
                {"user_id": uid, "method": {"$ne": "instant_card"}},
                {"_id": 0}, sort=[("created_at", -1)])
            if last and last.get("created_at"):
                try:
                    if (now - _norm_dt(last["created_at"])).days < _interval_days(user.get("payout_frequency", "weekly")):
                        continue
                except Exception:
                    pass
        # Single-winner guard: claim this cadence period BEFORE moving money so
        # overlapping/retried runs can't pay twice. The same key is the Stripe
        # idempotency key, so an SDK/network retry is deduped server-side too.
        freq = user.get("payout_frequency", "weekly")
        key = _payout_period_key(uid, freq, now)
        ref = f"payout:{key}"
        try:
            await db.payments_fulfilled.insert_one(
                {"ref_id": ref, "user_id": uid, "amount": balance, "created_at": now})
        except DuplicateKeyError:
            continue  # already paid (or being paid) this period
        # Try a real Stripe transfer; fall back to a simulated payout.
        status, transfer_id = "simulated", None
        acct = user.get("stripe_account_id")
        if stripe and STRIPE_SECRET_KEY and acct:
            try:
                stripe.api_key = STRIPE_SECRET_KEY
                tr = stripe.Transfer.create(
                    amount=int(round(balance * 100)), currency="usd", destination=acct,
                    idempotency_key=f"payout-{key}")
                status, transfer_id = "paid", tr["id"]
            except Exception:
                status = "failed"
        if status == "failed":
            # Keep the period guard so we never double-pay on a network timeout
            # (where the transfer may actually have succeeded). The balance carries
            # forward and is paid on the next period's run.
            continue
        await db.payouts.insert_one({
            "id": str(uuid.uuid4()), "user_id": uid, "amount": balance,
            "status": status, "stripe_transfer_id": transfer_id, "period_key": key,
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
                    f"Thanks for creating on OkaySpace.",
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
    # Scheduled-rail balance: external (non-wallet) earnings minus scheduled
    # payouts only. Wallet-backed earnings and instant cash-outs settle on the
    # wallet rail, so excluding them here keeps the same dollar from being shown
    # (and paid) as owed twice. (See process_payouts.)
    earned = sum(
        float(e.get("amount", 0) or 0)
        for e in await db.earnings.find({"user_id": uid}, {"_id": 0, "amount": 1, "source": 1}).to_list(20000)
        if e.get("source") not in WALLET_BACKED_SOURCES
    )
    paid_rows = await db.payouts.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(100)
    # Balance reconciles against scheduled payouts; total_paid_out / history still
    # show every withdrawal (instant cash-outs included) for the user's records.
    paid = sum(float(p.get("amount", 0) or 0) for p in paid_rows if not _is_instant_cashout(p))
    total_withdrawn = sum(float(p.get("amount", 0) or 0) for p in paid_rows)
    freq = user.get("payout_frequency", "weekly")
    last = next((p["created_at"] for p in paid_rows if not _is_instant_cashout(p)), None)
    next_due = None
    try:
        base = _norm_dt(last) if last else None
        if base:
            next_due = (base + timedelta(days=_interval_days(freq))).isoformat()
    except Exception:
        pass
    # Payout frequency and the minimum payout balance can each only be changed
    # once a month — surface when each unlocks so the UI can disable the control.
    def _locked_until(changed):
        try:
            if changed:
                nxt = _norm_dt(changed) + timedelta(days=30)
                if datetime.now(timezone.utc) < nxt:
                    return nxt.isoformat()
        except Exception:
            pass
        return None
    freq_locked_until = _locked_until(user.get("payout_frequency_changed_at"))
    threshold_locked_until = _locked_until(user.get("payout_threshold_changed_at"))
    return {
        "balance": round(earned - paid, 2),
        "total_paid_out": round(total_withdrawn, 2),
        "frequency": freq,
        "frequency_locked_until": freq_locked_until,
        "threshold_locked_until": threshold_locked_until,
        "threshold": round(float(user.get("payout_threshold", 0) or 0), 2),
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
                # Emulated bi-weekly Stripe-balance payouts ("Get paid automatically").
                from routes.payments import process_biweekly_payouts
                await process_biweekly_payouts()
            except Exception:
                pass
    try:
        asyncio.create_task(_loop())
    except Exception:
        pass
