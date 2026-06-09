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

import math

from core import db, get_current_user, is_mod as _is_site_mod, _norm_dt
from db import DuplicateKeyError
from models import Community, CommunityCreate, CommunityPatch, Post
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
    role = member.get("role") if member else None
    return Community(
        id=doc["id"], name=doc["name"], title=doc.get("title") or doc["name"],
        description=doc.get("description", ""), color=doc.get("color", "#3B82F6"),
        icon=doc.get("icon", "people"), banner=doc.get("banner"),
        rules=doc.get("rules") or [], flairs=doc.get("flairs") or [],
        owner_id=doc["owner_id"],
        member_count=member_count, post_count=doc.get("post_count", 0),
        is_member=bool(member), role=role,
        can_moderate=role in ("owner", "mod"),
        created_at=doc["created_at"],
    )


def _clean_str_list(items, cap_each: int, cap_len: int) -> list:
    out: list = []
    for it in (items or []):
        s = str(it or "").strip()[:cap_each]
        if s:
            out.append(s)
        if len(out) >= cap_len:
            break
    return out


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
        "banner": (body.banner or None),
        "rules": _clean_str_list(body.rules, 200, 15),
        "flairs": _clean_str_list(body.flairs, 24, 20),
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


async def _attach_karma(posts: List[Post]) -> List[Post]:
    """Set author_karma on each (community) post from the per-community tallies."""
    pairs = {(p.community_id, p.user_id) for p in posts if p.community_id}
    if not pairs:
        return posts
    cids = list({c for c, _ in pairs})
    uids = list({u for _, u in pairs})
    rows = await db.community_karma_totals.find(
        {"community_id": {"$in": cids}, "user_id": {"$in": uids}},
        {"_id": 0, "community_id": 1, "user_id": 1, "karma": 1},
    ).to_list(2000)
    km = {(r["community_id"], r["user_id"]): int(r.get("karma", 0) or 0) for r in rows}
    for p in posts:
        if p.community_id:
            p.author_karma = km.get((p.community_id, p.user_id), 0)
    return posts


# NOTE: must be registered BEFORE "/communities/{name}" so "feed" isn't captured
# as a community name.
@router.get("/communities/feed", response_model=List[Post])
async def communities_feed(authorization: Optional[str] = Header(None)):
    """A single feed of recent threads across all communities you've joined."""
    user = await get_current_user(authorization)
    mems = await db.community_members.find(
        {"user_id": user["user_id"]}, {"_id": 0, "community_id": 1}
    ).limit(500).to_list(500)
    cids = [m["community_id"] for m in mems]
    if not cids:
        return []
    docs = await db.posts.find(
        {"community_id": {"$in": cids}, "parent_id": None}, {"_id": 0}
    ).sort("created_at", -1).limit(100).to_list(100)
    out = [await _hydrate_post(d, user["user_id"]) for d in docs]
    return await _attach_karma(out)


@router.get("/communities/{name}", response_model=Community)
async def get_community(name: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.communities.find_one({"name": name.lower()}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Community not found")
    return await _hydrate_community(doc, user["user_id"])


async def _require_moderator(name: str, user: dict) -> dict:
    """Return the community doc if `user` can moderate it (owner/mod or site mod)."""
    doc = await db.communities.find_one({"name": name.lower()}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Community not found")
    if doc["owner_id"] == user["user_id"] or _is_site_mod(user):
        return doc
    mem = await db.community_members.find_one(
        {"community_id": doc["id"], "user_id": user["user_id"]}, {"_id": 0, "role": 1}
    )
    if not mem or mem.get("role") not in ("owner", "mod"):
        raise HTTPException(status_code=403, detail="Moderators only")
    return doc


@router.patch("/communities/{name}", response_model=Community)
async def edit_community(name: str, body: CommunityPatch, authorization: Optional[str] = Header(None)):
    """Edit community settings (owner/mods): about, look, banner, rules, flairs."""
    user = await get_current_user(authorization)
    doc = await _require_moderator(name, user)
    patch: dict = {}
    if body.title is not None:
        patch["title"] = body.title.strip()[:60] or doc["name"]
    if body.description is not None:
        patch["description"] = body.description.strip()[:500]
    if body.color is not None:
        patch["color"] = body.color
    if body.icon is not None:
        patch["icon"] = body.icon
    if body.banner is not None:
        patch["banner"] = body.banner or None
    if body.rules is not None:
        patch["rules"] = _clean_str_list(body.rules, 200, 15)
    if body.flairs is not None:
        patch["flairs"] = _clean_str_list(body.flairs, 24, 20)
    if patch:
        await db.communities.update_one({"id": doc["id"]}, {"$set": patch})
    fresh = await db.communities.find_one({"id": doc["id"]}, {"_id": 0})
    return await _hydrate_community(fresh, user["user_id"])


@router.post("/communities/{name}/mods/{user_id}")
async def add_moderator(name: str, user_id: str, authorization: Optional[str] = Header(None)):
    """Owner promotes a member to moderator."""
    user = await get_current_user(authorization)
    doc = await db.communities.find_one({"name": name.lower()}, {"_id": 0, "id": 1, "owner_id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Community not found")
    if doc["owner_id"] != user["user_id"] and not _is_site_mod(user):
        raise HTTPException(status_code=403, detail="Only the owner can add moderators")
    res = await db.community_members.update_one(
        {"community_id": doc["id"], "user_id": user_id}, {"$set": {"role": "mod"}}
    )
    if not res.matched_count:
        raise HTTPException(status_code=404, detail="That person isn't a member yet")
    try:
        from routes.notifications import emit_notification
        await emit_notification(user_id=user_id, actor_id=user["user_id"], ntype="community_mod",
                                message=f"in /{name.lower()}")
    except Exception:
        pass
    return {"ok": True}


@router.delete("/communities/{name}/mods/{user_id}")
async def remove_moderator(name: str, user_id: str, authorization: Optional[str] = Header(None)):
    """Owner demotes a moderator back to a regular member."""
    user = await get_current_user(authorization)
    doc = await db.communities.find_one({"name": name.lower()}, {"_id": 0, "id": 1, "owner_id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Community not found")
    if doc["owner_id"] != user["user_id"] and not _is_site_mod(user):
        raise HTTPException(status_code=403, detail="Only the owner can remove moderators")
    await db.community_members.update_one(
        {"community_id": doc["id"], "user_id": user_id}, {"$set": {"role": "member"}}
    )
    return {"ok": True}


@router.get("/communities/{name}/members")
async def list_members(name: str, authorization: Optional[str] = Header(None)):
    """List a community's members with their roles (owner/mod/member)."""
    await get_current_user(authorization)
    doc = await db.communities.find_one({"name": name.lower()}, {"_id": 0, "id": 1, "owner_id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Community not found")
    rows = await db.community_members.find(
        {"community_id": doc["id"]}, {"_id": 0, "user_id": 1, "role": 1, "joined_at": 1}
    ).limit(500).to_list(500)
    ids = [r["user_id"] for r in rows]
    users = {}
    if ids:
        urows = await db.users.find(
            {"user_id": {"$in": ids}},
            {"_id": 0, "user_id": 1, "name": 1, "username": 1, "picture": 1, "verified": 1, "avatar_frame": 1},
        ).to_list(len(ids))
        users = {u["user_id"]: u for u in urows}
    # owner first, then mods, then members
    rank = {"owner": 0, "mod": 1, "member": 2}
    rows.sort(key=lambda r: rank.get(r.get("role"), 3))
    out = []
    for r in rows:
        u = users.get(r["user_id"], {})
        out.append({
            "user_id": r["user_id"],
            "name": u.get("name", ""),
            "username": u.get("username"),
            "picture": u.get("picture"),
            "avatar_frame": u.get("avatar_frame"),
            "verified": bool(u.get("verified", False)),
            "role": r.get("role", "member"),
        })
    return {"members": out}


@router.delete("/communities/{name}/members/{user_id}")
async def remove_member(name: str, user_id: str, authorization: Optional[str] = Header(None)):
    """Moderator removes a member from the community."""
    user = await get_current_user(authorization)
    doc = await _require_moderator(name, user)
    if user_id == doc["owner_id"]:
        raise HTTPException(status_code=400, detail="The owner can't be removed")
    # Only the owner can remove a fellow moderator.
    target = await db.community_members.find_one(
        {"community_id": doc["id"], "user_id": user_id}, {"_id": 0, "role": 1}
    )
    if target and target.get("role") == "mod" and doc["owner_id"] != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only the owner can remove a moderator")
    await db.community_members.delete_one({"community_id": doc["id"], "user_id": user_id})
    return {"ok": True}


@router.post("/communities/{name}/posts/{post_id}/remove")
async def remove_community_post(name: str, post_id: str, authorization: Optional[str] = Header(None)):
    """Moderator removes a post from the community."""
    user = await get_current_user(authorization)
    doc = await _require_moderator(name, user)
    post = await db.posts.find_one({"id": post_id, "community_id": doc["id"]}, {"_id": 0, "id": 1, "user_id": 1})
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    await db.posts.delete_one({"id": post_id})
    for coll in (db.post_likes, db.post_dislikes, db.post_bookmarks,
                 db.post_reactions, db.post_views, db.poll_votes):
        await coll.delete_many({"post_id": post_id})
    try:
        from routes.notifications import emit_notification
        await emit_notification(user_id=post["user_id"], actor_id=user["user_id"],
                                ntype="community_removed", message=f"in /{name.lower()}")
    except Exception:
        pass
    return {"ok": True}


@router.post("/communities/{name}/posts/{post_id}/pin")
async def pin_community_post(name: str, post_id: str, authorization: Optional[str] = Header(None)):
    """Moderator pins/unpins a post to the top of the community."""
    user = await get_current_user(authorization)
    doc = await _require_moderator(name, user)
    post = await db.posts.find_one({"id": post_id, "community_id": doc["id"]}, {"_id": 0, "pinned": 1, "user_id": 1})
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    new_val = not bool(post.get("pinned"))
    await db.posts.update_one({"id": post_id}, {"$set": {"pinned": new_val}})
    if new_val:
        try:
            from routes.notifications import emit_notification
            await emit_notification(user_id=post["user_id"], actor_id=user["user_id"],
                                    ntype="community_pin", post_id=post_id, message=f"in /{name.lower()}")
        except Exception:
            pass
    return {"pinned": new_val}


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
    name: str,
    sort: str = Query("hot"),
    flair: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    user = await get_current_user(authorization)
    doc = await db.communities.find_one({"name": name.lower()}, {"_id": 0, "id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Community not found")
    q: dict = {"community_id": doc["id"], "parent_id": None}
    if flair and flair.strip():
        q["flair"] = flair.strip()[:24]
    docs = await db.posts.find(q, {"_id": 0}).sort("created_at", -1).limit(400).to_list(400)

    def votes(d: dict) -> int:
        return int(d.get("likes_count", 0) or 0) - int(d.get("dislikes_count", 0) or 0)

    def age_hours(d: dict) -> float:
        try:
            return max(0.0, (datetime.now(timezone.utc) - _norm_dt(d["created_at"])).total_seconds() / 3600.0)
        except Exception:
            return 9999.0

    if sort == "top":
        docs.sort(key=votes, reverse=True)
    elif sort == "rising":
        # Recent posts gaining votes fast (last 24h, by votes/age).
        recent = [d for d in docs if age_hours(d) <= 24]
        recent.sort(key=lambda d: votes(d) / (age_hours(d) + 2.0), reverse=True)
        docs = recent or docs
    elif sort == "hot":
        # Reddit-style hot: vote score dampened by age so fresh posts surface.
        def hot(d: dict) -> float:
            v = votes(d)
            sign = 1 if v > 0 else (-1 if v < 0 else 0)
            order = math.log10(max(abs(v), 1))
            return round(sign * order - age_hours(d) / 12.0, 6)
        docs.sort(key=hot, reverse=True)
    # "new" keeps the created_at-desc order from the query
    docs.sort(key=lambda d: not d.get("pinned", False))  # pinned first (stable)
    out = [await _hydrate_post(d, user["user_id"]) for d in docs]
    return await _attach_karma(out)
