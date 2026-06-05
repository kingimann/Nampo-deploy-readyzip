"""Shared dependencies, DB connection, helpers, and auth.

All route modules import from here.
"""
from __future__ import annotations

import os
import re
import uuid
import logging
from pathlib import Path
from datetime import datetime, timedelta, timezone
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
    # Developer API keys are a paid add-on and require an active plan.
    if session.get("kind") == "api_key":
        if not _has_api_access(user):
            raise HTTPException(
                status_code=402,
                detail={
                    "code": "api_plan_required",
                    "message": "This API key needs an active Developer API plan. Subscribe in Settings → Developer API.",
                    "plans": [{"id": p["id"], "name": p["name"], "price": p["price"]} for p in API_PLANS],
                },
            )
        # Usage-based metering: count this request against the period quota,
        # raising 429 (with pay-as-you-go options) when the limit is hit.
        await _check_and_bump_api_usage(user, token)
        # Best-effort "last used" tracking (throttled to once an hour so it
        # doesn't write on every request). Never blocks the request.
        try:
            now = datetime.now(timezone.utc)
            last = session.get("last_used_at")
            if not last or (now - _norm_dt(last)).total_seconds() > 3600:
                await db.user_sessions.update_one(
                    {"session_token": token}, {"$set": {"last_used_at": now}}
                )
        except Exception:
            pass
    return user


# Current legal policy versions. Bump these (to the new effective date) whenever
# the Terms of Service or Privacy Policy materially change — anyone who agreed to
# an older version is re-prompted to accept before they can keep using the app.
TOS_VERSION = "2026-06-05"
PRIVACY_VERSION = "2026-06-05"


# Developer API is a paid add-on with tiered plans — higher tier, more access.
# Each plan is billed per 30 days.
API_PLANS = [
    {"id": "basic",    "name": "Basic",    "price": 9.99,  "level": 1,
     "max_keys": 2,  "write": False, "webhooks": False, "rate_per_min": 60,    "monthly_quota": 10_000},
    {"id": "pro",      "name": "Pro",      "price": 29.99, "level": 2,
     "max_keys": 10, "write": True,  "webhooks": True,  "rate_per_min": 600,   "monthly_quota": 200_000},
    {"id": "business", "name": "Business", "price": 99.99, "level": 3,
     "max_keys": 50, "write": True,  "webhooks": True,  "rate_per_min": 6000,  "monthly_quota": 2_000_000},
]
API_PLANS_BY_ID = {p["id"]: p for p in API_PLANS}

# Pay-as-you-go overage packs — buy more requests for the current period when you
# hit your plan's quota (instead of waiting for the monthly reset).
API_OVERAGE_PACKS = [
    {"id": "pack_50k",  "name": "50k requests",  "requests": 50_000,  "price": 5.0},
    {"id": "pack_250k", "name": "250k requests", "requests": 250_000, "price": 20.0},
    {"id": "pack_1m",   "name": "1M requests",   "requests": 1_000_000, "price": 60.0},
]
API_OVERAGE_BY_ID = {p["id"]: p for p in API_OVERAGE_PACKS}
USAGE_PERIOD_DAYS = 30


async def _check_and_bump_api_usage(user: dict, token: str) -> None:
    """Per-period request metering for API keys. Raises 429 when over quota
    (plan quota + purchased pay-as-you-go credits). Best-effort increment."""
    plan = _active_plan(user)
    if not plan:
        return  # access already enforced upstream
    now = datetime.now(timezone.utc)
    start = user.get("api_usage_period_start")
    try:
        start_dt = _norm_dt(start) if start else None
    except Exception:
        start_dt = None
    # New period → reset counter and consumed overage.
    if not start_dt or (now - start_dt).days >= USAGE_PERIOD_DAYS:
        await db.users.update_one(
            {"user_id": user["user_id"]},
            {"$set": {"api_usage_period_start": now, "api_usage_count": 0, "api_extra_credits": 0}},
        )
        used, extra, start_dt = 0, 0, now
    else:
        used = int(user.get("api_usage_count", 0) or 0)
        extra = int(user.get("api_extra_credits", 0) or 0)
    limit = int(plan.get("monthly_quota", 0)) + extra
    if used >= limit:
        resets_at = start_dt + timedelta(days=USAGE_PERIOD_DAYS)
        raise HTTPException(status_code=429, detail={
            "code": "quota_exceeded",
            "message": "Monthly request quota reached. Buy a pay-as-you-go pack or wait for the reset.",
            "used": used, "limit": limit,
            "resets_at": resets_at.isoformat(),
            "packs": [{"id": p["id"], "name": p["name"], "price": p["price"]} for p in API_OVERAGE_PACKS],
        })
    try:
        await db.users.update_one({"user_id": user["user_id"]}, {"$inc": {"api_usage_count": 1}})
    except Exception:
        pass


def _active_plan(user: dict) -> Optional[dict]:
    """Return the user's active API plan dict, or None if expired/none."""
    until = user.get("api_access_until")
    if not until:
        return None
    try:
        if _norm_dt(until) <= datetime.now(timezone.utc):
            return None
    except Exception:
        return None
    return API_PLANS_BY_ID.get(user.get("api_plan") or "basic")


def _has_api_access(user: dict) -> bool:
    return _active_plan(user) is not None


# Fixed subscription tiers a fan chooses from (creators don't set custom prices).
SUBSCRIPTION_TIERS = [
    {"id": "basic", "name": "Basic", "price": 2.99},
    {"id": "plus",  "name": "Plus",  "price": 4.99},
    {"id": "vip",   "name": "VIP",   "price": 9.99},
]
SUBSCRIPTION_TIERS_BY_ID = {t["id"]: t for t in SUBSCRIPTION_TIERS}


def _needs_policy_agreement(d: dict) -> bool:
    return (
        str(d.get("tos_version") or "") != TOS_VERSION
        or str(d.get("privacy_version") or "") != PRIVACY_VERSION
    )


def _user_doc_to_model(d: dict) -> dict:
    return {
        "user_id": d["user_id"],
        "email": d["email"],
        "needs_policy_agreement": _needs_policy_agreement(d),
        "name": d.get("name", ""),
        "username": d.get("username"),
        "picture": d.get("picture"),
        "phone": d.get("phone"),
        "phone_verified": bool(d.get("phone_verified", False)),
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
        "payout_frequency": d.get("payout_frequency") or "monthly",
        "payout_threshold": float(d.get("payout_threshold", 0) or 0),
        "ad_balance": round(float(d.get("ad_balance", 0) or 0), 2),
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
