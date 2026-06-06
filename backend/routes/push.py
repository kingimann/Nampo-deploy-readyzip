"""Device push-token registration (used to ring calls in the background)."""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Header
from pydantic import BaseModel

from core import db, get_current_user

router = APIRouter()


class PushRegister(BaseModel):
    token: str
    platform: Optional[str] = None  # ios | android | web
    kind: Optional[str] = "expo"    # expo | fcm | voip


class PushUnregister(BaseModel):
    token: str


@router.post("/push/register")
async def register_push(body: PushRegister, authorization: Optional[str] = Header(None)):
    """Save (or move) a device push token for the current user. Idempotent."""
    user = await get_current_user(authorization)
    token = (body.token or "").strip()
    if not token:
        return {"ok": False}
    doc = {
        "token": token,
        "user_id": user["user_id"],
        "platform": (body.platform or "")[:16],
        "kind": (body.kind or "expo")[:16],
        "updated_at": datetime.now(timezone.utc),
    }
    existing = await db.push_tokens.find_one({"token": token}, {"_id": 0, "token": 1})
    if existing:
        await db.push_tokens.update_one({"token": token}, {"$set": doc})
    else:
        doc["created_at"] = datetime.now(timezone.utc)
        await db.push_tokens.insert_one(doc)
    return {"ok": True}


@router.delete("/push/register")
async def unregister_push(body: PushUnregister, authorization: Optional[str] = Header(None)):
    """Remove a token (e.g. on logout)."""
    user = await get_current_user(authorization)
    await db.push_tokens.delete_one({"token": (body.token or "").strip(), "user_id": user["user_id"]})
    return {"ok": True}


async def push_tokens_for(user_id: str) -> list:
    """All Expo push tokens registered for a user (helper for push senders)."""
    rows = await db.push_tokens.find(
        {"user_id": user_id, "kind": {"$in": ["expo", None]}}, {"_id": 0, "token": 1}
    ).to_list(20)
    return [r["token"] for r in rows if r.get("token")]
