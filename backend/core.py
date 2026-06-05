"""Shared dependencies, DB connection, helpers, and auth.

All route modules import from here.
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

from db import Database, DuplicateKeyError, init_db  # noqa: F401 – re-exported

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

FSQ_API_KEY = os.environ.get("FSQ_API_KEY", "")
FSQ_BASE = "https://places-api.foursquare.com/places"

logger = logging.getLogger("server")

# ── Lazy proxy so `from core import db` works in all route modules even
#    though the real Database is created asynchronously during startup. ──
_real_db: Optional[Database] = None


class _DbProxy:
    """Forwards attribute access to the real Database once it is initialised."""

    def __getattr__(self, name: str):
        if _real_db is None:
            raise RuntimeError("Database not initialised — call init_pool() first")
        return getattr(_real_db, name)


db: Database = _DbProxy()  # type: ignore[assignment]


async def init_pool() -> None:
    global _real_db
    dsn = os.environ["DATABASE_URL"]
    _real_db = await init_db(dsn)
    # Self-provision the ephemeral OAuth CSRF-state table (jsonb-doc pattern,
    # like the other collections) so Google sign-in works in dev and prod.
    # Provision the collections that depend on a UNIQUE index for correctness
    # (the route code relies on DuplicateKeyError for idempotency/uniqueness).
    # Every other collection self-provisions on first write (see db.py). On a
    # fresh database none of these exist yet, which is why a brand-new deploy
    # would otherwise 500 on register/login.
    _UNIQUE_INDEXES = [
        ("users", "uniq_users_email", "((doc ->> 'email'))"),
        ("users", "uniq_users_username", "((doc ->> 'username'))"),
        ("user_sessions", "uniq_user_sessions_token", "((doc ->> 'session_token'))"),
        ("post_likes", "uniq_post_likes", "((doc ->> 'post_id'), (doc ->> 'user_id'))"),
        ("post_dislikes", "uniq_post_dislikes", "((doc ->> 'post_id'), (doc ->> 'user_id'))"),
        ("post_bookmarks", "uniq_post_bookmarks", "((doc ->> 'post_id'), (doc ->> 'user_id'))"),
        ("post_views", "uniq_post_views", "((doc ->> 'post_id'), (doc ->> 'user_id'))"),
        ("follows", "uniq_follows", "((doc ->> 'follower_id'), (doc ->> 'followee_id'))"),
        ("group_members", "uniq_group_members", "((doc ->> 'group_id'), (doc ->> 'user_id'))"),
        ("custom_emojis", "uniq_custom_emoji_code", "((doc ->> 'shortcode'))"),
        ("communities", "uniq_community_name", "((doc ->> 'name'))"),
        ("community_members", "uniq_community_member", "((doc ->> 'community_id'), (doc ->> 'user_id'))"),
    ]
    async with _real_db._pool.acquire() as conn:
        for table, idx, cols in _UNIQUE_INDEXES:
            await conn.execute(f"CREATE TABLE IF NOT EXISTS {table} (doc jsonb NOT NULL)")
            await conn.execute(
                f"CREATE UNIQUE INDEX IF NOT EXISTS {idx} ON {table} {cols}"
            )
    logger.info("PostgreSQL pool ready")


def _norm_dt(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "guide"


async def _try_set_unique_slug(guide_id: str, base: str) -> str:
    """Find an unused slug and stamp it on the guide."""
    n = 0
    while True:
        slug = base if n == 0 else f"{base}-{n}"
        existing = await db.guides.find_one({"slug": slug})
        if not existing or existing.get("id") == guide_id:
            await db.guides.update_one(
                {"id": guide_id},
                {"$set": {"slug": slug}},
            )
            return slug
        n += 1
        if n > 50:
            raise HTTPException(status_code=500, detail="Slug collision")


async def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing authorization")
    token = authorization.split(" ", 1)[1].strip()
    session = await db.user_sessions.find_one({"session_token": token})
    if not session:
        raise HTTPException(status_code=401, detail="Invalid session")
    if _norm_dt(session["expires_at"]) < datetime.now(timezone.utc):
        await db.user_sessions.delete_one({"session_token": token})
        raise HTTPException(status_code=401, detail="Session expired")
    user = await db.users.find_one({"user_id": session["user_id"]})
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
        "verified": bool(d.get("verified", False)),
        "role": _effective_role(d),
        "sub_price": float(d.get("sub_price", 4.99) or 0),
        "created_at": d["created_at"],
    }


# Site-wide moderation roles. The repo owner bootstraps themselves as admin by
# listing their email in ADMIN_EMAILS; everything else is granted in-app.
ADMIN_EMAILS = {
    e.strip().lower()
    for e in (os.environ.get("ADMIN_EMAILS", "") or "").split(",")
    if e.strip()
}


def _effective_role(d: dict) -> str:
    if (d.get("email") or "").strip().lower() in ADMIN_EMAILS:
        return "admin"
    role = d.get("role") or "user"
    return role if role in ("user", "mod", "admin") else "user"


def is_admin(user: dict) -> bool:
    return _effective_role(user) == "admin"


def is_mod(user: dict) -> bool:
    return _effective_role(user) in ("mod", "admin")


async def _public_user(user_id: str, viewer_id: Optional[str] = None):
    from models import PublicUser
    u = await db.users.find_one({"user_id": user_id})
    if not u:
        return PublicUser(user_id=user_id, name="Unknown")
    stats = {
        "places": await db.places.count_documents({"user_id": user_id}),
        "guides": await db.guides.count_documents({"user_id": user_id}),
        "reviews": await db.reviews.count_documents({"user_id": user_id}),
        "followers": await db.follows.count_documents({"followee_id": user_id}),
        "following": await db.follows.count_documents({"follower_id": user_id}),
        "friends": await db.friendships.count_documents(
            {"$or": [{"a": user_id}, {"b": user_id}]}
        ),
    }
    subscriber_count = await db.subscriptions.count_documents(
        {"creator_id": user_id, "status": "active"}
    )
    is_subscribed = False
    if viewer_id and viewer_id != user_id:
        is_subscribed = bool(await db.subscriptions.find_one(
            {"subscriber_id": viewer_id, "creator_id": user_id, "status": "active"}, {"_id": 0}
        ))
    is_following = False
    is_followed_by = False
    friend_status = "none"
    if viewer_id and viewer_id != user_id:
        is_following = bool(
            await db.follows.find_one({"follower_id": viewer_id, "followee_id": user_id})
        )
        is_followed_by = bool(
            await db.follows.find_one({"follower_id": user_id, "followee_id": viewer_id})
        )
        a, b = sorted([viewer_id, user_id])
        if await db.friendships.find_one({"a": a, "b": b}):
            friend_status = "friends"
        else:
            sent = await db.friend_requests.find_one(
                {"from_id": viewer_id, "to_id": user_id, "status": "pending"}
            )
            recv = await db.friend_requests.find_one(
                {"from_id": user_id, "to_id": viewer_id, "status": "pending"}
            )
            if sent:
                friend_status = "request_sent"
            elif recv:
                friend_status = "request_received"
    return PublicUser(
        user_id=u["user_id"],
        name=u.get("name", ""),
        username=u.get("username"),
        picture=u.get("picture"),
        bio=u.get("bio", ""),
        verified=bool(u.get("verified", False)),
        role=_effective_role(u),
        sub_price=float(u.get("sub_price", 4.99) or 0),
        is_subscribed=is_subscribed,
        subscriber_count=subscriber_count,
        stats=stats,
        is_following=is_following,
        is_followed_by=is_followed_by,
        friend_status=friend_status,
    )


def _conv_key(a: str, b: str) -> str:
    return "::".join(sorted([a, b]))


def _new_share_id() -> str:
    return uuid.uuid4().hex[:10]
