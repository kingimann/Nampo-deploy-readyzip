"""Developer webhooks — let third parties subscribe to a user's events.

A developer registers an endpoint URL + the events they care about. When one of
those events fires for them (a new follower, message, tip, etc.) we POST a signed
JSON payload to their URL. Requires an API plan that includes webhooks.
"""
import asyncio
import hashlib
import hmac
import json
import secrets
import uuid
from datetime import datetime, timezone
from typing import List, Optional

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from core import db, get_current_user, _active_plan

router = APIRouter()

# Event types a webhook can subscribe to (mirror notification types + a few more).
WEBHOOK_EVENTS = [
    "follow", "friend_request", "friend_accept",
    "message", "group_message",
    "tip", "subscribe",
    "post_like", "post_reply", "mention",
]


class WebhookCreate(BaseModel):
    url: str
    events: Optional[List[str]] = None   # subset of WEBHOOK_EVENTS; default all


def _public(doc: dict, secret: Optional[str] = None) -> dict:
    out = {
        "id": doc.get("id"),
        "url": doc.get("url"),
        "events": doc.get("events", []),
        "active": doc.get("active", True),
        "created_at": doc.get("created_at"),
        "secret_prefix": (doc.get("secret", "")[:12] + "…") if doc.get("secret") else "",
    }
    if secret:
        out["secret"] = secret   # full secret returned once, at creation
    return out


@router.get("/webhooks/events")
async def list_events():
    return {"events": WEBHOOK_EVENTS}


@router.get("/webhooks")
async def list_webhooks(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    rows = await db.dev_webhooks.find({"user_id": user["user_id"]}, {"_id": 0}).sort("created_at", -1).to_list(50)
    return {"webhooks": [_public(r) for r in rows]}


@router.post("/webhooks")
async def create_webhook(body: WebhookCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    plan = _active_plan(user)
    if not plan or not plan.get("webhooks"):
        raise HTTPException(status_code=403, detail={
            "code": "upgrade_required",
            "message": "Webhooks require the Pro plan or higher.",
            "required_plan": "pro",
        })
    url = (body.url or "").strip()
    if not (url.startswith("https://") or url.startswith("http://")):
        raise HTTPException(status_code=400, detail="A valid https URL is required")
    events = [e for e in (body.events or WEBHOOK_EVENTS) if e in WEBHOOK_EVENTS] or WEBHOOK_EVENTS
    if await db.dev_webhooks.count_documents({"user_id": user["user_id"]}) >= 10:
        raise HTTPException(status_code=400, detail="Webhook limit reached (10)")
    secret = f"whsec_{secrets.token_urlsafe(24)}"
    doc = {
        "id": str(uuid.uuid4()), "user_id": user["user_id"], "url": url,
        "events": events, "secret": secret, "active": True,
        "created_at": datetime.now(timezone.utc),
    }
    await db.dev_webhooks.insert_one(doc.copy())
    return _public(doc, secret=secret)


@router.delete("/webhooks/{webhook_id}")
async def delete_webhook(webhook_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    await db.dev_webhooks.delete_one({"id": webhook_id, "user_id": user["user_id"]})
    return {"deleted": True}


async def _post(url: str, secret: str, payload: dict):
    body = json.dumps(payload, default=str).encode("utf-8")
    sig = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            await client.post(
                url, content=body,
                headers={"Content-Type": "application/json", "X-Nami-Signature": f"sha256={sig}",
                         "X-Nami-Event": payload.get("event", "")},
            )
    except Exception:
        pass  # best-effort delivery; no retries for now


async def deliver_event(user_id: str, event: str, data: dict) -> None:
    """Fire all of a user's webhooks subscribed to `event` (best-effort, async)."""
    try:
        hooks = await db.dev_webhooks.find(
            {"user_id": user_id, "active": True, "events": event}, {"_id": 0}
        ).to_list(20)
    except Exception:
        return
    if not hooks:
        return
    payload_base = {"event": event, "data": data, "created_at": datetime.now(timezone.utc).isoformat()}
    for h in hooks:
        asyncio.create_task(_post(h["url"], h.get("secret", ""), payload_base))
