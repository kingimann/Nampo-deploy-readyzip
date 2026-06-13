"""Place reviews."""
import math
from datetime import datetime, timezone
from typing import List, Optional, Tuple
import uuid

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from core import db, get_current_user
from models import NearbyRatedPlace, Review, ReviewCreate, ReviewSummary

router = APIRouter()


def _haversine_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    """Great-circle distance in km between (lng, lat) points."""
    (lng1, lat1), (lng2, lat2) = a, b
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lng2 - lng1)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))

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


@router.get("/reviews/nearby", response_model=List[NearbyRatedPlace])
async def reviews_nearby(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    radius_km: float = Query(5.0, ge=0, le=200),
    limit: int = Query(50, ge=1, le=200),
    authorization: Optional[str] = Header(None),
):
    """Top-rated places within radius_km, aggregated by place_key. Powers a
    "great spots near you" list/layer on the map. Sorted by rating, then count."""
    await get_current_user(authorization)
    docs = await db.reviews.find({}, {"_id": 0}).to_list(5000)
    viewer = (float(lng), float(lat))
    groups: dict = {}
    for d in docs:
        dl, da = d.get("longitude"), d.get("latitude")
        key = d.get("place_key")
        rating = int(d.get("rating") or 0)
        if dl is None or da is None or not key or not (1 <= rating <= 5):
            continue
        dist = _haversine_km(viewer, (float(dl), float(da)))
        if dist > radius_km:
            continue
        g = groups.get(key)
        if g is None:
            g = groups[key] = {
                "place_key": key,
                "place_name": d.get("place_name") or "Place",
                "longitude": float(dl),
                "latitude": float(da),
                "count": 0,
                "total": 0,
                "distance_km": round(dist, 1),
            }
        g["count"] += 1
        g["total"] += rating
    out = [
        NearbyRatedPlace(
            place_key=g["place_key"],
            place_name=g["place_name"],
            longitude=g["longitude"],
            latitude=g["latitude"],
            count=g["count"],
            average=round(g["total"] / g["count"], 2),
            distance_km=g["distance_km"],
        )
        for g in groups.values()
    ]
    out.sort(key=lambda x: (-x.average, -x.count))
    return out[:limit]


@router.get("/reviews/summary", response_model=ReviewSummary)
async def review_summary(
    place_key: str = Query(...),
    authorization: Optional[str] = Header(None),
):
    """Aggregate rating for a place: count, mean and a 1..5 histogram. Lets the
    map/place card show "4.3 ★ (27)" without pulling every review."""
    await get_current_user(authorization)
    docs = await db.reviews.find({"place_key": place_key}, {"_id": 0, "rating": 1}).to_list(2000)
    dist = {str(i): 0 for i in range(1, 6)}
    total = 0
    for d in docs:
        r = int(d.get("rating") or 0)
        if 1 <= r <= 5:
            dist[str(r)] += 1
            total += r
    count = sum(dist.values())
    average = round(total / count, 2) if count else 0.0
    return ReviewSummary(place_key=place_key, count=count, average=average, distribution=dist)


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
