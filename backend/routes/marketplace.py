"""Marketplace listings + contact seller."""
import re
from datetime import datetime, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Header, HTTPException, Query

from core import _conv_key, _public_user, db, get_current_user
from models import (
    ConversationView,
    Listing,
    ListingCreate,
    ListingPatch,
    Message,
    PostAuthor,
)
from services.encryption import encrypt_text, decrypt_text

router = APIRouter()


async def _hydrate_listing(doc: dict) -> Listing:
    author_doc = await db.users.find_one({"user_id": doc["user_id"]}, {"_id": 0})
    seller = PostAuthor(
        user_id=doc["user_id"],
        name=author_doc.get("name", "Unknown") if author_doc else "Unknown",
        picture=author_doc.get("picture") if author_doc else None,
    )
    return Listing(
        id=doc["id"], user_id=doc["user_id"], seller=seller,
        title=doc["title"], price=doc.get("price", 0),
        currency=doc.get("currency", "USD"),
        category=doc.get("category", "other"),
        description=doc.get("description", ""),
        photo_base64=doc.get("photo_base64"),
        longitude=doc.get("longitude"), latitude=doc.get("latitude"),
        locality=doc.get("locality"),
        status=doc.get("status", "active"),
        created_at=doc["created_at"],
    )


@router.post("/listings", response_model=Listing)
async def create_listing(body: ListingCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    title = (body.title or "").strip()[:120]
    if not title:
        raise HTTPException(status_code=400, detail="Title required")
    if body.price < 0:
        raise HTTPException(status_code=400, detail="Price must be ≥ 0")
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["user_id"],
        "title": title,
        "price": float(body.price),
        "currency": (body.currency or "USD")[:8],
        "category": body.category or "other",
        "description": (body.description or "")[:2000],
        "photo_base64": body.photo_base64,
        "longitude": body.longitude,
        "latitude": body.latitude,
        "locality": (body.locality or "")[:120],
        "status": "active",
        "created_at": datetime.now(timezone.utc),
    }
    await db.listings.insert_one(doc.copy())
    return await _hydrate_listing(doc)


@router.get("/listings", response_model=List[Listing])
async def list_listings(
    category: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    status: Optional[str] = Query("active"),
    authorization: Optional[str] = Header(None),
):
    await get_current_user(authorization)
    filt: dict = {}
    if status:
        filt["status"] = status
    if category and category != "all":
        filt["category"] = category
    if q and q.strip():
        pattern = re.escape(q.strip())
        filt["$or"] = [
            {"title": {"$regex": pattern, "$options": "i"}},
            {"description": {"$regex": pattern, "$options": "i"}},
        ]
    cursor = db.listings.find(filt, {"_id": 0}).sort("created_at", -1).limit(100)
    docs = await cursor.to_list(100)
    return [await _hydrate_listing(d) for d in docs]


@router.get("/listings/user/{user_id}", response_model=List[Listing])
async def listings_by_user(user_id: str, authorization: Optional[str] = Header(None)):
    await get_current_user(authorization)
    cursor = db.listings.find({"user_id": user_id}, {"_id": 0}).sort("created_at", -1)
    docs = await cursor.to_list(100)
    return [await _hydrate_listing(d) for d in docs]


@router.get("/listings/{listing_id}", response_model=Listing)
async def get_listing(listing_id: str, authorization: Optional[str] = Header(None)):
    await get_current_user(authorization)
    doc = await db.listings.find_one({"id": listing_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Listing not found")
    return await _hydrate_listing(doc)


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
    if body.description is not None:
        patch["description"] = body.description[:2000]
    if body.photo_base64 is not None:
        patch["photo_base64"] = body.photo_base64
    if body.status is not None:
        patch["status"] = body.status
    if patch:
        await db.listings.update_one({"id": listing_id}, {"$set": patch})
    updated = await db.listings.find_one({"id": listing_id}, {"_id": 0})
    return await _hydrate_listing(updated)


@router.delete("/listings/{listing_id}")
async def delete_listing(listing_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    res = await db.listings.delete_one({"id": listing_id, "user_id": user["user_id"]})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Listing not found")
    return {"ok": True}


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
    now = datetime.now(timezone.utc)
    await db.messages.insert_one({
        "id": str(uuid.uuid4()),
        "conversation_id": conv["id"],
        "sender_id": user["user_id"],
        "type": "text",
        "text": encrypt_text(f"Hi! Is your listing \"{listing['title']}\" still available?"),
        "place_name": None,
        "place_address": None,
        "place_longitude": None,
        "place_latitude": None,
        "created_at": now,
    })
    await db.conversations.update_one({"id": conv["id"]}, {"$set": {"last_message_at": now}})
    other = await _public_user(seller_id)
    last_msg_doc = await db.messages.find_one(
        {"conversation_id": conv["id"]}, {"_id": 0}, sort=[("created_at", -1)]
    )
    if last_msg_doc:
        last_msg_doc = {**last_msg_doc, "text": decrypt_text(last_msg_doc.get("text") or "")}
    return ConversationView(
        id=conv["id"],
        other_user=other,
        last_message=Message(**last_msg_doc) if last_msg_doc else None,
        last_message_at=now,
        unread_count=0,
        created_at=conv["created_at"],
    )
