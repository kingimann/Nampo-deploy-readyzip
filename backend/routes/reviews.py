"""Place reviews."""
from datetime import datetime, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from core import db, get_current_user
from models import Review, ReviewCreate

router = APIRouter()

# --- §1 response models (extra="allow") ---
class OkOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    ok: bool = True



@router.get("/reviews", response_model=List[Review])
async def list_reviews_for_place(
    place_key: str = Query(...),
    authorization: Optional[str] = Header(None),
):
    await get_current_user(authorization)
    cursor = db.reviews.find({"place_key": place_key}, {"_id": 0}).sort("created_at", -1)
    docs = await cursor.to_list(200)
    return [Review(**d) for d in docs]


@router.post("/reviews", response_model=Review)
async def create_review(body: ReviewCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    if body.rating < 1 or body.rating > 5:
        raise HTTPException(status_code=400, detail="Rating must be 1..5")
    now = datetime.now(timezone.utc)
    await db.reviews.update_one(
        {"user_id": user["user_id"], "place_key": body.place_key},
        {
            "$set": {
                "user_name": user.get("name", ""),
                "user_picture": user.get("picture"),
                "place_name": body.place_name,
                "longitude": body.longitude,
                "latitude": body.latitude,
                "rating": body.rating,
                "text": (body.text or "")[:500],
            },
            "$setOnInsert": {
                "id": str(uuid.uuid4()),
                "user_id": user["user_id"],
                "place_key": body.place_key,
                "created_at": now,
            },
        },
        upsert=True,
    )
    doc = await db.reviews.find_one(
        {"user_id": user["user_id"], "place_key": body.place_key}, {"_id": 0}
    )
    return Review(**doc)


@router.delete("/reviews/{review_id}", response_model=OkOut)
async def delete_review(review_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    res = await db.reviews.delete_one({"id": review_id, "user_id": user["user_id"]})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Review not found")
    return {"ok": True}
