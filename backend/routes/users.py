"""User search and public profile endpoints."""
import re
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException, Query
from pymongo.errors import DuplicateKeyError

from core import _public_user, db, get_current_user
from models import PublicUser

router = APIRouter()


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
