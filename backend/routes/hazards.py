"""Driver hazard reports (Waze-style crowd-sourced map alerts).

Anyone can drop a report (police, accident, hazard, …) at their location. Reports
of the same type within a small radius cluster into one; once enough distinct
drivers report it, the hazard becomes "active" and shows on everyone's map.
Reports expire after a couple of hours, and "not there" votes can clear them.
"""
from datetime import datetime, timedelta, timezone
from math import radians, sin, cos, asin, sqrt
from typing import List, Optional
import uuid

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict

from core import db, get_current_user

router = APIRouter()

# --- §1 response models (extra="allow") ---
class HazardOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    type: str
    longitude: float
    latitude: float
    confirmations: int = 0
    dismissals: int = 0
    status: str = "pending"
    mine: bool = False
    created_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None


class HazardsOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    hazards: List[HazardOut] = []
    threshold: float = 0


HAZARD_TYPES = {
    "police", "accident", "hazard", "traffic", "road_closed",
    "construction", "pothole", "weather", "stalled",
}
TTL_MINUTES = 120          # reports expire after 2h
CONFIRM_THRESHOLD = 2      # distinct reporters before it shows to everyone
CLUSTER_M = 150            # same-type reports within this merge into one
LIST_RADIUS_M = 8000       # default fetch radius around the map center


class HazardCreate(BaseModel):
    type: str
    longitude: float
    latitude: float


def _haversine_m(lng1: float, lat1: float, lng2: float, lat2: float) -> float:
    r = 6371000.0
    dlat = radians(lat2 - lat1)
    dlng = radians(lng2 - lng1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2
    return 2 * r * asin(sqrt(a))


def _view(doc: dict, viewer_id: Optional[str]) -> dict:
    reporters = doc.get("reporters", []) or []
    dismissals = doc.get("dismissals", []) or []
    return {
        "id": doc["id"],
        "type": doc["type"],
        "longitude": doc["longitude"],
        "latitude": doc["latitude"],
        "confirmations": len(reporters),
        "dismissals": len(dismissals),
        "status": doc.get("status", "pending"),
        "mine": viewer_id in reporters if viewer_id else False,
        "created_at": doc.get("created_at"),
        "expires_at": doc.get("expires_at"),
    }


async def _live_hazards() -> List[dict]:
    now = datetime.now(timezone.utc)
    rows = await db.hazards.find({}, {"_id": 0}).sort("created_at", -1).limit(1000).to_list(1000)
    return [r for r in rows if r.get("expires_at") and r["expires_at"] > now]


def _recompute(doc: dict) -> dict:
    reporters = doc.get("reporters", []) or []
    dismissals = doc.get("dismissals", []) or []
    doc["status"] = "active" if len(reporters) >= CONFIRM_THRESHOLD else "pending"
    # More "gone" votes than reporters → treat as cleared (expire now).
    if len(dismissals) >= max(2, len(reporters)):
        doc["expires_at"] = datetime.now(timezone.utc)
        doc["status"] = "cleared"
    return doc


@router.post("/hazards", response_model=HazardOut)
async def report_hazard(body: HazardCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    htype = (body.type or "").strip().lower()
    if htype not in HAZARD_TYPES:
        raise HTTPException(status_code=400, detail="Unknown hazard type")
    now = datetime.now(timezone.utc)
    # Merge into an existing nearby report of the same type, if any.
    for h in await _live_hazards():
        if h["type"] != htype:
            continue
        if _haversine_m(body.longitude, body.latitude, h["longitude"], h["latitude"]) <= CLUSTER_M:
            reporters = list(dict.fromkeys((h.get("reporters", []) or []) + [user["user_id"]]))
            h["reporters"] = reporters
            h["dismissals"] = [d for d in (h.get("dismissals", []) or []) if d != user["user_id"]]
            h["expires_at"] = now + timedelta(minutes=TTL_MINUTES)  # fresh report keeps it alive
            _recompute(h)
            await db.hazards.update_one({"id": h["id"]}, {"$set": {
                "reporters": h["reporters"], "dismissals": h["dismissals"],
                "expires_at": h["expires_at"], "status": h["status"],
            }})
            return _view(h, user["user_id"])
    # Otherwise create a new report.
    doc = {
        "id": str(uuid.uuid4()),
        "type": htype,
        "longitude": body.longitude,
        "latitude": body.latitude,
        "reporters": [user["user_id"]],
        "dismissals": [],
        "status": "active" if CONFIRM_THRESHOLD <= 1 else "pending",
        "created_at": now,
        "expires_at": now + timedelta(minutes=TTL_MINUTES),
    }
    await db.hazards.insert_one(doc.copy())
    return _view(doc, user["user_id"])


@router.get("/hazards", response_model=HazardsOut)
async def list_hazards(
    longitude: float, latitude: float, radius: Optional[float] = None,
    authorization: Optional[str] = Header(None),
):
    user = await get_current_user(authorization)
    rad = min(float(radius or LIST_RADIUS_M), 50000)
    out = []
    for h in await _live_hazards():
        if _haversine_m(longitude, latitude, h["longitude"], h["latitude"]) > rad:
            continue
        # Show active hazards to everyone; show pending ones only to their reporter.
        if h.get("status") == "active" or (user["user_id"] in (h.get("reporters", []) or [])):
            out.append(_view(h, user["user_id"]))
    return {"hazards": out, "threshold": CONFIRM_THRESHOLD}


@router.post("/hazards/{hid}/confirm", response_model=HazardOut)
async def confirm_hazard(hid: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    h = await db.hazards.find_one({"id": hid}, {"_id": 0})
    if not h:
        raise HTTPException(status_code=404, detail="Hazard not found")
    h["reporters"] = list(dict.fromkeys((h.get("reporters", []) or []) + [user["user_id"]]))
    h["dismissals"] = [d for d in (h.get("dismissals", []) or []) if d != user["user_id"]]
    h["expires_at"] = datetime.now(timezone.utc) + timedelta(minutes=TTL_MINUTES)
    _recompute(h)
    await db.hazards.update_one({"id": hid}, {"$set": {
        "reporters": h["reporters"], "dismissals": h["dismissals"],
        "expires_at": h["expires_at"], "status": h["status"],
    }})
    return _view(h, user["user_id"])


@router.post("/hazards/{hid}/dismiss", response_model=HazardOut)
async def dismiss_hazard(hid: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    h = await db.hazards.find_one({"id": hid}, {"_id": 0})
    if not h:
        raise HTTPException(status_code=404, detail="Hazard not found")
    h["dismissals"] = list(dict.fromkeys((h.get("dismissals", []) or []) + [user["user_id"]]))
    h["reporters"] = [r for r in (h.get("reporters", []) or []) if r != user["user_id"]]
    _recompute(h)
    await db.hazards.update_one({"id": hid}, {"$set": {
        "reporters": h["reporters"], "dismissals": h["dismissals"],
        "expires_at": h["expires_at"], "status": h["status"],
    }})
    return _view(h, user["user_id"])
