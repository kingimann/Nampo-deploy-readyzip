"""Communities — a Reddit-style forum, separate from chat Groups.

A community owns forum posts (regular posts tagged with community_id + a title).
Membership lets you post; voting reuses post likes/dislikes; comments reuse the
post reply system.
"""
import re
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException, Query

from core import db, get_current_user
from db import DuplicateKeyError
from models import Community, CommunityCreate, Post
from routes.posts import _hydrate_post

router = APIRouter()

_NAME_RE = re.compile(r"^[a-z0-9_]{3,30}$")


async def _hydrate_community(doc: dict, viewer_id: Optional[str]) -> Community:
    member = None
    if viewer_id:
        member = await db.community_members.find_one(
            {"community_id": doc["id"], "user_id": viewer_id}, {"_id": 0}
        )
    member_count = await db.community_members.count_documents({"community_id": doc["id"]})
    return Community(
        id=doc["id"], name=doc["name"], title=doc.get("title") or doc["name"],
        description=doc.get("description", ""), color=doc.get("color", "#3B82F6"),
        icon=doc.get("icon", "people"), owner_id=doc["owner_id"],
        member_count=member_count, post_count=doc.get("post_count", 0),
        is_member=bool(member), role=member.get("role") if member else None,
        created_at=doc["created_at"],
    )


@router.post("/communities", response_model=Community)
async def create_community(body: CommunityCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    name = (body.name or "").strip().lower()
    if not _NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Name must be 3-30 chars: a-z, 0-9, underscore")
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "name": name,
        "title": (body.title or name).strip()[:60],
        "description": (body.description or "").strip()[:500],
        "color": body.color or "#3B82F6",
        "icon": body.icon or "people",
        "owner_id": user["user_id"],
        "post_count": 0,
        "created_at": now,
    }
    try:
        await db.communities.insert_one(doc.copy())
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail=f"/{name} is taken")
    await db.community_members.insert_one({
        "id": str(uuid.uuid4()), "community_id": doc["id"],
        "user_id": user["user_id"], "role": "owner", "joined_at": now,
    })
    return await _hydrate_community(doc, user["user_id"])


@router.get("/communities", response_model=List[Community])
async def list_communities(q: Optional[str] = Query(None), authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    filt: dict = {}
    if q and q.strip():
        pattern = re.escape(q.strip())
        filt["$or"] = [
            {"name": {"$regex": pattern, "$options": "i"}},
            {"title": {"$regex": pattern, "$options": "i"}},
        ]
    docs = await db.communities.find(filt, {"_id": 0}).limit(100).to_list(100)
    docs.sort(key=lambda d: d.get("post_count", 0), reverse=True)
    return [await _hydrate_community(d, user["user_id"]) for d in docs]


@router.get("/communities/{name}", response_model=Community)
async def get_community(name: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.communities.find_one({"name": name.lower()}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Community not found")
    return await _hydrate_community(doc, user["user_id"])


@router.post("/communities/{name}/join")
async def join_community(name: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.communities.find_one({"name": name.lower()}, {"_id": 0, "id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Community not found")
    try:
        await db.community_members.insert_one({
            "id": str(uuid.uuid4()), "community_id": doc["id"],
            "user_id": user["user_id"], "role": "member",
            "joined_at": datetime.now(timezone.utc),
        })
    except DuplicateKeyError:
        pass
    return {"joined": True}


@router.delete("/communities/{name}/join")
async def leave_community(name: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.communities.find_one({"name": name.lower()}, {"_id": 0, "id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Community not found")
    await db.community_members.delete_one({"community_id": doc["id"], "user_id": user["user_id"]})
    return {"joined": False}


@router.get("/communities/{name}/posts", response_model=List[Post])
async def community_posts(
    name: str, sort: str = Query("hot"), authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    doc = await db.communities.find_one({"name": name.lower()}, {"_id": 0, "id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Community not found")
    docs = await db.posts.find(
        {"community_id": doc["id"], "parent_id": None}, {"_id": 0}
    ).sort("created_at", -1).limit(300).to_list(300)

    def votes(d: dict) -> int:
        return int(d.get("likes_count", 0)) - int(d.get("dislikes_count", 0))

    if sort == "top" or sort == "hot":
        docs.sort(key=votes, reverse=True)  # stable: ties keep recency order
    # "new" keeps the created_at-desc order from the query
    docs.sort(key=lambda d: not d.get("pinned", False))  # pinned first
    return [await _hydrate_post(d, user["user_id"]) for d in docs]
