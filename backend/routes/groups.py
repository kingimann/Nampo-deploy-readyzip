"""Groups + group posts (Facebook-style — full Post features inside groups)."""
from datetime import datetime, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict
from db import DuplicateKeyError

from core import db, get_current_user
from models import Group, GroupCreate, GroupEvent, GroupEventCreate, Post, PostCreate
from routes.posts import _hydrate_post, create_post as create_post_route
try:
    from routes.notifications import emit_notification  # type: ignore
except Exception:  # pragma: no cover
    emit_notification = None  # type: ignore


async def _notify(user_id: str, actor_id: str, ntype: str, group_id: str):
    if not emit_notification:
        return
    try:
        await emit_notification(
            user_id=user_id, actor_id=actor_id,
            ntype=ntype, group_id=group_id,
        )
    except Exception:
        pass

router = APIRouter()


async def _hydrate_group(doc: dict, viewer_id: Optional[str]) -> Group:
    count = await db.group_members.count_documents({"group_id": doc["id"]})
    is_member = False
    my_role = "member"
    membership_pending = False
    pending_count = 0
    if viewer_id:
        mem = await db.group_members.find_one(
            {"group_id": doc["id"], "user_id": viewer_id}, {"_id": 0}
        )
        if mem:
            is_member = True
            my_role = mem.get("role", "member")
        else:
            req = await db.group_join_requests.find_one(
                {"group_id": doc["id"], "user_id": viewer_id, "status": "pending"},
                {"_id": 0},
            )
            if req:
                membership_pending = True
        # Owners and admins see request count
        if my_role in ("owner", "admin") and is_member:
            pending_count = await db.group_join_requests.count_documents(
                {"group_id": doc["id"], "status": "pending"}
            )
    return Group(
        id=doc["id"], name=doc["name"],
        description=doc.get("description", ""),
        color=doc.get("color", "#3B82F6"),
        cover_image=doc.get("cover_image"),
        is_private=bool(doc.get("is_private", False)),
        rules=list(doc.get("rules", [])),
        owner_id=doc["owner_id"],
        member_count=count,
        is_member=is_member,
        membership_pending=membership_pending,
        my_role=my_role,
        pending_request_count=pending_count,
        pinned_post_ids=list(doc.get("pinned_post_ids", []))[:3],
        created_at=doc["created_at"],
    )


@router.post("/groups", response_model=Group)
async def create_group(body: GroupCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    name = (body.name or "").strip()[:80]
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "name": name,
        "description": (body.description or "")[:500],
        "color": body.color or "#3B82F6",
        "is_private": bool(body.is_private),
        "owner_id": user["user_id"],
        "created_at": now,
    }
    await db.groups.insert_one(doc.copy())
    await db.group_members.insert_one({
        "group_id": doc["id"], "user_id": user["user_id"],
        "role": "owner", "joined_at": now,
    })
    return await _hydrate_group(doc, user["user_id"])


@router.get("/groups", response_model=List[Group])
async def list_groups(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    cursor = db.groups.find({}, {"_id": 0}).sort("created_at", -1).limit(100)
    docs = await cursor.to_list(100)
    return [await _hydrate_group(d, user["user_id"]) for d in docs]


@router.get("/groups/{group_id}", response_model=Group)
async def get_group(group_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.groups.find_one({"id": group_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Group not found")
    return await _hydrate_group(doc, user["user_id"])


# --- §1 response models (extra="allow" so no field is ever dropped) ----------
class _GOut(BaseModel):
    model_config = ConfigDict(extra="allow")


class OkOut(_GOut):
    ok: bool = True


class RsvpOut(_GOut):
    going: bool = False
    going_count: int = 0


class GroupRequestItem(_GOut):
    user_id: str = ""
    name: str = ""
    username: Optional[str] = None
    picture: Optional[str] = None
    created_at: Optional[datetime] = None


class GroupMemberItem(_GOut):
    user_id: str = ""
    name: str = ""
    username: Optional[str] = None
    picture: Optional[str] = None
    role: str = "member"
    joined_at: Optional[datetime] = None


@router.delete("/groups/{group_id}", response_model=OkOut)
async def delete_group(group_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.groups.find_one({"id": group_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Group not found")
    if doc["owner_id"] != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only the owner can delete")
    await db.groups.delete_one({"id": group_id})
    await db.group_members.delete_many({"group_id": group_id})
    # Clean up unified posts that belong to this group
    await db.posts.delete_many({"group_id": group_id})
    return {"ok": True}


class _GroupPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None
    cover_image: Optional[str] = None
    is_private: Optional[bool] = None
    rules: Optional[List[str]] = None


@router.patch("/groups/{group_id}", response_model=Group)
async def update_group(
    group_id: str, body: _GroupPatch, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    doc = await db.groups.find_one({"id": group_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Group not found")
    if doc["owner_id"] != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only the owner can edit")
    updates: dict = {}
    if body.name is not None:
        n = body.name.strip()[:80]
        if not n:
            raise HTTPException(status_code=400, detail="Name required")
        updates["name"] = n
    if body.description is not None:
        updates["description"] = body.description[:500]
    if body.color is not None:
        updates["color"] = body.color
    if body.cover_image is not None:
        # accept data URI or empty string to clear
        cov = body.cover_image.strip()
        if cov and not cov.startswith("data:image/") and not cov.startswith("http"):
            raise HTTPException(status_code=400, detail="Invalid cover image")
        # cap base64 size at ~4MB to avoid blowing up Mongo docs
        if len(cov) > 6_500_000:
            raise HTTPException(status_code=400, detail="Image too large")
        updates["cover_image"] = cov or None
    if body.is_private is not None:
        updates["is_private"] = bool(body.is_private)
    if body.rules is not None:
        cleaned: list = []
        for r in body.rules:
            s = str(r or "").strip()[:200]
            if s:
                cleaned.append(s)
            if len(cleaned) >= 15:
                break
        updates["rules"] = cleaned
    if updates:
        await db.groups.update_one({"id": group_id}, {"$set": updates})
    fresh = await db.groups.find_one({"id": group_id}, {"_id": 0})
    return await _hydrate_group(fresh, user["user_id"])


# ───────── Pinned posts (owner-only, max 3) ─────────
PIN_LIMIT = 3


@router.post("/groups/{group_id}/pins/{post_id}", response_model=Group)
async def pin_post(group_id: str, post_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    grp = await db.groups.find_one({"id": group_id}, {"_id": 0})
    if not grp:
        raise HTTPException(status_code=404, detail="Group not found")
    if grp["owner_id"] != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only the owner can pin")
    post = await db.posts.find_one(
        {"id": post_id, "group_id": group_id}, {"_id": 0, "id": 1}
    )
    if not post:
        raise HTTPException(status_code=404, detail="Post not in this group")
    pins: List[str] = list(grp.get("pinned_post_ids", []) or [])
    if post_id in pins:
        # already pinned — return current state
        return await _hydrate_group(grp, user["user_id"])
    pins.insert(0, post_id)
    pins = pins[:PIN_LIMIT]
    await db.groups.update_one({"id": group_id}, {"$set": {"pinned_post_ids": pins}})
    fresh = await db.groups.find_one({"id": group_id}, {"_id": 0})
    return await _hydrate_group(fresh, user["user_id"])


@router.delete("/groups/{group_id}/pins/{post_id}", response_model=Group)
async def unpin_post(group_id: str, post_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    grp = await db.groups.find_one({"id": group_id}, {"_id": 0})
    if not grp:
        raise HTTPException(status_code=404, detail="Group not found")
    if grp["owner_id"] != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only the owner can unpin")
    pins: List[str] = [p for p in (grp.get("pinned_post_ids", []) or []) if p != post_id]
    await db.groups.update_one({"id": group_id}, {"$set": {"pinned_post_ids": pins}})
    fresh = await db.groups.find_one({"id": group_id}, {"_id": 0})
    return await _hydrate_group(fresh, user["user_id"])


@router.get("/groups/{group_id}/pins", response_model=List[Post])
async def list_pinned_posts(group_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    grp = await db.groups.find_one({"id": group_id}, {"_id": 0})
    if not grp:
        raise HTTPException(status_code=404, detail="Group not found")
    member = await db.group_members.find_one(
        {"group_id": group_id, "user_id": user["user_id"]}, {"_id": 0}
    )
    if not member:
        raise HTTPException(status_code=403, detail="Not a member")
    pins = list(grp.get("pinned_post_ids", []) or [])
    if not pins:
        return []
    docs = await db.posts.find(
        {"id": {"$in": pins}, "group_id": group_id}, {"_id": 0}
    ).to_list(PIN_LIMIT)
    # Preserve pin order
    by_id = {d["id"]: d for d in docs}
    ordered = [by_id[p] for p in pins if p in by_id]
    return [await _hydrate_post(d, user["user_id"]) for d in ordered]


@router.post("/groups/{group_id}/join", response_model=Group)
async def join_group(group_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.groups.find_one({"id": group_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Group not found")

    # Already a member? no-op.
    existing = await db.group_members.find_one(
        {"group_id": group_id, "user_id": user["user_id"]}, {"_id": 0}
    )
    if existing:
        return await _hydrate_group(doc, user["user_id"])

    # Private group → create / re-activate a join request instead.
    if doc.get("is_private"):
        await db.group_join_requests.update_one(
            {"group_id": group_id, "user_id": user["user_id"]},
            {"$set": {
                "group_id": group_id, "user_id": user["user_id"],
                "status": "pending",
                "created_at": datetime.now(timezone.utc),
            }},
            upsert=True,
        )
        # Notify the owner.
        await _notify(doc["owner_id"], user["user_id"], "group_join_request", group_id)
        return await _hydrate_group(doc, user["user_id"])

    # Public group → join immediately.
    try:
        await db.group_members.insert_one({
            "group_id": group_id, "user_id": user["user_id"],
            "role": "member", "joined_at": datetime.now(timezone.utc),
        })
    except DuplicateKeyError:
        pass
    return await _hydrate_group(doc, user["user_id"])


@router.post("/groups/{group_id}/leave", response_model=Group)
async def leave_group(group_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.groups.find_one({"id": group_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Group not found")
    if doc["owner_id"] == user["user_id"]:
        raise HTTPException(status_code=400, detail="Owner cannot leave; delete instead")
    await db.group_members.delete_one({"group_id": group_id, "user_id": user["user_id"]})
    # Also clear any pending request the user may have had
    await db.group_join_requests.delete_one(
        {"group_id": group_id, "user_id": user["user_id"]}
    )
    return await _hydrate_group(doc, user["user_id"])


# ───────── Admin actions (owner / admin) ─────────

async def _require_admin(group_id: str, user_id: str):
    doc = await db.groups.find_one({"id": group_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Group not found")
    mem = await db.group_members.find_one(
        {"group_id": group_id, "user_id": user_id}, {"_id": 0}
    )
    role = mem.get("role") if mem else None
    if role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Admins only")
    return doc, role


@router.post("/groups/{group_id}/members/{target_id}/promote", response_model=Group)
async def promote_member(
    group_id: str, target_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    doc = await db.groups.find_one({"id": group_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Group not found")
    if doc["owner_id"] != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only the owner can promote")
    if target_id == doc["owner_id"]:
        raise HTTPException(status_code=400, detail="Owner is already top-level")
    r = await db.group_members.update_one(
        {"group_id": group_id, "user_id": target_id},
        {"$set": {"role": "admin"}},
    )
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Not a member")
    return await _hydrate_group(doc, user["user_id"])


@router.post("/groups/{group_id}/members/{target_id}/demote", response_model=Group)
async def demote_member(
    group_id: str, target_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    doc = await db.groups.find_one({"id": group_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Group not found")
    if doc["owner_id"] != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only the owner can demote")
    if target_id == doc["owner_id"]:
        raise HTTPException(status_code=400, detail="Cannot demote the owner")
    r = await db.group_members.update_one(
        {"group_id": group_id, "user_id": target_id},
        {"$set": {"role": "member"}},
    )
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Not a member")
    return await _hydrate_group(doc, user["user_id"])


@router.delete("/groups/{group_id}/members/{target_id}", response_model=Group)
async def kick_member(
    group_id: str, target_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    doc, my_role = await _require_admin(group_id, user["user_id"])
    if target_id == doc["owner_id"]:
        raise HTTPException(status_code=400, detail="Cannot kick the owner")
    # Admin cannot kick another admin (only owner can)
    if my_role == "admin":
        t = await db.group_members.find_one(
            {"group_id": group_id, "user_id": target_id}, {"_id": 0}
        )
        if t and t.get("role") == "admin":
            raise HTTPException(status_code=403, detail="Only the owner can kick admins")
    await db.group_members.delete_one({"group_id": group_id, "user_id": target_id})
    return await _hydrate_group(doc, user["user_id"])


# ───────── Join requests (private groups) ─────────

@router.get("/groups/{group_id}/requests", response_model=List[GroupRequestItem])
async def list_join_requests(
    group_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    await _require_admin(group_id, user["user_id"])
    rows = await db.group_join_requests.find(
        {"group_id": group_id, "status": "pending"}, {"_id": 0}
    ).sort("created_at", 1).to_list(200)
    out = []
    uids = [r["user_id"] for r in rows]
    udocs = await db.users.find({"user_id": {"$in": uids}}, {"_id": 0}).to_list(len(uids) or 1)
    umap = {u["user_id"]: u for u in udocs}
    for r in rows:
        u = umap.get(r["user_id"])
        if not u:
            continue
        out.append({
            "user_id": u["user_id"],
            "name": u.get("name", ""),
            "username": u.get("username"),
            "picture": u.get("picture"),
            "created_at": r["created_at"],
        })
    return out


@router.post("/groups/{group_id}/requests/{target_id}/approve", response_model=Group)
async def approve_request(
    group_id: str, target_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    doc, _ = await _require_admin(group_id, user["user_id"])
    req = await db.group_join_requests.find_one(
        {"group_id": group_id, "user_id": target_id, "status": "pending"}, {"_id": 0}
    )
    if not req:
        raise HTTPException(status_code=404, detail="No pending request")
    try:
        await db.group_members.insert_one({
            "group_id": group_id, "user_id": target_id,
            "role": "member", "joined_at": datetime.now(timezone.utc),
        })
    except DuplicateKeyError:
        pass
    await db.group_join_requests.update_one(
        {"group_id": group_id, "user_id": target_id},
        {"$set": {"status": "approved", "decided_at": datetime.now(timezone.utc),
                  "decided_by": user["user_id"]}},
    )
    await _notify(target_id, user["user_id"], "group_request_approved", group_id)
    return await _hydrate_group(doc, user["user_id"])


@router.post("/groups/{group_id}/requests/{target_id}/reject", response_model=Group)
async def reject_request(
    group_id: str, target_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    doc, _ = await _require_admin(group_id, user["user_id"])
    r = await db.group_join_requests.update_one(
        {"group_id": group_id, "user_id": target_id, "status": "pending"},
        {"$set": {"status": "rejected", "decided_at": datetime.now(timezone.utc),
                  "decided_by": user["user_id"]}},
    )
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="No pending request")
    await _notify(target_id, user["user_id"], "group_request_rejected", group_id)
    return await _hydrate_group(doc, user["user_id"])


@router.get("/groups/{group_id}/posts", response_model=List[Post])
async def list_group_posts(group_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    grp = await db.groups.find_one({"id": group_id}, {"_id": 0, "id": 1})
    if not grp:
        raise HTTPException(status_code=404, detail="Group not found")
    member = await db.group_members.find_one(
        {"group_id": group_id, "user_id": user["user_id"]}, {"_id": 0}
    )
    if not member:
        raise HTTPException(status_code=403, detail="Not a member")
    # Use main posts collection — group posts are real Posts scoped to group_id.
    cursor = (
        db.posts.find(
            {"group_id": group_id, "parent_id": None},
            {"_id": 0},
        ).sort("created_at", -1).limit(100)
    )
    docs = await cursor.to_list(100)
    return [await _hydrate_post(d, user["user_id"]) for d in docs]


@router.post("/groups/{group_id}/posts", response_model=Post)
async def create_group_post(
    group_id: str, body: PostCreate, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    grp = await db.groups.find_one({"id": group_id}, {"_id": 0, "id": 1})
    if not grp:
        raise HTTPException(status_code=404, detail="Group not found")
    member = await db.group_members.find_one(
        {"group_id": group_id, "user_id": user["user_id"]}, {"_id": 0}
    )
    if not member:
        raise HTTPException(status_code=403, detail="Not a member")
    # Delegate to the main post creator (gives us media, polls, link previews,
    # hashtags, etc.) — then stamp group_id on the doc.
    post = await create_post_route(body, authorization)
    await db.posts.update_one({"id": post.id}, {"$set": {"group_id": group_id}})
    # Re-fetch to include group_id on the returned model (model itself doesn't
    # surface it, but consumer reading list endpoint will filter by group_id).
    return post


@router.get("/groups/{group_id}/members", response_model=List[GroupMemberItem])
async def list_group_members(group_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    member = await db.group_members.find_one(
        {"group_id": group_id, "user_id": user["user_id"]}, {"_id": 0}
    )
    if not member:
        raise HTTPException(status_code=403, detail="Not a member")
    rows = await (
        db.group_members.find({"group_id": group_id}, {"_id": 0})
        .sort("joined_at", 1).limit(200).to_list(200)
    )
    out = []
    uids = [r["user_id"] for r in rows]
    udocs = await db.users.find({"user_id": {"$in": uids}}, {"_id": 0}).to_list(len(uids) or 1)
    umap = {u["user_id"]: u for u in udocs}
    for r in rows:
        u = umap.get(r["user_id"])
        if not u:
            continue
        out.append({
            "user_id": u["user_id"],
            "name": u.get("name", ""),
            "username": u.get("username"),
            "picture": u.get("picture"),
            "role": r.get("role", "member"),
            "joined_at": r.get("joined_at"),
        })
    return out


# ───────── Group events (Facebook-style) ─────────

async def _member_or_404(group_id: str, user_id: str) -> dict:
    doc = await db.groups.find_one({"id": group_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Group not found")
    mem = await db.group_members.find_one(
        {"group_id": group_id, "user_id": user_id}, {"_id": 0, "role": 1}
    )
    if not mem:
        raise HTTPException(status_code=403, detail="Join the group first")
    return mem


async def _hydrate_event(e: dict, viewer_id: str, my_role: str = "member") -> GroupEvent:
    going_count = await db.group_event_rsvps.count_documents({"event_id": e["id"]})
    going = bool(await db.group_event_rsvps.find_one(
        {"event_id": e["id"], "user_id": viewer_id}, {"_id": 0, "id": 1}
    ))
    creator = await db.users.find_one({"user_id": e["creator_id"]}, {"_id": 0, "name": 1})
    return GroupEvent(
        id=e["id"], group_id=e["group_id"], creator_id=e["creator_id"],
        creator_name=(creator or {}).get("name", "Someone"),
        title=e.get("title", ""), description=e.get("description", "") or "",
        location=e.get("location"), starts_at=e.get("starts_at", ""),
        going_count=going_count, going=going,
        can_manage=(e["creator_id"] == viewer_id or my_role in ("owner", "admin")),
        created_at=e["created_at"],
    )


@router.get("/groups/{group_id}/events", response_model=List[GroupEvent])
async def list_group_events(group_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    mem = await _member_or_404(group_id, user["user_id"])
    rows = await db.group_events.find({"group_id": group_id}, {"_id": 0}).to_list(200)
    # Soonest first; events without a parseable time sort last.
    def _key(e: dict) -> str:
        return str(e.get("starts_at") or "~")
    rows.sort(key=_key)
    return [await _hydrate_event(e, user["user_id"], mem.get("role", "member")) for e in rows]


@router.post("/groups/{group_id}/events", response_model=GroupEvent)
async def create_group_event(
    group_id: str, body: GroupEventCreate, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    mem = await _member_or_404(group_id, user["user_id"])
    title = (body.title or "").strip()[:140]
    if not title:
        raise HTTPException(status_code=400, detail="Event title required")
    if not (body.starts_at or "").strip():
        raise HTTPException(status_code=400, detail="Event start time required")
    doc = {
        "id": str(uuid.uuid4()), "group_id": group_id, "creator_id": user["user_id"],
        "title": title, "description": (body.description or "").strip()[:1000],
        "location": (body.location or "").strip()[:200] or None,
        "starts_at": body.starts_at.strip()[:40],
        "created_at": datetime.now(timezone.utc),
    }
    await db.group_events.insert_one(doc.copy())
    # The creator is going by default.
    try:
        await db.group_event_rsvps.insert_one({
            "id": str(uuid.uuid4()), "event_id": doc["id"], "user_id": user["user_id"],
            "created_at": datetime.now(timezone.utc),
        })
    except DuplicateKeyError:
        pass
    return await _hydrate_event(doc, user["user_id"], mem.get("role", "member"))


@router.post("/groups/{group_id}/events/{event_id}/rsvp", response_model=RsvpOut)
async def rsvp_group_event(
    group_id: str, event_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    await _member_or_404(group_id, user["user_id"])
    ev = await db.group_events.find_one({"id": event_id, "group_id": group_id}, {"_id": 0, "id": 1})
    if not ev:
        raise HTTPException(status_code=404, detail="Event not found")
    existing = await db.group_event_rsvps.find_one(
        {"event_id": event_id, "user_id": user["user_id"]}, {"_id": 0, "id": 1}
    )
    if existing:
        await db.group_event_rsvps.delete_one({"event_id": event_id, "user_id": user["user_id"]})
        going = False
    else:
        try:
            await db.group_event_rsvps.insert_one({
                "id": str(uuid.uuid4()), "event_id": event_id, "user_id": user["user_id"],
                "created_at": datetime.now(timezone.utc),
            })
        except DuplicateKeyError:
            pass
        going = True
    count = await db.group_event_rsvps.count_documents({"event_id": event_id})
    return {"going": going, "going_count": count}


@router.delete("/groups/{group_id}/events/{event_id}", response_model=OkOut)
async def delete_group_event(
    group_id: str, event_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    ev = await db.group_events.find_one({"id": event_id, "group_id": group_id}, {"_id": 0})
    if not ev:
        raise HTTPException(status_code=404, detail="Event not found")
    mem = await db.group_members.find_one(
        {"group_id": group_id, "user_id": user["user_id"]}, {"_id": 0, "role": 1}
    )
    role = (mem or {}).get("role")
    if ev["creator_id"] != user["user_id"] and role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Only the creator or an admin can delete this event")
    await db.group_events.delete_one({"id": event_id})
    await db.group_event_rsvps.delete_many({"event_id": event_id})
    return {"ok": True}
