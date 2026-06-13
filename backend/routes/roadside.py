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
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from core import db, get_current_user, account_age_days, _norm_dt, is_mod, is_admin
from routes.notifications import emit_notification
from routes.money import _wallet_balance, _debit_wallet, _credit_wallet, _record_platform_fee
from services.encryption import encrypt_text, decrypt_text

try:
    from db import DuplicateKeyError
except Exception:  # pragma: no cover
    class DuplicateKeyError(Exception):
        pass

# Daily call-number counter resets at local midnight. The timezone is
# configurable; falls back to UTC if tzdata isn't available.
try:
    from zoneinfo import ZoneInfo
    _ROAD_TZ = ZoneInfo(os.getenv("ROADSIDE_TZ", "America/Toronto"))
except Exception:  # pragma: no cover
    _ROAD_TZ = timezone.utc


def _road_day(now: datetime) -> str:
    try:
        return now.astimezone(_ROAD_TZ).strftime("%Y-%m-%d")
    except Exception:
        return now.strftime("%Y-%m-%d")


async def _next_call_number(day: str) -> int:
    """Highest call number used so far today, + 1. (The actual assignment is
    confirmed by the unique-index insert, which retries on a race.)"""
    last = await db.roadside_requests.find(
        {"call_date": day}, {"_id": 0, "call_number": 1}
    ).sort("call_number", -1).limit(1).to_list(1)
    if last and last[0].get("call_number"):
        return int(last[0]["call_number"]) + 1
    return 1


router = APIRouter()

SERVICES = {"tow", "lockout", "battery", "tire", "gas"}
ACTIVE = {"open", "accepted"}
_LABELS = {"tow": "tow", "lockout": "lockout", "battery": "battery boost", "tire": "tire change", "gas": "gas delivery"}
FUEL_TYPES = {"regular", "midgrade", "premium"}   # gasoline only — no diesel

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


def _parse_money(s: Optional[str]) -> float:
    """Parse a dollar string like "$20" into a number, capped to sane bounds."""
    try:
        v = float(re.sub(r"[^0-9.]", "", str(s or "")) or 0)
        return round(max(0.0, min(v, 500.0)), 2)
    except (TypeError, ValueError):
        return 0.0


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
    fuel_type: Optional[str] = None          # gas delivery: regular | midgrade | premium
    fuel_amount: Optional[str] = None        # gas delivery: how much (e.g. "2 gallons")
    photos: Optional[List[str]] = None
    note: Optional[str] = None
    payment_method: Optional[str] = "wallet"  # wallet (escrow) | cash (pay in person)


class RoadsideReview(BaseModel):
    rating: int
    text: Optional[str] = None


class RoadsideReviewOut(BaseModel):
    rating: int
    text: Optional[str] = None


class RoadsideCheck(BaseModel):
    service: Optional[str] = None
    has_location: bool = False
    place_name: Optional[str] = None
    dest_name: Optional[str] = None
    fuel_type: Optional[str] = None
    fuel_amount: Optional[str] = None
    vehicle_year: Optional[str] = None
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    vehicle_color: Optional[str] = None
    vehicle_plate: Optional[str] = None
    note: Optional[str] = None


class RoadsidePhotoCheck(BaseModel):
    photo: Optional[str] = None              # single base64 data URI, just captured


class RoadsideVerify(BaseModel):
    photos: Optional[List[str]] = None       # "after" proof photos taken at completion


class RoadsidePhotos(BaseModel):
    phase: str = "before"                    # before | after
    photos: Optional[List[str]] = None


class RoadsideArrive(BaseModel):
    longitude: float                         # the helper's current location
    latitude: float


ARRIVE_RADIUS_M = 200                        # helper must be within this to mark "on location"


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
    caller_name: Optional[str] = None        # admin-set display name for the call
    requester: Optional[RoadsideParty] = None
    helper_id: Optional[str] = None
    helper: Optional[RoadsideParty] = None
    service: str
    status: str                              # open | accepted | completed | cancelled
    call_number: Optional[int] = None        # daily queue number (resets at local midnight)
    is_test: bool = False                    # admin-created test call
    en_route: bool = False
    arrived: bool = False                     # helper is on location
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
    fuel_type: Optional[str] = None
    fuel_amount: Optional[str] = None
    fuel_cost: float = 0.0
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


async def _hydrate(doc: dict, viewer_id: str, viewer_coords: Optional[Tuple[float, float]] = None, force_reveal: bool = False) -> RoadsideRequest:
    # Phone numbers are only shared once two members are matched (accepted) and
    # only with each other, so a helper can call the stranded member (and back).
    # Admins viewing the dispatch board see full details (force_reveal).
    reveal = force_reveal or (doc["status"] == "accepted" and viewer_id in (doc["requester_id"], doc.get("helper_id")))
    dist = None
    c = _doc_coords(doc)
    if viewer_coords and c:
        dist = round(_haversine_km(viewer_coords, c), 1)
    return RoadsideRequest(
        id=doc["id"],
        requester_id=doc["requester_id"],
        caller_name=doc.get("caller_name"),
        requester=await _party(doc["requester_id"], reveal_phone=reveal),
        helper_id=doc.get("helper_id"),
        helper=await _party(doc.get("helper_id"), reveal_phone=reveal),
        service=doc["service"],
        status=doc["status"],
        call_number=doc.get("call_number"),
        is_test=bool(doc.get("is_test", False)),
        en_route=bool(doc.get("en_route", False)),
        arrived=bool(doc.get("arrived", False)),
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
        fuel_type=doc.get("fuel_type"),
        fuel_amount=doc.get("fuel_amount"),
        fuel_cost=round(float(doc.get("fuel_cost", 0) or 0), 2),
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
    platform revenue, and mark the job complete. Concurrency-safe via an atomic
    status claim — only the caller that flips accepted->completed pays out, so two
    concurrent verifies (or a verify racing a cancel) can't disburse twice."""
    if doc.get("settled"):
        return
    now = datetime.now(timezone.utc)
    claim = await db.roadside_requests.update_one(
        {"id": doc["id"], "status": "accepted"},
        {"$set": {"status": "completed", "settled": True, "completed_at": now}},
    )
    if getattr(claim, "matched_count", 0) != 1:
        return  # already completed or cancelled by a concurrent caller
    base = round(float(doc.get("price", ROADSIDE_BASE) or 0), 2)
    tax = round(float(doc.get("tax", 0) or 0), 2)
    fuel_cost = round(float(doc.get("fuel_cost", 0) or 0), 2)
    payout = round(base + fuel_cost, 2)   # service fee + any fuel the helper bought
    helper_id = doc.get("helper_id")
    if helper_id and doc.get("held"):
        await _credit_wallet(helper_id, payout)
        await db.earnings.insert_one({
            "id": str(uuid.uuid4()), "user_id": helper_id, "amount": payout, "kind": "roadside",
            "from_user_id": doc["requester_id"], "from_name": "Roadside",
            "message": f"Roadside {_label(doc['service'])}", "source": "roadside",
            "created_at": now,
        })
        await _record_platform_fee(tax, "roadside_tax", doc["requester_id"], doc["id"])
    doc.update({"status": "completed", "settled": True, "completed_at": now})
    cash = doc.get("payment_method") == "cash"
    if helper_id:
        await emit_notification(
            user_id=helper_id, actor_id=doc["requester_id"], ntype="roadside",
            message=(f"Job complete — collect ${payout:.2f} cash from the member."
                     if cash else f"Job complete — ${payout:.2f} was added to your wallet."),
        )
    await emit_notification(
        user_id=doc["requester_id"], actor_id=helper_id, ntype="roadside",
        message=("Roadside job complete — pay your helper in cash. Thanks!"
                 if cash else "Your roadside job is complete and the helper has been paid. Thanks!"),
    )


# ───────────────────────────── endpoints ────────────────────────────────────
# --- §1 response models (extra="allow" so no field is ever dropped) ----------
class _RsOut(BaseModel):
    model_config = ConfigDict(extra="allow")


class OkOut(_RsOut):
    ok: bool = True


class DeletedOut(_RsOut):
    deleted: int = 0


class QuoteOut(_RsOut):
    base: float = 0
    tax: float = 0
    total: float = 0
    tax_rate: float = 0
    wallet_balance: float = 0


class EligibilityOut(_RsOut):
    eligible: bool = False
    missing: list = []


class VerificationStatusOut(_RsOut):
    status: str = ""          # none | pending | approved | rejected
    verified: bool = False
    reason: Optional[str] = None


class DecisionOut(_RsOut):
    ok: bool = True
    status: str = ""


@router.get("/roadside/quote", response_model=QuoteOut)
async def quote(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    base, tax, total = _pricing()
    bal = await _wallet_balance(user["user_id"])
    return {"base": base, "tax": tax, "total": total, "tax_rate": ROADSIDE_TAX_RATE, "wallet_balance": bal}


@router.post("/roadside/check")
async def check_form(body: RoadsideCheck, authorization: Optional[str] = Header(None)):
    """AI (+ rule) review of a draft request: is it filled out correctly, and
    what should be fixed? Returns {ok, issues:[{field, message}]}."""
    await get_current_user(authorization)
    from services.ollama import review_form
    return await review_form(body.model_dump())


@router.post("/roadside/check-photo")
async def check_photo(body: RoadsidePhotoCheck, authorization: Optional[str] = Header(None)):
    """Verify a freshly-taken roadside photo shows the vehicle / the problem and
    isn't blank or random. Called right after capture. Returns {ok, reason}."""
    await get_current_user(authorization)
    from services.ollama import verify_vehicle_photo
    return await verify_vehicle_photo(body.photo or "")


@router.get("/roadside/eligibility", response_model=EligibilityOut)
async def helper_eligibility(authorization: Optional[str] = Header(None)):
    """Whether the current member meets the trust bar to help others."""
    user = await get_current_user(authorization)
    return _helper_eligibility(user)


# ── Requester verification (insurance + ownership, admin-reviewed) ───────────
MAX_DOC_CHARS = 7_000_000  # cap each base64 doc (~5MB image)


@router.get("/roadside/verification", response_model=VerificationStatusOut)
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


@router.post("/roadside/verification", response_model=VerificationStatusOut)
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


@router.post("/admin/roadside/verifications/{vid}/decision", response_model=DecisionOut)
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
        raise HTTPException(status_code=400, detail="Pick a valid service: tow, lockout, battery, tire or gas.")
    dest_name = (body.dest_name or "").strip()[:200]
    if svc == "tow" and not dest_name:
        raise HTTPException(status_code=400, detail="Add where you'd like the vehicle towed to.")
    fuel_type = (body.fuel_type or "").strip().lower() or None
    fuel_amount = (body.fuel_amount or "").strip()[:40] or None
    if svc == "gas":
        if fuel_type == "diesel":
            raise HTTPException(status_code=400, detail="We don't deliver diesel — choose regular, mid-grade or premium.")
        if fuel_type not in FUEL_TYPES:
            raise HTTPException(status_code=400, detail="Choose a fuel type: regular, mid-grade or premium.")
        if not fuel_amount:
            raise HTTPException(status_code=400, detail="Tell the driver how much gas you want.")
    else:
        fuel_type, fuel_amount = None, None
    # The vehicle must be a real make/model/year — block clearly made-up ones.
    from services.ollama import validate_vehicle
    vc = await validate_vehicle(body.vehicle_year, body.vehicle_make, body.vehicle_model, body.vehicle_color, body.vehicle_plate)
    if not vc["valid"]:
        raise HTTPException(status_code=400, detail={
            "code": "vehicle_invalid",
            "message": vc["reason"] or "That doesn't look like a real vehicle — check the year, make and model.",
        })
    existing = await db.roadside_requests.find_one(
        {"requester_id": user["user_id"], "status": {"$in": list(ACTIVE)}}, {"_id": 0, "id": 1}
    )
    if existing:
        raise HTTPException(status_code=400, detail={
            "code": "active_request_exists",
            "message": "You already have an active roadside request. Cancel it before starting a new one.",
        })
    method = "cash" if (body.payment_method or "").strip().lower() == "cash" else "wallet"
    base, tax, _ = _pricing()
    # Gas delivery adds the cost of the fuel itself to the total (paid to the helper).
    fuel_cost = _parse_money(fuel_amount) if svc == "gas" else 0.0
    if method == "cash":
        # Pay the helper ($80 + any fuel) in person — no platform hold, no tax.
        tax, held = 0.0, False
        total = round(base + fuel_cost, 2)
    else:
        held = True
        total = round(base + tax + fuel_cost, 2)
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
        "arrived": False,
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
        "fuel_type": fuel_type,
        "fuel_amount": fuel_amount,
        "fuel_cost": fuel_cost,
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
    # Assign a daily queue number (1, 2, 3 … resetting at local midnight). A
    # unique index on (call_date, call_number) makes this race-safe: if two
    # requests grab the same number, one insert wins and the other retries.
    day = _road_day(now)
    doc["call_date"] = day
    inserted = False
    for _ in range(100):
        doc["call_number"] = await _next_call_number(day)
        try:
            await db.roadside_requests.insert_one(doc.copy())
            inserted = True
            break
        except DuplicateKeyError:
            continue
    if not inserted:
        # Never block a real help request over a numbering hiccup.
        doc.pop("call_date", None)
        doc.pop("call_number", None)
        await db.roadside_requests.insert_one(doc.copy())
    return await _hydrate(doc, user["user_id"])


@router.post("/roadside/requests/{rid}/edit", response_model=RoadsideRequest)
async def edit_request(rid: str, body: RoadsideCreate, authorization: Optional[str] = Header(None)):
    """The requester edits their request while it's still OPEN (no helper yet).
    Re-validates the details, re-prices, and reconciles the wallet hold by
    refunding or charging only the difference. Once a helper has accepted, the
    request can no longer be edited — cancel it instead."""
    user = await get_current_user(authorization)
    doc = await db.roadside_requests.find_one({"id": rid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Request not found")
    if doc["requester_id"] != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only the requester can edit this.")
    if doc["status"] != "open":
        raise HTTPException(status_code=400, detail={
            "code": "not_editable",
            "message": "This request can't be edited — a helper has already accepted it. Cancel it instead.",
        })
    # Same validation as creating.
    svc = (body.service or "").strip().lower()
    if svc not in SERVICES:
        raise HTTPException(status_code=400, detail="Pick a valid service: tow, lockout, battery, tire or gas.")
    dest_name = (body.dest_name or "").strip()[:200]
    if svc == "tow" and not dest_name:
        raise HTTPException(status_code=400, detail="Add where you'd like the vehicle towed to.")
    fuel_type = (body.fuel_type or "").strip().lower() or None
    fuel_amount = (body.fuel_amount or "").strip()[:40] or None
    if svc == "gas":
        if fuel_type == "diesel":
            raise HTTPException(status_code=400, detail="We don't deliver diesel — choose regular, mid-grade or premium.")
        if fuel_type not in FUEL_TYPES:
            raise HTTPException(status_code=400, detail="Choose a fuel type: regular, mid-grade or premium.")
        if not fuel_amount:
            raise HTTPException(status_code=400, detail="Tell the driver how much gas you want.")
    else:
        fuel_type, fuel_amount = None, None
    from services.ollama import validate_vehicle
    vc = await validate_vehicle(body.vehicle_year, body.vehicle_make, body.vehicle_model, body.vehicle_color, body.vehicle_plate)
    if not vc["valid"]:
        raise HTTPException(status_code=400, detail={
            "code": "vehicle_invalid",
            "message": vc["reason"] or "That doesn't look like a real vehicle — check the year, make and model.",
        })
    # Re-price the edited request.
    method = "cash" if (body.payment_method or "").strip().lower() == "cash" else "wallet"
    base, tax, _ = _pricing()
    fuel_cost = _parse_money(fuel_amount) if svc == "gas" else 0.0
    if method == "cash":
        tax, new_held = 0.0, False
        new_total = round(base + fuel_cost, 2)
    else:
        new_held = True
        new_total = round(base + tax + fuel_cost, 2)
    # Reconcile the wallet against whatever is currently held: charge or refund
    # only the difference so the user is never double-charged for an edit.
    old_held_total = round(float(doc.get("total", 0) or 0), 2) if (doc.get("held") and not doc.get("settled") and not doc.get("refunded")) else 0.0
    new_debit = new_total if new_held else 0.0
    delta = round(new_debit - old_held_total, 2)
    now = datetime.now(timezone.utc)
    updates = {
        "service": svc,
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
        "fuel_type": fuel_type,
        "fuel_amount": fuel_amount,
        "fuel_cost": fuel_cost,
        "photos": _clean_photos(body.photos),
        "note": (body.note or "").strip()[:500] or None,
        "payment_method": method,
        "price": base,
        "tax": tax,
        "total": new_total,
        "held": new_held,
        "edited_at": now,
    }
    # Move money relative to the claim so a lost accept-race never leaves the
    # wallet out of sync. Extra charges are taken before the claim (and refunded
    # if it loses, via _credit_wallet which always succeeds); refunds are issued
    # only after the claim wins — never via _debit_wallet, which can silently
    # no-op if the user already spent the transient credit.
    _editable = {"id": rid, "status": "open"}
    if delta > 0:
        bal = await _wallet_balance(user["user_id"])
        if bal + 1e-9 < delta or not await _debit_wallet(user["user_id"], delta):
            raise HTTPException(status_code=400, detail={
                "code": "insufficient_balance",
                "message": f"This change needs ${delta:.2f} more in your wallet. Top up, then save again.",
            })
        res = await db.roadside_requests.update_one(_editable, {"$set": updates})
        if getattr(res, "matched_count", 0) == 0:
            await _credit_wallet(user["user_id"], delta)  # refund the charge; never lost
            raise HTTPException(status_code=409, detail={
                "code": "not_editable",
                "message": "A helper just accepted this request — it can no longer be edited.",
            })
    else:
        res = await db.roadside_requests.update_one(_editable, {"$set": updates})
        if getattr(res, "matched_count", 0) == 0:
            raise HTTPException(status_code=409, detail={
                "code": "not_editable",
                "message": "A helper just accepted this request — it can no longer be edited.",
            })
        if delta < 0:
            await _credit_wallet(user["user_id"], round(-delta, 2))
    doc.update(updates)
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
        # Gate on status="accepted" so en_route can't be set on a job that was
        # cancelled/completed in the race window (keeps the cancel fee logic honest).
        res = await db.roadside_requests.update_one(
            {"id": rid, "status": "accepted"}, {"$set": {"en_route": True, "en_route_at": now}})
        if getattr(res, "matched_count", 0) != 1:
            raise HTTPException(status_code=400, detail="This job isn't active.")
        doc["en_route"] = True
        await emit_notification(
            user_id=doc["requester_id"], actor_id=user["user_id"], ntype="roadside",
            message=f"{user.get('name') or 'Your helper'} is now en route to you.",
        )
    return await _hydrate(doc, user["user_id"])


@router.post("/roadside/requests/{rid}/arrived", response_model=RoadsideRequest)
async def arrived(rid: str, body: RoadsideArrive, authorization: Optional[str] = Header(None)):
    """The assigned helper marks that they're on location (arrived). Gated by a
    GPS proximity check — the helper must actually be near the member."""
    user = await get_current_user(authorization)
    doc = await db.roadside_requests.find_one({"id": rid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Request not found")
    if doc.get("helper_id") != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only the assigned helper can do this.")
    if doc["status"] != "accepted":
        raise HTTPException(status_code=400, detail="This job isn't active.")
    # Confirm the helper is actually at the member's location.
    member_c = _doc_coords(doc)
    if member_c:
        dist_m = _haversine_km((float(body.longitude), float(body.latitude)), member_c) * 1000
        if dist_m > ARRIVE_RADIUS_M:
            raise HTTPException(status_code=400, detail={
                "code": "too_far",
                "message": f"You're about {round(dist_m)} m away. Get within {ARRIVE_RADIUS_M} m of the member, then mark you're on location.",
            })
    if not doc.get("arrived"):
        now = datetime.now(timezone.utc)
        await db.roadside_requests.update_one({"id": rid}, {"$set": {"en_route": True, "arrived": True, "arrived_at": now}})
        doc["en_route"] = True
        doc["arrived"] = True
        await emit_notification(
            user_id=doc["requester_id"], actor_id=user["user_id"], ntype="roadside",
            message=f"{user.get('name') or 'Your helper'} is on location.",
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
    prev_status = doc["status"]
    # A held-and-unsettled job owes a refund. Claim the terminal transition
    # atomically BEFORE moving any money: flipping the current ACTIVE status to
    # cancelled is single-winner, so a second cancel can't double-refund and a
    # cancel racing _settle can't pay the one escrow out to both parties (settle
    # claims status="accepted"->completed; only one of the two can win).
    will_refund = bool(doc.get("held") and not doc.get("settled") and not doc.get("refunded"))
    claim = await db.roadside_requests.update_one(
        {"id": rid, "status": prev_status},
        {"$set": {"status": "cancelled", "completed_at": now, "refunded": will_refund}},
    )
    if getattr(claim, "matched_count", 0) != 1:
        raise HTTPException(status_code=409, detail="This request was just completed or cancelled.")
    helper_fee = 0.0
    if will_refund:
        # Read en_route from the row we just locked-and-won, not the pre-claim
        # snapshot — `enroute` is gated on status="accepted", so it can no longer
        # change now that we've flipped to cancelled.
        fresh = await db.roadside_requests.find_one({"id": rid}, {"_id": 0, "en_route": 1})
        en_route = bool((fresh or {}).get("en_route"))
        if prev_status == "accepted" and en_route:
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
    doc.update({"status": "cancelled", "completed_at": now, "refunded": will_refund})
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


async def mark_roadside_disputed(rid: str, uid: str) -> bool:
    """Flag a roadside job as disputed on behalf of `uid` (a party to it), within
    the 7-day window. Used when a support ticket is actually opened for the job,
    so a dispute is only ever recorded once a valid ticket exists. Best-effort:
    returns True if the job is now flagged for this user, False otherwise."""
    doc = await db.roadside_requests.find_one({"id": rid}, {"_id": 0})
    if not doc or uid not in (doc["requester_id"], doc.get("helper_id")):
        return False
    now = datetime.now(timezone.utc)
    if (now - _norm_dt(doc["created_at"])) > DISPUTE_WINDOW:
        return False
    disputed_by = list(doc.get("disputed_by") or [])
    if uid not in disputed_by:
        disputed_by.append(uid)
        await db.roadside_requests.update_one({"id": rid}, {"$set": {"disputed_by": disputed_by, "disputed_at": now}})
        other = doc.get("helper_id") if uid == doc["requester_id"] else doc["requester_id"]
        if other:
            await emit_notification(
                user_id=other, actor_id=uid, ntype="roadside",
                message="A dispute was opened on your roadside job. Our team will look into it.",
            )
    return True


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


# ──────────────────────────────────────────────────────────────────────────
# Admin dispatch: create test/real calls, search by daily call number, and
# view full call details.
# ──────────────────────────────────────────────────────────────────────────
class AdminCallCreate(BaseModel):
    service: str = "tow"
    longitude: float
    latitude: float
    place_name: Optional[str] = None
    note: Optional[str] = None
    is_test: bool = True
    caller_name: Optional[str] = None
    vehicle_year: Optional[str] = None
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    vehicle_color: Optional[str] = None
    vehicle_plate: Optional[str] = None
    dest_name: Optional[str] = None
    photos: Optional[List[str]] = None
    price: Optional[float] = None       # custom price (admin override); 0/none = free


@router.post("/roadside/admin/calls", response_model=RoadsideRequest)
async def admin_create_call(body: AdminCallCreate, authorization: Optional[str] = Header(None)):
    """Admin creates a call (test or real) with a daily call number. No wallet
    charge or hold — these are dispatch/test entries."""
    user = await get_current_user(authorization)
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Admin only")
    svc = (body.service or "").strip().lower()
    if svc not in SERVICES:
        raise HTTPException(status_code=400, detail=f"service must be one of {sorted(SERVICES)}")
    now = datetime.now(timezone.utc)
    price = round(max(0.0, float(body.price)), 2) if body.price else 0.0
    doc = {
        "id": str(uuid.uuid4()),
        "requester_id": user["user_id"],
        "caller_name": (body.caller_name or "").strip()[:80] or None,
        "helper_id": None,
        "service": svc,
        "status": "open",
        "is_test": bool(body.is_test),
        "admin_created": True,
        "en_route": False,
        "arrived": False,
        "longitude": float(body.longitude),
        "latitude": float(body.latitude),
        "place_name": (body.place_name or "").strip()[:200] or None,
        "vehicle_year": (body.vehicle_year or "").strip()[:8] or None,
        "vehicle_make": (body.vehicle_make or "").strip()[:40] or None,
        "vehicle_model": (body.vehicle_model or "").strip()[:60] or None,
        "vehicle_color": (body.vehicle_color or "").strip()[:30] or None,
        "vehicle_plate": (body.vehicle_plate or "").strip()[:16] or None,
        "dest_name": (body.dest_name or "").strip()[:200] or None,
        "photos": _clean_photos(body.photos),
        "before_photos": [],
        "after_photos": [],
        "note": (body.note or "").strip()[:500] or None,
        "payment_method": "cash",
        "price": price,
        "tax": 0.0,
        "total": price,
        "held": False,
        "settled": False,
        "refunded": False,
        "requester_verified": True,
        "helper_verified": False,
        "created_at": now,
        "accepted_at": None,
        "completed_at": None,
    }
    day = _road_day(now)
    doc["call_date"] = day
    inserted = False
    for _ in range(100):
        doc["call_number"] = await _next_call_number(day)
        try:
            await db.roadside_requests.insert_one(doc.copy())
            inserted = True
            break
        except DuplicateKeyError:
            continue
    if not inserted:
        doc.pop("call_date", None)
        doc.pop("call_number", None)
        await db.roadside_requests.insert_one(doc.copy())
    return await _hydrate(doc, user["user_id"], force_reveal=True)


@router.get("/roadside/admin/calls", response_model=List[RoadsideRequest])
async def admin_list_calls(
    date: Optional[str] = Query(None, description="YYYY-MM-DD; blank = recent across all days"),
    call_number: Optional[int] = Query(None, description="filter to one call number"),
    authorization: Optional[str] = Header(None),
):
    """List calls. With a date, returns that day's calls (by number). Without a
    date, returns the most recent calls across all days. An optional call_number
    filters either view. Admins see full details, including phone numbers."""
    user = await get_current_user(authorization)
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Admin only")
    day = (date or "").strip()
    q: dict = {}
    if day:
        q["call_date"] = day
    if call_number is not None:
        q["call_number"] = int(call_number)
    sort_field = "call_number" if day else "created_at"
    docs = await db.roadside_requests.find(q, {"_id": 0}).sort(sort_field, -1).limit(500).to_list(500)
    return [await _hydrate(d, user["user_id"], force_reveal=True) for d in docs]


@router.delete("/roadside/admin/calls/{rid}", response_model=OkOut)
async def admin_delete_call(rid: str, authorization: Optional[str] = Header(None)):
    """Permanently erase one call."""
    user = await get_current_user(authorization)
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Admin only")
    d = await db.roadside_requests.find_one({"id": rid}, {"_id": 0, "id": 1})
    if not d:
        raise HTTPException(status_code=404, detail="Call not found")
    await db.roadside_requests.delete_one({"id": rid})
    return {"ok": True}


@router.delete("/roadside/admin/calls", response_model=DeletedOut)
async def admin_erase_calls(
    date: Optional[str] = Query(None, description="YYYY-MM-DD; the day to erase"),
    all_: bool = Query(False, alias="all", description="erase every call across all days"),
    test_only: bool = Query(False, description="only erase admin test calls"),
    authorization: Optional[str] = Header(None),
):
    """Bulk-erase calls. Either pass all=true (every call) or a date (that day).
    test_only=true limits it to admin-created test calls."""
    user = await get_current_user(authorization)
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Admin only")
    q: dict = {}
    if not all_:
        day = (date or "").strip() or _road_day(datetime.now(timezone.utc))
        q["call_date"] = day
    if test_only:
        q["is_test"] = True
    rows = await db.roadside_requests.find(q, {"_id": 0, "id": 1}).limit(10000).to_list(10000)
    n = 0
    for r in rows:
        await db.roadside_requests.delete_one({"id": r["id"]})
        n += 1
    return {"deleted": n}
