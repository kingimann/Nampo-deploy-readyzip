"""Marketplace listings + contact seller."""
import math
import re
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple
import uuid

from fastapi import APIRouter, Header, HTTPException, Query

from core import _conv_key, _public_user, db, get_current_user, _norm_dt, require_account_age, MARKETPLACE_MIN_AGE_DAYS, is_admin
from db import DuplicateKeyError
from models import (
    BusinessBrand,
    BusinessProfile,
    BusinessProfilePatch,
    ConversationView,
    Listing,
    ListingComment,
    ListingCreate,
    ListingPatch,
    MarketplaceReview,
    MarketplaceReviewCreate,
    Message,
    PostAuthor,
    ReportCreate,
    SellerProfile,
    TradeConfirm,
)
from pydantic import BaseModel, ConfigDict

router = APIRouter()


async def _has_verified_trade(a: str, b: str) -> bool:
    """True if users a and b have a confirmed marketplace trade between them."""
    doc = await db.marketplace_trades.find_one(
        {"status": "confirmed", "party_ids": {"$all": [a, b]}}, {"_id": 0, "id": 1}
    )
    return bool(doc)


async def _has_verified_personal_trade(a: str, b: str) -> bool:
    """A confirmed trade between a and b on a PERSONAL listing (no business).
    Personal reviews are earned only from personal trades — business trades earn
    business reviews instead, keeping the two reputations completely separate."""
    doc = await db.marketplace_trades.find_one(
        {"status": "confirmed", "party_ids": {"$all": [a, b]},
         "$or": [{"business_id": None}, {"business_id": {"$exists": False}}]},
        {"_id": 0, "id": 1},
    )
    return bool(doc)


async def _has_verified_business_trade(reviewer_id: str, business_id: str) -> bool:
    """True if the reviewer has a confirmed trade made WITH this business
    (a listing that was attributed to the business at the time of the trade)."""
    doc = await db.marketplace_trades.find_one(
        {"status": "confirmed", "business_id": business_id, "party_ids": reviewer_id},
        {"_id": 0, "id": 1},
    )
    return bool(doc)


async def _subject_trade_role(reviewer_id: str, subject_id: str) -> str:
    """In the verified trade between these two, was `subject_id` acting as the
    'seller' (the listing's owner) or the 'buyer'? Defaults to 'seller'."""
    trade = await db.marketplace_trades.find_one(
        {"status": "confirmed", "party_ids": {"$all": [reviewer_id, subject_id]}},
        {"_id": 0, "listing_id": 1}, sort=[("created_at", -1)],
    )
    if trade:
        listing = await db.listings.find_one({"id": trade.get("listing_id")}, {"_id": 0, "user_id": 1})
        seller_id = (listing or {}).get("user_id")
        if seller_id == reviewer_id:
            return "buyer"   # the reviewer was the seller, so the subject is the buyer
    return "seller"


def _gen_trade_code() -> str:
    # Unambiguous 6-char code (no 0/O/1/I).
    import secrets
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(6))


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


async def _business_brand(business_id: Optional[str]) -> Optional[BusinessBrand]:
    """Resolve the storefront brand for listing cards. Returns None when the
    business doesn't exist or its owner's personal account is banned — the ban
    cascade hides the business everywhere it would otherwise surface."""
    if not business_id:
        return None
    b = await db.business_profiles.find_one({"id": business_id}, {"_id": 0})
    if not b:
        return None
    owner = await db.users.find_one(
        {"user_id": b.get("owner_id")}, {"_id": 0, "banned": 1, "verified": 1}
    )
    if not owner or owner.get("banned"):
        return None
    return BusinessBrand(
        id=b["id"], name=b.get("name", "Shop"),
        logo=b.get("logo"), accent=b.get("accent"),
        verified=bool(owner.get("verified", False)),
    )


async def _hydrate_listing(
    doc: dict, viewer_id: Optional[str] = None,
    saved_ids: Optional[set] = None, with_counts: bool = False,
    viewer_coords: Optional[Tuple[float, float]] = None,
) -> Listing:
    author_doc = await db.users.find_one({"user_id": doc["user_id"]}, {"_id": 0}) or {}
    from core import _resolve_badges
    seller = PostAuthor(
        user_id=doc["user_id"],
        name=author_doc.get("name", "Unknown") or "Unknown",
        username=author_doc.get("username"),
        picture=author_doc.get("picture"),
        verified=bool(author_doc.get("verified", False)),
        badges=await _resolve_badges(author_doc.get("badge_ids")),
        id_verified=bool(author_doc.get("id_verified", False)),
        phone_verified=bool(author_doc.get("phone_verified", False)),
        email_verified=bool(author_doc.get("email_verified", False)),
    )
    photos = doc.get("photos") or ([doc["photo_base64"]] if doc.get("photo_base64") else [])
    if saved_ids is not None:
        saved_by_me = doc["id"] in saved_ids
    elif viewer_id:
        saved_by_me = bool(await db.listing_saves.find_one(
            {"listing_id": doc["id"], "user_id": viewer_id}, {"_id": 0, "id": 1}))
    else:
        saved_by_me = False
    saved_count = await db.listing_saves.count_documents({"listing_id": doc["id"]}) if with_counts else 0
    liked_by_me = bool(await db.listing_likes.find_one(
        {"listing_id": doc["id"], "user_id": viewer_id}, {"_id": 0, "id": 1})) if viewer_id else False
    distance_km = None
    if viewer_coords is not None:
        coords = _doc_coords(doc)
        if coords is not None:
            distance_km = round(_haversine_km(viewer_coords, coords), 1)
    business = await _business_brand(doc.get("business_id"))
    return Listing(
        id=doc["id"], user_id=doc["user_id"], seller=seller,
        title=doc["title"], price=doc.get("price", 0),
        currency=doc.get("currency", "USD"),
        category=doc.get("category", "other"),
        condition=doc.get("condition", "used"),
        description=doc.get("description", ""),
        photo_base64=doc.get("photo_base64"),
        photos=photos,
        longitude=doc.get("longitude"), latitude=doc.get("latitude"),
        locality=doc.get("locality"),
        negotiable=bool(doc.get("negotiable", False)),
        quantity=int(doc.get("quantity", 1) or 1),
        brand=doc.get("brand"),
        delivery=doc.get("delivery", "pickup"),
        contact_email=doc.get("contact_email"),
        contact_phone=doc.get("contact_phone"),
        business_id=doc.get("business_id"),
        business=business,
        distance_km=distance_km,
        status=doc.get("status", "active"),
        flag_reasons=doc.get("flag_reasons"),
        views_count=doc.get("views_count", 0),
        saved_count=saved_count,
        saved_by_me=saved_by_me,
        likes_count=int(doc.get("likes_count", 0) or 0),
        liked_by_me=liked_by_me,
        comments_count=int(doc.get("comments_count", 0) or 0),
        created_at=doc["created_at"],
    )


async def _saved_ids_for(user_id: str) -> set:
    rows = await db.listing_saves.find({"user_id": user_id}, {"_id": 0, "listing_id": 1}).to_list(1000)
    return {r["listing_id"] for r in rows if r.get("listing_id")}


_MEDIA_LIMIT = 8 * 1024 * 1024

# Anti-spam: min seconds between a user's listings, and a per-day cap.
LISTING_COOLDOWN_SECONDS = 120
LISTING_DAILY_CAP = 20


def _norm_title(t: str) -> str:
    """Normalize a title for duplicate detection (lowercase, collapse spaces)."""
    return " ".join((t or "").lower().split())


def _clean_photos(body) -> list:
    photos = list(body.photos or [])
    if not photos and getattr(body, "photo_base64", None):
        photos = [body.photo_base64]
    return [p for p in photos[:6] if p and len(p) <= _MEDIA_LIMIT]


@router.post("/listings", response_model=Listing)
async def create_listing(body: ListingCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    if user.get("marketplace_disabled"):
        raise HTTPException(status_code=403, detail={
            "code": "marketplace_disabled",
            "message": "Marketplace selling has been disabled on your account by an administrator.",
        })
    require_account_age(user, "sell on the marketplace", MARKETPLACE_MIN_AGE_DAYS)
    title = (body.title or "").strip()[:120]
    if not title:
        raise HTTPException(status_code=400, detail="Title required")
    if body.price < 0:
        raise HTTPException(status_code=400, detail="Price must be ≥ 0")

    now = datetime.now(timezone.utc)
    uid = user["user_id"]
    # ── Anti-spam ── (admins are immune to these site rules) ────────────────
    if not is_admin(user):
        # 1) Cooldown between listings.
        last = await db.listings.find_one({"user_id": uid}, {"_id": 0, "created_at": 1}, sort=[("created_at", -1)])
        if last and last.get("created_at"):
            try:
                since = (now - _norm_dt(last["created_at"])).total_seconds()
                if since < LISTING_COOLDOWN_SECONDS:
                    wait = int(LISTING_COOLDOWN_SECONDS - since)
                    raise HTTPException(status_code=429, detail={
                        "code": "listing_cooldown",
                        "message": f"Please wait {wait}s before posting another listing.",
                    })
            except HTTPException:
                raise
            except Exception:
                pass
        # 2) Daily cap.
        day_ago = now - timedelta(days=1)
        recent_count = await db.listings.count_documents({"user_id": uid, "created_at": {"$gte": day_ago}})
        if recent_count >= LISTING_DAILY_CAP:
            raise HTTPException(status_code=429, detail={
                "code": "listing_daily_cap",
                "message": f"You've hit the daily limit of {LISTING_DAILY_CAP} listings. Try again tomorrow.",
            })
        # 3) No duplicates — same normalized title with an active listing.
        dupe = await db.listings.find_one(
            {"user_id": uid, "status": "active", "title_norm": _norm_title(title)}, {"_id": 0, "id": 1}
        )
        if dupe:
            raise HTTPException(status_code=409, detail={
                "code": "duplicate_listing",
                "message": "You already have an active listing with this title.",
            })

    # If listing under a business storefront, verify the caller owns it.
    business_id = None
    if body.business_id:
        biz = await db.business_profiles.find_one(
            {"id": body.business_id, "owner_id": uid}, {"_id": 0, "id": 1}
        )
        if not biz:
            raise HTTPException(status_code=403, detail={
                "code": "not_your_business",
                "message": "You can only list under a business storefront you own.",
            })
        business_id = body.business_id

    photos = _clean_photos(body)
    # AI + rule spam moderation. Reused photos across the seller's own listings
    # are a common spam signal, so check that here (DB-side) and pass it in.
    dup_existing = False
    if photos:
        other = await db.listings.find_one(
            {"user_id": user["user_id"], "status": "active", "photos": {"$all": photos}}, {"_id": 0, "id": 1}
        )
        dup_existing = bool(other)
    from services.ollama import moderate_listing
    mod = await moderate_listing(title, body.description or "", photos, dup_existing)
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["user_id"],
        "title": title,
        "title_norm": _norm_title(title),
        "price": float(body.price),
        "currency": (body.currency or "USD")[:8],
        "category": body.category or "other",
        "condition": body.condition or "used",
        "description": (body.description or "")[:2000],
        "photo_base64": photos[0] if photos else None,
        "photos": photos,
        "longitude": body.longitude,
        "latitude": body.latitude,
        "locality": (body.locality or "")[:120],
        "negotiable": bool(body.negotiable),
        "quantity": max(1, int(body.quantity or 1)),
        "brand": (body.brand or "").strip()[:80] or None,
        "delivery": body.delivery if body.delivery in ("pickup", "shipping", "both") else "pickup",
        "contact_email": (body.contact_email or "").strip()[:120] or None,
        "contact_phone": (body.contact_phone or "").strip()[:40] or None,
        "business_id": business_id,
        "status": "flagged" if mod["flagged"] else "active",
        "flag_reasons": mod["reasons"] if mod["flagged"] else None,
        "flagged_at": datetime.now(timezone.utc) if mod["flagged"] else None,
        "views_count": 0,
        "created_at": datetime.now(timezone.utc),
    }
    await db.listings.insert_one(doc.copy())
    if mod["flagged"]:
        from routes.notifications import emit_notification
        await emit_notification(
            user_id=user["user_id"], actor_id=None, ntype="moderation",
            message=("Your listing “" + title[:60] + "” was unpublished by our automated check: "
                     + "; ".join(mod["reasons"][:3]) + " Fix it and it'll go live, or contact support."),
        )
    return await _hydrate_listing(doc, viewer_id=user["user_id"])


@router.get("/listings", response_model=List[Listing])
async def list_listings(
    category: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    status: Optional[str] = Query("active"),
    condition: Optional[str] = Query(None),
    min_price: Optional[float] = Query(None),
    max_price: Optional[float] = Query(None),
    sort: Optional[str] = Query("recent"),  # recent | price_low | price_high | popular | nearby
    lat: Optional[float] = Query(None),
    lng: Optional[float] = Query(None),
    radius_km: Optional[float] = Query(None),
    authorization: Optional[str] = Header(None),
):
    user = await get_current_user(authorization)
    filt: dict = {}
    if status and status != "all":
        filt["status"] = status
    if category and category != "all":
        filt["category"] = category
    if condition and condition != "all":
        filt["condition"] = condition
    price_filt: dict = {}
    if min_price is not None:
        price_filt["$gte"] = float(min_price)
    if max_price is not None:
        price_filt["$lte"] = float(max_price)
    if price_filt:
        filt["price"] = price_filt
    if q and q.strip():
        pattern = re.escape(q.strip())
        filt["$or"] = [
            {"title": {"$regex": pattern, "$options": "i"}},
            {"description": {"$regex": pattern, "$options": "i"}},
        ]
    sort_field, sort_dir = "created_at", -1
    if sort == "price_low":
        sort_field, sort_dir = "price", 1
    elif sort == "price_high":
        sort_field, sort_dir = "price", -1
    elif sort == "popular":
        sort_field, sort_dir = "views_count", -1
    # Pull a wider candidate set when filtering by distance, since many get
    # dropped for being out of range or having no coordinates.
    viewer_coords: Optional[Tuple[float, float]] = (
        (float(lng), float(lat)) if lat is not None and lng is not None else None
    )
    want_distance = viewer_coords is not None and (radius_km is not None or sort == "nearby")
    cap = 400 if want_distance else 100
    cursor = db.listings.find(filt, {"_id": 0}).sort(sort_field, sort_dir).limit(cap)
    docs = await cursor.to_list(cap)
    if want_distance and radius_km is not None:
        kept = []
        for d in docs:
            c = _doc_coords(d)
            if c is not None and _haversine_km(viewer_coords, c) <= float(radius_km):
                kept.append(d)
        docs = kept
    saved_ids = await _saved_ids_for(user["user_id"])
    listings = [
        await _hydrate_listing(d, saved_ids=saved_ids, viewer_coords=viewer_coords)
        for d in docs
    ]
    if sort == "nearby" and viewer_coords is not None:
        listings.sort(key=lambda x: (x.distance_km is None, x.distance_km or 0.0))
    return listings[:100]


@router.get("/listings/saved", response_model=List[Listing])
async def saved_listings(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    saved = await db.listing_saves.find(
        {"user_id": user["user_id"]}, {"_id": 0, "listing_id": 1}
    ).sort("created_at", -1).to_list(200)
    ids = [s["listing_id"] for s in saved]
    if not ids:
        return []
    docs = await db.listings.find({"id": {"$in": ids}}, {"_id": 0}).to_list(200)
    order = {lid: i for i, lid in enumerate(ids)}
    docs.sort(key=lambda d: order.get(d["id"], 1e9))
    return [await _hydrate_listing(d, viewer_id=user["user_id"]) for d in docs]


@router.get("/listings/user/{user_id}", response_model=List[Listing])
async def listings_by_user(user_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    filt: dict = {"user_id": user_id}
    # Owners see their own flagged (unpublished) listings so they can fix them;
    # everyone else does not.
    if me["user_id"] != user_id:
        filt["status"] = {"$ne": "flagged"}
    cursor = db.listings.find(filt, {"_id": 0}).sort("created_at", -1)
    docs = await cursor.to_list(100)
    saved_ids = await _saved_ids_for(me["user_id"])
    return [await _hydrate_listing(d, saved_ids=saved_ids) for d in docs]


@router.get("/marketplace/purchases", response_model=List[Listing])
async def my_purchases(authorization: Optional[str] = Header(None)):
    """Listings the current user bought (verified sold to them), newest first."""
    me = await get_current_user(authorization)
    docs = await db.listings.find(
        {"sold_to": me["user_id"], "status": "sold"}, {"_id": 0}
    ).sort("sold_at", -1).limit(100).to_list(100)
    saved_ids = await _saved_ids_for(me["user_id"])
    return [await _hydrate_listing(d, saved_ids=saved_ids) for d in docs]


@router.get("/listings/{listing_id}", response_model=Listing)
async def get_listing(listing_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.listings.find_one({"id": listing_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Listing not found")
    # A flagged (unpublished) listing is only visible to its owner.
    if doc.get("status") == "flagged" and doc["user_id"] != user["user_id"]:
        raise HTTPException(status_code=404, detail="Listing not found")
    # Count a view (not for the owner).
    if doc["user_id"] != user["user_id"]:
        await db.listings.update_one({"id": listing_id}, {"$inc": {"views_count": 1}})
        doc["views_count"] = doc.get("views_count", 0) + 1
    return await _hydrate_listing(doc, viewer_id=user["user_id"], with_counts=True)


# --- §1 response models (extra="allow" so no field is ever dropped) ----------
class _MkOut(BaseModel):
    model_config = ConfigDict(extra="allow")


class OkOut(_MkOut):
    ok: bool = True


class SaveOut(_MkOut):
    ok: bool = True
    saved: bool = False


class TradeStartOut(_MkOut):
    code: str = ""
    status: str = ""


class TradeConfirmOut(_MkOut):
    status: str = ""
    partner_name: Optional[str] = None


@router.post("/listings/{listing_id}/save", response_model=SaveOut)
async def save_listing(listing_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    listing = await db.listings.find_one({"id": listing_id}, {"_id": 0, "id": 1})
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    existing = await db.listing_saves.find_one(
        {"listing_id": listing_id, "user_id": user["user_id"]}, {"_id": 0, "id": 1})
    if not existing:
        await db.listing_saves.insert_one({
            "id": str(uuid.uuid4()),
            "listing_id": listing_id,
            "user_id": user["user_id"],
            "created_at": datetime.now(timezone.utc),
        })
    return {"ok": True, "saved": True}


@router.delete("/listings/{listing_id}/save", response_model=SaveOut)
async def unsave_listing(listing_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    await db.listing_saves.delete_one({"listing_id": listing_id, "user_id": user["user_id"]})
    return {"ok": True, "saved": False}


@router.patch("/listings/{listing_id}", response_model=Listing)
async def patch_listing(
    listing_id: str, body: ListingPatch, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    doc = await db.listings.find_one({"id": listing_id, "user_id": user["user_id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Listing not found")
    patch = {}
    if body.title is not None and body.title.strip():
        patch["title"] = body.title.strip()[:120]
    if body.price is not None:
        if body.price < 0:
            raise HTTPException(status_code=400, detail="Price must be ≥ 0")
        patch["price"] = float(body.price)
    if body.currency is not None:
        patch["currency"] = body.currency[:8]
    if body.category is not None:
        patch["category"] = body.category
    if body.condition is not None:
        patch["condition"] = body.condition
    if body.description is not None:
        patch["description"] = body.description[:2000]
    if body.photos is not None:
        photos = [p for p in body.photos[:6] if p and len(p) <= _MEDIA_LIMIT]
        patch["photos"] = photos
        patch["photo_base64"] = photos[0] if photos else None
    elif body.photo_base64 is not None:
        patch["photo_base64"] = body.photo_base64
        patch["photos"] = [body.photo_base64] if body.photo_base64 else []
    if body.status is not None:
        # status is constrained to {"active","sold"} by the model; "flagged" is
        # moderation's call (see the re-moderation below), never client-set.
        patch["status"] = body.status
    if body.locality is not None:
        patch["locality"] = body.locality[:120]
    if body.longitude is not None:
        patch["longitude"] = body.longitude
    if body.latitude is not None:
        patch["latitude"] = body.latitude
    if body.negotiable is not None:
        patch["negotiable"] = bool(body.negotiable)
    if body.quantity is not None:
        patch["quantity"] = max(1, int(body.quantity))
    if body.brand is not None:
        patch["brand"] = (body.brand or "").strip()[:80] or None
    if body.delivery is not None and body.delivery in ("pickup", "shipping", "both"):
        patch["delivery"] = body.delivery
    if body.contact_email is not None:
        patch["contact_email"] = (body.contact_email or "").strip()[:120] or None
    if body.contact_phone is not None:
        patch["contact_phone"] = (body.contact_phone or "").strip()[:40] or None
    if body.business_id is not None:
        if body.business_id == "":
            patch["business_id"] = None       # move back to the personal profile
        else:
            biz = await db.business_profiles.find_one(
                {"id": body.business_id, "owner_id": user["user_id"]}, {"_id": 0, "id": 1}
            )
            if not biz:
                raise HTTPException(status_code=403, detail={
                    "code": "not_your_business",
                    "message": "You can only list under a business storefront you own.",
                })
            patch["business_id"] = body.business_id
    # Re-moderate when the content (title/description/photos) changed — fixing a
    # flagged listing republishes it; editing one into spam re-flags it. Also
    # re-moderate when the owner tries to (re)activate, so a flagged listing
    # can't be silently un-flagged by sending {status:"active"}. Marking SOLD
    # never needs moderation, so it's the only status that skips this.
    content_changed = any(k in patch for k in ("title", "description", "photos"))
    reactivating_flagged = body.status == "active" and doc.get("status") == "flagged"
    if (content_changed or reactivating_flagged) and body.status != "sold" \
            and doc.get("status") in ("active", "flagged", None):
        title = patch.get("title", doc.get("title", ""))
        desc = patch.get("description", doc.get("description", ""))
        photos = patch.get("photos", doc.get("photos") or [])
        from services.ollama import moderate_listing
        mod = await moderate_listing(title, desc or "", photos, False)
        was_flagged = doc.get("status") == "flagged"
        patch["status"] = "flagged" if mod["flagged"] else "active"
        patch["flag_reasons"] = mod["reasons"] if mod["flagged"] else None
        if mod["flagged"] and not was_flagged:
            from routes.notifications import emit_notification
            await emit_notification(
                user_id=user["user_id"], actor_id=None, ntype="moderation",
                message=("Your listing was unpublished by our automated check: "
                         + "; ".join(mod["reasons"][:3]) + " Fix it and it'll go live, or contact support."),
            )
    if patch:
        await db.listings.update_one({"id": listing_id}, {"$set": patch})
    # Price-drop alert: if the price was lowered, tell everyone who saved this
    # listing (only while it's still active — no ping on a sold/flagged edit).
    old_price = round(float(doc.get("price", 0) or 0), 2)
    new_price = patch.get("price")
    if (new_price is not None and round(float(new_price), 2) < old_price
            and patch.get("status", doc.get("status")) == "active"):
        await _notify_price_drop(listing_id, doc.get("title") or "a listing",
                                 old_price, round(float(new_price), 2), user["user_id"])
    updated = await db.listings.find_one({"id": listing_id}, {"_id": 0})
    return await _hydrate_listing(updated, viewer_id=user["user_id"], with_counts=True)


async def _notify_price_drop(listing_id: str, title: str, old_price: float,
                             new_price: float, owner_id: str) -> None:
    """Notify savers (not the owner) that a saved listing's price dropped."""
    savers = await db.listing_saves.find(
        {"listing_id": listing_id}, {"_id": 0, "user_id": 1}).limit(500).to_list(500)
    if not savers:
        return
    from routes.notifications import emit_notification
    msg = f"Price dropped on “{title[:48]}” — now ${new_price:.2f} (was ${old_price:.2f})"
    seen = set()
    for s in savers:
        uid = s.get("user_id")
        if not uid or uid == owner_id or uid in seen:
            continue
        seen.add(uid)
        try:
            await emit_notification(user_id=uid, actor_id=owner_id,
                                    ntype="marketplace", message=msg, post_id=listing_id)
        except Exception:
            pass


@router.delete("/listings/{listing_id}", response_model=OkOut)
async def delete_listing(listing_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    res = await db.listings.delete_one({"id": listing_id, "user_id": user["user_id"]})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Listing not found")
    return {"ok": True}


# ---------- Seller / buyer profiles + reviews ----------
# Granular rating categories collected after a verified trade (each 1-5 stars).
REVIEW_CATEGORIES = ["communication", "as_described", "shipping", "friendliness"]


def _clean_category_ratings(raw) -> dict:
    out = {}
    if isinstance(raw, dict):
        for k in REVIEW_CATEGORIES:
            v = raw.get(k)
            if isinstance(v, (int, float)) and 1 <= int(v) <= 5:
                out[k] = int(v)
    return out


async def _hydrate_review(doc: dict) -> MarketplaceReview:
    author_doc = await db.users.find_one({"user_id": doc["reviewer_id"]}, {"_id": 0})
    reviewer = PostAuthor(
        user_id=doc["reviewer_id"],
        name=author_doc.get("name", "Unknown") if author_doc else "Unknown",
        picture=author_doc.get("picture") if author_doc else None,
    )
    biz_id = doc.get("subject_business_id")
    if biz_id:
        verified = await _has_verified_business_trade(doc["reviewer_id"], biz_id)
    else:
        verified = await _has_verified_trade(doc["reviewer_id"], doc.get("subject_user_id"))
    return MarketplaceReview(
        id=doc["id"], subject_user_id=doc.get("subject_user_id"),
        subject_business_id=biz_id, reviewer=reviewer,
        rating=doc.get("rating", 5), ratings=doc.get("ratings") or {},
        verified=verified, role=doc.get("role", "seller"),
        text=doc.get("text", ""), created_at=doc["created_at"],
    )


@router.get("/marketplace/users/{user_id}", response_model=SellerProfile)
async def seller_profile(user_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    udoc = await db.users.find_one({"user_id": user_id}, {"_id": 0, "user_id": 1})
    if not udoc:
        raise HTTPException(status_code=404, detail="User not found")
    pu = await _public_user(user_id)
    ratings = await db.marketplace_reviews.find(
        {"subject_user_id": user_id}, {"_id": 0, "rating": 1, "ratings": 1, "role": 1}
    ).to_list(2000)
    count = len(ratings)
    rating = round(sum(r.get("rating", 0) for r in ratings) / count, 1) if count else 0.0
    # Split into the user's seller-side and buyer-side reputations.
    def _avg(rows):
        return round(sum(r.get("rating", 0) for r in rows) / len(rows), 1) if rows else 0.0
    seller_rows = [r for r in ratings if r.get("role", "seller") == "seller"]
    buyer_rows = [r for r in ratings if r.get("role") == "buyer"]
    seller_rating, seller_review_count = _avg(seller_rows), len(seller_rows)
    buyer_rating, buyer_review_count = _avg(buyer_rows), len(buyer_rows)
    # Average each granular category across all reviews that scored it.
    category_ratings: dict = {}
    for cat in REVIEW_CATEGORIES:
        vals = [int(r["ratings"][cat]) for r in ratings
                if isinstance(r.get("ratings"), dict) and isinstance(r["ratings"].get(cat), (int, float))]
        if vals:
            category_ratings[cat] = round(sum(vals) / len(vals), 1)
    listing_docs = await db.listings.find(
        {"user_id": user_id, "status": {"$ne": "sold"}}, {"_id": 0}
    ).sort("created_at", -1).to_list(60)
    listing_docs = [d for d in listing_docs if d.get("status") != "flagged"]   # hide unpublished
    saved_ids = await _saved_ids_for(me["user_id"])
    listings = [await _hydrate_listing(d, saved_ids=saved_ids) for d in listing_docs]
    listing_count = await db.listings.count_documents({"user_id": user_id})
    reviewed_by_me = bool(await db.marketplace_reviews.find_one(
        {"subject_user_id": user_id, "reviewer_id": me["user_id"]}, {"_id": 0, "id": 1}
    ))
    can_review = me["user_id"] != user_id and await _has_verified_personal_trade(me["user_id"], user_id)
    return SellerProfile(
        user=pu, rating=rating, review_count=count, category_ratings=category_ratings,
        seller_rating=seller_rating, seller_review_count=seller_review_count,
        buyer_rating=buyer_rating, buyer_review_count=buyer_review_count,
        listing_count=listing_count, listings=listings, reviewed_by_me=reviewed_by_me,
        can_review=can_review,
    )


@router.get("/marketplace/users/{user_id}/reviews", response_model=List[MarketplaceReview])
async def list_seller_reviews(user_id: str, authorization: Optional[str] = Header(None)):
    await get_current_user(authorization)
    docs = await db.marketplace_reviews.find(
        {"subject_user_id": user_id}, {"_id": 0}
    ).sort("created_at", -1).to_list(100)
    return [await _hydrate_review(d) for d in docs]


# ---------- Business storefronts ----------
# A business profile is a separate selling identity owned by a personal account.
# It's kept apart from the social profile, but the ban cascade ties it to the
# owner: a banned owner's storefront 404s and its brand is stripped from cards.
_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _clean_biz_patch(body: BusinessProfilePatch) -> dict:
    out: dict = {}
    if body.name is not None:
        out["name"] = body.name.strip()[:60]
    if body.tagline is not None:
        out["tagline"] = body.tagline.strip()[:120] or None
    if body.bio is not None:
        out["bio"] = body.bio.strip()[:1000] or None
    if body.logo is not None:
        out["logo"] = (body.logo or None) if len(body.logo or "") <= _MEDIA_LIMIT else None
    if body.banner is not None:
        out["banner"] = (body.banner or None) if len(body.banner or "") <= _MEDIA_LIMIT else None
    if body.accent is not None:
        out["accent"] = body.accent if (body.accent and _HEX_RE.match(body.accent)) else None
    if body.category is not None:
        out["category"] = body.category.strip()[:40] or None
    if body.policies is not None:
        out["policies"] = body.policies.strip()[:1000] or None
    if body.location is not None:
        out["location"] = body.location.strip()[:120] or None
    if body.contact_email is not None:
        out["contact_email"] = body.contact_email.strip()[:120] or None
    if body.contact_phone is not None:
        out["contact_phone"] = body.contact_phone.strip()[:40] or None
    if body.website is not None:
        out["website"] = body.website.strip()[:200] or None
    return out


async def _business_rating(business_id: str) -> Tuple[float, int]:
    """The storefront's reputation from its OWN reviews — completely separate
    from the owner's personal seller/buyer reviews."""
    rows = await db.marketplace_reviews.find(
        {"subject_business_id": business_id}, {"_id": 0, "rating": 1}
    ).to_list(2000)
    if not rows:
        return 0.0, 0
    return round(sum(r.get("rating", 0) for r in rows) / len(rows), 1), len(rows)


async def _hydrate_business(
    doc: dict, viewer_id: str, with_listings: bool = False,
    saved_ids: Optional[set] = None,
) -> BusinessProfile:
    from core import _resolve_badges
    owner_doc = await db.users.find_one({"user_id": doc["owner_id"]}, {"_id": 0}) or {}
    owner = PostAuthor(
        user_id=doc["owner_id"],
        name=owner_doc.get("name", "Unknown") or "Unknown",
        username=owner_doc.get("username"),
        picture=owner_doc.get("picture"),
        verified=bool(owner_doc.get("verified", False)),
        badges=await _resolve_badges(owner_doc.get("badge_ids")),
    )
    listing_count = await db.listings.count_documents(
        {"business_id": doc["id"], "status": {"$ne": "sold"}}
    )
    rating, review_count = await _business_rating(doc["id"])
    reviewed_by_me = bool(await db.marketplace_reviews.find_one(
        {"subject_business_id": doc["id"], "reviewer_id": viewer_id}, {"_id": 0, "id": 1}))
    can_review = (viewer_id != doc["owner_id"]) and await _has_verified_business_trade(viewer_id, doc["id"])
    listings: List[Listing] = []
    if with_listings:
        ldocs = await db.listings.find(
            {"business_id": doc["id"], "status": {"$ne": "sold"}}, {"_id": 0}
        ).sort("created_at", -1).to_list(60)
        ldocs = [d for d in ldocs if d.get("status") != "flagged"]
        listings = [await _hydrate_listing(d, saved_ids=saved_ids) for d in ldocs]
    return BusinessProfile(
        id=doc["id"], owner_id=doc["owner_id"], owner=owner,
        name=doc.get("name", "Shop"), tagline=doc.get("tagline"),
        bio=doc.get("bio"), logo=doc.get("logo"), banner=doc.get("banner"),
        accent=doc.get("accent"), category=doc.get("category"),
        policies=doc.get("policies"), location=doc.get("location"),
        contact_email=doc.get("contact_email"), contact_phone=doc.get("contact_phone"),
        website=doc.get("website"),
        listing_count=listing_count, rating=rating, review_count=review_count,
        is_owner=(viewer_id == doc["owner_id"]),
        reviewed_by_me=reviewed_by_me, can_review=can_review,
        listings=listings, created_at=doc["created_at"],
    )


@router.get("/marketplace/business/me", response_model=Optional[BusinessProfile])
async def my_business(authorization: Optional[str] = Header(None)):
    """The caller's own storefront, or null if they haven't created one."""
    user = await get_current_user(authorization)
    doc = await db.business_profiles.find_one({"owner_id": user["user_id"]}, {"_id": 0})
    if not doc:
        return None
    return await _hydrate_business(doc, user["user_id"])


@router.put("/marketplace/business", response_model=BusinessProfile)
async def upsert_business(body: BusinessProfilePatch, authorization: Optional[str] = Header(None)):
    """Create the caller's storefront (one per account) or update the existing one."""
    user = await get_current_user(authorization)
    if user.get("marketplace_disabled"):
        raise HTTPException(status_code=403, detail={
            "code": "marketplace_disabled",
            "message": "Marketplace selling has been disabled on your account by an administrator.",
        })
    require_account_age(user, "open a business storefront", MARKETPLACE_MIN_AGE_DAYS)
    patch = _clean_biz_patch(body)
    existing = await db.business_profiles.find_one({"owner_id": user["user_id"]}, {"_id": 0})
    if existing:
        if "name" in patch and not patch["name"]:
            raise HTTPException(status_code=400, detail="Business name can't be empty")
        if patch:
            await db.business_profiles.update_one({"id": existing["id"]}, {"$set": patch})
        doc = await db.business_profiles.find_one({"id": existing["id"]}, {"_id": 0})
        return await _hydrate_business(doc, user["user_id"])
    name = (patch.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Business name is required")
    doc = {
        **patch,
        "id": str(uuid.uuid4()),
        "owner_id": user["user_id"],
        "name": name,
        "created_at": datetime.now(timezone.utc),
    }
    try:
        await db.business_profiles.insert_one(doc.copy())
    except Exception:
        # Lost the create race (unique owner_id) — return the row that won.
        existing = await db.business_profiles.find_one({"owner_id": user["user_id"]}, {"_id": 0})
        if existing:
            return await _hydrate_business(existing, user["user_id"])
        raise
    return await _hydrate_business(doc, user["user_id"])


@router.delete("/marketplace/business", response_model=OkOut)
async def delete_business(authorization: Optional[str] = Header(None)):
    """Close the storefront and move its listings back to the personal profile."""
    user = await get_current_user(authorization)
    doc = await db.business_profiles.find_one(
        {"owner_id": user["user_id"]}, {"_id": 0, "id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="No business storefront")
    await db.listings.update_many({"business_id": doc["id"]}, {"$set": {"business_id": None}})
    await db.business_profiles.delete_one({"id": doc["id"]})
    return {"ok": True}


@router.get("/marketplace/business/{business_id}", response_model=BusinessProfile)
async def get_business(business_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    doc = await db.business_profiles.find_one({"id": business_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Business not found")
    # Ban cascade: a banned owner's storefront is hidden from everyone.
    owner = await db.users.find_one(
        {"user_id": doc["owner_id"]}, {"_id": 0, "banned": 1})
    if owner and owner.get("banned"):
        raise HTTPException(status_code=404, detail="Business not found")
    saved_ids = await _saved_ids_for(me["user_id"])
    return await _hydrate_business(doc, me["user_id"], with_listings=True, saved_ids=saved_ids)


@router.get("/marketplace/business/{business_id}/reviews", response_model=List[MarketplaceReview])
async def list_business_reviews(business_id: str, authorization: Optional[str] = Header(None)):
    """A business storefront's own reviews — separate from the owner's personal reviews."""
    await get_current_user(authorization)
    docs = await db.marketplace_reviews.find(
        {"subject_business_id": business_id}, {"_id": 0}
    ).sort("created_at", -1).to_list(100)
    return [await _hydrate_review(d) for d in docs]


@router.post("/marketplace/business/{business_id}/reviews", response_model=MarketplaceReview)
async def add_business_review(
    business_id: str, body: MarketplaceReviewCreate, authorization: Optional[str] = Header(None)
):
    me = await get_current_user(authorization)
    biz = await db.business_profiles.find_one({"id": business_id}, {"_id": 0, "id": 1, "owner_id": 1})
    if not biz:
        raise HTTPException(status_code=404, detail="Business not found")
    if biz["owner_id"] == me["user_id"]:
        raise HTTPException(status_code=400, detail="You can't review your own business")
    if not await _has_verified_business_trade(me["user_id"], business_id):
        raise HTTPException(
            status_code=403,
            detail="You can only review a business after a verified trade with it. Exchange a trade code first.",
        )
    cats = _clean_category_ratings(body.ratings)
    if cats:
        rating = max(1, min(5, round(sum(cats.values()) / len(cats))))
    else:
        rating = max(1, min(5, int(body.rating or 5)))
    text = (body.text or "")[:1000]
    now = datetime.now(timezone.utc)
    existing = await db.marketplace_reviews.find_one(
        {"subject_business_id": business_id, "reviewer_id": me["user_id"]}, {"_id": 0}
    )
    if existing:
        await db.marketplace_reviews.update_one(
            {"id": existing["id"]},
            {"$set": {"rating": rating, "ratings": cats, "text": text, "role": "seller", "created_at": now}},
        )
        rid = existing["id"]
    else:
        rid = str(uuid.uuid4())
        try:
            await db.marketplace_reviews.insert_one({
                "id": rid, "subject_business_id": business_id, "subject_user_id": None,
                "reviewer_id": me["user_id"], "rating": rating, "ratings": cats,
                "text": text, "role": "seller", "created_at": now,
            })
        except DuplicateKeyError:
            dup = await db.marketplace_reviews.find_one(
                {"subject_business_id": business_id, "reviewer_id": me["user_id"]}, {"_id": 0, "id": 1})
            rid = (dup or {}).get("id", rid)
            await db.marketplace_reviews.update_one(
                {"id": rid},
                {"$set": {"rating": rating, "ratings": cats, "text": text, "role": "seller", "created_at": now}})
    doc = await db.marketplace_reviews.find_one({"id": rid}, {"_id": 0})
    return await _hydrate_review(doc)


# ---------- Trade verification (shared code) ----------
@router.post("/listings/{listing_id}/trade/start", response_model=TradeStartOut)
async def start_trade(listing_id: str, authorization: Optional[str] = Header(None)):
    """Generate a one-time code for this listing. Share it with the other party;
    once they enter it, the trade is verified and both can review each other."""
    me = await get_current_user(authorization)
    listing = await db.listings.find_one({"id": listing_id}, {"_id": 0})
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    # A listing can only be verified/sold once.
    done = await db.marketplace_trades.find_one(
        {"listing_id": listing_id, "status": "confirmed"}, {"_id": 0, "id": 1}
    )
    if done:
        raise HTTPException(status_code=400, detail={
            "code": "already_sold",
            "message": "This listing has already been verified as sold.",
        })
    # Reuse an existing pending code this user started for this listing.
    existing = await db.marketplace_trades.find_one(
        {"listing_id": listing_id, "started_by": me["user_id"], "status": "pending"}, {"_id": 0}
    )
    if existing:
        return {"code": existing["code"], "status": "pending"}
    code = _gen_trade_code()
    await db.marketplace_trades.insert_one({
        "id": str(uuid.uuid4()),
        "listing_id": listing_id,
        "code": code,
        "started_by": me["user_id"],
        "party_ids": [me["user_id"]],  # initiator is counted; counterparty enters the code
        "status": "pending",
        "created_at": datetime.now(timezone.utc),
    })
    return {"code": code, "status": "pending"}


@router.post("/trades/confirm", response_model=TradeConfirmOut)
async def confirm_trade(body: TradeConfirm, authorization: Optional[str] = Header(None)):
    """Enter a code shared by the other party to verify the trade."""
    me = await get_current_user(authorization)
    code = (body.code or "").strip().upper()
    if not code:
        raise HTTPException(status_code=400, detail="Enter a code")
    trade = await db.marketplace_trades.find_one({"code": code}, {"_id": 0})
    if not trade:
        raise HTTPException(status_code=404, detail="Invalid code")
    if trade.get("status") == "confirmed":
        if me["user_id"] in trade.get("party_ids", []):
            return {"status": "confirmed"}
        raise HTTPException(status_code=400, detail="This code has already been used")
    if me["user_id"] in trade.get("party_ids", []):
        raise HTTPException(status_code=400, detail="You generated this code — share it with the other person to confirm")
    now = datetime.now(timezone.utc)
    parties = list(dict.fromkeys([*trade.get("party_ids", []), me["user_id"]]))
    listing_id = trade.get("listing_id")
    # Claim the listing as sold atomically FIRST — it's the scarce resource, so
    # this is the single-winner gate that enforces one verification per listing
    # even when two buyers confirm different codes for the same listing at once.
    if listing_id:
        sold = await db.listings.update_one(
            {"id": listing_id, "status": {"$ne": "sold"}},
            {"$set": {"status": "sold", "sold_to": me["user_id"], "sold_at": now}},
        )
        if getattr(sold, "matched_count", 0) != 1:
            raise HTTPException(status_code=400, detail={
                "code": "already_sold",
                "message": "This listing has already been verified as sold.",
            })
    # Capture whether this trade was with a business storefront, so reviews go to
    # the right (separate) reputation: business trades → business reviews.
    lst = await db.listings.find_one({"id": listing_id}, {"_id": 0, "business_id": 1}) if listing_id else None
    trade_business_id = (lst or {}).get("business_id")
    # Claim this trade (single-winner) so the same code can't confirm twice.
    claimed = await db.marketplace_trades.update_one(
        {"id": trade["id"], "status": "pending"},
        {"$set": {"party_ids": parties, "status": "confirmed", "buyer_id": me["user_id"],
                  "business_id": trade_business_id, "confirmed_at": now}},
    )
    if getattr(claimed, "matched_count", 0) != 1:
        raise HTTPException(status_code=400, detail="This code has already been used")
    other = trade.get("started_by")
    other_doc = await db.users.find_one({"user_id": other}, {"_id": 0, "name": 1}) if other else None
    return {"status": "confirmed", "partner_name": (other_doc or {}).get("name", "the seller")}


@router.post("/marketplace/users/{user_id}/reviews", response_model=MarketplaceReview)
async def add_seller_review(
    user_id: str, body: MarketplaceReviewCreate, authorization: Optional[str] = Header(None)
):
    me = await get_current_user(authorization)
    if user_id == me["user_id"]:
        raise HTTPException(status_code=400, detail="You can't review yourself")
    subj = await db.users.find_one({"user_id": user_id}, {"_id": 0, "user_id": 1})
    if not subj:
        raise HTTPException(status_code=404, detail="User not found")
    if not await _has_verified_personal_trade(me["user_id"], user_id):
        raise HTTPException(
            status_code=403,
            detail="You can only review someone after a verified personal trade. Exchange a trade code first.",
        )
    # Granular per-category stars; the overall rating is their average.
    cats = _clean_category_ratings(body.ratings)
    if cats:
        rating = max(1, min(5, round(sum(cats.values()) / len(cats))))
    else:
        rating = max(1, min(5, int(body.rating or 5)))
    text = (body.text or "")[:1000]
    # Was the person being reviewed the seller or the buyer in their trade?
    role = await _subject_trade_role(me["user_id"], user_id)
    now = datetime.now(timezone.utc)
    existing = await db.marketplace_reviews.find_one(
        {"subject_user_id": user_id, "reviewer_id": me["user_id"]}, {"_id": 0}
    )
    if existing:
        await db.marketplace_reviews.update_one(
            {"id": existing["id"]},
            {"$set": {"rating": rating, "ratings": cats, "text": text, "role": role, "created_at": now}},
        )
        rid = existing["id"]
    else:
        rid = str(uuid.uuid4())
        try:
            await db.marketplace_reviews.insert_one({
                "id": rid, "subject_user_id": user_id, "reviewer_id": me["user_id"],
                "rating": rating, "ratings": cats, "text": text, "role": role, "created_at": now,
            })
        except DuplicateKeyError:
            # Lost a concurrent submit — update the row that won instead.
            dup = await db.marketplace_reviews.find_one(
                {"subject_user_id": user_id, "reviewer_id": me["user_id"]}, {"_id": 0, "id": 1})
            rid = (dup or {}).get("id", rid)
            await db.marketplace_reviews.update_one(
                {"id": rid},
                {"$set": {"rating": rating, "ratings": cats, "text": text, "role": role, "created_at": now}})
    doc = await db.marketplace_reviews.find_one({"id": rid}, {"_id": 0})
    return await _hydrate_review(doc)


@router.post("/listings/{listing_id}/contact", response_model=ConversationView)
async def contact_seller(listing_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    listing = await db.listings.find_one({"id": listing_id}, {"_id": 0})
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    if listing["user_id"] == user["user_id"]:
        raise HTTPException(status_code=400, detail="Cannot message yourself about your own listing")
    # An admin-imposed messaging lock blocks opening new threads to message.
    if user.get("messaging_disabled"):
        raise HTTPException(status_code=403, detail={
            "code": "messaging_disabled",
            "message": "Messaging has been disabled on your account by an administrator.",
        })
    seller_id = listing["user_id"]
    key = _conv_key(user["user_id"], seller_id)
    existing = await db.conversations.find_one(
        {"key": key, "kind": {"$ne": "group"}}, {"_id": 0}
    )
    if existing:
        conv = existing
    else:
        # Honour the seller's "who can message me" policy when STARTING a new
        # thread (mirrors get_or_create_conversation). Existing threads are left
        # alone — the relationship already exists.
        from routes.messaging import _can_message
        seller_doc = await db.users.find_one({"user_id": seller_id}, {"_id": 0})
        if seller_doc and not await _can_message(user["user_id"], seller_doc):
            raise HTTPException(status_code=403, detail={
                "code": "messages_restricted",
                "message": "This account isn't accepting messages from you.",
            })
        conv = {
            "id": str(uuid.uuid4()),
            "kind": "dm",
            "key": key,
            "participant_ids": sorted([user["user_id"], seller_id]),
            "deleted_by": [],
            "last_message_at": None,
            "created_at": datetime.now(timezone.utc),
        }
        await db.conversations.insert_one(conv.copy())
        conv.pop("_id", None)
    # Tag the conversation as a marketplace chat so it shows in its own section.
    listing_title = (listing.get("title") or "")[:120]
    conv["listing_id"] = listing_id
    conv["listing_title"] = listing_title
    await db.conversations.update_one(
        {"id": conv["id"]},
        {"$set": {"listing_id": listing_id, "listing_title": listing_title}},
    )
    # Don't auto-send a greeting — just open the conversation so the buyer writes
    # their own first message. Surface any existing last message if the thread
    # already had one.
    other = await _public_user(seller_id)
    last_msg_doc = await db.messages.find_one(
        {"conversation_id": conv["id"]}, {"_id": 0}, sort=[("created_at", -1)]
    )
    if last_msg_doc:
        # Decrypt every content field (not just text) — voice/file/place/poll
        # are encrypted at rest too. Local import avoids a circular import.
        from routes.messaging import _decrypt_msg
        last_msg_doc = _decrypt_msg(last_msg_doc)
    return ConversationView(
        id=conv["id"],
        other_user=other,
        listing_id=conv.get("listing_id"),
        listing_title=conv.get("listing_title"),
        last_message=Message(**last_msg_doc) if last_msg_doc else None,
        last_message_at=conv.get("last_message_at"),
        unread_count=0,
        created_at=conv["created_at"],
    )


# ── Listing engagement: like, comment, report ──────────────────────────────
class ListingCommentCreate(BaseModel):
    text: str
    parent_id: Optional[str] = None     # reply to another comment


class ListingCommentEdit(BaseModel):
    text: str


async def _hydrate_comment(c: dict, viewer_id: str) -> ListingComment:
    from core import _resolve_badges
    a = await db.users.find_one({"user_id": c["user_id"]}, {"_id": 0}) or {}
    likes_count = await db.listing_comment_likes.count_documents({"comment_id": c["id"]})
    liked_by_me = bool(await db.listing_comment_likes.find_one(
        {"comment_id": c["id"], "user_id": viewer_id}, {"_id": 0, "id": 1}))
    replies_count = await db.listing_comments.count_documents({"parent_id": c["id"]})
    return ListingComment(
        id=c["id"], listing_id=c["listing_id"],
        author=PostAuthor(
            user_id=c["user_id"],
            name=a.get("name", "User"),
            username=a.get("username"),
            picture=a.get("picture"),
            verified=bool(a.get("verified", False)),
            badges=await _resolve_badges(a.get("badge_ids")),
        ),
        text=c.get("text", ""),
        parent_id=c.get("parent_id"),
        likes_count=likes_count,
        liked_by_me=liked_by_me,
        replies_count=replies_count,
        edited_at=c.get("edited_at"),
        mine=c["user_id"] == viewer_id,
        created_at=c["created_at"],
    )


@router.post("/listings/{listing_id}/like", response_model=Listing)
async def toggle_listing_like(listing_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.listings.find_one({"id": listing_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Listing not found")
    existing = await db.listing_likes.find_one(
        {"listing_id": listing_id, "user_id": user["user_id"]}, {"_id": 0, "id": 1})
    if existing:
        await db.listing_likes.delete_one({"listing_id": listing_id, "user_id": user["user_id"]})
        await db.listings.update_one({"id": listing_id}, {"$inc": {"likes_count": -1}})
    else:
        await db.listing_likes.insert_one({
            "id": str(uuid.uuid4()), "listing_id": listing_id,
            "user_id": user["user_id"], "created_at": datetime.now(timezone.utc),
        })
        await db.listings.update_one({"id": listing_id}, {"$inc": {"likes_count": 1}})
    updated = await db.listings.find_one({"id": listing_id}, {"_id": 0})
    return await _hydrate_listing(updated, viewer_id=user["user_id"], with_counts=True)


@router.post("/listings/{listing_id}/report", response_model=OkOut)
async def report_listing(listing_id: str, body: ReportCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.listings.find_one({"id": listing_id}, {"_id": 0, "id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Listing not found")
    existing = await db.reports.find_one(
        {"listing_id": listing_id, "reporter_id": user["user_id"]}, {"_id": 0, "id": 1})
    if not existing:
        await db.reports.insert_one({
            "id": str(uuid.uuid4()),
            "listing_id": listing_id,
            "reporter_id": user["user_id"],
            "reason": (body.reason or "other")[:200],
            "created_at": datetime.now(timezone.utc),
        })
    return {"ok": True}


@router.get("/listings/{listing_id}/comments", response_model=List[ListingComment])
async def list_listing_comments(listing_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    rows = await db.listing_comments.find(
        {"listing_id": listing_id}, {"_id": 0}
    ).sort("created_at", 1).to_list(300)
    return [await _hydrate_comment(c, user["user_id"]) for c in rows]


@router.post("/listings/{listing_id}/comments", response_model=ListingComment)
async def add_listing_comment(listing_id: str, body: ListingCommentCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.listings.find_one({"id": listing_id}, {"_id": 0, "id": 1, "user_id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Listing not found")
    text = (body.text or "").strip()[:1000]
    if not text:
        raise HTTPException(status_code=400, detail="Comment can't be empty")
    parent_id = None
    if body.parent_id:
        parent = await db.listing_comments.find_one(
            {"id": body.parent_id, "listing_id": listing_id}, {"_id": 0, "id": 1, "parent_id": 1})
        if not parent:
            raise HTTPException(status_code=404, detail="Comment to reply to not found")
        # Keep nesting to one level: a reply to a reply attaches to the top comment.
        parent_id = parent.get("parent_id") or parent["id"]
    c = {
        "id": str(uuid.uuid4()), "listing_id": listing_id,
        "user_id": user["user_id"], "text": text,
        "parent_id": parent_id,
        "created_at": datetime.now(timezone.utc),
    }
    await db.listing_comments.insert_one(c)
    await db.listings.update_one({"id": listing_id}, {"$inc": {"comments_count": 1}})
    return await _hydrate_comment(c, user["user_id"])


@router.patch("/listings/{listing_id}/comments/{comment_id}", response_model=ListingComment)
async def edit_listing_comment(listing_id: str, comment_id: str, body: ListingCommentEdit, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    c = await db.listing_comments.find_one({"id": comment_id, "listing_id": listing_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Comment not found")
    if c["user_id"] != user["user_id"]:
        raise HTTPException(status_code=403, detail="You can only edit your own comment")
    text = (body.text or "").strip()[:1000]
    if not text:
        raise HTTPException(status_code=400, detail="Comment can't be empty")
    now = datetime.now(timezone.utc)
    await db.listing_comments.update_one({"id": comment_id}, {"$set": {"text": text, "edited_at": now}})
    c = await db.listing_comments.find_one({"id": comment_id}, {"_id": 0})
    return await _hydrate_comment(c, user["user_id"])


@router.post("/listings/{listing_id}/comments/{comment_id}/like", response_model=ListingComment)
async def like_listing_comment(listing_id: str, comment_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    c = await db.listing_comments.find_one({"id": comment_id, "listing_id": listing_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Comment not found")
    existing = await db.listing_comment_likes.find_one(
        {"comment_id": comment_id, "user_id": user["user_id"]}, {"_id": 0, "id": 1})
    if existing:
        await db.listing_comment_likes.delete_one({"comment_id": comment_id, "user_id": user["user_id"]})
    else:
        await db.listing_comment_likes.insert_one({
            "id": str(uuid.uuid4()), "comment_id": comment_id,
            "user_id": user["user_id"], "created_at": datetime.now(timezone.utc),
        })
    return await _hydrate_comment(c, user["user_id"])


@router.delete("/listings/{listing_id}/comments/{comment_id}", response_model=OkOut)
async def delete_listing_comment(listing_id: str, comment_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    c = await db.listing_comments.find_one({"id": comment_id, "listing_id": listing_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Comment not found")
    listing = await db.listings.find_one({"id": listing_id}, {"_id": 0, "user_id": 1})
    # The comment's author or the listing's owner can delete it.
    if c["user_id"] != user["user_id"] and (listing or {}).get("user_id") != user["user_id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    # Remove the comment and any replies to it (plus their likes).
    child_ids = [r["id"] for r in await db.listing_comments.find(
        {"parent_id": comment_id}, {"_id": 0, "id": 1}).to_list(500)]
    ids = [comment_id] + child_ids
    await db.listing_comments.delete_many({"id": {"$in": ids}})
    await db.listing_comment_likes.delete_many({"comment_id": {"$in": ids}})
    await db.listings.update_one({"id": listing_id}, {"$inc": {"comments_count": -len(ids)}})
    return {"ok": True}


# ────────────────────────────────────────────────────────────────────────────
# Offers — price negotiation on a listing (the listing's `negotiable` flag hints
# this is welcome). A buyer makes an offer; the seller accepts, declines, or
# counters; the buyer can accept a counter or withdraw. Accepting an offer
# declines the listing's other open offers. No money moves here — the agreed
# price is settled in person via the trade code (POST /trades/confirm).
# ────────────────────────────────────────────────────────────────────────────
_OPEN_OFFER = ("pending", "countered")


class OfferBody(BaseModel):
    amount: float
    message: Optional[str] = None


class CounterBody(BaseModel):
    amount: float


class OfferOut(_MkOut):
    id: str
    listing_id: str
    listing_title: Optional[str] = None
    seller_id: str
    buyer_id: str
    buyer_name: Optional[str] = None
    amount: float
    counter_amount: Optional[float] = None      # set when the seller counters
    message: Optional[str] = None
    status: str = "pending"                      # pending|countered|accepted|declined|withdrawn
    role: Optional[str] = None                   # "buyer"|"seller" relative to the viewer
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class OffersForListingOut(_MkOut):
    offers: list = []


class MyOffersOut(_MkOut):
    made: list = []        # offers the viewer made (as a buyer)
    received: list = []    # offers on the viewer's listings (as a seller)


def _offer_amount(amount) -> float:
    try:
        amt = round(float(amount), 2)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Enter a valid amount")
    if not math.isfinite(amt) or amt <= 0:
        raise HTTPException(status_code=400, detail="Your offer must be greater than 0")
    if amt > 1_000_000:
        raise HTTPException(status_code=400, detail="That offer is too large")
    return amt


def _offer_view(o: dict, viewer_id: Optional[str] = None) -> dict:
    role = None
    if viewer_id == o.get("buyer_id"):
        role = "buyer"
    elif viewer_id == o.get("seller_id"):
        role = "seller"
    ca = o.get("counter_amount")
    return {
        "id": o["id"], "listing_id": o.get("listing_id"), "listing_title": o.get("listing_title"),
        "seller_id": o.get("seller_id"), "buyer_id": o.get("buyer_id"), "buyer_name": o.get("buyer_name"),
        "amount": round(float(o.get("amount", 0) or 0), 2),
        "counter_amount": (round(float(ca), 2) if ca is not None else None),
        "message": o.get("message"), "status": o.get("status", "pending"), "role": role,
        "created_at": o.get("created_at"), "updated_at": o.get("updated_at"),
    }


async def _notify_offer(user_id: str, actor_id: str, message: str):
    try:
        from routes.notifications import emit_notification
        await emit_notification(user_id=user_id, actor_id=actor_id, ntype="marketplace", message=message)
    except Exception:
        pass


@router.post("/listings/{listing_id}/offers", response_model=OfferOut)
async def make_offer(listing_id: str, body: OfferBody, authorization: Optional[str] = Header(None)):
    """A buyer offers a price on a listing. Re-offering updates the existing
    open offer rather than stacking duplicates."""
    me = await get_current_user(authorization)
    listing = await db.listings.find_one({"id": listing_id}, {"_id": 0})
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    if listing.get("status") == "sold":
        raise HTTPException(status_code=400, detail={"code": "already_sold", "message": "This listing has already sold."})
    if listing["user_id"] == me["user_id"]:
        raise HTTPException(status_code=400, detail="You can't make an offer on your own listing")
    amount = _offer_amount(body.amount)
    msg = (body.message or "").strip()[:500] or None
    now = datetime.now(timezone.utc)
    existing = await db.marketplace_offers.find_one(
        {"listing_id": listing_id, "buyer_id": me["user_id"], "status": {"$in": list(_OPEN_OFFER)}}, {"_id": 0}
    )
    if existing:
        await db.marketplace_offers.update_one(
            {"id": existing["id"]},
            {"$set": {"amount": amount, "message": msg, "status": "pending",
                      "counter_amount": None, "updated_at": now}},
        )
        doc = await db.marketplace_offers.find_one({"id": existing["id"]}, {"_id": 0})
    else:
        doc = {
            "id": str(uuid.uuid4()), "listing_id": listing_id, "listing_title": listing.get("title"),
            "seller_id": listing["user_id"], "buyer_id": me["user_id"], "buyer_name": me.get("name", "A buyer"),
            "amount": amount, "counter_amount": None, "message": msg, "status": "pending",
            "created_at": now, "updated_at": now,
        }
        await db.marketplace_offers.insert_one(doc.copy())
    await _notify_offer(listing["user_id"], me["user_id"],
                        f"offered ${amount:.2f} for “{(listing.get('title') or 'your listing')[:48]}”")
    return _offer_view(doc, me["user_id"])


@router.get("/listings/{listing_id}/offers", response_model=OffersForListingOut)
async def listing_offers(listing_id: str, authorization: Optional[str] = Header(None)):
    """The listing owner sees every offer; anyone else sees only their own."""
    me = await get_current_user(authorization)
    listing = await db.listings.find_one({"id": listing_id}, {"_id": 0, "user_id": 1})
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    q = {"listing_id": listing_id}
    if listing["user_id"] != me["user_id"]:
        q["buyer_id"] = me["user_id"]
    rows = await db.marketplace_offers.find(q, {"_id": 0}).sort("updated_at", -1).limit(200).to_list(200)
    return {"offers": [_offer_view(o, me["user_id"]) for o in rows]}


@router.get("/offers", response_model=MyOffersOut)
async def my_offers(authorization: Optional[str] = Header(None)):
    """The viewer's offers: those they made (buyer) and those on their listings (seller)."""
    me = await get_current_user(authorization)
    made = await db.marketplace_offers.find({"buyer_id": me["user_id"]}, {"_id": 0}).sort("updated_at", -1).limit(100).to_list(100)
    received = await db.marketplace_offers.find({"seller_id": me["user_id"]}, {"_id": 0}).sort("updated_at", -1).limit(100).to_list(100)
    return {"made": [_offer_view(o, me["user_id"]) for o in made],
            "received": [_offer_view(o, me["user_id"]) for o in received]}


async def _seller_offer(offer_id: str, me: dict) -> dict:
    o = await db.marketplace_offers.find_one({"id": offer_id}, {"_id": 0})
    if not o:
        raise HTTPException(status_code=404, detail="Offer not found")
    if o.get("seller_id") != me["user_id"]:
        raise HTTPException(status_code=403, detail="Only the seller can do that")
    return o


async def _buyer_offer(offer_id: str, me: dict) -> dict:
    o = await db.marketplace_offers.find_one({"id": offer_id}, {"_id": 0})
    if not o:
        raise HTTPException(status_code=404, detail="Offer not found")
    if o.get("buyer_id") != me["user_id"]:
        raise HTTPException(status_code=403, detail="Only the buyer can do that")
    return o


@router.post("/offers/{offer_id}/accept", response_model=OfferOut)
async def accept_offer(offer_id: str, authorization: Optional[str] = Header(None)):
    """Seller accepts a buyer's offer. Single-winner claim; the listing's other
    open offers are declined."""
    me = await get_current_user(authorization)
    o = await _seller_offer(offer_id, me)
    now = datetime.now(timezone.utc)
    claim = await db.marketplace_offers.update_one(
        {"id": offer_id, "status": {"$in": list(_OPEN_OFFER)}},
        {"$set": {"status": "accepted", "updated_at": now}},
    )
    if getattr(claim, "matched_count", 0) != 1:
        raise HTTPException(status_code=409, detail="This offer was already handled")
    # Decline the listing's other still-open offers.
    await db.marketplace_offers.update_many(
        {"listing_id": o["listing_id"], "status": {"$in": list(_OPEN_OFFER)}, "id": {"$ne": offer_id}},
        {"$set": {"status": "declined", "updated_at": now}},
    )
    await _notify_offer(o["buyer_id"], me["user_id"],
                        f"accepted your ${round(float(o.get('amount', 0) or 0), 2):.2f} offer — arrange the trade")
    o.update({"status": "accepted", "updated_at": now})
    return _offer_view(o, me["user_id"])


@router.post("/offers/{offer_id}/decline", response_model=OfferOut)
async def decline_offer(offer_id: str, authorization: Optional[str] = Header(None)):
    """Seller declines an offer."""
    me = await get_current_user(authorization)
    o = await _seller_offer(offer_id, me)
    now = datetime.now(timezone.utc)
    claim = await db.marketplace_offers.update_one(
        {"id": offer_id, "status": {"$in": list(_OPEN_OFFER)}},
        {"$set": {"status": "declined", "updated_at": now}},
    )
    if getattr(claim, "matched_count", 0) != 1:
        raise HTTPException(status_code=409, detail="This offer was already handled")
    await _notify_offer(o["buyer_id"], me["user_id"], "declined your offer")
    o.update({"status": "declined", "updated_at": now})
    return _offer_view(o, me["user_id"])


@router.post("/offers/{offer_id}/counter", response_model=OfferOut)
async def counter_offer(offer_id: str, body: CounterBody, authorization: Optional[str] = Header(None)):
    """Seller counters with a price; the buyer can accept it or re-offer."""
    me = await get_current_user(authorization)
    o = await _seller_offer(offer_id, me)
    if o.get("status") not in _OPEN_OFFER:
        raise HTTPException(status_code=409, detail="This offer was already handled")
    amount = _offer_amount(body.amount)
    now = datetime.now(timezone.utc)
    await db.marketplace_offers.update_one(
        {"id": offer_id}, {"$set": {"status": "countered", "counter_amount": amount, "updated_at": now}})
    await _notify_offer(o["buyer_id"], me["user_id"], f"countered with ${amount:.2f}")
    o.update({"status": "countered", "counter_amount": amount, "updated_at": now})
    return _offer_view(o, me["user_id"])


@router.post("/offers/{offer_id}/accept-counter", response_model=OfferOut)
async def accept_counter(offer_id: str, authorization: Optional[str] = Header(None)):
    """Buyer accepts the seller's counter price."""
    me = await get_current_user(authorization)
    o = await _buyer_offer(offer_id, me)
    if o.get("status") != "countered" or o.get("counter_amount") is None:
        raise HTTPException(status_code=409, detail="There's no counter to accept")
    now = datetime.now(timezone.utc)
    ca = round(float(o["counter_amount"]), 2)
    claim = await db.marketplace_offers.update_one(
        {"id": offer_id, "status": "countered"},
        {"$set": {"status": "accepted", "amount": ca, "updated_at": now}},
    )
    if getattr(claim, "matched_count", 0) != 1:
        raise HTTPException(status_code=409, detail="This offer was already handled")
    await _notify_offer(o["seller_id"], me["user_id"], f"accepted your ${ca:.2f} counter — arrange the trade")
    o.update({"status": "accepted", "amount": ca, "updated_at": now})
    return _offer_view(o, me["user_id"])


@router.post("/offers/{offer_id}/withdraw", response_model=OfferOut)
async def withdraw_offer(offer_id: str, authorization: Optional[str] = Header(None)):
    """Buyer withdraws their open offer."""
    me = await get_current_user(authorization)
    o = await _buyer_offer(offer_id, me)
    now = datetime.now(timezone.utc)
    claim = await db.marketplace_offers.update_one(
        {"id": offer_id, "status": {"$in": list(_OPEN_OFFER)}},
        {"$set": {"status": "withdrawn", "updated_at": now}},
    )
    if getattr(claim, "matched_count", 0) != 1:
        raise HTTPException(status_code=409, detail="This offer was already handled")
    await _notify_offer(o["seller_id"], me["user_id"], "withdrew their offer")
    o.update({"status": "withdrawn", "updated_at": now})
    return _offer_view(o, me["user_id"])


# ────────────────────────────────────────────────────────────────────────────
# Saved searches — a user saves a query + filters and revisits it; each saved
# search reports how many new active listings match since they last looked
# (a lightweight "alerts" badge, no push needed).
# ────────────────────────────────────────────────────────────────────────────
class SavedSearchBody(BaseModel):
    name: Optional[str] = None
    query: Optional[str] = None
    category: Optional[str] = None
    condition: Optional[str] = None
    min_price: Optional[float] = None
    max_price: Optional[float] = None
    sort: Optional[str] = None


class SavedSearchOut(_MkOut):
    id: str
    name: str
    query: Optional[str] = None
    category: Optional[str] = None
    condition: Optional[str] = None
    min_price: Optional[float] = None
    max_price: Optional[float] = None
    sort: Optional[str] = None
    new_count: int = 0                          # active matches since last_checked_at
    created_at: Optional[datetime] = None


class SavedSearchesOut(_MkOut):
    searches: list = []


def _saved_search_label(b: "SavedSearchBody | dict") -> str:
    g = (lambda k: (b.get(k) if isinstance(b, dict) else getattr(b, k, None)))
    parts = []
    if (g("query") or "").strip():
        parts.append(f'“{g("query").strip()}”')
    if g("category"):
        parts.append(str(g("category")))
    if g("min_price") is not None or g("max_price") is not None:
        lo = g("min_price")
        hi = g("max_price")
        parts.append(f'${lo or 0:.0f}–{("$%.0f" % hi) if hi is not None else "∞"}')
    return " · ".join(parts) or "All listings"


def _saved_search_match(s: dict, since: datetime) -> dict:
    """Mongo-style filter for active listings matching this search since `since`."""
    filt: dict = {"status": "active", "created_at": {"$gt": since}}
    if s.get("category"):
        filt["category"] = s["category"]
    if s.get("condition"):
        filt["condition"] = s["condition"]
    price: dict = {}
    if s.get("min_price") is not None:
        price["$gte"] = float(s["min_price"])
    if s.get("max_price") is not None:
        price["$lte"] = float(s["max_price"])
    if price:
        filt["price"] = price
    q = (s.get("query") or "").strip()
    if q:
        pattern = re.escape(q)
        filt["$or"] = [
            {"title": {"$regex": pattern, "$options": "i"}},
            {"description": {"$regex": pattern, "$options": "i"}},
        ]
    return filt


def _saved_search_view(s: dict) -> dict:
    return {
        "id": s["id"], "name": s.get("name") or _saved_search_label(s),
        "query": s.get("query"), "category": s.get("category"), "condition": s.get("condition"),
        "min_price": s.get("min_price"), "max_price": s.get("max_price"), "sort": s.get("sort"),
        "created_at": s.get("created_at"),
    }


@router.post("/marketplace/saved-searches", response_model=SavedSearchOut)
async def save_search(body: SavedSearchBody, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    if await db.marketplace_saved_searches.count_documents({"user_id": me["user_id"]}) >= 50:
        raise HTTPException(status_code=400, detail="You can save up to 50 searches")
    now = datetime.now(timezone.utc)
    mn = body.min_price if (body.min_price is None or body.min_price >= 0) else None
    mx = body.max_price if (body.max_price is None or body.max_price >= 0) else None
    doc = {
        "id": str(uuid.uuid4()), "user_id": me["user_id"],
        "name": (body.name or "").strip()[:80] or _saved_search_label(body),
        "query": (body.query or "").strip()[:120] or None,
        "category": body.category, "condition": body.condition,
        "min_price": mn, "max_price": mx, "sort": body.sort,
        "created_at": now, "last_checked_at": now,
    }
    await db.marketplace_saved_searches.insert_one(doc.copy())
    out = _saved_search_view(doc)
    out["new_count"] = 0   # nothing is "new" the instant you save it
    return out


@router.get("/marketplace/saved-searches", response_model=SavedSearchesOut)
async def list_saved_searches(authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    rows = await db.marketplace_saved_searches.find(
        {"user_id": me["user_id"]}, {"_id": 0}).sort("created_at", -1).limit(50).to_list(50)
    out = []
    for s in rows:
        since = s.get("last_checked_at") or s.get("created_at") or datetime.now(timezone.utc)
        try:
            since = _norm_dt(since)
        except Exception:
            since = datetime.now(timezone.utc)
        view = _saved_search_view(s)
        view["new_count"] = await db.listings.count_documents(_saved_search_match(s, since))
        out.append(view)
    return {"searches": out}


@router.post("/marketplace/saved-searches/{search_id}/seen", response_model=OkOut)
async def mark_saved_search_seen(search_id: str, authorization: Optional[str] = Header(None)):
    """Reset the 'new' badge — call when the user opens the saved search."""
    me = await get_current_user(authorization)
    res = await db.marketplace_saved_searches.update_one(
        {"id": search_id, "user_id": me["user_id"]},
        {"$set": {"last_checked_at": datetime.now(timezone.utc)}},
    )
    if getattr(res, "matched_count", 0) != 1:
        raise HTTPException(status_code=404, detail="Saved search not found")
    return {"ok": True}


@router.delete("/marketplace/saved-searches/{search_id}", response_model=OkOut)
async def delete_saved_search(search_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    res = await db.marketplace_saved_searches.delete_one({"id": search_id, "user_id": me["user_id"]})
    if getattr(res, "deleted_count", 0) != 1:
        raise HTTPException(status_code=404, detail="Saved search not found")
    return {"ok": True}


class OffersCountOut(_MkOut):
    count: int = 0
    received_pending: int = 0
    countered_to_me: int = 0


@router.get("/offers/unread-count", response_model=OffersCountOut)
async def offers_unread_count(authorization: Optional[str] = Header(None)):
    """Offers needing the current user's action — for a tab badge. As a seller:
    pending offers on your listings. As a buyer: offers the seller countered
    (waiting on you)."""
    me = await get_current_user(authorization)
    received = await db.marketplace_offers.count_documents(
        {"seller_id": me["user_id"], "status": "pending"})
    countered = await db.marketplace_offers.count_documents(
        {"buyer_id": me["user_id"], "status": "countered"})
    return {"count": received + countered,
            "received_pending": received, "countered_to_me": countered}
