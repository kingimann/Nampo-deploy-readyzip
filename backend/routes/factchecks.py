"""Factcheck — community notes on posts (X Community Notes-style).

Anyone can propose a note (with a required source link) on a post. Others rate
it Helpful / Not helpful; once a note clears the helpfulness threshold it becomes
publicly "shown" and is denormalized onto the post (`post.factcheck`) so feeds
render it for free. Falls back to pending until then.
"""
from datetime import datetime, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict

from core import db, get_current_user
try:
    from routes.notifications import emit_notification  # type: ignore
except Exception:  # pragma: no cover
    emit_notification = None  # type: ignore

router = APIRouter()

# --- §1 response models (extra="allow") ---
class OkOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    ok: bool = True


class FactcheckOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    post_id: str
    author_id: str
    author_name: str = "Someone"
    text: str = ""
    source_url: str = ""
    helpful_count: int = 0
    not_helpful_count: int = 0
    status: str = "pending"
    my_rating: Optional[bool] = None   # True / False / None
    created_at: Optional[datetime] = None


class FactchecksOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    factchecks: List[FactcheckOut] = []
    threshold: float = 0


# A note becomes publicly visible once it has at least this many net-helpful
# votes (helpful must also outweigh not-helpful). Simple threshold MVP — X uses a
# bridging algorithm, but this is a sensible, predictable start.
HELPFUL_THRESHOLD = 3
# Warn the author once their note is this heavily downvoted (and clearly net-negative).
NOT_HELPFUL_WARN = 5
TEXT_MAX = 1000


class FactcheckCreate(BaseModel):
    text: str
    source_url: str


class FactcheckRate(BaseModel):
    helpful: Optional[bool] = None   # True = helpful, False = not helpful, None = clear


def _valid_url(u: str) -> bool:
    u = (u or "").strip()
    return u.startswith("http://") or u.startswith("https://")


def _view(doc: dict, my_rating: Optional[bool]) -> dict:
    return {
        "id": doc["id"],
        "post_id": doc["post_id"],
        "author_id": doc["author_id"],
        "author_name": doc.get("author_name", "Someone"),
        "text": doc.get("text", ""),
        "source_url": doc.get("source_url", ""),
        "helpful_count": int(doc.get("helpful_count", 0)),
        "not_helpful_count": int(doc.get("not_helpful_count", 0)),
        "status": doc.get("status", "pending"),
        "my_rating": my_rating,   # True / False / None
        "created_at": doc.get("created_at"),
    }


async def _refresh_post_factcheck(post_id: str) -> None:
    """Denormalize the best shown note onto the post (or clear it)."""
    shown = await db.factchecks.find(
        {"post_id": post_id, "status": "shown"}, {"_id": 0}
    ).to_list(50)
    if not shown:
        await db.posts.update_one({"id": post_id}, {"$set": {"factcheck": None}})
        return
    best = max(shown, key=lambda d: int(d.get("helpful_count", 0)) - int(d.get("not_helpful_count", 0)))
    await db.posts.update_one({"id": post_id}, {"$set": {"factcheck": {
        "id": best["id"], "text": best.get("text", ""), "source_url": best.get("source_url", ""),
    }}})


@router.post("/posts/{post_id}/factchecks", response_model=FactcheckOut)
async def add_factcheck(post_id: str, body: FactcheckCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    post = await db.posts.find_one({"id": post_id}, {"_id": 0, "id": 1})
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    text = (body.text or "").strip()[:TEXT_MAX]
    if not text:
        raise HTTPException(status_code=400, detail="Note text is required")
    if not _valid_url(body.source_url):
        raise HTTPException(status_code=400, detail="A valid source link (http/https) is required")
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "post_id": post_id,
        "author_id": user["user_id"],
        "author_name": user.get("name", "Someone"),
        "text": text,
        "source_url": body.source_url.strip()[:500],
        "helpful_count": 0,
        "not_helpful_count": 0,
        "status": "pending",
        "created_at": now,
    }
    await db.factchecks.insert_one(doc.copy())
    return _view(doc, None)


@router.get("/posts/{post_id}/factchecks", response_model=FactchecksOut)
async def list_factchecks(post_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    rows = await db.factchecks.find({"post_id": post_id}, {"_id": 0}).limit(100).to_list(100)
    mine = await db.factcheck_ratings.find(
        {"factcheck_id": {"$in": [r["id"] for r in rows]}, "user_id": user["user_id"]}, {"_id": 0}
    ).to_list(200) if rows else []
    my_map = {m["factcheck_id"]: m.get("helpful") for m in mine}
    out = [_view(r, my_map.get(r["id"])) for r in rows]
    # Shown first, then by net helpfulness, then newest.
    out.sort(key=lambda v: (
        0 if v["status"] == "shown" else 1,
        -(v["helpful_count"] - v["not_helpful_count"]),
    ))
    return {"factchecks": out, "threshold": HELPFUL_THRESHOLD}


@router.post("/factchecks/{fc_id}/rate", response_model=OkOut)
async def rate_factcheck(fc_id: str, body: FactcheckRate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    fc = await db.factchecks.find_one({"id": fc_id}, {"_id": 0})
    if not fc:
        raise HTTPException(status_code=404, detail="Note not found")
    key = {"factcheck_id": fc_id, "user_id": user["user_id"]}
    if body.helpful is None:
        await db.factcheck_ratings.delete_one(key)
    else:
        existing = await db.factcheck_ratings.find_one(key, {"_id": 0})
        if existing:
            await db.factcheck_ratings.update_one(key, {"$set": {"helpful": bool(body.helpful)}})
        else:
            await db.factcheck_ratings.insert_one({**key, "helpful": bool(body.helpful), "created_at": datetime.now(timezone.utc)})
    helpful_count = await db.factcheck_ratings.count_documents({"factcheck_id": fc_id, "helpful": True})
    not_helpful_count = await db.factcheck_ratings.count_documents({"factcheck_id": fc_id, "helpful": False})
    status = "shown" if (helpful_count >= HELPFUL_THRESHOLD and helpful_count > not_helpful_count) else "pending"
    await db.factchecks.update_one({"id": fc_id}, {"$set": {
        "helpful_count": helpful_count, "not_helpful_count": not_helpful_count, "status": status,
    }})
    # Warn the note's author once it's getting heavily downvoted (net-negative).
    if (not_helpful_count >= NOT_HELPFUL_WARN
            and not_helpful_count >= 2 * (helpful_count + 1)
            and not fc.get("warned")):
        await db.factchecks.update_one({"id": fc_id}, {"$set": {"warned": True}})
        if emit_notification:
            try:
                await emit_notification(
                    user_id=fc["author_id"], actor_id=None, ntype="factcheck_warning",
                    message="Your Factcheck note is being rated unhelpful by many readers. Notes must be accurate and cite a reliable source, or they may be removed.",
                )
            except Exception:
                pass
    await _refresh_post_factcheck(fc["post_id"])
    fc.update({"helpful_count": helpful_count, "not_helpful_count": not_helpful_count, "status": status})
    return _view(fc, body.helpful)


@router.delete("/factchecks/{fc_id}", response_model=OkOut)
async def delete_factcheck(fc_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    fc = await db.factchecks.find_one({"id": fc_id}, {"_id": 0})
    if not fc:
        raise HTTPException(status_code=404, detail="Note not found")
    is_staff = user.get("role") in ("admin", "mod")
    if fc["author_id"] != user["user_id"] and not is_staff:
        raise HTTPException(status_code=403, detail="Not allowed")
    await db.factchecks.delete_one({"id": fc_id})
    await db.factcheck_ratings.delete_many({"factcheck_id": fc_id})
    await _refresh_post_factcheck(fc["post_id"])
    return {"ok": True}
