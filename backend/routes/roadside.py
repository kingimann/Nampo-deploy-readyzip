"""Roadside assistance.

Members request help when stranded — a tow or a light service (lockout,
battery boost / jump start, tire change / flat repair). The request is pinned to
the requester's location (tows also carry a destination); nearby members can see
open requests and accept one to go help.

Money (wallet escrow):
- A flat $80 service fee plus tax is HELD from the requester's wallet when the
  request is created.
- When the job is finished BOTH sides take an "after" photo and verify — only
  then does the $80 release to the helper's wallet and the tax book as platform
  revenue. The helper must also have added a "before" photo.
- Cancelling: full refund while the request is still open, or accepted but the
  helper hasn't set off ("en route") yet. Once the helper is en route, the
  requester forfeits half the $80 ($40) to the helper and the rest is refunded.
"""
import math
import uuid
from datetime import datetime, timezone
from typing import List, Optional, Tuple

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel

from core import db, get_current_user
from routes.notifications import emit_notification
from routes.money import _wallet_balance, _debit_wallet, _credit_wallet, _record_platform_fee

router = APIRouter()

SERVICES = {"tow", "lockout", "battery", "tire"}
ACTIVE = {"open", "accepted"}
_LABELS = {"tow": "tow", "lockout": "lockout", "battery": "battery boost", "tire": "tire change"}

ROADSIDE_BASE = 80.0       # flat service fee paid to the helper
ROADSIDE_TAX_RATE = 0.10   # tax & fees, kept by the platform
MAX_PHOTOS = 6


def _label(svc: str) -> str:
    return _LABELS.get(svc, "roadside")


def _pricing() -> Tuple[float, float, float]:
    base = round(ROADSIDE_BASE, 2)
    tax = round(base * ROADSIDE_TAX_RATE, 2)
    return base, tax, round(base + tax, 2)


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


def _clean_photos(photos: Optional[list], limit: int = MAX_PHOTOS) -> List[str]:
    """Keep up to `limit` non-empty image refs (Cloudinary URLs or data URIs)."""
    out: List[str] = []
    for p in (photos or []):
        if isinstance(p, str) and p.strip():
            out.append(p.strip())
        if len(out) >= limit:
            break
    return out


def _vehicle_str(d: dict) -> Optional[str]:
    head = " ".join(
        str(d.get(k)).strip() for k in ("vehicle_year", "vehicle_make", "vehicle_model")
        if d.get(k) and str(d.get(k)).strip()
    )
    extra = []
    if d.get("vehicle_color"):
        extra.append(str(d["vehicle_color"]).strip())
    if d.get("vehicle_plate"):
        extra.append(f"plate {str(d['vehicle_plate']).strip()}")
    s = head
    if extra:
        s = (head + " · " + ", ".join(extra)).strip(" ·")
    return s or None


# ───────────────────────────── models ──────────────────────────────────────
class RoadsideCreate(BaseModel):
    service: str
    longitude: float
    latitude: float
    place_name: Optional[str] = None
    vehicle_year: Optional[str] = None
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    vehicle_color: Optional[str] = None
    vehicle_plate: Optional[str] = None
    dest_name: Optional[str] = None          # tow destination (required for tow)
    dest_longitude: Optional[float] = None
    dest_latitude: Optional[float] = None
    photos: Optional[List[str]] = None
    note: Optional[str] = None


class RoadsideVerify(BaseModel):
    photos: Optional[List[str]] = None       # "after" proof photos taken at completion


class RoadsidePhotos(BaseModel):
    phase: str = "before"                    # before | after
    photos: Optional[List[str]] = None


class RoadsideParty(BaseModel):
    user_id: str
    name: str
    picture: Optional[str] = None
    phone: Optional[str] = None              # only revealed to the matched counterparty


class RoadsideRequest(BaseModel):
    id: str
    requester_id: str
    requester: Optional[RoadsideParty] = None
    helper_id: Optional[str] = None
    helper: Optional[RoadsideParty] = None
    service: str
    status: str                              # open | accepted | completed | cancelled
    en_route: bool = False
    longitude: float
    latitude: float
    place_name: Optional[str] = None
    vehicle: Optional[str] = None            # display string
    vehicle_year: Optional[str] = None
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    vehicle_color: Optional[str] = None
    vehicle_plate: Optional[str] = None
    dest_name: Optional[str] = None
    dest_longitude: Optional[float] = None
    dest_latitude: Optional[float] = None
    photos: List[str] = []
    before_photos: List[str] = []
    after_photos: List[str] = []
    note: Optional[str] = None
    price: float = 0.0
    tax: float = 0.0
    total: float = 0.0
    held: bool = False
    settled: bool = False
    refunded: bool = False
    requester_verified: bool = False
    helper_verified: bool = False
    distance_km: Optional[float] = None
    mine: bool = False
    helping: bool = False
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
        en_route=bool(doc.get("en_route", False)),
        longitude=doc["longitude"],
        latitude=doc["latitude"],
        place_name=doc.get("place_name"),
        vehicle=_vehicle_str(doc),
        vehicle_year=doc.get("vehicle_year"),
        vehicle_make=doc.get("vehicle_make"),
        vehicle_model=doc.get("vehicle_model"),
        vehicle_color=doc.get("vehicle_color"),
        vehicle_plate=doc.get("vehicle_plate"),
        dest_name=doc.get("dest_name"),
        dest_longitude=doc.get("dest_longitude"),
        dest_latitude=doc.get("dest_latitude"),
        photos=doc.get("photos") or [],
        before_photos=doc.get("before_photos") or [],
        after_photos=doc.get("after_photos") or [],
        note=doc.get("note"),
        price=round(float(doc.get("price", 0) or 0), 2),
        tax=round(float(doc.get("tax", 0) or 0), 2),
        total=round(float(doc.get("total", 0) or 0), 2),
        held=bool(doc.get("held", False)),
        settled=bool(doc.get("settled", False)),
        refunded=bool(doc.get("refunded", False)),
        requester_verified=bool(doc.get("requester_verified", False)),
        helper_verified=bool(doc.get("helper_verified", False)),
        distance_km=dist,
        mine=(doc["requester_id"] == viewer_id),
        helping=(doc.get("helper_id") == viewer_id),
        created_at=doc["created_at"],
        accepted_at=doc.get("accepted_at"),
        completed_at=doc.get("completed_at"),
    )


async def _settle(doc: dict) -> None:
    """Release the held escrow: pay the helper the base fee, book the tax as
    platform revenue, and mark the job complete. Idempotent on `settled`."""
    if doc.get("settled"):
        return
    base = round(float(doc.get("price", ROADSIDE_BASE) or 0), 2)
    tax = round(float(doc.get("tax", 0) or 0), 2)
    helper_id = doc.get("helper_id")
    now = datetime.now(timezone.utc)
    if helper_id and doc.get("held"):
        await _credit_wallet(helper_id, base)
        await db.earnings.insert_one({
            "id": str(uuid.uuid4()), "user_id": helper_id, "amount": base, "kind": "roadside",
            "from_user_id": doc["requester_id"], "from_name": "Roadside",
            "message": f"Roadside {_label(doc['service'])}", "source": "roadside",
            "created_at": now,
        })
        await _record_platform_fee(tax, "roadside_tax", doc["requester_id"], doc["id"])
    await db.roadside_requests.update_one(
        {"id": doc["id"]}, {"$set": {"status": "completed", "settled": True, "completed_at": now}}
    )
    doc.update({"status": "completed", "settled": True, "completed_at": now})
    if helper_id:
        await emit_notification(
            user_id=helper_id, actor_id=doc["requester_id"], ntype="roadside",
            message=f"Job complete — ${base:.2f} was added to your wallet.",
        )
    await emit_notification(
        user_id=doc["requester_id"], actor_id=helper_id, ntype="roadside",
        message="Your roadside job is complete and the helper has been paid. Thanks!",
    )


# ───────────────────────────── endpoints ────────────────────────────────────
@router.get("/roadside/quote")
async def quote(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    base, tax, total = _pricing()
    bal = await _wallet_balance(user["user_id"])
    return {"base": base, "tax": tax, "total": total, "tax_rate": ROADSIDE_TAX_RATE, "wallet_balance": bal}


@router.post("/roadside/requests", response_model=RoadsideRequest)
async def create_request(body: RoadsideCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    svc = (body.service or "").strip().lower()
    if svc not in SERVICES:
        raise HTTPException(status_code=400, detail="Pick a valid service: tow, lockout, battery or tire.")
    dest_name = (body.dest_name or "").strip()[:200]
    if svc == "tow" and not dest_name:
        raise HTTPException(status_code=400, detail="Add where you'd like the vehicle towed to.")
    existing = await db.roadside_requests.find_one(
        {"requester_id": user["user_id"], "status": {"$in": list(ACTIVE)}}, {"_id": 0, "id": 1}
    )
    if existing:
        raise HTTPException(status_code=400, detail={
            "code": "active_request_exists",
            "message": "You already have an active roadside request. Cancel it before starting a new one.",
        })
    base, tax, total = _pricing()
    bal = await _wallet_balance(user["user_id"])
    if bal + 1e-9 < total:
        raise HTTPException(status_code=400, detail={
            "code": "insufficient_balance",
            "message": f"Roadside help costs ${total:.2f} (incl. tax). Top up your wallet, then try again.",
        })
    ok = await _debit_wallet(user["user_id"], total)
    if not ok:
        raise HTTPException(status_code=400, detail={
            "code": "insufficient_balance",
            "message": f"Roadside help costs ${total:.2f} (incl. tax). Top up your wallet, then try again.",
        })
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "requester_id": user["user_id"],
        "helper_id": None,
        "service": svc,
        "status": "open",
        "en_route": False,
        "longitude": float(body.longitude),
        "latitude": float(body.latitude),
        "place_name": (body.place_name or "").strip()[:200] or None,
        "vehicle_year": (body.vehicle_year or "").strip()[:8] or None,
        "vehicle_make": (body.vehicle_make or "").strip()[:40] or None,
        "vehicle_model": (body.vehicle_model or "").strip()[:60] or None,
        "vehicle_color": (body.vehicle_color or "").strip()[:30] or None,
        "vehicle_plate": (body.vehicle_plate or "").strip()[:16] or None,
        "dest_name": dest_name or None,
        "dest_longitude": body.dest_longitude,
        "dest_latitude": body.dest_latitude,
        "photos": _clean_photos(body.photos),
        "before_photos": [],
        "after_photos": [],
        "note": (body.note or "").strip()[:500] or None,
        "price": base,
        "tax": tax,
        "total": total,
        "held": True,
        "settled": False,
        "refunded": False,
        "requester_verified": False,
        "helper_verified": False,
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
        raise HTTPException(status_code=400, detail={"code": "not_open", "message": "This request is no longer open."})
    now = datetime.now(timezone.utc)
    # Atomic claim — only succeeds if it's still open, so two helpers can't both win.
    res = await db.roadside_requests.update_one(
        {"id": rid, "status": "open"},
        {"$set": {"status": "accepted", "helper_id": user["user_id"], "accepted_at": now}},
    )
    if getattr(res, "matched_count", 0) == 0:
        raise HTTPException(status_code=400, detail={"code": "not_open", "message": "Someone just accepted this request."})
    doc.update({"status": "accepted", "helper_id": user["user_id"], "accepted_at": now})
    await emit_notification(
        user_id=doc["requester_id"], actor_id=user["user_id"], ntype="roadside",
        message=f"{user.get('name') or 'A member'} accepted your {_label(doc['service'])} request.",
    )
    return await _hydrate(doc, user["user_id"])


@router.post("/roadside/requests/{rid}/enroute", response_model=RoadsideRequest)
async def enroute(rid: str, authorization: Optional[str] = Header(None)):
    """The assigned helper marks that they've set off. After this, a requester
    cancel forfeits half the fee to the helper."""
    user = await get_current_user(authorization)
    doc = await db.roadside_requests.find_one({"id": rid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Request not found")
    if doc.get("helper_id") != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only the assigned helper can do this.")
    if doc["status"] != "accepted":
        raise HTTPException(status_code=400, detail="This job isn't active.")
    if not doc.get("en_route"):
        now = datetime.now(timezone.utc)
        await db.roadside_requests.update_one({"id": rid}, {"$set": {"en_route": True, "en_route_at": now}})
        doc["en_route"] = True
        await emit_notification(
            user_id=doc["requester_id"], actor_id=user["user_id"], ntype="roadside",
            message=f"{user.get('name') or 'Your helper'} is now en route to you.",
        )
    return await _hydrate(doc, user["user_id"])


@router.post("/roadside/requests/{rid}/photos", response_model=RoadsideRequest)
async def add_photos(rid: str, body: RoadsidePhotos, authorization: Optional[str] = Header(None)):
    """Attach before/after service photos (either party, while the job is active)."""
    user = await get_current_user(authorization)
    uid = user["user_id"]
    doc = await db.roadside_requests.find_one({"id": rid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Request not found")
    if uid not in (doc["requester_id"], doc.get("helper_id")):
        raise HTTPException(status_code=403, detail="This isn't your request.")
    if doc["status"] != "accepted":
        raise HTTPException(status_code=400, detail="Photos can only be added while the job is active.")
    add = _clean_photos(body.photos)
    if not add:
        raise HTTPException(status_code=400, detail="No photos to add.")
    field = "before_photos" if body.phase == "before" else "after_photos"
    merged = (doc.get(field) or []) + add
    await db.roadside_requests.update_one({"id": rid}, {"$set": {field: merged[:12]}})
    doc[field] = merged[:12]
    return await _hydrate(doc, uid)


@router.post("/roadside/requests/{rid}/verify", response_model=RoadsideRequest)
async def verify(rid: str, body: RoadsideVerify, authorization: Optional[str] = Header(None)):
    """Each party verifies the finished job with an 'after' photo. Only when BOTH
    have verified does the job complete and payment release. The helper must have
    added a 'before' photo first."""
    user = await get_current_user(authorization)
    uid = user["user_id"]
    doc = await db.roadside_requests.find_one({"id": rid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Request not found")
    is_req = doc["requester_id"] == uid
    is_help = doc.get("helper_id") == uid
    if not (is_req or is_help):
        raise HTTPException(status_code=403, detail="This isn't your request.")
    if doc["status"] != "accepted":
        raise HTTPException(status_code=400, detail="Only an accepted job can be verified.")
    after = _clean_photos(body.photos, limit=4)
    if not after:
        raise HTTPException(status_code=400, detail={
            "code": "photo_required",
            "message": "Take an 'after' photo of the finished job to verify.",
        })
    if is_help and not (doc.get("before_photos") or []):
        raise HTTPException(status_code=400, detail={
            "code": "before_required",
            "message": "Add at least one 'before' photo of the vehicle before you verify.",
        })
    field = "requester_verified" if is_req else "helper_verified"
    merged_after = (doc.get("after_photos") or []) + after
    await db.roadside_requests.update_one(
        {"id": rid}, {"$set": {field: True, "after_photos": merged_after[:12]}}
    )
    doc[field] = True
    doc["after_photos"] = merged_after[:12]
    if doc.get("requester_verified") and doc.get("helper_verified"):
        await _settle(doc)
    else:
        other = doc.get("helper_id") if is_req else doc["requester_id"]
        if other:
            await emit_notification(
                user_id=other, actor_id=uid, ntype="roadside",
                message="Your roadside partner verified the job. Add an 'after' photo and verify to finish and release payment.",
            )
    return await _hydrate(doc, uid)


@router.post("/roadside/requests/{rid}/cancel", response_model=RoadsideRequest)
async def cancel(rid: str, authorization: Optional[str] = Header(None)):
    """The requester cancels. Full refund while open, or accepted-but-not-en-route.
    Once the helper is en route, the requester forfeits half the $80 to them."""
    user = await get_current_user(authorization)
    doc = await db.roadside_requests.find_one({"id": rid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Request not found")
    if doc["requester_id"] != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only the requester can cancel this.")
    if doc["status"] not in ACTIVE:
        raise HTTPException(status_code=400, detail="This request is already closed.")
    now = datetime.now(timezone.utc)
    total = round(float(doc.get("total", 0) or 0), 2)
    base = round(float(doc.get("price", 0) or 0), 2)
    helper_id = doc.get("helper_id")
    en_route = bool(doc.get("en_route"))
    refunded = False
    helper_fee = 0.0
    if doc.get("held") and not doc.get("settled") and not doc.get("refunded"):
        if doc["status"] == "accepted" and en_route:
            helper_fee = round(base / 2.0, 2)            # forfeit half the service fee
        refund = round(total - helper_fee, 2)
        if refund > 0:
            await _credit_wallet(doc["requester_id"], refund)
        if helper_fee > 0 and helper_id:
            await _credit_wallet(helper_id, helper_fee)
            await db.earnings.insert_one({
                "id": str(uuid.uuid4()), "user_id": helper_id, "amount": helper_fee,
                "kind": "roadside_cancel", "from_user_id": doc["requester_id"], "from_name": "Roadside",
                "message": "Roadside call-out (cancelled en route)", "source": "roadside",
                "created_at": now,
            })
        refunded = True
    await db.roadside_requests.update_one(
        {"id": rid}, {"$set": {"status": "cancelled", "completed_at": now, "refunded": refunded}}
    )
    doc.update({"status": "cancelled", "completed_at": now, "refunded": refunded})
    if helper_id:
        msg = (
            f"The member cancelled after you set off — ${helper_fee:.2f} was added to your wallet."
            if helper_fee > 0 else
            "The member cancelled their roadside request."
        )
        await emit_notification(user_id=helper_id, actor_id=user["user_id"], ntype="roadside", message=msg)
    return await _hydrate(doc, user["user_id"])
