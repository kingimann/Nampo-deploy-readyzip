"""Post drafts — save a composer payload (text, media, poll, …) to finish later.

The payload is stored opaquely so the client can evolve the composer without
backend changes. Drafts are private to their owner.
"""
import json
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from core import db, get_current_user

router = APIRouter()

MAX_DRAFT_BYTES = 16 * 1024 * 1024  # ~16MB serialized (covers base64 media)
MAX_DRAFTS = 50


class DraftBody(BaseModel):
    payload: dict


class Draft(BaseModel):
    id: str
    payload: dict
    created_at: datetime
    updated_at: datetime


def _to_model(doc: dict) -> Draft:
    return Draft(
        id=doc["id"],
        payload=doc.get("payload") or {},
        created_at=doc["created_at"],
        updated_at=doc.get("updated_at") or doc["created_at"],
    )


def _check_size(payload: dict) -> None:
    try:
        if len(json.dumps(payload)) > MAX_DRAFT_BYTES:
            raise HTTPException(status_code=413, detail="Draft too large to save")
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid draft payload")


@router.get("/drafts", response_model=List[Draft])
async def list_drafts(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    rows = await db.drafts.find(
        {"user_id": user["user_id"]}, {"_id": 0}
    ).sort("updated_at", -1).limit(MAX_DRAFTS).to_list(MAX_DRAFTS)
    return [_to_model(r) for r in rows]


@router.post("/drafts", response_model=Draft)
async def create_draft(body: DraftBody, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    _check_size(body.payload)
    # Keep a lid on how many drafts pile up — drop the oldest beyond the cap.
    count = await db.drafts.count_documents({"user_id": user["user_id"]})
    if count >= MAX_DRAFTS:
        oldest = await db.drafts.find(
            {"user_id": user["user_id"]}, {"_id": 0, "id": 1}
        ).sort("updated_at", 1).limit(count - MAX_DRAFTS + 1).to_list(count)
        for o in oldest:
            await db.drafts.delete_one({"id": o["id"]})
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["user_id"],
        "payload": body.payload,
        "created_at": now,
        "updated_at": now,
    }
    await db.drafts.insert_one(doc.copy())
    return _to_model(doc)


@router.patch("/drafts/{draft_id}", response_model=Draft)
async def update_draft(draft_id: str, body: DraftBody, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    _check_size(body.payload)
    d = await db.drafts.find_one({"id": draft_id}, {"_id": 0})
    if not d or d.get("user_id") != user["user_id"]:
        raise HTTPException(status_code=404, detail="Draft not found")
    now = datetime.now(timezone.utc)
    await db.drafts.update_one({"id": draft_id}, {"$set": {"payload": body.payload, "updated_at": now}})
    d["payload"] = body.payload
    d["updated_at"] = now
    return _to_model(d)


@router.delete("/drafts/{draft_id}")
async def delete_draft(draft_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    d = await db.drafts.find_one({"id": draft_id}, {"_id": 0})
    if not d or d.get("user_id") != user["user_id"]:
        raise HTTPException(status_code=404, detail="Draft not found")
    await db.drafts.delete_one({"id": draft_id})
    return {"ok": True}
