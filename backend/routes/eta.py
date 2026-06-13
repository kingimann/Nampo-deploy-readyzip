"""ETA Sharing: REST + WebSocket pub/sub."""
import asyncio
import json
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional
import uuid

from fastapi import APIRouter, Header, HTTPException, WebSocket, WebSocketDisconnect

from core import _new_share_id, _norm_dt, db, get_current_user
from models import EtaShare, EtaShareCreate, EtaUpdate

router = APIRouter()


@router.post("/eta", response_model=EtaShare)
async def create_eta(body: EtaShareCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    now = datetime.now(timezone.utc)
    ttl = max(5, min(body.ttl_minutes, 60 * 24))
    doc = {
        "id": str(uuid.uuid4()),
        "share_id": _new_share_id(),
        "user_id": user["user_id"],
        "name": body.name or user.get("name", "Friend"),
        "destination_name": body.destination_name,
        "destination_longitude": body.destination_longitude,
        "destination_latitude": body.destination_latitude,
        "current_longitude": body.initial_longitude,
        "current_latitude": body.initial_latitude,
        "eta_minutes": body.eta_minutes,
        "active": True,
        "expires_at": now + timedelta(minutes=ttl),
        "updated_at": now,
        "created_at": now,
    }
    await db.eta_shares.insert_one(doc.copy())
    return EtaShare(**doc)


@router.post("/eta/{share_id}/update", response_model=EtaShare)
async def update_eta(
    share_id: str, body: EtaUpdate, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    share = await db.eta_shares.find_one({"share_id": share_id}, {"_id": 0})
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    if share["user_id"] != user["user_id"]:
        raise HTTPException(status_code=403, detail="Not your share")
    now = datetime.now(timezone.utc)
    # A stopped or expired share is done — don't accept zombie position updates
    # (and lazily flag the expiry so the public link reflects it too).
    if not share.get("active", True):
        raise HTTPException(status_code=410, detail="Share ended")
    if _norm_dt(share["expires_at"]) < now:
        await db.eta_shares.update_one({"share_id": share_id}, {"$set": {"active": False}})
        raise HTTPException(status_code=410, detail="Share expired")
    patch = {
        "current_longitude": body.current_longitude,
        "current_latitude": body.current_latitude,
        "updated_at": now,
    }
    if body.eta_minutes is not None:
        patch["eta_minutes"] = body.eta_minutes
    await db.eta_shares.update_one({"share_id": share_id}, {"$set": patch})
    updated = await db.eta_shares.find_one({"share_id": share_id}, {"_id": 0})
    await _broadcast_eta(share_id, updated)
    return EtaShare(**updated)


@router.post("/eta/{share_id}/stop", response_model=EtaShare)
async def stop_eta(share_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    share = await db.eta_shares.find_one({"share_id": share_id}, {"_id": 0})
    if not share or share["user_id"] != user["user_id"]:
        raise HTTPException(status_code=404, detail="Share not found")
    await db.eta_shares.update_one({"share_id": share_id}, {"$set": {"active": False}})
    updated = await db.eta_shares.find_one({"share_id": share_id}, {"_id": 0})
    await _broadcast_eta(share_id, updated)
    return EtaShare(**updated)


@router.get("/public/eta/{share_id}", response_model=EtaShare)
async def get_public_eta(share_id: str):
    """No auth — anyone with the link can view."""
    share = await db.eta_shares.find_one({"share_id": share_id}, {"_id": 0})
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    if _norm_dt(share["expires_at"]) < datetime.now(timezone.utc):
        await db.eta_shares.update_one({"share_id": share_id}, {"$set": {"active": False}})
        share["active"] = False
    return EtaShare(**share)


# ----- WebSocket pub/sub -----
_eta_subscribers: Dict[str, List[WebSocket]] = {}
_eta_lock = asyncio.Lock()


async def _broadcast_eta(share_id: str, share_doc: dict):
    async with _eta_lock:
        subs = list(_eta_subscribers.get(share_id, []))
    if not subs:
        return
    payload = {**share_doc}
    for k in ("expires_at", "updated_at", "created_at"):
        if isinstance(payload.get(k), datetime):
            payload[k] = payload[k].isoformat()
    msg = json.dumps({"type": "eta", "share": payload})
    dead: List[WebSocket] = []
    for ws in subs:
        try:
            await ws.send_text(msg)
        except Exception:
            dead.append(ws)
    if dead:
        async with _eta_lock:
            cur = _eta_subscribers.get(share_id, [])
            _eta_subscribers[share_id] = [w for w in cur if w not in dead]


async def ws_eta(websocket: WebSocket, share_id: str):
    await websocket.accept()
    share = await db.eta_shares.find_one({"share_id": share_id}, {"_id": 0})
    if not share:
        await websocket.send_text(json.dumps({"type": "error", "detail": "not_found"}))
        await websocket.close()
        return
    payload = {**share}
    for k in ("expires_at", "updated_at", "created_at"):
        if isinstance(payload.get(k), datetime):
            payload[k] = payload[k].isoformat()
    await websocket.send_text(json.dumps({"type": "eta", "share": payload}))

    async with _eta_lock:
        _eta_subscribers.setdefault(share_id, []).append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        async with _eta_lock:
            cur = _eta_subscribers.get(share_id, [])
            _eta_subscribers[share_id] = [w for w in cur if w is not websocket]
