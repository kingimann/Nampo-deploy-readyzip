"""Places & recents endpoints."""
from datetime import datetime, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict

from core import db, get_current_user
from models import Place, PlaceCreate, Recent, RecentCreate

router = APIRouter()

# --- §1 response models (extra="allow") ---
class OkOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    ok: bool = True



@router.get("/places", response_model=List[Place])
async def list_places(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    cursor = db.places.find({"user_id": user["user_id"]}, {"_id": 0}).sort("created_at", -1)
    docs = await cursor.to_list(500)
    return [Place(**d) for d in docs]


@router.post("/places", response_model=Place)
async def create_place(body: PlaceCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    place = {
        "id": str(uuid.uuid4()),
        "user_id": user["user_id"],
        "title": body.title,
        "notes": body.notes or "",
        "longitude": body.longitude,
        "latitude": body.latitude,
        "address": body.address or "",
        "category": body.category,
        "created_at": datetime.now(timezone.utc),
    }
    await db.places.insert_one(place.copy())
    return Place(**place)


@router.get("/places/{place_id}", response_model=Place)
async def get_place(place_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.places.find_one({"id": place_id, "user_id": user["user_id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Place not found")
    return Place(**doc)


@router.delete("/places/{place_id}", response_model=OkOut)
async def delete_place(place_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    result = await db.places.delete_one({"id": place_id, "user_id": user["user_id"]})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Place not found")
    await db.guides.update_many(
        {"user_id": user["user_id"]},
        {"$pull": {"place_ids": place_id}},
    )
    return {"ok": True}


# ---------- Recents ----------
@router.get("/recents", response_model=List[Recent])
async def list_recents(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    cursor = db.recents.find({"user_id": user["user_id"]}, {"_id": 0}).sort("created_at", -1)
    docs = await cursor.to_list(20)
    return [Recent(**d) for d in docs]


@router.post("/recents", response_model=Recent)
async def create_recent(body: RecentCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    await db.recents.delete_many(
        {
            "user_id": user["user_id"],
            "name": body.name,
            "longitude": {"$gte": body.longitude - 1e-4, "$lte": body.longitude + 1e-4},
            "latitude": {"$gte": body.latitude - 1e-4, "$lte": body.latitude + 1e-4},
        }
    )
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["user_id"],
        "name": body.name,
        "full_address": body.full_address or "",
        "longitude": body.longitude,
        "latitude": body.latitude,
        "created_at": datetime.now(timezone.utc),
    }
    await db.recents.insert_one(doc.copy())
    extras = (
        await db.recents.find({"user_id": user["user_id"]}, {"_id": 0, "id": 1})
        .sort("created_at", -1)
        .skip(20)
        .to_list(100)
    )
    if extras:
        await db.recents.delete_many({"id": {"$in": [e["id"] for e in extras]}})
    return Recent(**doc)


@router.delete("/recents/{recent_id}", response_model=OkOut)
async def delete_recent(recent_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    res = await db.recents.delete_one({"id": recent_id, "user_id": user["user_id"]})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Recent not found")
    return {"ok": True}


@router.delete("/recents", response_model=OkOut)
async def clear_recents(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    await db.recents.delete_many({"user_id": user["user_id"]})
    return {"ok": True}
