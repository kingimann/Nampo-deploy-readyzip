"""Shared dependencies, db connection, helpers, and auth.

All route modules import from here. Keeps `server.py` tiny.
"""
from __future__ import annotations

import os
import re
import uuid
import logging
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

from dotenv import load_dotenv
from fastapi import HTTPException, Header
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import DuplicateKeyError

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

FSQ_API_KEY = os.environ.get("FSQ_API_KEY", "")
FSQ_BASE = "https://places-api.foursquare.com/places"

logger = logging.getLogger("server")


def _norm_dt(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "guide"


async def _unique_slug(base: str) -> str:
    """Best-effort slug picker; caller MUST still catch DuplicateKeyError on insert."""
    slug = base
    n = 0
    while await db.guides.find_one({"slug": slug}, {"_id": 0, "id": 1}):
        n += 1
        slug = f"{base}-{n}"
    return slug


async def _try_set_unique_slug(guide_id: str, base: str) -> str:
    """Race-safe: keeps trying with -N suffix until unique index accepts the update."""
    n = 0
    while True:
        slug = base if n == 0 else f"{base}-{n}"
        try:
            res = await db.guides.update_one(
                {"id": guide_id, "$or": [{"slug": {"$exists": False}}, {"slug": None}]},
                {"$set": {"slug": slug}},
            )
            if res.modified_count == 0:
                doc = await db.guides.find_one({"id": guide_id}, {"_id": 0, "slug": 1})
                if doc and doc.get("slug"):
                    return doc["slug"]
            return slug
        except DuplicateKeyError:
            n += 1
            if n > 50:
                raise HTTPException(status_code=500, detail="Slug collision")


async def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing authorization")
    token = authorization.split(" ", 1)[1].strip()
    session = await db.user_sessions.find_one({"session_token": token}, {"_id": 0})
    if not session:
        raise HTTPException(status_code=401, detail="Invalid session")
    if _norm_dt(session["expires_at"]) < datetime.now(timezone.utc):
        await db.user_sessions.delete_one({"session_token": token})
        raise HTTPException(status_code=401, detail="Session expired")
    user = await db.users.find_one({"user_id": session["user_id"]}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def _user_doc_to_model(d: dict) -> dict:
    return {
        "user_id": d["user_id"],
        "email": d["email"],
        "name": d.get("name", ""),
        "username": d.get("username"),
        "picture": d.get("picture"),
        "bio": d.get("bio", ""),
        "home_name": d.get("home_name"),
        "home_longitude": d.get("home_longitude"),
        "home_latitude": d.get("home_latitude"),
        "work_name": d.get("work_name"),
        "work_longitude": d.get("work_longitude"),
        "work_latitude": d.get("work_latitude"),
        "created_at": d["created_at"],
    }


async def _public_user(user_id: str, viewer_id: Optional[str] = None):
    # Local import to avoid circular dep.
    from models import PublicUser
    u = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    if not u:
        return PublicUser(user_id=user_id, name="Unknown")
    stats = {
        "places": await db.places.count_documents({"user_id": user_id}),
        "guides": await db.guides.count_documents({"user_id": user_id}),
        "reviews": await db.reviews.count_documents({"user_id": user_id}),
        "followers": await db.follows.count_documents({"followee_id": user_id}),
        "following": await db.follows.count_documents({"follower_id": user_id}),
        "friends": await db.friendships.count_documents({
            "$or": [{"a": user_id}, {"b": user_id}],
        }),
    }
    is_following = False
    is_followed_by = False
    friend_status = "none"
    if viewer_id and viewer_id != user_id:
        is_following = bool(await db.follows.find_one(
            {"follower_id": viewer_id, "followee_id": user_id}, {"_id": 0}
        ))
        is_followed_by = bool(await db.follows.find_one(
            {"follower_id": user_id, "followee_id": viewer_id}, {"_id": 0}
        ))
        # Friend status
        a, b = sorted([viewer_id, user_id])
        if await db.friendships.find_one({"a": a, "b": b}, {"_id": 0}):
            friend_status = "friends"
        else:
            sent = await db.friend_requests.find_one(
                {"from_id": viewer_id, "to_id": user_id, "status": "pending"}, {"_id": 0}
            )
            recv = await db.friend_requests.find_one(
                {"from_id": user_id, "to_id": viewer_id, "status": "pending"}, {"_id": 0}
            )
            if sent: friend_status = "request_sent"
            elif recv: friend_status = "request_received"
    return PublicUser(
        user_id=u["user_id"],
        name=u.get("name", ""),
        username=u.get("username"),
        picture=u.get("picture"),
        bio=u.get("bio", ""),
        stats=stats,
        is_following=is_following,
        is_followed_by=is_followed_by,
        friend_status=friend_status,
    )


def _conv_key(a: str, b: str) -> str:
    return "::".join(sorted([a, b]))


def _new_share_id() -> str:
    return uuid.uuid4().hex[:10]
