"""In-app notifications.

A `notification` row looks like:
    {
      id, user_id (recipient), type, actor_id (optional),
      post_id|conversation_id|group_id|message (preview), read, created_at
    }

`type` values: like, repost, reply, message, group_invite, group_message.
Emitting is fire-and-forget (callers wrap in try/except) so a notification
failure never breaks the underlying action.
"""
from datetime import datetime, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict

from core import db, get_current_user

router = APIRouter()

# --- §1 response models (extra="allow") ---
class OkOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    ok: bool = True


class CountOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    count: int = 0



class Notification(BaseModel):
    id: str
    user_id: str
    type: str
    actor_id: Optional[str] = None
    actor_name: Optional[str] = None
    actor_picture: Optional[str] = None
    post_id: Optional[str] = None
    conversation_id: Optional[str] = None
    group_id: Optional[str] = None
    message: Optional[str] = None
    read: bool = False
    created_at: datetime


async def emit_notification(
    *,
    user_id: str,
    actor_id: Optional[str],
    ntype: str,
    post_id: Optional[str] = None,
    conversation_id: Optional[str] = None,
    group_id: Optional[str] = None,
    message: Optional[str] = None,
) -> None:
    """Insert a notification. Skip self-notifications (actor == recipient)."""
    if actor_id and actor_id == user_id:
        return
    try:
        await db.notifications.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "type": ntype,
            "actor_id": actor_id,
            "post_id": post_id,
            "conversation_id": conversation_id,
            "group_id": group_id,
            "message": message,
            "read": False,
            "created_at": datetime.now(timezone.utc),
        })
    except Exception:
        # Never break the upstream action because of a notification write.
        pass
    # Fan out to any developer webhooks the recipient has registered.
    try:
        from routes.webhooks import deliver_event
        await deliver_event(user_id, ntype, {
            "actor_id": actor_id, "post_id": post_id,
            "conversation_id": conversation_id, "group_id": group_id, "message": message,
        })
    except Exception:
        pass
    # Mirror to SMS when the recipient opted in and has a verified phone.
    try:
        await _maybe_sms_notify(user_id, ntype, actor_id, message)
    except Exception:
        pass


# Notification types worth a text (the noisier ones like likes are left out).
_SMS_TYPES = {
    "message", "group_invite", "group_message", "friend_request",
    "friend_accept", "poke", "money", "tip", "subscribe",
}


async def _maybe_sms_notify(
    user_id: str, ntype: str, actor_id: Optional[str], message: Optional[str],
) -> None:
    if ntype not in _SMS_TYPES:
        return
    user = await db.users.find_one(
        {"user_id": user_id},
        {"_id": 0, "phone": 1, "phone_verified": 1, "sms_notifications": 1},
    )
    if not user or not user.get("sms_notifications") or not user.get("phone_verified") or not user.get("phone"):
        return
    from services.sms import send_sms, sms_enabled
    if not sms_enabled():
        return
    actor_name = "Someone"
    if actor_id:
        a = await db.users.find_one({"user_id": actor_id}, {"_id": 0, "name": 1})
        if a and a.get("name"):
            actor_name = a["name"]
    verb = {
        "message": "sent you a message",
        "group_invite": "invited you to a group",
        "group_message": "posted in your group",
        "friend_request": "sent you a friend request",
        "friend_accept": "accepted your friend request",
        "poke": "poked you",
        "money": "sent you money",
        "tip": "tipped you",
        "subscribe": "subscribed to you",
    }.get(ntype, "sent you a notification")
    body = f"OkaySpace: {actor_name} {verb}."
    if message:
        body += f" “{message[:80]}”"
    await send_sms(user["phone"], body)


def _hydrate(doc: dict, actors: dict) -> Notification:
    a = actors.get(doc.get("actor_id")) or {}
    return Notification(
        id=doc["id"],
        user_id=doc["user_id"],
        type=doc["type"],
        actor_id=doc.get("actor_id"),
        actor_name=a.get("name"),
        actor_picture=a.get("picture"),
        post_id=doc.get("post_id"),
        conversation_id=doc.get("conversation_id"),
        group_id=doc.get("group_id"),
        message=doc.get("message"),
        read=bool(doc.get("read", False)),
        created_at=doc["created_at"],
    )


@router.get("/notifications", response_model=List[Notification])
async def list_notifications(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    cursor = (
        db.notifications.find({"user_id": user["user_id"]}, {"_id": 0})
        .sort("created_at", -1)
        .limit(100)
    )
    docs = await cursor.to_list(100)
    # Batch every actor lookup into one query instead of one find_one per
    # notification (was up to 100 sequential user reads per load).
    actor_ids = list({d["actor_id"] for d in docs if d.get("actor_id")})
    actors: dict = {}
    if actor_ids:
        rows = await db.users.find(
            {"user_id": {"$in": actor_ids}},
            {"_id": 0, "user_id": 1, "name": 1, "picture": 1},
        ).to_list(len(actor_ids))
        actors = {r["user_id"]: r for r in rows}
    return [_hydrate(d, actors) for d in docs]


# ── "Activity" tab: recent actions by people in your network ─────────────────
class ActivityItem(BaseModel):
    id: str
    actor_id: str
    actor_name: str
    actor_picture: Optional[str] = None
    type: str                  # like | comment | repost
    post_id: Optional[str] = None
    target_kind: str = "post"  # post | video
    text: Optional[str] = None # comment text or post preview
    created_at: datetime


async def _network_ids(me_id: str) -> list:
    """People you follow ∪ people who follow you ∪ friends (minus yourself)."""
    ids = set()
    f1 = await db.follows.find({"follower_id": me_id}, {"_id": 0, "followee_id": 1}).to_list(3000)
    f2 = await db.follows.find({"followee_id": me_id}, {"_id": 0, "follower_id": 1}).to_list(3000)
    fr = await db.friendships.find({"$or": [{"a": me_id}, {"b": me_id}]}, {"_id": 0, "a": 1, "b": 1}).to_list(3000)
    for f in f1:
        ids.add(f.get("followee_id"))
    for f in f2:
        ids.add(f.get("follower_id"))
    for f in fr:
        ids.add(f.get("a"))
        ids.add(f.get("b"))
    ids.discard(me_id)
    ids.discard(None)
    return list(ids)


@router.get("/notifications/activity", response_model=List[ActivityItem])
async def network_activity(authorization: Optional[str] = Header(None)):
    """Instagram-style activity feed: what people in your network recently did —
    liked, commented on, or reposted a post or video."""
    user = await get_current_user(authorization)
    me = user["user_id"]
    net = await _network_ids(me)
    if not net:
        return []
    from core import _norm_dt
    raw = []
    reacts = await db.post_reactions.find(
        {"user_id": {"$in": net}}, {"_id": 0}
    ).sort("created_at", -1).limit(80).to_list(80)
    for r in reacts:
        if r.get("post_id") and r.get("created_at"):
            raw.append({"type": "like", "actor": r["user_id"], "post_id": r["post_id"], "created_at": r["created_at"]})
    acts = await db.posts.find(
        {"user_id": {"$in": net}, "$or": [{"parent_id": {"$ne": None}}, {"repost_of": {"$ne": None}}]},
        {"_id": 0},
    ).sort("created_at", -1).limit(80).to_list(80)
    for p in acts:
        if p.get("repost_of"):
            raw.append({"type": "repost", "actor": p["user_id"], "post_id": p["repost_of"], "created_at": p.get("created_at")})
        elif p.get("parent_id"):
            raw.append({"type": "comment", "actor": p["user_id"], "post_id": p["parent_id"], "created_at": p.get("created_at"), "text": (p.get("text") or "")[:140]})

    def _ts(x):
        try:
            return _norm_dt(x["created_at"])
        except Exception:
            return datetime.min.replace(tzinfo=timezone.utc)
    raw.sort(key=_ts, reverse=True)

    actor_cache: dict = {}
    post_cache: dict = {}
    out: List[ActivityItem] = []
    seq = 0
    for a in raw:
        if len(out) >= 40:
            break
        pid = a.get("post_id")
        if not pid:
            continue
        pdoc = post_cache.get(pid)
        if pdoc is None:
            pdoc = await db.posts.find_one({"id": pid}, {"_id": 0, "media": 1, "text": 1, "user_id": 1}) or {}
            post_cache[pid] = pdoc
        if not pdoc:
            continue
        # Activity on YOUR own posts already shows in the Notifications tab.
        if pdoc.get("user_id") == me:
            continue
        adoc = actor_cache.get(a["actor"])
        if adoc is None:
            adoc = await db.users.find_one({"user_id": a["actor"]}, {"_id": 0, "name": 1, "picture": 1}) or {}
            actor_cache[a["actor"]] = adoc
        kind = "video" if any((m or {}).get("type") == "video" for m in (pdoc.get("media") or [])) else "post"
        preview = a.get("text") or ((pdoc.get("text") or "")[:140] or None)
        seq += 1
        out.append(ActivityItem(
            id=f"{a['type']}:{a['actor']}:{pid}:{seq}",
            actor_id=a["actor"],
            actor_name=adoc.get("name", "Someone"),
            actor_picture=adoc.get("picture"),
            type=a["type"],
            post_id=pid,
            target_kind=kind,
            text=preview,
            created_at=a["created_at"],
        ))
    return out


@router.get("/notifications/unread", response_model=CountOut)
async def unread_count(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    n = await db.notifications.count_documents(
        {"user_id": user["user_id"], "read": False}
    )
    return {"count": n}


@router.post("/notifications/{notif_id}/read", response_model=OkOut)
async def mark_one_read(notif_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    res = await db.notifications.update_one(
        {"id": notif_id, "user_id": user["user_id"]},
        {"$set": {"read": True}},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Notification not found")
    return {"ok": True}


@router.post("/notifications/read-all", response_model=OkOut)
async def mark_all_read(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    await db.notifications.update_many(
        {"user_id": user["user_id"], "read": False},
        {"$set": {"read": True}},
    )
    return {"ok": True}


@router.delete("/notifications/{notif_id}", response_model=OkOut)
async def delete_notification(notif_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    res = await db.notifications.delete_one(
        {"id": notif_id, "user_id": user["user_id"]}
    )
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Notification not found")
    return {"ok": True}
