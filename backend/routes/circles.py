"""Audience circles — Close-Friends-style layers.

A user creates named circles (e.g. "Work", "Inner Circle", "Hobbies") and adds
people to them. When they post, they can target a circle as the audience, and
only the circle's members (plus the author) can see that post — across feeds,
profiles and direct links. No separate accounts, no per-post member juggling.

Circle document:
  { id, owner_id, name, member_ids: [...], created_at }
"""
from datetime import datetime, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from core import _public_user, db, get_current_user
from models import PublicUser

router = APIRouter()


class CircleCreate(BaseModel):
    name: str
    member_ids: Optional[List[str]] = None


class CirclePatch(BaseModel):
    name: Optional[str] = None
    add_member_ids: Optional[List[str]] = None
    remove_member_ids: Optional[List[str]] = None


def _view(c: dict) -> dict:
    return {
        "id": c["id"],
        "name": c.get("name", ""),
        "member_count": len(c.get("member_ids") or []),
        "member_ids": list(c.get("member_ids") or []),
        "created_at": c.get("created_at"),
    }


def _clean_ids(ids, exclude: str) -> list:
    out, seen = [], set()
    for m in (ids or []):
        if isinstance(m, str) and m and m != exclude and m not in seen:
            seen.add(m)
            out.append(m)
    return out[:2000]


@router.post("/circles")
async def create_circle(body: CircleCreate, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    name = (body.name or "").strip()[:60]
    if not name:
        raise HTTPException(status_code=400, detail="Give the circle a name")
    if await db.circles.count_documents({"owner_id": me["user_id"]}) >= 50:
        raise HTTPException(status_code=400, detail="You can have up to 50 circles")
    doc = {
        "id": str(uuid.uuid4()),
        "owner_id": me["user_id"],
        "name": name,
        "member_ids": _clean_ids(body.member_ids, me["user_id"]),
        "created_at": datetime.now(timezone.utc),
    }
    await db.circles.insert_one(doc.copy())
    return _view(doc)


@router.get("/circles")
async def list_circles(authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    rows = await db.circles.find({"owner_id": me["user_id"]}, {"_id": 0}).sort("created_at", -1).to_list(100)
    return [_view(c) for c in rows]


@router.get("/circles/{circle_id}/members", response_model=List[PublicUser])
async def circle_members(circle_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    c = await db.circles.find_one({"id": circle_id, "owner_id": me["user_id"]}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Circle not found")
    return [await _public_user(uid, me["user_id"]) for uid in (c.get("member_ids") or [])[:500]]


@router.patch("/circles/{circle_id}")
async def update_circle(circle_id: str, body: CirclePatch, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    c = await db.circles.find_one({"id": circle_id, "owner_id": me["user_id"]}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Circle not found")
    members = set(c.get("member_ids") or [])
    members |= set(_clean_ids(body.add_member_ids, me["user_id"]))
    members -= {m for m in (body.remove_member_ids or []) if isinstance(m, str)}
    update: dict = {"member_ids": list(members)[:2000]}
    if body.name is not None and body.name.strip():
        update["name"] = body.name.strip()[:60]
    await db.circles.update_one({"id": circle_id, "owner_id": me["user_id"]}, {"$set": update})
    c.update(update)
    return _view(c)


@router.delete("/circles/{circle_id}")
async def delete_circle(circle_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    res = await db.circles.delete_one({"id": circle_id, "owner_id": me["user_id"]})
    if getattr(res, "deleted_count", 0) != 1:
        raise HTTPException(status_code=404, detail="Circle not found")
    # Posts that targeted this circle now resolve to "circle gone" → visible only
    # to the author (the membership check can never match a deleted circle).
    return {"ok": True}
