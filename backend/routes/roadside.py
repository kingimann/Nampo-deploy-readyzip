"""Roadside assistance.

Members request help when stranded — a tow or a light service (lockout,
battery boost / jump start, tire change / flat repair). The request is pinned to
the requester's location; nearby members can see open requests and accept one to
go help. Peer-to-peer, location-based, with notifications to keep both sides in
the loop.
"""
import math
import uuid
from datetime import datetime, timezone
from typing import List, Optional, Tuple

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel

from core import db, get_current_user
from routes.notifications import emit_notification

router = APIRouter()

SERVICES = {"tow", "lockout", "battery", "tire"}
ACTIVE = {"open", "accepted"}
_LABELS = {
    "tow": "tow",
    "lockout": "lockout",
    "battery": "battery boost",
    "tire": "tire change",
}


def _label(svc: str) -> str:
    return _LABELS.get(svc, "roadside")


def _haversine_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    """Great-circle distance in km between (lng, lat) points."""
    (lng1, lat1), (lng2, lat2) = a, b
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lng2 - lng1)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def _doc_coords(doc: dict) -> Optional[Tuple[float, float]]:
    lng, lat = doc.get("longitude"), doc.get("latitude")
    if lng is None or lat is None:
        return None
    try:
        return (float(lng), float(lat))
    except (TypeError, ValueError):
        return None


# ───────────────────────────── models ──────────────────────────────────────
class RoadsideCreate(BaseModel):
    service: str
    longitude: float
    latitude: float
    place_name: Optional[str] = None
    vehicle: Optional[str] = None
    note: Optional[str] = None


class RoadsideParty(BaseModel):
    user_id: str
    name: str
    picture: Optional[str] = None
    phone: Optional[str] = None   # only revealed to the matched counterparty


class RoadsideRequest(BaseModel):
    id: str
    requester_id: str
    requester: Optional[RoadsideParty] = None
    helper_id: Optional[str] = None
    helper: Optional[RoadsideParty] = None
    service: str
    status: str                   # open | accepted | completed | cancelled
    longitude: float
    latitude: float
    place_name: Optional[str] = None
    vehicle: Optional[str] = None
    note: Optional[str] = None
    distance_km: Optional[float] = None
    mine: bool = False            # viewer is the requester
    helping: bool = False         # viewer is the helper
    created_at: datetime
    accepted_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


async def _party(uid: Optional[str], reveal_phone: bool = False) -> Optional[RoadsideParty]:
    if not uid:
        return None
    u = await db.users.find_one(
        {"user_id": uid},
        {"_id": 0, "user_id": 1, "name": 1, "picture": 1, "phone": 1, "phone_verified": 1},
    )
    if not u:
        return RoadsideParty(user_id=uid, name="Member")
    phone = u.get("phone") if (reveal_phone and u.get("phone_verified")) else None
    return RoadsideParty(user_id=uid, name=u.get("name") or "Member", picture=u.get("picture"), phone=phone)


async def _hydrate(doc: dict, viewer_id: str, viewer_coords: Optional[Tuple[float, float]] = None) -> RoadsideRequest:
    # Phone numbers are only shared once two members are matched (accepted) and
    # only with each other, so a helper can call the stranded member (and back).
    reveal = doc["status"] == "accepted" and viewer_id in (doc["requester_id"], doc.get("helper_id"))
    dist = None
    c = _doc_coords(doc)
    if viewer_coords and c:
        dist = round(_haversine_km(viewer_coords, c), 1)
    return RoadsideRequest(
        id=doc["id"],
        requester_id=doc["requester_id"],
        requester=await _party(doc["requester_id"], reveal_phone=reveal),
        helper_id=doc.get("helper_id"),
        helper=await _party(doc.get("helper_id"), reveal_phone=reveal),
        service=doc["service"],
        status=doc["status"],
        longitude=doc["longitude"],
        latitude=doc["latitude"],
        place_name=doc.get("place_name"),
        vehicle=doc.get("vehicle"),
        note=doc.get("note"),
        distance_km=dist,
        mine=(doc["requester_id"] == viewer_id),
        helping=(doc.get("helper_id") == viewer_id),
        created_at=doc["created_at"],
        accepted_at=doc.get("accepted_at"),
        completed_at=doc.get("completed_at"),
    )


# ───────────────────────────── endpoints ────────────────────────────────────
@router.post("/roadside/requests", response_model=RoadsideRequest)
async def create_request(body: RoadsideCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    svc = (body.service or "").strip().lower()
    if svc not in SERVICES:
        raise HTTPException(status_code=400, detail="Pick a valid service: tow, lockout, battery or tire.")
    existing = await db.roadside_requests.find_one(
        {"requester_id": user["user_id"], "status": {"$in": list(ACTIVE)}}, {"_id": 0, "id": 1}
    )
    if existing:
        raise HTTPException(status_code=400, detail={
            "code": "active_request_exists",
            "message": "You already have an active roadside request. Cancel it before starting a new one.",
        })
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "requester_id": user["user_id"],
        "helper_id": None,
        "service": svc,
        "status": "open",
        "longitude": float(body.longitude),
        "latitude": float(body.latitude),
        "place_name": (body.place_name or "").strip()[:160] or None,
        "vehicle": (body.vehicle or "").strip()[:120] or None,
        "note": (body.note or "").strip()[:500] or None,
        "created_at": now,
        "accepted_at": None,
        "completed_at": None,
    }
    await db.roadside_requests.insert_one(doc.copy())
    return await _hydrate(doc, user["user_id"])


@router.get("/roadside/active")
async def my_active(authorization: Optional[str] = Header(None)):
    """The viewer's current open/accepted request, or null."""
    user = await get_current_user(authorization)
    doc = await db.roadside_requests.find_one(
        {"requester_id": user["user_id"], "status": {"$in": list(ACTIVE)}}, {"_id": 0}
    )
    if not doc:
        return None
    return await _hydrate(doc, user["user_id"])


@router.get("/roadside/helping")
async def my_helping(authorization: Optional[str] = Header(None)):
    """A request the viewer accepted and is on the way to, or null."""
    user = await get_current_user(authorization)
    doc = await db.roadside_requests.find_one(
        {"helper_id": user["user_id"], "status": "accepted"}, {"_id": 0}
    )
    if not doc:
        return None
    return await _hydrate(doc, user["user_id"])


@router.get("/roadside/mine", response_model=List[RoadsideRequest])
async def my_requests(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    docs = await db.roadside_requests.find(
        {"requester_id": user["user_id"]}, {"_id": 0}
    ).sort("created_at", -1).to_list(50)
    return [await _hydrate(d, user["user_id"]) for d in docs]


@router.get("/roadside/nearby", response_model=List[RoadsideRequest])
async def nearby(
    lat: float = Query(...), lng: float = Query(...),
    radius_km: float = Query(50.0),
    authorization: Optional[str] = Header(None),
):
    user = await get_current_user(authorization)
    coords = (float(lng), float(lat))
    docs = await db.roadside_requests.find(
        {"status": "open"}, {"_id": 0}
    ).sort("created_at", -1).limit(300).to_list(300)
    scored: List[Tuple[float, dict]] = []
    for d in docs:
        if d["requester_id"] == user["user_id"]:
            continue
        c = _doc_coords(d)
        if not c:
            continue
        dist = _haversine_km(coords, c)
        if dist <= float(radius_km):
            scored.append((dist, d))
    scored.sort(key=lambda x: x[0])
    return [await _hydrate(d, user["user_id"], viewer_coords=coords) for _, d in scored[:50]]


@router.get("/roadside/requests/{rid}", response_model=RoadsideRequest)
async def get_one(rid: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.roadside_requests.find_one({"id": rid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Request not found")
    return await _hydrate(doc, user["user_id"])


@router.post("/roadside/requests/{rid}/accept", response_model=RoadsideRequest)
async def accept(rid: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.roadside_requests.find_one({"id": rid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Request not found")
    if doc["requester_id"] == user["user_id"]:
        raise HTTPException(status_code=400, detail="You can't accept your own request.")
    if doc["status"] != "open":
        raise HTTPException(status_code=400, detail={
            "code": "not_open", "message": "This request is no longer open.",
        })
    now = datetime.now(timezone.utc)
    # Atomic claim — only succeeds if it's still open, so two helpers can't both win.
    res = await db.roadside_requests.update_one(
        {"id": rid, "status": "open"},
        {"$set": {"status": "accepted", "helper_id": user["user_id"], "accepted_at": now}},
    )
    if getattr(res, "matched_count", 0) == 0:
        raise HTTPException(status_code=400, detail={
            "code": "not_open", "message": "Someone just accepted this request.",
        })
    doc.update({"status": "accepted", "helper_id": user["user_id"], "accepted_at": now})
    await emit_notification(
        user_id=doc["requester_id"], actor_id=user["user_id"], ntype="roadside",
        message=f"{user.get('name') or 'A member'} is on the way to help with your {_label(doc['service'])} request.",
    )
    return await _hydrate(doc, user["user_id"])


@router.post("/roadside/requests/{rid}/cancel", response_model=RoadsideRequest)
async def cancel(rid: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.roadside_requests.find_one({"id": rid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Request not found")
    if doc["requester_id"] != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only the requester can cancel this.")
    if doc["status"] not in ACTIVE:
        raise HTTPException(status_code=400, detail="This request is already closed.")
    now = datetime.now(timezone.utc)
    await db.roadside_requests.update_one({"id": rid}, {"$set": {"status": "cancelled", "completed_at": now}})
    helper_id = doc.get("helper_id")
    doc.update({"status": "cancelled", "completed_at": now})
    if helper_id:
        await emit_notification(
            user_id=helper_id, actor_id=user["user_id"], ntype="roadside",
            message="The member cancelled their roadside request.",
        )
    return await _hydrate(doc, user["user_id"])


@router.post("/roadside/requests/{rid}/complete", response_model=RoadsideRequest)
async def complete(rid: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.roadside_requests.find_one({"id": rid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Request not found")
    if user["user_id"] not in (doc["requester_id"], doc.get("helper_id")):
        raise HTTPException(status_code=403, detail="This isn't your request.")
    if doc["status"] != "accepted":
        raise HTTPException(status_code=400, detail="Only an accepted request can be completed.")
    now = datetime.now(timezone.utc)
    await db.roadside_requests.update_one({"id": rid}, {"$set": {"status": "completed", "completed_at": now}})
    doc.update({"status": "completed", "completed_at": now})
    other = doc.get("helper_id") if user["user_id"] == doc["requester_id"] else doc["requester_id"]
    if other:
        await emit_notification(
            user_id=other, actor_id=user["user_id"], ntype="roadside",
            message="Your roadside job was marked complete. Thanks for helping out!",
        )
    return await _hydrate(doc, user["user_id"])
