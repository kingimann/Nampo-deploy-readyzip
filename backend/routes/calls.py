"""In-app voice/video calls via LiveKit.

Mints LiveKit access tokens (so the API secret stays server-side) and rings the
other participant through the existing notification system. The room name is
derived from the conversation id, so both sides join the same room.

Config: LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL (wss://…). Self-host
LiveKit or use LiveKit Cloud.
"""
import base64
import hashlib
import hmac
import json
import time
from typing import Optional

from fastapi import APIRouter, Header, HTTPException

from core import LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL, db, get_current_user
from routes.notifications import emit_notification

router = APIRouter()


def calls_enabled() -> bool:
    return bool(LIVEKIT_API_KEY and LIVEKIT_API_SECRET and LIVEKIT_URL)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _livekit_token(identity: str, name: str, room: str, ttl: int = 3600) -> str:
    """A LiveKit access token is a HS256 JWT signed with the API secret."""
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "iss": LIVEKIT_API_KEY,
        "sub": identity,
        "name": name,
        "nbf": now,
        "exp": now + ttl,
        "video": {
            "room": room,
            "roomJoin": True,
            "canPublish": True,
            "canSubscribe": True,
        },
    }
    seg = (
        _b64url(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + _b64url(json.dumps(payload, separators=(",", ":")).encode())
    )
    sig = hmac.new(LIVEKIT_API_SECRET.encode(), seg.encode(), hashlib.sha256).digest()
    return seg + "." + _b64url(sig)


async def _conv_or_404(conversation_id: str, user_id: str) -> dict:
    conv = await db.conversations.find_one({"id": conversation_id}, {"_id": 0})
    if not conv or user_id not in (conv.get("participant_ids") or []):
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@router.post("/calls/{conversation_id}/token")
async def call_token(conversation_id: str, authorization: Optional[str] = Header(None)):
    """Mint a LiveKit token for this conversation's call room (members only)."""
    user = await get_current_user(authorization)
    if not calls_enabled():
        raise HTTPException(status_code=503, detail={
            "code": "calls_not_configured",
            "message": "Calling isn't set up on this server (LIVEKIT_* not configured).",
        })
    await _conv_or_404(conversation_id, user["user_id"])
    room = f"call_{conversation_id}"
    token = _livekit_token(user["user_id"], user.get("name") or "User", room)
    return {"token": token, "url": LIVEKIT_URL, "room": room, "identity": user["user_id"]}


@router.post("/calls/{conversation_id}/ring")
async def call_ring(conversation_id: str, authorization: Optional[str] = Header(None)):
    """Notify the other participant(s) of an incoming call."""
    user = await get_current_user(authorization)
    conv = await _conv_or_404(conversation_id, user["user_id"])
    room = f"call_{conversation_id}"
    for pid in (conv.get("participant_ids") or []):
        if pid == user["user_id"]:
            continue
        await emit_notification(
            user_id=pid, actor_id=user["user_id"], ntype="call",
            conversation_id=conversation_id, message="📞 Incoming voice call",
        )
    return {"ok": True, "room": room}
