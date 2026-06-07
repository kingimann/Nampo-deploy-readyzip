"""Marketplace listings + contact seller."""
import math
import re
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple
import uuid

from fastapi import APIRouter, Header, HTTPException, Query

from core import _conv_key, _public_user, db, get_current_user, _norm_dt, require_account_age, MARKETPLACE_MIN_AGE_DAYS, is_admin
from models import (
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
from pydantic import BaseModel
from services.encryption import encrypt_text, decrypt_text

router = APIRouter()


async def _has_verified_trade(a: str, b: str) -> bool:
    """True if users a and b have a confirmed marketplace trade between them."""
    doc = await db.marketplace_trades.find_one(
        {"status": "confirmed", "party_ids": {"$all": [a, b]}}, {"_id": 0, "id": 1}
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
        distance_km=distance_km,
        status=doc.get("status", "active"),
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

    photos = _clean_photos(body)
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
        "status": "active",
        "views_count": 0,
        "created_at": datetime.now(timezone.utc),
    }
    await db.listings.insert_one(doc.copy())
    return await _hydrate_listing(doc, viewer_id=user["user_id"])


@router.get("/listings", response_model=List[Listing])
async def list_listings(
    category: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    status: Optional[str] = Query("active"),
    condition: Optional[str] = Query(None),
    min_price: Optional[float] = Query(None),
    max_price: Optional[float] = Query(None),
    sort: Optional[str] = Query("recent"),  # recent | price_low | price_high | nearby
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
    cursor = db.listings.find({"user_id": user_id}, {"_id": 0}).sort("created_at", -1)
    docs = await cursor.to_list(100)
    saved_ids = await _saved_ids_for(me["user_id"])
    return [await _hydrate_listing(d, saved_ids=saved_ids) for d in docs]


@router.get("/listings/{listing_id}", response_model=Listing)
async def get_listing(listing_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.listings.find_one({"id": listing_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Listing not found")
    # Count a view (not for the owner).
    if doc["user_id"] != user["user_id"]:
        await db.listings.update_one({"id": listing_id}, {"$inc": {"views_count": 1}})
        doc["views_count"] = doc.get("views_count", 0) + 1
    return await _hydrate_listing(doc, viewer_id=user["user_id"], with_counts=True)


@router.post("/listings/{listing_id}/save")
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


@router.delete("/listings/{listing_id}/save")
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
    if patch:
        await db.listings.update_one({"id": listing_id}, {"$set": patch})
    updated = await db.listings.find_one({"id": listing_id}, {"_id": 0})
    return await _hydrate_listing(updated, viewer_id=user["user_id"], with_counts=True)


@router.delete("/listings/{listing_id}")
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
    verified = await _has_verified_trade(doc["reviewer_id"], doc["subject_user_id"])
    return MarketplaceReview(
        id=doc["id"], subject_user_id=doc["subject_user_id"], reviewer=reviewer,
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
    saved_ids = await _saved_ids_for(me["user_id"])
    listings = [await _hydrate_listing(d, saved_ids=saved_ids) for d in listing_docs]
    listing_count = await db.listings.count_documents({"user_id": user_id})
    reviewed_by_me = bool(await db.marketplace_reviews.find_one(
        {"subject_user_id": user_id, "reviewer_id": me["user_id"]}, {"_id": 0, "id": 1}
    ))
    can_review = me["user_id"] != user_id and await _has_verified_trade(me["user_id"], user_id)
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


# ---------- Trade verification (shared code) ----------
@router.post("/listings/{listing_id}/trade/start")
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


@router.post("/trades/confirm")
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
    # One verification per listing.
    listing_id = trade.get("listing_id")
    if listing_id:
        done = await db.marketplace_trades.find_one(
            {"listing_id": listing_id, "status": "confirmed"}, {"_id": 0, "id": 1}
        )
        if done:
            raise HTTPException(status_code=400, detail={
                "code": "already_sold",
                "message": "This listing has already been verified as sold.",
            })
    now = datetime.now(timezone.utc)
    parties = list(dict.fromkeys([*trade.get("party_ids", []), me["user_id"]]))
    await db.marketplace_trades.update_one(
        {"id": trade["id"]},
        {"$set": {"party_ids": parties, "status": "confirmed", "buyer_id": me["user_id"], "confirmed_at": now}},
    )
    # Verifying = the item was sold to the confirming user. Mark the listing sold.
    if listing_id:
        await db.listings.update_one(
            {"id": listing_id},
            {"$set": {"status": "sold", "sold_to": me["user_id"], "sold_at": now}},
        )
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
    if not await _has_verified_trade(me["user_id"], user_id):
        raise HTTPException(
            status_code=403,
            detail="You can only review someone after a verified trade. Exchange a trade code first.",
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
        await db.marketplace_reviews.insert_one({
            "id": rid, "subject_user_id": user_id, "reviewer_id": me["user_id"],
            "rating": rating, "ratings": cats, "text": text, "role": role, "created_at": now,
        })
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
    seller_id = listing["user_id"]
    key = _conv_key(user["user_id"], seller_id)
    existing = await db.conversations.find_one({"key": key}, {"_id": 0})
    if existing:
        conv = existing
    else:
        conv = {
            "id": str(uuid.uuid4()),
            "key": key,
            "participant_ids": sorted([user["user_id"], seller_id]),
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
        last_msg_doc = {**last_msg_doc, "text": decrypt_text(last_msg_doc.get("text") or "")}
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


@router.post("/listings/{listing_id}/report")
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


@router.delete("/listings/{listing_id}/comments/{comment_id}")
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
