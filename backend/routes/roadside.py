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
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel

from core import db, get_current_user, account_age_days, _norm_dt, is_mod, is_admin
from routes.notifications import emit_notification
from routes.money import _wallet_balance, _debit_wallet, _credit_wallet, _record_platform_fee
from services.encryption import encrypt_text, decrypt_text

router = APIRouter()

SERVICES = {"tow", "lockout", "battery", "tire"}
ACTIVE = {"open", "accepted"}
_LABELS = {"tow": "tow", "lockout": "lockout", "battery": "battery boost", "tire": "tire change"}

ROADSIDE_BASE = 80.0       # flat service fee paid to the helper
ROADSIDE_TAX_RATE = 0.10   # tax & fees, kept by the platform
MAX_PHOTOS = 6
# To HELP others, a member must clear a trust bar.
ROADSIDE_HELPER_MIN_AGE_DAYS = int(os.environ.get("ROADSIDE_HELPER_MIN_AGE_DAYS", "90") or 90)


def _helper_eligibility(u: dict) -> dict:
    """Trust requirements to accept (help with) someone's roadside request:
    ID + email + phone verified, account at least 3 months old, and no bans,
    suspensions or warnings."""
    now = datetime.now(timezone.utc)
    su = u.get("suspended_until")
    suspended = False
    try:
        suspended = bool(su and _norm_dt(su) > now)
    except Exception:
        suspended = False
    warnings = int(u.get("warnings_count", 0) or 0) + len(u.get("warnings") or [])
    months = max(1, ROADSIDE_HELPER_MIN_AGE_DAYS // 30)
    checks = [
        ("id_verified", "ID verified", bool(u.get("id_verified"))),
        ("email_verified", "Email verified", bool(u.get("email_verified"))),
        ("phone_verified", "Phone verified", bool(u.get("phone_verified"))),
        ("account_age", f"Account {months}+ months old", account_age_days(u) >= ROADSIDE_HELPER_MIN_AGE_DAYS),
        ("no_bans", "No bans or suspensions", not u.get("banned") and not suspended),
        ("no_warnings", "No active warnings", warnings == 0),
    ]
    requirements = [{"key": k, "label": lbl, "met": met} for (k, lbl, met) in checks]
    missing = [lbl for (_, lbl, met) in checks if not met]
    # Admins are immune to the trust bar (and to roadside verification).
    return {
        "eligible": len(missing) == 0 or is_admin(u),
        "requirements": requirements,
        "missing": missing,
        "min_age_days": ROADSIDE_HELPER_MIN_AGE_DAYS,
    }


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
    payment_method: Optional[str] = "wallet"  # wallet (escrow) | cash (pay in person)


class RoadsideReview(BaseModel):
    rating: int
    text: Optional[str] = None


class RoadsideReviewOut(BaseModel):
    rating: int
    text: Optional[str] = None


class RoadsideVerify(BaseModel):
    photos: Optional[List[str]] = None       # "after" proof photos taken at completion


class RoadsidePhotos(BaseModel):
    phase: str = "before"                    # before | after
    photos: Optional[List[str]] = None


class RoadsideVerifySubmit(BaseModel):
    insurance_photo: str                     # base64 data URI — held encrypted, deleted on decision
    ownership_photo: str
    vehicle_year: Optional[str] = None
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    note: Optional[str] = None


class RoadsideDecision(BaseModel):
    approve: bool
    reason: Optional[str] = None


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
    payment_method: str = "wallet"           # wallet (escrow) | cash (in person)
    price: float = 0.0
    tax: float = 0.0
    total: float = 0.0
    held: bool = False
    settled: bool = False
    refunded: bool = False
    requester_verified: bool = False
    helper_verified: bool = False
    disputed: bool = False
    distance_km: Optional[float] = None
    mine: bool = False
    helping: bool = False
    # History-only extras (set by GET /roadside/history)
    can_review: Optional[bool] = None
    can_dispute: Optional[bool] = None
    my_review: Optional[RoadsideReviewOut] = None
    their_review: Optional[RoadsideReviewOut] = None
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
        payment_method=doc.get("payment_method") or "wallet",
        price=round(float(doc.get("price", 0) or 0), 2),
        tax=round(float(doc.get("tax", 0) or 0), 2),
        total=round(float(doc.get("total", 0) or 0), 2),
        held=bool(doc.get("held", False)),
        settled=bool(doc.get("settled", False)),
        refunded=bool(doc.get("refunded", False)),
        requester_verified=bool(doc.get("requester_verified", False)),
        helper_verified=bool(doc.get("helper_verified", False)),
        disputed=bool(doc.get("disputed_by")),
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
    cash = doc.get("payment_method") == "cash"
    if helper_id:
        await emit_notification(
            user_id=helper_id, actor_id=doc["requester_id"], ntype="roadside",
            message=(f"Job complete — collect ${base:.2f} cash from the member."
                     if cash else f"Job complete — ${base:.2f} was added to your wallet."),
        )
    await emit_notification(
        user_id=doc["requester_id"], actor_id=helper_id, ntype="roadside",
        message=("Roadside job complete — pay your helper in cash. Thanks!"
                 if cash else "Your roadside job is complete and the helper has been paid. Thanks!"),
    )


# ───────────────────────────── endpoints ────────────────────────────────────
@router.get("/roadside/quote")
async def quote(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    base, tax, total = _pricing()
    bal = await _wallet_balance(user["user_id"])
    return {"base": base, "tax": tax, "total": total, "tax_rate": ROADSIDE_TAX_RATE, "wallet_balance": bal}


@router.get("/roadside/eligibility")
async def helper_eligibility(authorization: Optional[str] = Header(None)):
    """Whether the current member meets the trust bar to help others."""
    user = await get_current_user(authorization)
    return _helper_eligibility(user)


# ── Requester verification (insurance + ownership, admin-reviewed) ───────────
MAX_DOC_CHARS = 7_000_000  # cap each base64 doc (~5MB image)


@router.get("/roadside/verification")
async def my_verification(authorization: Optional[str] = Header(None)):
    """Whether the current member may REQUEST help: same identity bar as helpers,
    plus an admin-approved insurance + ownership check."""
    user = await get_current_user(authorization)
    elig = _helper_eligibility(user)
    v = await db.roadside_verifications.find_one(
        {"user_id": user["user_id"]},
        {"_id": 0, "status": 1, "reason": 1},
        sort=[("created_at", -1)],
    )
    return {
        "verified": bool(user.get("roadside_verified")) or is_admin(user),
        "status": "approved" if is_admin(user) else (v or {}).get("status", "none"),
        "reason": (v or {}).get("reason"),
        "eligibility": elig,
    }


@router.post("/roadside/verification")
async def submit_verification(body: RoadsideVerifySubmit, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    if user.get("roadside_verified"):
        return {"status": "approved", "verified": True}
    elig = _helper_eligibility(user)
    if not elig["eligible"]:
        raise HTTPException(status_code=403, detail={
            "code": "not_eligible",
            "message": "Complete ID, email and phone verification (account 3+ months old, no bans) before verifying for roadside help.",
            "missing": elig["missing"],
        })
    ins = (body.insurance_photo or "").strip()
    own = (body.ownership_photo or "").strip()
    if not ins or not own:
        raise HTTPException(status_code=400, detail="Upload a photo of both your insurance and proof of ownership.")
    if len(ins) > MAX_DOC_CHARS or len(own) > MAX_DOC_CHARS:
        raise HTTPException(status_code=413, detail="Document image too large — use a smaller photo.")
    pending = await db.roadside_verifications.find_one(
        {"user_id": user["user_id"], "status": "pending"}, {"_id": 0, "id": 1}
    )
    if pending:
        raise HTTPException(status_code=400, detail={"code": "pending", "message": "Your documents are already under review."})

    now = datetime.now(timezone.utc)
    veh = _vehicle_str({
        "vehicle_year": body.vehicle_year, "vehicle_make": body.vehicle_make, "vehicle_model": body.vehicle_model,
    })
    base = {
        "id": str(uuid.uuid4()),
        "user_id": user["user_id"],
        "vehicle_year": (body.vehicle_year or "").strip()[:8] or None,
        "vehicle_make": (body.vehicle_make or "").strip()[:40] or None,
        "vehicle_model": (body.vehicle_model or "").strip()[:60] or None,
        "note": (body.note or "").strip()[:500] or None,
        "created_at": now,
    }

    # AI check first (Ollama vision). The images are processed in memory and are
    # NOT stored when the AI returns a clear verdict.
    from services.ollama import verify_documents
    result = await verify_documents(ins, own, veh, user.get("name"))

    if result["decision"] == "approve":
        await db.roadside_verifications.insert_one({
            **base, "status": "approved", "method": "ai", "reason": result.get("reason"),
            "decided_at": now, "decided_by": None,
        })
        await db.users.update_one(
            {"user_id": user["user_id"]}, {"$set": {"roadside_verified": True, "roadside_verified_at": now}}
        )
        await emit_notification(
            user_id=user["user_id"], actor_id=None, ntype="roadside",
            message="You're verified for roadside help — you can now request assistance.",
        )
        return {"status": "approved", "verified": True, "reason": result.get("reason")}

    if result["decision"] == "reject":
        await db.roadside_verifications.insert_one({
            **base, "status": "rejected", "method": "ai", "reason": result.get("reason"),
            "decided_at": now, "decided_by": None,
        })
        return {"status": "rejected", "verified": False, "reason": result.get("reason")}

    # AI unavailable → fall back to the admin review queue. Documents are
    # encrypted at rest and wiped the moment an admin decides.
    await db.roadside_verifications.insert_one({
        **base, "status": "pending", "method": "manual",
        "insurance_enc": encrypt_text(ins), "ownership_enc": encrypt_text(own),
        "reason": None, "decided_at": None, "decided_by": None,
    })
    return {"status": "pending", "verified": False}


@router.get("/admin/roadside/verifications")
async def admin_list_verifications(
    status: str = Query("pending"), authorization: Optional[str] = Header(None),
):
    user = await get_current_user(authorization)
    if not is_mod(user):
        raise HTTPException(status_code=403, detail="Staff only.")
    q = {"status": status} if status else {}
    docs = await db.roadside_verifications.find(q, {"_id": 0}).sort("created_at", -1).limit(50).to_list(50)
    out = []
    for d in docs:
        u = await db.users.find_one({"user_id": d["user_id"]}, {"_id": 0, "name": 1, "picture": 1, "email": 1})
        out.append({
            "id": d["id"],
            "user_id": d["user_id"],
            "user": {"name": (u or {}).get("name", "Member"), "picture": (u or {}).get("picture"), "email": (u or {}).get("email")},
            "status": d["status"],
            "vehicle": _vehicle_str(d),
            "note": d.get("note"),
            # Decrypted only for the reviewing admin; never persisted in the clear.
            "insurance_photo": decrypt_text(d["insurance_enc"]) if d.get("insurance_enc") else None,
            "ownership_photo": decrypt_text(d["ownership_enc"]) if d.get("ownership_enc") else None,
            "created_at": d["created_at"],
        })
    return out


@router.post("/admin/roadside/verifications/{vid}/decision")
async def admin_decide_verification(vid: str, body: RoadsideDecision, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    if not is_mod(user):
        raise HTTPException(status_code=403, detail="Staff only.")
    d = await db.roadside_verifications.find_one({"id": vid}, {"_id": 0})
    if not d:
        raise HTTPException(status_code=404, detail="Verification not found")
    if d["status"] != "pending":
        raise HTTPException(status_code=400, detail="This verification was already decided.")
    now = datetime.now(timezone.utc)
    approve = bool(body.approve)
    # Wipe the documents on decision — we don't keep them.
    await db.roadside_verifications.update_one({"id": vid}, {"$set": {
        "status": "approved" if approve else "rejected",
        "reason": (body.reason or "").strip()[:300] or None,
        "decided_at": now,
        "decided_by": user["user_id"],
        "insurance_enc": None,
        "ownership_enc": None,
    }})
    await db.users.update_one(
        {"user_id": d["user_id"]},
        {"$set": {"roadside_verified": approve, "roadside_verified_at": now if approve else None}},
    )
    await emit_notification(
        user_id=d["user_id"], actor_id=None, ntype="roadside",
        message=(
            "You're verified for roadside help — you can now request assistance."
            if approve else
            f"Your roadside verification was declined.{(' ' + body.reason) if body.reason else ' Please resubmit clear documents.'}"
        ),
    )
    return {"ok": True, "status": "approved" if approve else "rejected"}


@router.post("/roadside/requests", response_model=RoadsideRequest)
async def create_request(body: RoadsideCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    # Admins bypass all roadside verification.
    if not is_admin(user):
        # Requesters must clear the same identity bar as helpers …
        elig = _helper_eligibility(user)
        if not elig["eligible"]:
            raise HTTPException(status_code=403, detail={
                "code": "not_eligible",
                "message": "Verify your identity (ID, email and phone; account 3+ months old; no bans) before requesting roadside help.",
                "missing": elig["missing"],
            })
        # … and have an approved insurance + ownership verification.
        if not user.get("roadside_verified"):
            raise HTTPException(status_code=403, detail={
                "code": "roadside_not_verified",
                "message": "Verify your insurance and vehicle ownership before you can request roadside help.",
            })
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
    method = "cash" if (body.payment_method or "").strip().lower() == "cash" else "wallet"
    base, tax, total = _pricing()
    if method == "cash":
        # Pay the helper $80 in person — no platform hold, no tax.
        tax, total, held = 0.0, base, False
    else:
        held = True
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
        "payment_method": method,
        "price": base,
        "tax": tax,
        "total": total,
        "held": held,
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
    elig = _helper_eligibility(user)
    if not elig["eligible"]:
        raise HTTPException(status_code=403, detail={
            "code": "not_eligible",
            "message": "To help on roadside you must be ID, email and phone verified, have an account at least 3 months old, and no bans or warnings.",
            "missing": elig["missing"],
        })
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


# ── Reviews, disputes & history ─────────────────────────────────────────────
DISPUTE_WINDOW = timedelta(days=7)


@router.post("/roadside/requests/{rid}/review", response_model=RoadsideRequest)
async def review(rid: str, body: RoadsideReview, authorization: Optional[str] = Header(None)):
    """Either party rates the other after the job is complete (one review each)."""
    user = await get_current_user(authorization)
    uid = user["user_id"]
    doc = await db.roadside_requests.find_one({"id": rid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Request not found")
    if uid not in (doc["requester_id"], doc.get("helper_id")):
        raise HTTPException(status_code=403, detail="This isn't your job.")
    if doc["status"] != "completed":
        raise HTTPException(status_code=400, detail="You can review once the job is complete.")
    subject = doc.get("helper_id") if uid == doc["requester_id"] else doc["requester_id"]
    if not subject:
        raise HTTPException(status_code=400, detail="No counterparty to review.")
    if await db.roadside_reviews.find_one({"request_id": rid, "reviewer_id": uid}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=400, detail="You already reviewed this job.")
    rating = max(1, min(5, int(body.rating or 0)))
    now = datetime.now(timezone.utc)
    await db.roadside_reviews.insert_one({
        "id": str(uuid.uuid4()), "request_id": rid,
        "reviewer_id": uid, "subject_id": subject,
        "role": "customer" if uid == doc["requester_id"] else "helper",
        "rating": rating, "text": (body.text or "").strip()[:500] or None,
        "created_at": now,
    })
    await emit_notification(
        user_id=subject, actor_id=uid, ntype="roadside",
        message=f"You got a {rating}-star roadside review.",
    )
    return await _hydrate(doc, uid)


@router.post("/roadside/requests/{rid}/dispute", response_model=RoadsideRequest)
async def dispute(rid: str, authorization: Optional[str] = Header(None)):
    """Either party flags a dispute, up to 7 days after the service call."""
    user = await get_current_user(authorization)
    uid = user["user_id"]
    doc = await db.roadside_requests.find_one({"id": rid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Request not found")
    if uid not in (doc["requester_id"], doc.get("helper_id")):
        raise HTTPException(status_code=403, detail="This isn't your job.")
    now = datetime.now(timezone.utc)
    if (now - _norm_dt(doc["created_at"])) > DISPUTE_WINDOW:
        raise HTTPException(status_code=400, detail={
            "code": "window_closed",
            "message": "The 7-day window to dispute this service has closed.",
        })
    disputed_by = list(doc.get("disputed_by") or [])
    if uid not in disputed_by:
        disputed_by.append(uid)
        await db.roadside_requests.update_one({"id": rid}, {"$set": {"disputed_by": disputed_by, "disputed_at": now}})
        doc["disputed_by"] = disputed_by
        other = doc.get("helper_id") if uid == doc["requester_id"] else doc["requester_id"]
        if other:
            await emit_notification(
                user_id=other, actor_id=uid, ntype="roadside",
                message="A dispute was opened on your roadside job. Our team will look into it.",
            )
    return await _hydrate(doc, uid)


@router.get("/roadside/history", response_model=List[RoadsideRequest])
async def history(authorization: Optional[str] = Header(None)):
    """Recent jobs you were part of — for leaving a review or opening a dispute."""
    user = await get_current_user(authorization)
    uid = user["user_id"]
    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    docs = await db.roadside_requests.find(
        {"$or": [{"requester_id": uid}, {"helper_id": uid}],
         "status": {"$in": ["completed", "cancelled", "accepted"]},
         "created_at": {"$gte": cutoff}},
        {"_id": 0},
    ).sort("created_at", -1).limit(40).to_list(40)
    now = datetime.now(timezone.utc)
    out: List[RoadsideRequest] = []
    for d in docs:
        h = await _hydrate(d, uid)
        my = await db.roadside_reviews.find_one({"request_id": d["id"], "reviewer_id": uid}, {"_id": 0, "rating": 1, "text": 1})
        their = await db.roadside_reviews.find_one({"request_id": d["id"], "subject_id": uid}, {"_id": 0, "rating": 1, "text": 1})
        h.can_review = d["status"] == "completed" and my is None
        h.my_review = RoadsideReviewOut(**my) if my else None
        h.their_review = RoadsideReviewOut(**their) if their else None
        h.can_dispute = (now - _norm_dt(d["created_at"])) <= DISPUTE_WINDOW and uid not in (d.get("disputed_by") or [])
        out.append(h)
    return out
