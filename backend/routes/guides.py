"""Guides (private + public) + clone endpoints."""
from datetime import datetime, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict

from core import (
    _public_user,
    _slugify,
    _try_set_unique_slug,
    db,
    get_current_user,
)
from models import Guide, GuideCreate, GuidePatch, Place, PublicGuide

router = APIRouter()

# --- §1 response models (extra="allow") ---
class OkOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    ok: bool = True



@router.get("/guides", response_model=List[Guide])
async def list_guides(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    cursor = db.guides.find({"user_id": user["user_id"]}, {"_id": 0}).sort("created_at", -1)
    docs = await cursor.to_list(200)
    out = []
    for d in docs:
        d.setdefault("is_public", False)
        d.setdefault("slug", None)
        out.append(Guide(**d))
    return out


@router.post("/guides", response_model=Guide)
async def create_guide(body: GuideCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["user_id"],
        "name": body.name,
        "color": body.color or "#3B82F6",
        "icon": body.icon or "bookmark",
        "place_ids": [],
        "is_public": False,
        "created_at": datetime.now(timezone.utc),
    }
    await db.guides.insert_one(doc.copy())
    doc["slug"] = None
    return Guide(**doc)


@router.patch("/guides/{guide_id}", response_model=Guide)
async def patch_guide(
    guide_id: str, body: GuidePatch, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    guide = await db.guides.find_one({"id": guide_id, "user_id": user["user_id"]}, {"_id": 0})
    if not guide:
        raise HTTPException(status_code=404, detail="Guide not found")
    patch = {}
    if body.name is not None and body.name.strip():
        patch["name"] = body.name.strip()[:80]
    if body.color is not None:
        patch["color"] = body.color
    if body.is_public is not None:
        patch["is_public"] = body.is_public
    if patch:
        await db.guides.update_one({"id": guide_id}, {"$set": patch})
    if body.is_public is True and not guide.get("slug"):
        new_slug = await _try_set_unique_slug(
            guide_id, _slugify(patch.get("name") or guide["name"])
        )
        # Smart enhancement: announce the now-public guide in the owner's feed.
        place_count = len(guide.get("place_ids") or [])
        try:
            await db.posts.insert_one({
                "id": str(uuid.uuid4()),
                "user_id": user["user_id"],
                "text": (
                    f"Just published a guide: {patch.get('name') or guide['name']} "
                    f"({place_count} {'place' if place_count == 1 else 'places'}) · /g/{new_slug}"
                ),
                "parent_id": None,
                "place_name": None,
                "place_longitude": None,
                "place_latitude": None,
                "likes_count": 0,
                "replies_count": 0,
                "created_at": datetime.now(timezone.utc),
            })
        except Exception:
            pass  # never break guide publish on feed failure
    updated = await db.guides.find_one({"id": guide_id}, {"_id": 0})
    updated.setdefault("is_public", False)
    updated.setdefault("slug", None)
    return Guide(**updated)


@router.delete("/guides/{guide_id}", response_model=OkOut)
async def delete_guide(guide_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    res = await db.guides.delete_one({"id": guide_id, "user_id": user["user_id"]})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Guide not found")
    return {"ok": True}


@router.post("/guides/{guide_id}/places/{place_id}", response_model=Guide)
async def add_place_to_guide(
    guide_id: str, place_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    guide = await db.guides.find_one({"id": guide_id, "user_id": user["user_id"]}, {"_id": 0})
    if not guide:
        raise HTTPException(status_code=404, detail="Guide not found")
    place = await db.places.find_one({"id": place_id, "user_id": user["user_id"]}, {"_id": 0})
    if not place:
        raise HTTPException(status_code=404, detail="Place not found")
    await db.guides.update_one(
        {"id": guide_id, "user_id": user["user_id"]},
        {"$addToSet": {"place_ids": place_id}},
    )
    updated = await db.guides.find_one({"id": guide_id, "user_id": user["user_id"]}, {"_id": 0})
    updated.setdefault("is_public", False)
    updated.setdefault("slug", None)
    return Guide(**updated)


@router.delete("/guides/{guide_id}/places/{place_id}", response_model=Guide)
async def remove_place_from_guide(
    guide_id: str, place_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    res = await db.guides.update_one(
        {"id": guide_id, "user_id": user["user_id"]},
        {"$pull": {"place_ids": place_id}},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Guide not found")
    updated = await db.guides.find_one({"id": guide_id, "user_id": user["user_id"]}, {"_id": 0})
    updated.setdefault("is_public", False)
    updated.setdefault("slug", None)
    return Guide(**updated)


# ---------- Public (no auth) ----------
@router.get("/public/guides/{slug}", response_model=PublicGuide)
async def get_public_guide(slug: str):
    guide = await db.guides.find_one({"slug": slug, "is_public": True}, {"_id": 0})
    if not guide:
        raise HTTPException(status_code=404, detail="Guide not found")
    place_ids = guide.get("place_ids", [])
    places_docs = await db.places.find(
        {"id": {"$in": place_ids}}, {"_id": 0}
    ).to_list(200)
    order = {pid: i for i, pid in enumerate(place_ids)}
    places_docs.sort(key=lambda p: order.get(p["id"], 0))
    owner = await _public_user(guide["user_id"])
    return PublicGuide(
        id=guide["id"],
        slug=guide["slug"],
        name=guide["name"],
        color=guide.get("color", "#3B82F6"),
        icon=guide.get("icon", "bookmark"),
        owner=owner,
        places=[Place(**p) for p in places_docs],
        created_at=guide["created_at"],
    )


@router.post("/public/guides/{slug}/clone", response_model=Guide)
async def clone_public_guide(slug: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    src = await db.guides.find_one({"slug": slug, "is_public": True}, {"_id": 0})
    if not src:
        raise HTTPException(status_code=404, detail="Guide not found")
    place_ids = src.get("place_ids", [])
    src_places = await db.places.find(
        {"id": {"$in": place_ids}}, {"_id": 0}
    ).to_list(200)
    new_place_ids = []
    for p in src_places:
        new_pid = str(uuid.uuid4())
        await db.places.insert_one(
            {
                "id": new_pid,
                "user_id": user["user_id"],
                "title": p["title"],
                "notes": p.get("notes", ""),
                "longitude": p["longitude"],
                "latitude": p["latitude"],
                "address": p.get("address", ""),
                "category": p.get("category", "marker"),
                "created_at": datetime.now(timezone.utc),
            }
        )
        new_place_ids.append(new_pid)
    new_guide = {
        "id": str(uuid.uuid4()),
        "user_id": user["user_id"],
        "name": f"{src['name']} (clone)",
        "color": src.get("color", "#3B82F6"),
        "icon": src.get("icon", "bookmark"),
        "place_ids": new_place_ids,
        "is_public": False,
        "slug": None,
        "created_at": datetime.now(timezone.utc),
    }
    await db.guides.insert_one(new_guide.copy())
    return Guide(**new_guide)
