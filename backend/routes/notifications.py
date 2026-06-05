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
from pydantic import BaseModel

from core import db, get_current_user

router = APIRouter()


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


async def _hydrate(doc: dict) -> Notification:
    actor_name = None
    actor_picture = None
    if doc.get("actor_id"):
        a = await db.users.find_one({"user_id": doc["actor_id"]}, {"_id": 0})
        if a:
            actor_name = a.get("name")
            actor_picture = a.get("picture")
    return Notification(
        id=doc["id"],
        user_id=doc["user_id"],
        type=doc["type"],
        actor_id=doc.get("actor_id"),
        actor_name=actor_name,
        actor_picture=actor_picture,
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
    return [await _hydrate(d) for d in docs]


@router.get("/notifications/unread")
async def unread_count(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    n = await db.notifications.count_documents(
        {"user_id": user["user_id"], "read": False}
    )
    return {"count": n}


@router.post("/notifications/{notif_id}/read")
async def mark_one_read(notif_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    res = await db.notifications.update_one(
        {"id": notif_id, "user_id": user["user_id"]},
        {"$set": {"read": True}},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Notification not found")
    return {"ok": True}


@router.post("/notifications/read-all")
async def mark_all_read(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    await db.notifications.update_many(
        {"user_id": user["user_id"], "read": False},
        {"$set": {"read": True}},
    )
    return {"ok": True}


@router.delete("/notifications/{notif_id}")
async def delete_notification(notif_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    res = await db.notifications.delete_one(
        {"id": notif_id, "user_id": user["user_id"]}
    )
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Notification not found")
    return {"ok": True}
