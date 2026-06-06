"""Peer-to-peer money: send money (gated by the sender's security question)
and request money (the other person pays or declines).

Transfers are recorded the same way tips are (db.tips + db.earnings) so they
appear in the Wallet's Sent/Received lists automatically.
"""
import uuid
from datetime import datetime, timezone
from typing import List, Optional

import bcrypt
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from core import db, get_current_user, _public_user, CURRENCIES, normalize_currency
from routes.notifications import emit_notification

router = APIRouter()


# ── Wallet balance (spendable, topped-up funds) ──────────────────────────────
async def _wallet_balance(uid: str) -> float:
    u = await db.users.find_one({"user_id": uid}, {"_id": 0, "wallet_balance": 1})
    return round(float((u or {}).get("wallet_balance", 0) or 0), 2)


async def _credit_wallet(uid: str, amount: float):
    await db.users.update_one({"user_id": uid}, {"$inc": {"wallet_balance": round(float(amount), 2)}})


async def _apply_wallet_topup(uid: str, amount: float, source: str, session_id: Optional[str] = None) -> bool:
    """Credit a wallet top-up exactly once. The Stripe session id makes this
    idempotent so the webhook and the on-return confirm can't double-credit."""
    amount = round(float(amount), 2)
    if amount <= 0:
        return False
    if session_id:
        existing = await db.wallet_topups.find_one({"session_id": session_id}, {"_id": 0, "id": 1})
        if existing:
            return False
    await _credit_wallet(uid, amount)
    await db.wallet_topups.insert_one({
        "id": str(uuid.uuid4()), "user_id": uid, "amount": amount,
        "source": source, "session_id": session_id, "created_at": datetime.now(timezone.utc),
    })
    return True


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
        "source": "transfer", "created_at": now,
    })
    return now


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
    # Hold the funds: debit the sender now (escrow). They're credited to the
    # recipient on accept, or refunded to the sender on decline.
    if not await _debit_wallet(me["user_id"], amount):
        raise _insufficient()
    # Money isn't credited until the recipient accepts it (Cash App-style).
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "from_user_id": me["user_id"], "from_name": me.get("name", "Someone"),
        "to_user_id": body.to_user_id, "amount": amount, "note": (body.note or "")[:200],
        "status": "pending", "created_at": now,
    }
    await db.money_transfers.insert_one(doc.copy())
    await _notify_money(body.to_user_id, me["user_id"], "money_received",
                        f"sent you ${amount:.2f} — accept it")
    return {"ok": True, "amount": amount, "status": "pending"}


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
    }


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
    amount = round(float(t.get("amount", 0) or 0), 2)
    sender = await db.users.find_one({"user_id": t["from_user_id"]}, {"_id": 0, "user_id": 1, "name": 1}) \
        or {"user_id": t["from_user_id"], "name": t.get("from_name", "Someone")}
    await _do_transfer(sender, me["user_id"], amount, t.get("note") or "")
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
    # Refund the escrowed funds back to the sender.
    await _credit_wallet(t["from_user_id"], round(float(t.get("amount", 0) or 0), 2))
    await db.money_transfers.update_one(
        {"id": tid}, {"$set": {"status": "declined", "resolved_at": datetime.now(timezone.utc)}}
    )
    await _notify_money(t["from_user_id"], me["user_id"], "money_declined",
                        "declined your money")
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
    if not await _debit_wallet(me["user_id"], amount):
        raise _insufficient()
    await _do_transfer(me, req["from_user_id"], amount, req.get("note") or "")
    await db.money_requests.update_one(
        {"id": rid}, {"$set": {"status": "paid", "resolved_at": datetime.now(timezone.utc)}}
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
        return _checkout_response(session, bool(body.embedded))

    # Test mode: credit instantly.
    await _apply_wallet_topup(me["user_id"], amount, "test")
    usd = await _wallet_balance(me["user_id"])
    out = _currency_view(me.get("currency"), usd)
    out.update({"ok": True, "simulated": True})
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
    usd = await _wallet_balance(me["user_id"])
    out = _currency_view(me.get("currency"), usd)
    out.update({"ok": paid, "paid": paid, "credited": credited})
    return out
