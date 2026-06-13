"""Stories — 24h ephemeral image/video feed."""
from datetime import datetime, timedelta, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict

from core import db, get_current_user
from models import (
    Story, StoryCreate, StoryTrayItem, StoryViewer, StoryReply,
)
try:
    from routes.notifications import emit_notification  # type: ignore
except Exception:  # pragma: no cover
    emit_notification = None  # type: ignore

router = APIRouter()

# --- §1 response models (extra="allow") ---
class OkOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    ok: bool = True


class ViewedOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    viewed: bool = False


STORY_TTL_HOURS = 24
MAX_BASE64 = 12 * 1024 * 1024  # ~12MB (≈9MB raw video / image)


async def _hydrate_story(doc: dict, viewer_id: str) -> Story:
    u = await db.users.find_one({"user_id": doc["user_id"]}, {"_id": 0}) or {}
    view_count = await db.story_views.count_documents({"story_id": doc["id"]})
    viewed = bool(await db.story_views.find_one(
        {"story_id": doc["id"], "viewer_id": viewer_id}, {"_id": 0}
    ))
    return Story(
        id=doc["id"],
        user_id=doc["user_id"],
        user_name=u.get("name", "Unknown"),
        user_picture=u.get("picture"),
        user_username=u.get("username"),
        type=doc.get("type", "image"),
        media_base64=doc["media_base64"],
        caption=doc.get("caption", ""),
        duration_ms=doc.get("duration_ms"),
        view_count=view_count,
        viewed_by_me=viewed,
        created_at=doc["created_at"],
        expires_at=doc["expires_at"],
    )


@router.post("/stories", response_model=Story)
async def create_story(body: StoryCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    if not body.media or not body.media.base64:
        raise HTTPException(status_code=400, detail="Media required")
    if len(body.media.base64) > MAX_BASE64:
        raise HTTPException(status_code=413, detail="Media too large")
    if body.media.type not in ("image", "video"):
        raise HTTPException(status_code=400, detail="Type must be image or video")
    if body.media.type == "video" and body.media.duration_ms and body.media.duration_ms > 16_000:
        raise HTTPException(status_code=400, detail="Video must be <= 15 seconds")
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["user_id"],
        "type": body.media.type,
        "media_base64": body.media.base64,
        "caption": (body.caption or "")[:200],
        "duration_ms": body.media.duration_ms,
        "created_at": now,
        "expires_at": now + timedelta(hours=STORY_TTL_HOURS),
    }
    await db.stories.insert_one(doc.copy())
    from core import award_points, POINTS_PER_STORY
    await award_points(user["user_id"], POINTS_PER_STORY)
    return await _hydrate_story(doc, user["user_id"])


@router.get("/stories/tray", response_model=List[StoryTrayItem])
async def stories_tray(authorization: Optional[str] = Header(None)):
    """One row per author with at least one non-expired story.
    Sorted: unviewed first, then by latest_at desc.
    """
    user = await get_current_user(authorization)
    now = datetime.now(timezone.utc)
    cursor = db.stories.find(
        {"expires_at": {"$gt": now}}, {"_id": 0},
    ).sort("created_at", -1).limit(500)
    docs = await cursor.to_list(500)
    if not docs:
        return []
    # Group by user
    by_user: dict[str, list[dict]] = {}
    for d in docs:
        by_user.setdefault(d["user_id"], []).append(d)
    # Compute viewed state per user
    out: list[StoryTrayItem] = []
    # Batch the per-author lookups into two queries (was 2 per author): one for
    # all authors, one for all of my views across every story shown.
    uids = list(by_user.keys())
    udocs = await db.users.find({"user_id": {"$in": uids}}, {"_id": 0}).to_list(len(uids) or 1)
    umap = {u["user_id"]: u for u in udocs}
    all_ids = [s["id"] for items in by_user.values() for s in items]
    my_views = await db.story_views.find(
        {"story_id": {"$in": all_ids}, "viewer_id": user["user_id"]}, {"_id": 0, "story_id": 1},
    ).to_list(len(all_ids) or 1)
    viewed_ids = {v["story_id"] for v in my_views}
    for uid, items in by_user.items():
        u = umap.get(uid) or {}
        viewed_count = sum(1 for s in items if s["id"] in viewed_ids)
        out.append(StoryTrayItem(
            user_id=uid,
            user_name=u.get("name", "Unknown"),
            user_picture=u.get("picture"),
            user_username=u.get("username"),
            has_unviewed=viewed_count < len(items),
            story_count=len(items),
            latest_at=max(s["created_at"] for s in items),
        ))
    # Sort: self first if has unviewed, then others by unviewed-first, then latest_at desc
    out.sort(key=lambda x: (x.user_id != user["user_id"], not x.has_unviewed, -x.latest_at.timestamp()))
    return out


@router.get("/stories/user/{user_id}", response_model=List[Story])
async def list_user_stories(user_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    # Private account: only the owner and approved followers see their stories.
    if user_id != user["user_id"]:
        owner = await db.users.find_one({"user_id": user_id}, {"_id": 0, "is_private": 1})
        if owner and owner.get("is_private"):
            follows = await db.follows.find_one(
                {"follower_id": user["user_id"], "followee_id": user_id}, {"_id": 0, "follower_id": 1})
            if not follows:
                return []
    now = datetime.now(timezone.utc)
    cursor = db.stories.find(
        {"user_id": user_id, "expires_at": {"$gt": now}}, {"_id": 0},
    ).sort("created_at", 1)
    docs = await cursor.to_list(50)
    return [await _hydrate_story(d, user["user_id"]) for d in docs]


@router.post("/stories/{story_id}/view", response_model=ViewedOut)
async def view_story(story_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    now = datetime.now(timezone.utc)
    s = await db.stories.find_one({"id": story_id, "expires_at": {"$gt": now}}, {"_id": 0})
    if not s:
        raise HTTPException(status_code=404, detail="Story not found")
    if s["user_id"] == user["user_id"]:
        return {"viewed": False}  # owner viewing own story doesn't count
    res = await db.story_views.update_one(
        {"story_id": story_id, "viewer_id": user["user_id"]},
        {"$setOnInsert": {
            "story_id": story_id,
            "viewer_id": user["user_id"],
            "story_owner_id": s["user_id"],
            "viewed_at": datetime.now(timezone.utc),
        }},
        upsert=True,
    )
    return {"viewed": bool(res.upserted_id)}


@router.get("/stories/{story_id}/viewers", response_model=List[StoryViewer])
async def list_story_viewers(story_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    now = datetime.now(timezone.utc)
    s = await db.stories.find_one({"id": story_id, "expires_at": {"$gt": now}}, {"_id": 0})
    if not s:
        raise HTTPException(status_code=404, detail="Story not found")
    if s["user_id"] != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only the owner can see viewers")
    rows = await db.story_views.find(
        {"story_id": story_id}, {"_id": 0},
    ).sort("viewed_at", -1).limit(500).to_list(500)
    out: list[StoryViewer] = []
    vids = [r["viewer_id"] for r in rows]
    udocs = await db.users.find({"user_id": {"$in": vids}}, {"_id": 0}).to_list(len(vids) or 1)
    umap = {u["user_id"]: u for u in udocs}
    for r in rows:
        u = umap.get(r["viewer_id"]) or {}
        out.append(StoryViewer(
            user_id=r["viewer_id"],
            name=u.get("name", "Unknown"),
            username=u.get("username"),
            picture=u.get("picture"),
            viewed_at=r["viewed_at"],
        ))
    return out


@router.delete("/stories/{story_id}", response_model=OkOut)
async def delete_story(story_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    s = await db.stories.find_one({"id": story_id}, {"_id": 0})
    if not s:
        raise HTTPException(status_code=404, detail="Story not found")
    if s["user_id"] != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only the owner can delete")
    await db.stories.delete_one({"id": story_id})
    await db.story_views.delete_many({"story_id": story_id})
    return {"ok": True}


@router.post("/stories/{story_id}/reply", response_model=OkOut)
async def reply_to_story(
    story_id: str, body: StoryReply, authorization: Optional[str] = Header(None)
):
    """Sends a DM to the story owner referencing the story."""
    user = await get_current_user(authorization)
    now = datetime.now(timezone.utc)
    s = await db.stories.find_one({"id": story_id, "expires_at": {"$gt": now}}, {"_id": 0})
    if not s:
        raise HTTPException(status_code=404, detail="Story not found")
    if s["user_id"] == user["user_id"]:
        raise HTTPException(status_code=400, detail="Can't reply to your own story")
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty reply")
    # Find or create a 1-1 conversation
    participants = sorted([user["user_id"], s["user_id"]])
    conv = await db.conversations.find_one(
        {"kind": "dm", "participant_ids": participants}, {"_id": 0}
    )
    now = datetime.now(timezone.utc)
    if not conv:
        conv = {
            "id": str(uuid.uuid4()),
            "kind": "dm",
            "participant_ids": participants,
            "created_at": now,
            "last_message_at": now,
        }
        await db.conversations.insert_one(conv.copy())
    # Send message with story reference baked into the text
    msg = {
        "id": str(uuid.uuid4()),
        "conversation_id": conv["id"],
        "sender_id": user["user_id"],
        "type": "text",
        "text": f"↩ Replied to your story: {text[:500]}",
        "media": [],
        "created_at": now,
    }
    await db.messages.insert_one(msg.copy())
    await db.conversations.update_one(
        {"id": conv["id"]},
        {"$set": {"last_message_at": now}, "$pull": {"deleted_by": {"$in": participants}}},
    )
    if emit_notification:
        try:
            await emit_notification(
                user_id=s["user_id"], actor_id=user["user_id"],
                ntype="story_reply", conversation_id=conv["id"],
            )
        except Exception:
            pass
    return {"ok": True, "conversation_id": conv["id"]}
