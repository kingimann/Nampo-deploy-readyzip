"""Peer-to-peer money: send money (gated by the sender's security question)
and request money (the other person pays or declines).

Transfers are recorded the same way tips are (db.tips + db.earnings) so they
appear in the Wallet's Sent/Received lists automatically.
"""
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Optional

import bcrypt
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from core import db, get_current_user, _public_user, CURRENCIES, normalize_currency, _norm_dt, is_admin

# How long the sender can reverse a money transfer before the recipient can claim it.
REVERSAL_WINDOW_MIN = 5
from routes.notifications import emit_notification

router = APIRouter()


# ── Wallet balance (spendable, topped-up funds) ──────────────────────────────
async def _wallet_balance(uid: str) -> float:
    u = await db.users.find_one({"user_id": uid}, {"_id": 0, "wallet_balance": 1})
    return round(float((u or {}).get("wallet_balance", 0) or 0), 2)


async def _credit_wallet(uid: str, amount: float):
    await db.users.update_one({"user_id": uid}, {"$inc": {"wallet_balance": round(float(amount), 2)}})


async def _apply_wallet_topup(uid: str, amount: float, source: str, session_id: Optional[str] = None) -> bool:
    """Credit a wallet top-up exactly once and mark it completed. Idempotent via
    the Stripe session id, so the webhook, the on-return confirm and the sync
    can't double-credit. If a 'processing' record already exists for the session
    it's flipped to 'completed'; otherwise a completed record is created."""
    amount = round(float(amount), 2)
    if amount <= 0:
        return False
    now = datetime.now(timezone.utc)
    if session_id:
        existing = await db.wallet_topups.find_one({"session_id": session_id}, {"_id": 0, "id": 1, "status": 1})
        if existing:
            if existing.get("status") == "completed":
                return False   # already credited
            await _credit_wallet(uid, amount)
            await db.wallet_topups.update_one(
                {"session_id": session_id},
                {"$set": {"status": "completed", "completed_at": now, "amount": amount, "source": source}},
            )
            return True
    await _credit_wallet(uid, amount)
    await db.wallet_topups.insert_one({
        "id": str(uuid.uuid4()), "user_id": uid, "amount": amount,
        "source": source, "session_id": session_id, "status": "completed",
        "created_at": now, "completed_at": now,
    })
    return True


async def _mark_topup_failed(session_id: str):
    if not session_id:
        return
    await db.wallet_topups.update_one(
        {"session_id": session_id, "status": "processing"},
        {"$set": {"status": "failed", "completed_at": datetime.now(timezone.utc)}},
    )


async def _debit_wallet(uid: str, amount: float) -> bool:
    """Debit the user's wallet if they have enough. Returns False if not."""
    amount = round(float(amount), 2)
    bal = await _wallet_balance(uid)
    if bal + 1e-9 < amount:
        return False
    await db.users.update_one({"user_id": uid}, {"$inc": {"wallet_balance": -amount}})
    return True


def _insufficient():
    return HTTPException(status_code=400, detail={
        "code": "insufficient_balance",
        "message": "Not enough wallet balance. Top up your wallet first.",
    })


async def _fee_dollars() -> float:
    """The flat per-payment transaction fee, in dollars (admin-controlled)."""
    from routes.payments import transaction_fee_cents
    return round((await transaction_fee_cents()) / 100.0, 2)


async def _record_platform_fee(fee: float, source: str, from_user_id: str, ref_id: str):
    """Book the flat transaction fee as platform revenue (only once a payment
    actually settles — reversed/declined transfers refund the fee instead)."""
    fee = round(float(fee or 0), 2)
    if fee <= 0:
        return
    await db.platform_revenue.insert_one({
        "id": str(uuid.uuid4()), "amount": fee, "source": source,
        "from_user_id": from_user_id, "ref_id": ref_id,
        "created_at": datetime.now(timezone.utc),
    })


def _hash(s: str) -> str:
    return bcrypt.hashpw(s.encode("utf-8")[:72], bcrypt.gensalt(rounds=12)).decode("utf-8")


def _verify(s: str, h: str) -> bool:
    try:
        return bcrypt.checkpw(s.encode("utf-8")[:72], h.encode("utf-8"))
    except Exception:
        return False


def _norm(answer: Optional[str]) -> str:
    return (answer or "").strip().lower()


async def _require_answer(user_doc: dict, answer: Optional[str]):
    """Enforce the sender's security question before money leaves their account."""
    h = user_doc.get("transfer_answer_hash")
    if not h:
        raise HTTPException(status_code=400, detail={
            "code": "security_not_set",
            "message": "Set up your transfer security question first",
        })
    if not _verify(_norm(answer), h):
        raise HTTPException(status_code=403, detail={
            "code": "wrong_answer",
            "message": "Incorrect security answer",
        })


async def _do_transfer(sender: dict, to_id: str, amount: float, note: str):
    """Credit the recipient: add to their spendable wallet and mirror a tip so
    the Wallet's Received list shows it. The sender is debited by the caller."""
    now = datetime.now(timezone.utc)
    name = sender.get("name", "Someone")
    await _credit_wallet(to_id, amount)
    await db.tips.insert_one({
        "id": str(uuid.uuid4()),
        "from_user_id": sender["user_id"], "from_name": name,
        "to_user_id": to_id, "amount": amount, "currency": "USD",
        "message": (note or "")[:200], "source": "transfer", "created_at": now,
    })
    await db.earnings.insert_one({
        "id": str(uuid.uuid4()), "user_id": to_id, "amount": amount, "kind": "tip",
        "from_user_id": sender["user_id"], "from_name": name,
        "message": (note or "")[:200], "source": "transfer", "created_at": now,
    })
    # Nudge the recipient to connect Stripe so they can cash this balance out.
    await _maybe_payout_nudge(to_id)
    return now


async def _maybe_payout_nudge(user_id: str):
    """If the user has money to cash out but hasn't started Stripe payout setup,
    remind them (at most once a week) to connect Stripe."""
    from routes.payments import stripe_enabled
    if not stripe_enabled():
        return
    u = await db.users.find_one({"user_id": user_id}, {"_id": 0, "stripe_account_id": 1, "payout_nudge_at": 1})
    if not u or u.get("stripe_account_id"):
        return   # already connected / started payout setup
    last = u.get("payout_nudge_at")
    now = datetime.now(timezone.utc)
    try:
        if last and (now - _norm_dt(last)).days < 7:
            return
    except Exception:
        pass
    await db.users.update_one({"user_id": user_id}, {"$set": {"payout_nudge_at": now}})
    await _notify_money(user_id, user_id, "payout_setup",
                        "Set up Stripe payouts to cash out your wallet balance")


async def _notify_money(to_id: str, actor_id: str, ntype: str, message: str):
    try:
        await emit_notification(user_id=to_id, actor_id=actor_id, ntype=ntype, message=message)
    except Exception:
        pass


# ── Security question (sender's secret) ──────────────────────────────────────
class SecuritySet(BaseModel):
    question: str
    answer: str
    current_answer: Optional[str] = None   # required when changing an existing one


@router.get("/money/security")
async def get_security(authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    return {"is_set": bool(me.get("transfer_answer_hash")), "question": me.get("transfer_question")}


@router.post("/money/security")
async def set_security(body: SecuritySet, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    question = (body.question or "").strip()[:200]
    answer = (body.answer or "").strip()
    if not question or not answer:
        raise HTTPException(status_code=400, detail="Question and answer are required")
    if me.get("transfer_answer_hash") and not _verify(_norm(body.current_answer), me["transfer_answer_hash"]):
        raise HTTPException(status_code=403, detail="Current security answer is incorrect")
    await db.users.update_one({"user_id": me["user_id"]}, {"$set": {
        "transfer_question": question,
        "transfer_answer_hash": _hash(_norm(answer)),
    }})
    return {"ok": True, "question": question}


# ── Send money ───────────────────────────────────────────────────────────────
class SendMoney(BaseModel):
    to_user_id: str
    amount: float
    note: Optional[str] = ""
    answer: str


@router.post("/money/send")
async def send_money(body: SendMoney, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    if body.to_user_id == me["user_id"]:
        raise HTTPException(status_code=400, detail="You can't send money to yourself")
    to = await db.users.find_one({"user_id": body.to_user_id}, {"_id": 0, "user_id": 1, "name": 1})
    if not to:
        raise HTTPException(status_code=404, detail="Recipient not found")
    amount = round(float(body.amount or 0), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than 0")
    await _require_answer(me, body.answer)
    # The payer covers a flat transaction fee; the recipient gets the full amount.
    # Admins (the platform owner) are exempt — no fee on their own sends.
    fee = 0.0 if is_admin(me) else await _fee_dollars()
    # Hold the funds: debit the sender (amount + fee) now (escrow). The amount is
    # credited to the recipient on accept; the full amount+fee is refunded on decline.
    if not await _debit_wallet(me["user_id"], round(amount + fee, 2)):
        raise _insufficient()
    # Money isn't credited until the recipient accepts it (Cash App-style), and
    # for the first few minutes the sender can still reverse it (in case of a
    # mistake) — the recipient can't claim it until claimable_at.
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "from_user_id": me["user_id"], "from_name": me.get("name", "Someone"),
        "to_user_id": body.to_user_id, "amount": amount, "fee": fee, "note": (body.note or "")[:200],
        "status": "pending", "created_at": now,
        "claimable_at": now + timedelta(minutes=REVERSAL_WINDOW_MIN),
    }
    await db.money_transfers.insert_one(doc.copy())
    await _notify_money(body.to_user_id, me["user_id"], "money_received",
                        f"sent you ${amount:.2f} — accept it")
    return {"ok": True, "amount": amount, "fee": fee, "status": "pending",
            "claimable_at": doc["claimable_at"], "reversal_window_min": REVERSAL_WINDOW_MIN}


async def _hydrate_transfer(t: dict, viewer_id: str) -> dict:
    other_id = t["to_user_id"] if t["from_user_id"] == viewer_id else t["from_user_id"]
    other = await _public_user(other_id, viewer_id)
    return {
        "id": t["id"], "from_user_id": t["from_user_id"], "to_user_id": t["to_user_id"],
        "amount": round(float(t.get("amount", 0) or 0), 2), "note": t.get("note") or "",
        "status": t.get("status", "pending"),
        "direction": "outgoing" if t["from_user_id"] == viewer_id else "incoming",
        "other_user": {
            "user_id": other.user_id, "name": other.name,
            "username": other.username, "picture": other.picture, "verified": other.verified,
        },
        "created_at": t.get("created_at"),
        "claimable_at": t.get("claimable_at"),
        "resolved_at": t.get("resolved_at"),
    }


@router.get("/money/transfers/history")
async def transfers_history(authorization: Optional[str] = Header(None)):
    """All money transfers involving me (both directions, every status)."""
    me = await get_current_user(authorization)
    uid = me["user_id"]
    rows = await db.money_transfers.find(
        {"$or": [{"from_user_id": uid}, {"to_user_id": uid}]}, {"_id": 0}
    ).sort("created_at", -1).limit(100).to_list(100)
    return {"transfers": [await _hydrate_transfer(t, uid) for t in rows]}


@router.get("/money/transfers")
async def list_transfers(authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    uid = me["user_id"]
    incoming = await db.money_transfers.find(
        {"to_user_id": uid, "status": "pending"}, {"_id": 0}
    ).sort("created_at", -1).limit(50).to_list(50)
    outgoing = await db.money_transfers.find(
        {"from_user_id": uid}, {"_id": 0}
    ).sort("created_at", -1).limit(50).to_list(50)
    return {
        "incoming": [await _hydrate_transfer(t, uid) for t in incoming],
        "outgoing": [await _hydrate_transfer(t, uid) for t in outgoing],
    }


@router.post("/money/transfers/{tid}/accept")
async def accept_transfer(tid: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    t = await db.money_transfers.find_one(
        {"id": tid, "to_user_id": me["user_id"], "status": "pending"}, {"_id": 0}
    )
    if not t:
        raise HTTPException(status_code=404, detail="Transfer not found")
    # Honour the sender's reversal window — can't be claimed until claimable_at.
    claimable = t.get("claimable_at")
    if claimable:
        try:
            mins = (_norm_dt(claimable) - datetime.now(timezone.utc)).total_seconds() / 60.0
            if mins > 0:
                raise HTTPException(status_code=409, detail={
                    "code": "not_yet_claimable",
                    "message": f"Available to accept in about {max(1, round(mins))} min — the sender can still reverse it until then.",
                })
        except HTTPException:
            raise
        except Exception:
            pass
    amount = round(float(t.get("amount", 0) or 0), 2)
    sender = await db.users.find_one({"user_id": t["from_user_id"]}, {"_id": 0, "user_id": 1, "name": 1}) \
        or {"user_id": t["from_user_id"], "name": t.get("from_name", "Someone")}
    await _do_transfer(sender, me["user_id"], amount, t.get("note") or "")
    await _record_platform_fee(t.get("fee", 0), "transfer_fee", t["from_user_id"], tid)
    await db.money_transfers.update_one(
        {"id": tid}, {"$set": {"status": "accepted", "resolved_at": datetime.now(timezone.utc)}}
    )
    await _notify_money(t["from_user_id"], me["user_id"], "money_accepted",
                        f"accepted your ${amount:.2f}")
    return {"ok": True, "amount": amount}


@router.post("/money/transfers/{tid}/decline")
async def decline_transfer(tid: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    t = await db.money_transfers.find_one(
        {"id": tid, "to_user_id": me["user_id"], "status": "pending"}, {"_id": 0}
    )
    if not t:
        raise HTTPException(status_code=404, detail="Transfer not found")
    # Refund the escrowed funds (amount + fee) back to the sender.
    await _credit_wallet(t["from_user_id"], round(float(t.get("amount", 0) or 0) + float(t.get("fee", 0) or 0), 2))
    await db.money_transfers.update_one(
        {"id": tid}, {"$set": {"status": "declined", "resolved_at": datetime.now(timezone.utc)}}
    )
    await _notify_money(t["from_user_id"], me["user_id"], "money_declined",
                        "declined your money")
    return {"ok": True}


@router.post("/money/transfers/{tid}/reverse")
async def reverse_transfer(tid: str, authorization: Optional[str] = Header(None)):
    """The sender reverses a transfer they sent (e.g. a mistake) while it's still
    pending — they get refunded and the recipient is notified."""
    me = await get_current_user(authorization)
    t = await db.money_transfers.find_one(
        {"id": tid, "from_user_id": me["user_id"], "status": "pending"}, {"_id": 0}
    )
    if not t:
        raise HTTPException(status_code=404, detail="Transfer not found or already settled")
    await _credit_wallet(me["user_id"], round(float(t.get("amount", 0) or 0) + float(t.get("fee", 0) or 0), 2))
    await db.money_transfers.update_one(
        {"id": tid}, {"$set": {"status": "reversed", "resolved_at": datetime.now(timezone.utc)}}
    )
    await _notify_money(t["to_user_id"], me["user_id"], "money_reversed",
                        f"reversed the ${round(float(t.get('amount', 0) or 0), 2):.2f} they sent")
    return {"ok": True}


# ── Request money ────────────────────────────────────────────────────────────
class RequestMoney(BaseModel):
    to_user_id: str         # who is asked to pay
    amount: float
    note: Optional[str] = ""


class PayRequest(BaseModel):
    answer: str


async def _hydrate_request(r: dict, viewer_id: str) -> dict:
    other_id = r["to_user_id"] if r["from_user_id"] == viewer_id else r["from_user_id"]
    other = await _public_user(other_id, viewer_id)
    return {
        "id": r["id"],
        "from_user_id": r["from_user_id"],
        "to_user_id": r["to_user_id"],
        "amount": round(float(r.get("amount", 0) or 0), 2),
        "note": r.get("note") or "",
        "status": r.get("status", "pending"),
        "direction": "outgoing" if r["from_user_id"] == viewer_id else "incoming",
        "other_user": {
            "user_id": other.user_id, "name": other.name,
            "username": other.username, "picture": other.picture,
            "verified": other.verified,
        },
        "created_at": r.get("created_at"),
    }


@router.post("/money/request")
async def request_money(body: RequestMoney, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    if body.to_user_id == me["user_id"]:
        raise HTTPException(status_code=400, detail="You can't request money from yourself")
    payer = await db.users.find_one({"user_id": body.to_user_id}, {"_id": 0, "user_id": 1, "name": 1})
    if not payer:
        raise HTTPException(status_code=404, detail="User not found")
    amount = round(float(body.amount or 0), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than 0")
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "from_user_id": me["user_id"], "from_name": me.get("name", "Someone"),
        "to_user_id": body.to_user_id,
        "amount": amount, "note": (body.note or "")[:200],
        "status": "pending", "created_at": now,
    }
    await db.money_requests.insert_one(doc.copy())
    await _notify_money(body.to_user_id, me["user_id"], "money_request",
                        f"requested ${amount:.2f}")
    return await _hydrate_request(doc, me["user_id"])


@router.get("/money/requests")
async def list_requests(authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    uid = me["user_id"]
    incoming = await db.money_requests.find(
        {"to_user_id": uid, "status": "pending"}, {"_id": 0}
    ).sort("created_at", -1).limit(50).to_list(50)
    outgoing = await db.money_requests.find(
        {"from_user_id": uid}, {"_id": 0}
    ).sort("created_at", -1).limit(50).to_list(50)
    return {
        "incoming": [await _hydrate_request(r, uid) for r in incoming],
        "outgoing": [await _hydrate_request(r, uid) for r in outgoing],
    }


@router.post("/money/requests/{rid}/pay")
async def pay_request(rid: str, body: PayRequest, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    req = await db.money_requests.find_one(
        {"id": rid, "to_user_id": me["user_id"], "status": "pending"}, {"_id": 0}
    )
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")
    amount = round(float(req.get("amount", 0) or 0), 2)
    await _require_answer(me, body.answer)
    # The payer covers the flat transaction fee; the requester gets the full amount.
    # Admins (the platform owner) are exempt.
    fee = 0.0 if is_admin(me) else await _fee_dollars()
    if not await _debit_wallet(me["user_id"], round(amount + fee, 2)):
        raise _insufficient()
    await _do_transfer(me, req["from_user_id"], amount, req.get("note") or "")
    await _record_platform_fee(fee, "transfer_fee", me["user_id"], rid)
    await db.money_requests.update_one(
        {"id": rid}, {"$set": {"status": "paid", "fee": fee, "resolved_at": datetime.now(timezone.utc)}}
    )
    await _notify_money(req["from_user_id"], me["user_id"], "money_request_paid",
                        f"paid your ${amount:.2f} request")
    return {"ok": True, "amount": amount}


@router.post("/money/requests/{rid}/decline")
async def decline_request(rid: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    req = await db.money_requests.find_one(
        {"id": rid, "to_user_id": me["user_id"], "status": "pending"}, {"_id": 0}
    )
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")
    await db.money_requests.update_one(
        {"id": rid}, {"$set": {"status": "declined", "resolved_at": datetime.now(timezone.utc)}}
    )
    await _notify_money(req["from_user_id"], me["user_id"], "money_request_declined",
                        "declined your money request")
    return {"ok": True}


@router.post("/money/requests/{rid}/cancel")
async def cancel_request(rid: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    req = await db.money_requests.find_one(
        {"id": rid, "from_user_id": me["user_id"], "status": "pending"}, {"_id": 0}
    )
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")
    await db.money_requests.update_one(
        {"id": rid}, {"$set": {"status": "cancelled", "resolved_at": datetime.now(timezone.utc)}}
    )
    return {"ok": True}


# ── Wallet: balance, currency + top up ───────────────────────────────────────
def _currency_view(code: str, usd: float) -> dict:
    code = normalize_currency(code)
    cur = CURRENCIES[code]
    return {
        "currency": code,
        "symbol": cur["symbol"],
        "name": cur["name"],
        "rate": cur["rate"],
        "balance": round(float(usd), 2),                 # canonical USD
        "display": round(float(usd) * cur["rate"], 2),   # in chosen currency
    }


@router.get("/currencies")
async def list_currencies():
    """All supported display currencies and their fixed USD conversion rates."""
    return {"currencies": CURRENCIES}


# ── Pay a creator straight from the wallet balance (tips & subscriptions) ─────
class WalletPay(BaseModel):
    kind: str                       # tip | subscription
    creator_id: str
    amount: Optional[float] = None  # tip amount
    tier: Optional[str] = None      # subscription tier id
    note: Optional[str] = ""
    conversation_id: Optional[str] = None


@router.post("/payments/pay-wallet")
async def pay_from_wallet(body: WalletPay, authorization: Optional[str] = Header(None)):
    """Pay a tip or a (first) subscription charge from the in-app wallet balance.
    Tips carry the flat transaction fee (admins exempt); subscriptions take the
    platform percentage cut. Returns 400 insufficient_balance with the shortfall
    so the client can offer to top up the difference or pay the rest by card."""
    me = await get_current_user(authorization)
    if body.creator_id == me["user_id"]:
        raise HTTPException(status_code=400, detail="You can't pay yourself")
    creator = await db.users.find_one({"user_id": body.creator_id}, {"_id": 0, "user_id": 1, "name": 1, "email": 1})
    if not creator:
        raise HTTPException(status_code=404, detail="Creator not found")

    from routes.payments import platform_fee_percent, transaction_fee_cents
    now = datetime.now(timezone.utc)
    name = me.get("name", "Someone")

    if body.kind == "subscription":
        from core import SUBSCRIPTION_TIERS_BY_ID
        tier = SUBSCRIPTION_TIERS_BY_ID.get(body.tier or "plus")
        if not tier:
            raise HTTPException(status_code=400, detail="Choose a valid subscription tier")
        amount = round(float(tier["price"]), 2)
        fee = 0.0
    else:
        amount = round(float(body.amount or 0), 2)
        if amount <= 0:
            raise HTTPException(status_code=400, detail="Amount must be greater than 0")
        fee = 0.0 if is_admin(me) else await _fee_dollars()

    total = round(amount + fee, 2)
    bal = await _wallet_balance(me["user_id"])
    if bal + 1e-9 < total:
        raise HTTPException(status_code=400, detail={
            "code": "insufficient_balance",
            "message": "Not enough wallet balance.",
            "balance": round(bal, 2), "amount": amount, "fee": round(fee, 2),
            "total": total, "short": round(max(0.0, total - bal), 2),
        })

    if not await _debit_wallet(me["user_id"], total):
        raise _insufficient()

    # Platform's percentage cut (subscriptions/tips); the creator gets the rest.
    pct = await platform_fee_percent()
    creator_net = round(amount * (1 - pct / 100.0), 2)
    await _credit_wallet(body.creator_id, creator_net)
    await db.earnings.insert_one({
        "id": str(uuid.uuid4()), "user_id": body.creator_id, "amount": creator_net,
        "kind": "subscription" if body.kind == "subscription" else "tip",
        "from_user_id": me["user_id"], "from_name": name,
        "message": (body.note or "")[:200] if body.kind != "subscription" else "",
        "source": "wallet", "created_at": now,
    })
    # Platform revenue = flat fee + percentage cut.
    if body.kind == "subscription":
        await _record_platform_fee(round(amount - creator_net, 2), "subscription_fee", me["user_id"], body.creator_id)
        await db.subscriptions.insert_one({
            "id": str(uuid.uuid4()), "subscriber_id": me["user_id"], "creator_id": body.creator_id,
            "amount": amount, "tier": (body.tier or "plus"), "status": "active", "source": "wallet",
            "started_at": now, "renews_at": now + timedelta(days=30), "created_at": now,
        })
    else:
        await _record_platform_fee(fee, "transfer_fee", me["user_id"], body.creator_id)
        if pct > 0:
            await _record_platform_fee(round(amount - creator_net, 2), "tip_fee", me["user_id"], body.creator_id)
        await db.tips.insert_one({
            "id": str(uuid.uuid4()), "from_user_id": me["user_id"], "from_name": name,
            "to_user_id": body.creator_id, "amount": amount, "currency": "USD",
            "message": (body.note or "")[:200], "source": "wallet", "created_at": now,
        })
        if body.conversation_id:
            conv = await db.conversations.find_one({"id": body.conversation_id}, {"_id": 0, "participant_ids": 1})
            if conv and me["user_id"] in conv.get("participant_ids", []):
                await db.messages.insert_one({
                    "id": str(uuid.uuid4()), "conversation_id": body.conversation_id, "sender_id": me["user_id"],
                    "type": "tip", "text": (body.note or ""), "amount": amount,
                    "media": [], "reactions": {}, "deleted": False, "created_at": now,
                })
                await db.conversations.update_one({"id": body.conversation_id}, {"$set": {"last_message_at": now}})

    await _maybe_payout_nudge(body.creator_id)
    try:
        await emit_notification(user_id=body.creator_id, actor_id=me["user_id"],
                                ntype="subscribe" if body.kind == "subscription" else "tip",
                                message=f"${amount:.2f} {'subscription' if body.kind == 'subscription' else 'tip'} from your balance")
    except Exception:
        pass
    return {"ok": True, "amount": amount, "balance": await _wallet_balance(me["user_id"])}


@router.get("/wallet/balance")
async def wallet_balance(authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    usd = await _wallet_balance(me["user_id"])
    out = _currency_view(me.get("currency"), usd)
    out["currencies"] = CURRENCIES
    return out


class SetCurrency(BaseModel):
    currency: str


@router.post("/wallet/currency")
async def set_currency(body: SetCurrency, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    code = normalize_currency(body.currency)
    await db.users.update_one({"user_id": me["user_id"]}, {"$set": {"currency": code}})
    usd = await _wallet_balance(me["user_id"])
    return _currency_view(code, usd)


class WalletTopup(BaseModel):
    amount: float
    embedded: Optional[bool] = False


@router.post("/wallet/topup")
async def wallet_topup(body: WalletTopup, authorization: Optional[str] = Header(None)):
    """Add funds to the wallet. Uses Stripe Checkout when real payments are
    live (credited by the webhook); otherwise credits immediately (test mode)."""
    me = await get_current_user(authorization)
    amount = round(float(body.amount or 0), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than 0")
    if amount > 10000:
        raise HTTPException(status_code=400, detail="Maximum top-up is $10,000")

    from routes.payments import payments_live
    if await payments_live():
        from routes.payments import stripe, _ui_kwargs, _checkout_response
        session = stripe.checkout.Session.create(
            mode="payment",
            line_items=[{
                "price_data": {
                    "currency": "usd",
                    "product_data": {"name": "Wallet top-up"},
                    "unit_amount": int(round(amount * 100)),
                },
                "quantity": 1,
            }],
            **_ui_kwargs(bool(body.embedded), "/wallet"),
            metadata={"kind": "wallet_topup", "buyer_id": me["user_id"], "amount": str(amount)},
        )
        # Record the attempt so it shows in the user's top-up history as
        # "Processing" until the payment completes (or expires -> "Failed").
        await db.wallet_topups.insert_one({
            "id": str(uuid.uuid4()), "user_id": me["user_id"], "amount": amount,
            "source": "stripe", "session_id": session["id"], "status": "processing",
            "created_at": datetime.now(timezone.utc),
        })
        return _checkout_response(session, bool(body.embedded))

    # Test mode: credit instantly.
    await _apply_wallet_topup(me["user_id"], amount, "test")
    usd = await _wallet_balance(me["user_id"])
    out = _currency_view(me.get("currency"), usd)
    out.update({"ok": True, "simulated": True})
    return out


@router.post("/wallet/topup/sync")
async def wallet_topup_sync(authorization: Optional[str] = Header(None)):
    """Safety net: scan the user's recent Stripe Checkout sessions and credit any
    paid wallet top-up that wasn't recorded (e.g. a missed/late webhook).
    Idempotent via the session id."""
    me = await get_current_user(authorization)
    from routes.payments import stripe, stripe_enabled
    credited_total, count = 0.0, 0
    if stripe_enabled():
        try:
            sessions = stripe.checkout.Session.list(limit=100)
            for s in (sessions.get("data", []) if isinstance(sessions, dict) else sessions.data):
                meta = (s.get("metadata") if isinstance(s, dict) else s.metadata) or {}
                if meta.get("kind") != "wallet_topup" or meta.get("buyer_id") != me["user_id"]:
                    continue
                pay_status = s.get("payment_status") if isinstance(s, dict) else s.payment_status
                if pay_status != "paid":
                    continue
                sid = s.get("id") if isinstance(s, dict) else s.id
                amt = round(float(meta.get("amount") or 0), 2)
                if await _apply_wallet_topup(me["user_id"], amt, "stripe", sid):
                    credited_total += amt
                    count += 1
        except Exception:
            pass
    usd = await _wallet_balance(me["user_id"])
    out = _currency_view(me.get("currency"), usd)
    out.update({"credited": round(credited_total, 2), "count": count})
    return out


class TopupIntent(BaseModel):
    amount: float


@router.post("/wallet/topup/intent")
async def wallet_topup_intent(body: TopupIntent, authorization: Optional[str] = Header(None)):
    """Create a PaymentIntent for an inline (Stripe Elements) card top-up."""
    me = await get_current_user(authorization)
    amount = round(float(body.amount or 0), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than 0")
    if amount > 10000:
        raise HTTPException(status_code=400, detail="Maximum top-up is $10,000")
    from routes.payments import payments_live, stripe, STRIPE_PUBLISHABLE_KEY
    if not await payments_live():
        raise HTTPException(status_code=400, detail={"code": "not_live", "message": "Card payments aren't enabled right now."})
    pi = stripe.PaymentIntent.create(
        amount=int(round(amount * 100)), currency="usd",
        payment_method_types=["card"],
        metadata={"kind": "wallet_topup", "buyer_id": me["user_id"], "amount": str(amount)},
    )
    await db.wallet_topups.insert_one({
        "id": str(uuid.uuid4()), "user_id": me["user_id"], "amount": amount,
        "source": "stripe", "session_id": pi["id"], "status": "processing",
        "created_at": datetime.now(timezone.utc),
    })
    return {"client_secret": pi["client_secret"], "publishable_key": STRIPE_PUBLISHABLE_KEY, "intent_id": pi["id"]}


class IntentConfirm(BaseModel):
    intent_id: str


@router.post("/wallet/topup/confirm-intent")
async def wallet_topup_confirm_intent(body: IntentConfirm, authorization: Optional[str] = Header(None)):
    """Credit a top-up after the inline card payment succeeds (idempotent)."""
    me = await get_current_user(authorization)
    from routes.payments import stripe, stripe_enabled
    if not stripe_enabled() or not body.intent_id:
        raise HTTPException(status_code=400, detail="Nothing to confirm")
    try:
        pi = stripe.PaymentIntent.retrieve(body.intent_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Payment not found")
    if (pi.get("metadata") or {}).get("buyer_id") != me["user_id"]:
        raise HTTPException(status_code=403, detail="This payment isn't yours")
    paid = pi.get("status") == "succeeded"
    amt = round(float((pi.get("metadata") or {}).get("amount") or 0), 2)
    credited = False
    if paid:
        credited = await _apply_wallet_topup(me["user_id"], amt, "stripe", pi["id"])
    usd = await _wallet_balance(me["user_id"])
    out = _currency_view(me.get("currency"), usd)
    out.update({"ok": paid, "paid": paid, "credited": credited, "status": pi.get("status")})
    return out


class TopupConfirm(BaseModel):
    session_id: str


@router.post("/wallet/topup/confirm")
async def wallet_topup_confirm(body: TopupConfirm, authorization: Optional[str] = Header(None)):
    """Confirm a wallet top-up right after the user returns from Stripe Checkout,
    so the balance updates even if the webhook is delayed or misconfigured.
    Idempotent: crediting is keyed on the Stripe session id."""
    me = await get_current_user(authorization)
    from routes.payments import stripe, stripe_enabled
    if not stripe_enabled() or not body.session_id:
        raise HTTPException(status_code=400, detail="No payment to confirm")
    try:
        sess = stripe.checkout.Session.retrieve(body.session_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Payment session not found")
    meta = (sess.get("metadata") or {})
    if meta.get("kind") != "wallet_topup" or meta.get("buyer_id") != me["user_id"]:
        raise HTTPException(status_code=403, detail="This payment isn't yours")
    paid = sess.get("payment_status") == "paid"
    amt = round(float(meta.get("amount") or 0), 2)
    credited = False
    if paid:
        credited = await _apply_wallet_topup(me["user_id"], amt, "stripe", sess["id"])
    elif sess.get("status") == "expired":
        await _mark_topup_failed(sess["id"])
    usd = await _wallet_balance(me["user_id"])
    out = _currency_view(me.get("currency"), usd)
    status = "completed" if paid else ("failed" if sess.get("status") == "expired" else "processing")
    out.update({"ok": paid, "paid": paid, "credited": credited, "status": status})
    return out


def _topup_view(t: dict) -> dict:
    return {
        "id": t.get("id"),
        "amount": round(float(t.get("amount", 0) or 0), 2),
        "status": t.get("status", "completed"),     # processing | completed | failed
        "source": t.get("source", "stripe"),         # stripe | test
        "created_at": t.get("created_at"),
        "completed_at": t.get("completed_at"),
    }


@router.post("/wallet/topup/{tid}/cancel")
async def cancel_topup(tid: str, authorization: Optional[str] = Header(None)):
    """Cancel a top-up that's still processing (e.g. the user left the Stripe
    page). If the payment actually went through, it's credited instead."""
    me = await get_current_user(authorization)
    t = await db.wallet_topups.find_one({"id": tid, "user_id": me["user_id"]}, {"_id": 0})
    if not t:
        raise HTTPException(status_code=404, detail="Top-up not found")
    if t.get("status") != "processing":
        return {"ok": True, "status": t.get("status", "completed")}
    sid = t.get("session_id")
    if sid:
        try:
            from routes.payments import stripe, stripe_enabled
            if stripe_enabled():
                sess = stripe.checkout.Session.retrieve(sid)
                if sess.get("payment_status") == "paid":
                    amt = round(float((sess.get("metadata") or {}).get("amount") or t.get("amount") or 0), 2)
                    await _apply_wallet_topup(me["user_id"], amt, "stripe", sid)
                    return {"ok": True, "status": "completed", "credited": True}
                try:
                    stripe.checkout.Session.expire(sid)
                except Exception:
                    pass
        except Exception:
            pass
    await db.wallet_topups.update_one(
        {"id": tid}, {"$set": {"status": "cancelled", "completed_at": datetime.now(timezone.utc)}},
    )
    return {"ok": True, "status": "cancelled"}


@router.get("/wallet/topups")
async def list_topups(authorization: Optional[str] = Header(None)):
    """The user's wallet top-up history with status (processing/completed/failed)."""
    me = await get_current_user(authorization)
    rows = await db.wallet_topups.find(
        {"user_id": me["user_id"]}, {"_id": 0}
    ).sort("created_at", -1).limit(50).to_list(50)
    return {"topups": [_topup_view(t) for t in rows]}
