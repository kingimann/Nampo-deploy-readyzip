"""User search and public profile endpoints."""
import re
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel
from db import DuplicateKeyError

from core import (
    _public_user, db, get_current_user, is_admin,
    SUBSCRIPTION_TIERS, SUBSCRIPTION_TIERS_BY_ID,
)
from services.email import send_email
from models import AdminUserPatch, PublicUser, Tip, TipCreate, WalletSummary, WalletTxn

try:
    from routes.notifications import emit_notification  # type: ignore
except Exception:  # pragma: no cover
    emit_notification = None  # type: ignore

router = APIRouter()


@router.patch("/admin/users/{user_id}", response_model=PublicUser)
async def admin_patch_user(
    user_id: str, body: AdminUserPatch, authorization: Optional[str] = Header(None)
):
    """Admin-only: toggle a user's verified badge and set their site role."""
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    target = await db.users.find_one({"user_id": user_id}, {"_id": 0, "user_id": 1})
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
    return await _public_user(user_id, viewer_id=me["user_id"])


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
async def _credit(to_user_id: str, amount: float, kind: str, frm: dict):
    """Record an earning for the recipient (all money goes to the creator)."""
    await db.earnings.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": to_user_id,
        "amount": round(float(amount), 2),
        "kind": kind,
        "from_user_id": frm["user_id"],
        "from_name": frm.get("name", "Someone"),
        "created_at": datetime.now(timezone.utc),
    })


@router.post("/users/{user_id}/tip", response_model=Tip)
async def tip_user(user_id: str, body: TipCreate, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
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
    await _credit(user_id, amount, "tip", me)
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
                  created_at=r["created_at"])
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
         "to_user_id": t.get("to_user_id", ""), "created_at": t["created_at"]}
        for t in sent_tips
    ] + [
        {"id": s["id"], "kind": "subscription", "amount": float(s.get("amount", 0) or 0),
         "to_user_id": s.get("creator_id", ""), "created_at": s.get("created_at") or s.get("started_at")}
        for s in paid_subs
    ]
    sent_items.sort(key=lambda x: x["created_at"], reverse=True)
    sent = [
        WalletTxn(id=i["id"], kind=i["kind"], amount=i["amount"],
                  from_user_id=i["to_user_id"], from_name=name_by_id.get(i["to_user_id"], "Someone"),
                  created_at=i["created_at"])
        for i in sent_items[:30]
    ]

    return WalletSummary(
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
