"""User search and public profile endpoints."""
import re
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel
from db import DuplicateKeyError

from core import (
    _public_user, db, get_current_user, is_admin, _effective_role, _norm_dt,
    SUBSCRIPTION_TIERS, SUBSCRIPTION_TIERS_BY_ID, _invalidate_badge_cache,
)
from services.email import send_email
from models import AdminUserPatch, Badge, PublicUser, Tip, TipCreate, WalletSummary, WalletTxn

try:
    from routes.notifications import emit_notification  # type: ignore
except Exception:  # pragma: no cover
    emit_notification = None  # type: ignore

router = APIRouter()


def _block_self_funds(user_id: str, me: dict):
    """No one — not even an admin — may edit their OWN balance or transactions.
    Otherwise an admin could credit themselves and cash out money that isn't
    theirs. Managing other users' records stays allowed."""
    if user_id == me["user_id"]:
        raise HTTPException(
            status_code=403,
            detail="You can't edit your own balance or transactions — that would let you withdraw money that isn't yours.",
        )


async def _audit(admin: dict, action: str, target: dict, detail: str = ""):
    """Record an admin action to the audit log (best-effort)."""
    try:
        await db.admin_audit.insert_one({
            "id": str(uuid.uuid4()),
            "admin_id": admin["user_id"], "admin_name": admin.get("name", "Admin"),
            "action": action,
            "target_id": target.get("user_id"), "target_name": target.get("name", "User"),
            "detail": (detail or "")[:300],
            "created_at": datetime.now(timezone.utc),
        })
    except Exception:
        pass


@router.patch("/admin/users/{user_id}", response_model=PublicUser)
async def admin_patch_user(
    user_id: str, body: AdminUserPatch, authorization: Optional[str] = Header(None)
):
    """Admin-only: toggle a user's verified badge and set their site role."""
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    target = await db.users.find_one({"user_id": user_id}, {"_id": 0, "user_id": 1, "name": 1})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    patch: dict = {}
    if body.verified is not None:
        patch["verified"] = bool(body.verified)
    if body.role is not None:
        if body.role not in ("user", "mod", "admin"):
            raise HTTPException(status_code=400, detail="Invalid role")
        patch["role"] = body.role
    if patch:
        await db.users.update_one({"user_id": user_id}, {"$set": patch})
        if "verified" in patch:
            await _audit(me, "verified" if patch["verified"] else "unverified", target)
        if "role" in patch:
            await _audit(me, f"set role · {patch['role']}", target)
    return await _public_user(user_id, viewer_id=me["user_id"])


@router.get("/admin/audit")
async def admin_audit_log(limit: int = Query(80), authorization: Optional[str] = Header(None)):
    """Admin-only: recent moderation/admin actions."""
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    lim = max(1, min(int(limit or 80), 200))
    rows = await db.admin_audit.find({}, {"_id": 0}).sort("created_at", -1).limit(lim).to_list(lim)
    return {"entries": rows}


def _admin_user_view(u: dict) -> dict:
    now = datetime.now(timezone.utc)
    su = u.get("suspended_until")
    suspended = False
    try:
        suspended = bool(su and _norm_dt(su) > now)
    except Exception:
        suspended = False
    return {
        "user_id": u["user_id"], "name": u.get("name"), "username": u.get("username"),
        "email": u.get("email"), "picture": u.get("picture"),
        "role": _effective_role(u), "verified": bool(u.get("verified", False)),
        "banned": bool(u.get("banned", False)),
        "suspended": suspended, "suspended_until": su if suspended else None,
        "created_at": u.get("created_at"),
    }


@router.get("/admin/users")
async def admin_list_users(
    q: str = Query("", description="search name/username/email"),
    limit: int = Query(50), offset: int = Query(0),
    authorization: Optional[str] = Header(None),
):
    """Admin-only: list/search every user on the site."""
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    query: dict = {}
    if q.strip():
        pat = re.escape(q.strip())
        query = {"$or": [
            {"email": {"$regex": pat, "$options": "i"}},
            {"name": {"$regex": pat, "$options": "i"}},
            {"username": {"$regex": pat, "$options": "i"}},
        ]}
    total = await db.users.count_documents(query)
    lim = max(1, min(int(limit or 50), 100))
    rows = await db.users.find(query, {"_id": 0}).sort("created_at", -1).skip(max(0, int(offset or 0))).limit(lim).to_list(lim)
    return {"users": [_admin_user_view(u) for u in rows], "total": total}


class ModerationBody(BaseModel):
    days: Optional[float] = None     # for suspend
    reason: Optional[str] = ""


async def _require_admin_target(user_id: str, me: dict):
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    target = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if user_id == me["user_id"]:
        raise HTTPException(status_code=400, detail="You can't moderate yourself")
    if _effective_role(target) == "admin":
        raise HTTPException(status_code=400, detail="You can't moderate another admin")
    return target


@router.post("/admin/users/{user_id}/ban")
async def admin_ban_user(user_id: str, body: ModerationBody, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    target = await _require_admin_target(user_id, me)
    await db.users.update_one({"user_id": user_id}, {"$set": {
        "banned": True, "ban_reason": (body.reason or "")[:300], "suspended_until": None,
    }})
    await db.user_sessions.delete_many({"user_id": user_id})  # force log-out
    await _audit(me, "banned", target, body.reason or "")
    return {"ok": True}


@router.post("/admin/users/{user_id}/unban")
async def admin_unban_user(user_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    target = await db.users.find_one({"user_id": user_id}, {"_id": 0, "user_id": 1, "name": 1}) or {"user_id": user_id}
    await db.users.update_one({"user_id": user_id}, {"$set": {"banned": False, "suspended_until": None}})
    await _audit(me, "lifted ban/suspension", target)
    return {"ok": True}


@router.post("/admin/users/{user_id}/suspend")
async def admin_suspend_user(user_id: str, body: ModerationBody, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    target = await _require_admin_target(user_id, me)
    days = max(0.04, min(float(body.days or 7), 3650))
    until = datetime.now(timezone.utc) + timedelta(days=days)
    await db.users.update_one({"user_id": user_id}, {"$set": {
        "suspended_until": until, "suspend_reason": (body.reason or "")[:300],
    }})
    await db.user_sessions.delete_many({"user_id": user_id})
    nice = f"{int(days)}d" if float(days).is_integer() else f"{days}d"
    await _audit(me, f"suspended · {nice}", target, body.reason or "")
    return {"ok": True, "until": until}


class WalletSet(BaseModel):
    balance: float


@router.post("/admin/users/{user_id}/wallet")
async def admin_set_wallet(user_id: str, body: WalletSet, authorization: Optional[str] = Header(None)):
    """Admin-only: set a user's wallet balance (USD) to an exact amount."""
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    _block_self_funds(user_id, me)
    target = await db.users.find_one({"user_id": user_id}, {"_id": 0, "user_id": 1, "name": 1})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    bal = round(max(0.0, float(body.balance or 0)), 2)
    await db.users.update_one({"user_id": user_id}, {"$set": {"wallet_balance": bal}})
    await _audit(me, f"set wallet ${bal:.2f}", target)
    return {"ok": True, "balance": bal}


class AddTxn(BaseModel):
    kind: str                       # "topup" | "received" | "sent" | "cashout"
    amount: float
    note: Optional[str] = ""
    counterparty: Optional[str] = ""   # name shown on received/sent rows
    adjust_balance: bool = True        # also move the wallet balance
    created_at: Optional[str] = None   # ISO date/time to backdate; default now


@router.post("/admin/users/{user_id}/transaction")
async def admin_add_transaction(user_id: str, body: AddTxn, authorization: Optional[str] = Header(None)):
    """Admin-only: re-add a lost transaction to a user's history so it shows in
    their All-activity feed, optionally moving their wallet balance to match."""
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    _block_self_funds(user_id, me)
    target = await db.users.find_one({"user_id": user_id}, {"_id": 0, "user_id": 1, "name": 1})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    amount = round(abs(float(body.amount or 0)), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Enter an amount greater than 0")
    when = datetime.now(timezone.utc)
    if body.created_at:
        try:
            dt = datetime.fromisoformat(body.created_at.replace("Z", "+00:00"))
            when = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except Exception:
            pass
    kind = body.kind
    nid = str(uuid.uuid4())
    direction_in = kind in ("topup", "received")
    if kind == "topup":
        await db.wallet_topups.insert_one({
            "id": nid, "user_id": user_id, "amount": amount, "source": "admin",
            "session_id": None, "status": "completed", "created_at": when, "completed_at": when,
        })
    elif kind == "received":
        await db.earnings.insert_one({
            "id": nid, "user_id": user_id, "amount": amount, "kind": "tip",
            "from_user_id": "", "from_name": (body.counterparty or "Someone"),
            "message": (body.note or ""), "source": "admin", "created_at": when,
        })
    elif kind == "sent":
        await db.tips.insert_one({
            "id": nid, "from_user_id": user_id, "from_name": target.get("name", "Someone"),
            "to_user_id": "", "to_name": (body.counterparty or "Someone"), "amount": amount,
            "currency": "USD", "message": (body.note or ""), "source": "admin", "created_at": when,
        })
    elif kind == "cashout":
        await db.payouts.insert_one({
            "id": nid, "user_id": user_id, "amount": amount, "status": "paid",
            "method": "manual", "created_at": when,
        })
    else:
        raise HTTPException(status_code=400, detail="kind must be topup, received, sent or cashout")
    if body.adjust_balance:
        delta = amount if direction_in else -amount
        await db.users.update_one({"user_id": user_id}, {"$inc": {"wallet_balance": round(delta, 2)}})
    await _audit(me, f"re-added {kind} ${amount:.2f}", target, body.note or "")
    fresh = await db.users.find_one({"user_id": user_id}, {"_id": 0, "wallet_balance": 1})
    return {"ok": True, "id": nid, "balance": round(float((fresh or {}).get("wallet_balance", 0) or 0), 2)}


# Editable manual transactions: kind → (collection, owner field, money-in?, name field, note field)
_TXN_KINDS = {
    "topup":    {"coll": "wallet_topups", "owner": "user_id",      "in": True,  "name": None,        "note": None},
    "received": {"coll": "earnings",      "owner": "user_id",      "in": True,  "name": "from_name", "note": "message"},
    "sent":     {"coll": "tips",          "owner": "from_user_id", "in": False, "name": "to_name",   "note": "message"},
    "cashout":  {"coll": "payouts",       "owner": "user_id",      "in": False, "name": None,        "note": None},
}


def _parse_when(s: Optional[str]):
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


@router.get("/admin/users/{user_id}/transactions")
async def admin_list_transactions(user_id: str, authorization: Optional[str] = Header(None)):
    """Admin-only: list a user's editable transactions so they can be corrected."""
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    out = []
    for kind, cfg in _TXN_KINDS.items():
        coll = getattr(db, cfg["coll"])
        rows = await coll.find({cfg["owner"]: user_id}, {"_id": 0}).sort("created_at", -1).limit(50).to_list(50)
        for r in rows:
            out.append({
                "ref": f"{kind}:{r.get('id')}", "kind": kind, "in": cfg["in"],
                "amount": round(float(r.get("amount", 0) or 0), 2),
                "counterparty": (r.get(cfg["name"]) if cfg["name"] else "") or "",
                "note": (r.get(cfg["note"]) if cfg["note"] else "") or "",
                "created_at": r.get("created_at"),
            })
    out.sort(key=lambda x: str(x["created_at"]), reverse=True)
    return {"transactions": out}


class EditTxn(BaseModel):
    ref: str                       # "kind:record_id"
    amount: Optional[float] = None
    note: Optional[str] = None
    counterparty: Optional[str] = None
    created_at: Optional[str] = None
    adjust_balance: bool = False   # apply the amount change to the wallet balance


@router.patch("/admin/users/{user_id}/transaction")
async def admin_edit_transaction(user_id: str, body: EditTxn, authorization: Optional[str] = Header(None)):
    """Admin-only: edit a transaction's amount, name, note, or date/time."""
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    _block_self_funds(user_id, me)
    kind, _, rec_id = (body.ref or "").partition(":")
    cfg = _TXN_KINDS.get(kind)
    if not cfg or not rec_id:
        raise HTTPException(status_code=400, detail="Unknown transaction")
    coll = getattr(db, cfg["coll"])
    rec = await coll.find_one({"id": rec_id, cfg["owner"]: user_id}, {"_id": 0})
    if not rec:
        raise HTTPException(status_code=404, detail="Transaction not found")
    old_amount = round(float(rec.get("amount", 0) or 0), 2)
    new_amount = old_amount
    updates: dict = {}
    if body.amount is not None:
        new_amount = round(abs(float(body.amount)), 2)
        updates["amount"] = new_amount
    if body.note is not None and cfg["note"]:
        updates[cfg["note"]] = (body.note or "")[:200]
    if body.counterparty is not None and cfg["name"]:
        updates[cfg["name"]] = (body.counterparty or "")[:80]
    when = _parse_when(body.created_at)
    if when:
        updates["created_at"] = when
        if kind == "topup":
            updates["completed_at"] = when
    if updates:
        await coll.update_one({"id": rec_id}, {"$set": updates})
    if body.adjust_balance and new_amount != old_amount:
        sign = 1 if cfg["in"] else -1
        await db.users.update_one({"user_id": user_id}, {"$inc": {"wallet_balance": round(sign * (new_amount - old_amount), 2)}})
    target = await db.users.find_one({"user_id": user_id}, {"_id": 0, "user_id": 1, "name": 1})
    await _audit(me, f"edited {kind} → ${new_amount:.2f}", target or {"user_id": user_id, "name": ""})
    fresh = await db.users.find_one({"user_id": user_id}, {"_id": 0, "wallet_balance": 1})
    return {"ok": True, "balance": round(float((fresh or {}).get("wallet_balance", 0) or 0), 2)}


@router.delete("/admin/users/{user_id}/transaction")
async def admin_delete_transaction(user_id: str, ref: str = Query(...), adjust_balance: bool = Query(False),
                                   authorization: Optional[str] = Header(None)):
    """Admin-only: delete a transaction, optionally reversing its wallet effect."""
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    _block_self_funds(user_id, me)
    kind, _, rec_id = (ref or "").partition(":")
    cfg = _TXN_KINDS.get(kind)
    if not cfg or not rec_id:
        raise HTTPException(status_code=400, detail="Unknown transaction")
    coll = getattr(db, cfg["coll"])
    rec = await coll.find_one({"id": rec_id, cfg["owner"]: user_id}, {"_id": 0, "amount": 1})
    if not rec:
        raise HTTPException(status_code=404, detail="Transaction not found")
    await coll.delete_one({"id": rec_id, cfg["owner"]: user_id})
    if adjust_balance:
        amt = round(float(rec.get("amount", 0) or 0), 2)
        sign = -1 if cfg["in"] else 1   # reverse the original effect
        await db.users.update_one({"user_id": user_id}, {"$inc": {"wallet_balance": round(sign * amt, 2)}})
    target = await db.users.find_one({"user_id": user_id}, {"_id": 0, "user_id": 1, "name": 1})
    await _audit(me, f"deleted {kind} transaction", target or {"user_id": user_id, "name": ""})
    fresh = await db.users.find_one({"user_id": user_id}, {"_id": 0, "wallet_balance": 1})
    return {"ok": True, "balance": round(float((fresh or {}).get("wallet_balance", 0) or 0), 2)}


@router.delete("/admin/users/{user_id}")
async def admin_remove_user(user_id: str, authorization: Optional[str] = Header(None)):
    """Remove (delete) a user account and their sessions."""
    me = await get_current_user(authorization)
    target = await _require_admin_target(user_id, me)
    await db.users.delete_one({"user_id": user_id})
    await db.user_sessions.delete_many({"user_id": user_id})
    await _audit(me, "removed account", target)
    return {"ok": True}


# ── Custom badges (admin-defined; render next to names like the verified check) ──
class BadgeCreate(BaseModel):
    label: str
    icon: str               # emoji char or image URL / data URI
    color: Optional[str] = "#3B82F6"


class UserBadgeBody(BaseModel):
    badge_id: str
    action: str = "add"     # "add" | "remove"


@router.get("/badges", response_model=List[Badge])
async def list_badges(authorization: Optional[str] = Header(None)):
    """All badge definitions (for display and admin management)."""
    await get_current_user(authorization)
    rows = await db.badge_defs.find({}, {"_id": 0}).sort("created_at", -1).limit(200).to_list(200)
    return [Badge(id=r["id"], label=r.get("label", ""), icon=r.get("icon", ""), color=r.get("color", "#3B82F6")) for r in rows]


@router.post("/admin/badges", response_model=Badge)
async def create_badge(body: BadgeCreate, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    icon = (body.icon or "").strip()
    if not body.label.strip() or not icon:
        raise HTTPException(status_code=400, detail="Label and icon are required")
    if len(icon) > 1_500_000:
        raise HTTPException(status_code=413, detail="Badge image too large")
    doc = {
        "id": str(uuid.uuid4()), "label": body.label.strip()[:40], "icon": icon,
        "color": (body.color or "#3B82F6")[:9], "created_at": datetime.now(timezone.utc),
    }
    await db.badge_defs.insert_one(doc.copy())
    _invalidate_badge_cache()
    await _audit(me, f"created badge · {doc['label']}", {"user_id": "", "name": ""})
    return Badge(id=doc["id"], label=doc["label"], icon=doc["icon"], color=doc["color"])


@router.delete("/admin/badges/{badge_id}")
async def delete_badge(badge_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    await db.badge_defs.delete_one({"id": badge_id})
    await db.users.update_many({"badge_ids": badge_id}, {"$pull": {"badge_ids": badge_id}})
    _invalidate_badge_cache()
    await _audit(me, "deleted badge", {"user_id": "", "name": ""})
    return {"ok": True}


@router.post("/admin/users/{user_id}/badge")
async def set_user_badge(user_id: str, body: UserBadgeBody, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    target = await db.users.find_one({"user_id": user_id}, {"_id": 0, "user_id": 1, "name": 1})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    bdef = await db.badge_defs.find_one({"id": body.badge_id}, {"_id": 0, "id": 1, "label": 1})
    if not bdef:
        raise HTTPException(status_code=404, detail="Badge not found")
    if body.action == "remove":
        await db.users.update_one({"user_id": user_id}, {"$pull": {"badge_ids": body.badge_id}})
        await _audit(me, f"removed badge · {bdef.get('label', '')}", target)
    else:
        cur = await db.users.find_one({"user_id": user_id}, {"_id": 0, "badge_ids": 1})
        ids = list((cur or {}).get("badge_ids") or [])
        if body.badge_id not in ids:
            ids.append(body.badge_id)
        await db.users.update_one({"user_id": user_id}, {"$set": {"badge_ids": ids}})
        await _audit(me, f"gave badge · {bdef.get('label', '')}", target)
    return {"ok": True}


@router.post("/presence/ping")
async def presence_ping(authorization: Optional[str] = Header(None)):
    """Heartbeat: mark the caller active now (drives online/offline status)."""
    me = await get_current_user(authorization)
    await db.users.update_one({"user_id": me["user_id"]}, {"$set": {"last_seen": datetime.now(timezone.utc)}})
    return {"ok": True}


@router.get("/users/search", response_model=List[PublicUser])
async def search_users(
    q: str = Query(..., min_length=1),
    authorization: Optional[str] = Header(None),
):
    me_user = await get_current_user(authorization)
    pattern = re.escape(q)
    cursor = db.users.find(
        {
            "user_id": {"$ne": me_user["user_id"]},
            "$or": [
                {"email": {"$regex": pattern, "$options": "i"}},
                {"name": {"$regex": pattern, "$options": "i"}},
            ],
        },
        {"_id": 0},
    ).limit(20)
    docs = await cursor.to_list(20)
    out = []
    for d in docs:
        out.append(await _public_user(d["user_id"]))
    return out


@router.get("/users/{user_id}/public", response_model=PublicUser)
async def get_public_user(user_id: str, authorization: Optional[str] = Header(None)):
    me_user = await get_current_user(authorization)
    u = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    return await _public_user(user_id, me_user["user_id"])


@router.post("/users/{user_id}/follow")
async def toggle_follow(user_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    if user_id == me["user_id"]:
        raise HTTPException(status_code=400, detail="Cannot follow yourself")
    other = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    if not other:
        raise HTTPException(status_code=404, detail="User not found")
    existing = await db.follows.find_one(
        {"follower_id": me["user_id"], "followee_id": user_id}, {"_id": 0}
    )
    if existing:
        await db.follows.delete_one(
            {"follower_id": me["user_id"], "followee_id": user_id}
        )
        return {"following": False}
    try:
        await db.follows.insert_one({
            "follower_id": me["user_id"], "followee_id": user_id,
            "created_at": datetime.now(timezone.utc),
        })
        # notify the followee
        try:
            from routes.notifications import emit_notification
            await emit_notification(user_id=user_id, actor_id=me["user_id"], ntype="follow")
        except Exception:
            pass
    except DuplicateKeyError:
        pass
    return {"following": True}


@router.post("/users/{user_id}/poke")
async def poke_user(user_id: str, authorization: Optional[str] = Header(None)):
    """Facebook-style poke. One active outgoing poke per person until they
    respond; poking someone who poked you counts as poking back."""
    me = await get_current_user(authorization)
    if user_id == me["user_id"]:
        raise HTTPException(status_code=400, detail="You can't poke yourself")
    other = await db.users.find_one({"user_id": user_id}, {"_id": 0, "user_id": 1, "name": 1})
    if not other:
        raise HTTPException(status_code=404, detail="User not found")
    now = datetime.now(timezone.utc)
    # Responding to their poke clears it.
    await db.pokes.update_many(
        {"from_user_id": user_id, "to_user_id": me["user_id"], "active": True},
        {"$set": {"active": False}},
    )
    # Don't let the same poke pile up.
    existing = await db.pokes.find_one(
        {"from_user_id": me["user_id"], "to_user_id": user_id, "active": True}, {"_id": 0, "id": 1}
    )
    if existing:
        return {"ok": True, "already": True}
    await db.pokes.insert_one({
        "id": str(uuid.uuid4()), "from_user_id": me["user_id"], "to_user_id": user_id,
        "active": True, "created_at": now,
    })
    try:
        from routes.notifications import emit_notification
        await emit_notification(user_id=user_id, actor_id=me["user_id"], ntype="poke",
                                message="👉 poked you")
    except Exception:
        pass
    return {"ok": True}


# ───────── Followers / Following lists ─────────

@router.get("/users/{user_id}/followers", response_model=List[PublicUser])
async def list_followers(user_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    rows = await db.follows.find({"followee_id": user_id}, {"_id": 0}).sort("created_at", -1).limit(200).to_list(200)
    return [await _public_user(r["follower_id"], me["user_id"]) for r in rows]


@router.get("/users/{user_id}/following", response_model=List[PublicUser])
async def list_following(user_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    rows = await db.follows.find({"follower_id": user_id}, {"_id": 0}).sort("created_at", -1).limit(200).to_list(200)
    return [await _public_user(r["followee_id"], me["user_id"]) for r in rows]


# ───────── Friends (Facebook-style, symmetric with request/accept) ─────────

@router.post("/friends/request/{user_id}")
async def send_friend_request(user_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    if user_id == me["user_id"]:
        raise HTTPException(status_code=400, detail="Cannot friend yourself")
    other = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    if not other:
        raise HTTPException(status_code=404, detail="User not found")
    a, b = sorted([me["user_id"], user_id])
    if await db.friendships.find_one({"a": a, "b": b}, {"_id": 0}):
        return {"status": "friends"}
    # If the OTHER user already sent a request to me, accepting it makes us friends
    reverse = await db.friend_requests.find_one(
        {"from_id": user_id, "to_id": me["user_id"], "status": "pending"}, {"_id": 0}
    )
    if reverse:
        await db.friendships.update_one(
            {"a": a, "b": b},
            {"$set": {"a": a, "b": b, "created_at": datetime.now(timezone.utc)}},
            upsert=True,
        )
        await db.friend_requests.update_one(
            {"from_id": user_id, "to_id": me["user_id"]},
            {"$set": {"status": "accepted", "decided_at": datetime.now(timezone.utc)}},
        )
        try:
            from routes.notifications import emit_notification
            await emit_notification(user_id=user_id, actor_id=me["user_id"], ntype="friend_accept")
        except Exception:
            pass
        return {"status": "friends"}
    # Otherwise, create / refresh my pending request
    await db.friend_requests.update_one(
        {"from_id": me["user_id"], "to_id": user_id},
        {"$set": {
            "from_id": me["user_id"], "to_id": user_id,
            "status": "pending", "created_at": datetime.now(timezone.utc),
        }},
        upsert=True,
    )
    try:
        from routes.notifications import emit_notification
        await emit_notification(user_id=user_id, actor_id=me["user_id"], ntype="friend_request")
    except Exception:
        pass
    return {"status": "request_sent"}


@router.post("/friends/accept/{user_id}")
async def accept_friend_request(user_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    req = await db.friend_requests.find_one(
        {"from_id": user_id, "to_id": me["user_id"], "status": "pending"}, {"_id": 0}
    )
    if not req:
        raise HTTPException(status_code=404, detail="No pending request")
    a, b = sorted([me["user_id"], user_id])
    await db.friendships.update_one(
        {"a": a, "b": b},
        {"$set": {"a": a, "b": b, "created_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
    await db.friend_requests.update_one(
        {"from_id": user_id, "to_id": me["user_id"]},
        {"$set": {"status": "accepted", "decided_at": datetime.now(timezone.utc)}},
    )
    try:
        from routes.notifications import emit_notification
        await emit_notification(user_id=user_id, actor_id=me["user_id"], ntype="friend_accept")
    except Exception:
        pass
    return {"status": "friends"}


@router.post("/friends/reject/{user_id}")
async def reject_friend_request(user_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    r = await db.friend_requests.update_one(
        {"from_id": user_id, "to_id": me["user_id"], "status": "pending"},
        {"$set": {"status": "rejected", "decided_at": datetime.now(timezone.utc)}},
    )
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="No pending request")
    return {"status": "rejected"}


@router.delete("/friends/{user_id}")
async def unfriend(user_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    a, b = sorted([me["user_id"], user_id])
    res = await db.friendships.delete_one({"a": a, "b": b})
    # also clear any lingering request from either side
    await db.friend_requests.delete_many({
        "$or": [
            {"from_id": me["user_id"], "to_id": user_id},
            {"from_id": user_id, "to_id": me["user_id"]},
        ],
    })
    return {"removed": bool(res.deleted_count)}


@router.delete("/friends/request/{user_id}")
async def cancel_friend_request(user_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    await db.friend_requests.delete_one(
        {"from_id": me["user_id"], "to_id": user_id, "status": "pending"}
    )
    return {"status": "none"}


@router.get("/friends", response_model=List[PublicUser])
async def list_friends(authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    rows = await db.friendships.find(
        {"$or": [{"a": me["user_id"]}, {"b": me["user_id"]}]}, {"_id": 0},
    ).sort("created_at", -1).limit(500).to_list(500)
    out = []
    for r in rows:
        other = r["b"] if r["a"] == me["user_id"] else r["a"]
        out.append(await _public_user(other, me["user_id"]))
    return out


@router.get("/friends/requests", response_model=List[PublicUser])
async def list_friend_requests(authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    rows = await db.friend_requests.find(
        {"to_id": me["user_id"], "status": "pending"}, {"_id": 0},
    ).sort("created_at", -1).limit(200).to_list(200)
    return [await _public_user(r["from_id"], me["user_id"]) for r in rows]


# ───────── Monetization: tips, subscriptions, wallet (fake payments) ─────────
async def _credit(to_user_id: str, amount: float, kind: str, frm: dict, message: str = ""):
    """Record an earning for the recipient (all money goes to the creator)."""
    await db.earnings.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": to_user_id,
        "amount": round(float(amount), 2),
        "kind": kind,
        "from_user_id": frm["user_id"],
        "from_name": frm.get("name", "Someone"),
        "message": (message or "")[:200],
        "created_at": datetime.now(timezone.utc),
    })


@router.post("/users/{user_id}/tip", response_model=Tip)
async def tip_user(user_id: str, body: TipCreate, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    from routes.payments import payments_live
    if await payments_live():
        raise HTTPException(status_code=409, detail={"code": "use_stripe", "message": "Real payments are on — tips go through Stripe checkout."})
    if user_id == me["user_id"]:
        raise HTTPException(status_code=400, detail="You can't tip yourself")
    target = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    amount = round(float(body.amount or 0), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than 0")
    now = datetime.now(timezone.utc)
    tip = {
        "id": str(uuid.uuid4()),
        "from_user_id": me["user_id"],
        "from_name": me.get("name", "Someone"),
        "to_user_id": user_id,
        "amount": amount,
        "currency": "USD",
        "message": (body.message or "")[:200],
        "created_at": now,
    }
    await db.tips.insert_one(tip.copy())
    await _credit(user_id, amount, "tip", me, message=(body.message or ""))
    if emit_notification:
        try:
            await emit_notification(user_id=user_id, actor_id=me["user_id"], ntype="tip",
                                    message=f"sent you a ${amount:.2f} tip")
        except Exception:
            pass
    try:
        if target.get("email"):
            send_email(target["email"], f"You received a ${amount:.2f} tip",
                       f"Hi {target.get('name', 'there')},\n\n{me.get('name', 'Someone')} sent you a "
                       f"${amount:.2f} tip on Nami.\n\nIt's been added to your balance.")
    except Exception:
        pass
    return Tip(**tip)


@router.get("/subscription-tiers")
async def subscription_tiers():
    return {"tiers": SUBSCRIPTION_TIERS}


class SubscribeBody(BaseModel):
    tier: str = "plus"


@router.post("/users/{user_id}/subscribe")
async def subscribe_user(user_id: str, body: SubscribeBody = SubscribeBody(), authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    from routes.payments import payments_live
    if await payments_live():
        raise HTTPException(status_code=409, detail={"code": "use_stripe", "message": "Real payments are on — subscribe through Stripe checkout."})
    if user_id == me["user_id"]:
        raise HTTPException(status_code=400, detail="You can't subscribe to yourself")
    target = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    tier = SUBSCRIPTION_TIERS_BY_ID.get(body.tier)
    if not tier:
        raise HTTPException(status_code=400, detail="Choose a valid subscription tier")
    existing = await db.subscriptions.find_one(
        {"subscriber_id": me["user_id"], "creator_id": user_id, "status": "active"}, {"_id": 0}
    )
    if existing:
        return {"subscribed": True}
    price = round(float(tier["price"]), 2)
    now = datetime.now(timezone.utc)
    await db.subscriptions.insert_one({
        "id": str(uuid.uuid4()),
        "subscriber_id": me["user_id"],
        "creator_id": user_id,
        "amount": price,
        "tier": tier["id"],
        "status": "active",
        "started_at": now,
        "renews_at": now + timedelta(days=30),
        "created_at": now,
    })
    if price > 0:
        await _credit(user_id, price, "subscription", me)
    if emit_notification:
        try:
            await emit_notification(user_id=user_id, actor_id=me["user_id"], ntype="subscribe",
                                    message="subscribed to you")
        except Exception:
            pass
    try:
        if target.get("email"):
            send_email(target["email"], f"New subscriber: {me.get('name', 'Someone')}",
                       f"Hi {target.get('name', 'there')},\n\n{me.get('name', 'Someone')} just subscribed to you "
                       f"for ${price:.2f}/mo on Nami.\n\nIt's been added to your balance.")
    except Exception:
        pass
    return {"subscribed": True}


@router.delete("/users/{user_id}/subscribe")
async def unsubscribe_user(user_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    await db.subscriptions.update_many(
        {"subscriber_id": me["user_id"], "creator_id": user_id, "status": "active"},
        {"$set": {"status": "cancelled"}},
    )
    return {"subscribed": False}


@router.get("/wallet", response_model=WalletSummary)
async def my_wallet(authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    uid = me["user_id"]
    rows = await db.earnings.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).limit(500).to_list(500)
    tips_total = sum(r["amount"] for r in rows if r.get("kind") == "tip")
    subs_total = sum(r["amount"] for r in rows if r.get("kind") == "subscription")
    ads_total = sum(r["amount"] for r in rows if r.get("kind") in ("ad_revenue", "views"))
    tips_count = sum(1 for r in rows if r.get("kind") == "tip")
    active_subscribers = await db.subscriptions.count_documents({"creator_id": uid, "status": "active"})
    recent = [
        WalletTxn(id=r["id"], kind=r.get("kind", "tip"), amount=r["amount"],
                  from_user_id=r.get("from_user_id", ""), from_name=r.get("from_name", "Someone"),
                  source=r.get("source", "test"), message=r.get("message", ""), created_at=r["created_at"])
        for r in rows[:30]
    ]

    # ── Money sent: tips given + active subscriptions this user pays for ──
    sent_tips = await db.tips.find({"from_user_id": uid}, {"_id": 0}).sort("created_at", -1).limit(200).to_list(200)
    paid_subs = await db.subscriptions.find(
        {"subscriber_id": uid, "status": "active"}, {"_id": 0}
    ).sort("created_at", -1).limit(200).to_list(200)
    tips_sent_total = sum(float(t.get("amount", 0) or 0) for t in sent_tips)
    subs_sent_total = sum(float(s.get("amount", 0) or 0) for s in paid_subs)

    # Resolve the recipient names for display (tips don't store to_name).
    need_ids = {t.get("to_user_id") for t in sent_tips} | {s.get("creator_id") for s in paid_subs}
    need_ids.discard(None)
    name_by_id: dict = {}
    if need_ids:
        urows = await db.users.find({"user_id": {"$in": list(need_ids)}}, {"_id": 0, "user_id": 1, "name": 1}).to_list(len(need_ids))
        name_by_id = {u["user_id"]: u.get("name", "Someone") for u in urows}

    sent_items = [
        {"id": t["id"], "kind": "tip", "amount": float(t.get("amount", 0) or 0),
         "to_user_id": t.get("to_user_id", ""), "to_name": t.get("to_name", ""), "source": t.get("source", "test"),
         "message": t.get("message", ""), "created_at": t["created_at"]}
        for t in sent_tips
    ] + [
        {"id": s["id"], "kind": "subscription", "amount": float(s.get("amount", 0) or 0),
         "to_user_id": s.get("creator_id", ""), "to_name": "", "source": s.get("source", "test"),
         "message": "", "created_at": s.get("created_at") or s.get("started_at")}
        for s in paid_subs
    ]
    sent_items.sort(key=lambda x: x["created_at"], reverse=True)
    sent = [
        WalletTxn(id=i["id"], kind=i["kind"], amount=i["amount"],
                  from_user_id=i["to_user_id"],
                  from_name=name_by_id.get(i["to_user_id"]) or i.get("to_name") or "Someone",
                  source=i["source"], message=i.get("message", ""), created_at=i["created_at"])
        for i in sent_items[:30]
    ]

    from core import normalize_currency
    return WalletSummary(
        currency=normalize_currency(me.get("currency")),
        balance=round(float(me.get("wallet_balance", 0) or 0), 2),
        total_earned=round(sum(r.get("amount", 0) for r in rows), 2),
        tips_total=round(tips_total, 2),
        subs_total=round(subs_total, 2),
        ads_total=round(ads_total, 2),
        tips_count=tips_count,
        active_subscribers=active_subscribers,
        sub_price=round(float(me.get("sub_price", 4.99) or 0), 2),
        recent=recent,
        total_spent=round(tips_sent_total + subs_sent_total, 2),
        tips_sent_total=round(tips_sent_total, 2),
        subs_sent_total=round(subs_sent_total, 2),
        subscriptions_count=len(paid_subs),
        sent=sent,
    )


@router.get("/wallet/export")
async def export_wallet(authorization: Optional[str] = Header(None)):
    """A CSV of all earnings + payouts for the creator's records/taxes."""
    me = await get_current_user(authorization)
    uid = me["user_id"]
    earnings = await db.earnings.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(20000)
    payouts = await db.payouts.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(20000)

    def esc(v) -> str:
        s = "" if v is None else str(v)
        return f'"{s.replace(chr(34), chr(34) + chr(34))}"' if ("," in s or '"' in s) else s

    lines = ["date,type,category,amount,counterparty,status"]
    for e in earnings:
        lines.append(",".join([
            esc(e.get("created_at")), "earning", esc(e.get("kind", "tip")),
            f'{float(e.get("amount", 0) or 0):.2f}', esc(e.get("from_name", "")), "received",
        ]))
    for p in payouts:
        lines.append(",".join([
            esc(p.get("created_at")), "payout", esc(p.get("frequency", "")),
            f'-{float(p.get("amount", 0) or 0):.2f}', "", esc(p.get("status", "")),
        ]))
    return {"filename": f"nami-earnings-{uid}.csv", "csv": "\n".join(lines)}
