"""Developer webhooks — let third parties subscribe to a user's events.

A developer registers an endpoint URL + the events they care about. When one of
those events fires for them (a new follower, message, tip, etc.) we POST a signed
JSON payload to their URL. Requires an API plan that includes webhooks.
"""
import asyncio
import hashlib
import hmac
import ipaddress
import json
import secrets
import socket
import uuid
from datetime import datetime, timezone
from typing import List, Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from core import db, get_current_user, _active_plan

router = APIRouter()


def _webhook_url_ok(url: str) -> bool:
    """SSRF guard: only http(s) to a PUBLIC host on 80/443. Blocks delivery to
    loopback / private / link-local (cloud metadata 169.254.169.254) / reserved
    addresses. httpx does not follow redirects by default, so a public host can't
    302 us to an internal one."""
    try:
        p = urlparse(url)
    except Exception:
        return False
    if p.scheme not in ("http", "https") or not p.hostname:
        return False
    if p.port is not None and p.port not in (80, 443):
        return False
    try:
        infos = socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == "https" else 80))
    except Exception:
        return False
    for _f, _t, _pr, _c, sockaddr in infos:
        try:
            ip = ipaddress.ip_address(sockaddr[0])
        except Exception:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return False
    return True

# Event types a webhook can subscribe to. These mirror the notification types we
# actually emit (see emit_notification call sites), so every event here can really
# fire — plus form.submission, which is delivered directly with the full payload.
WEBHOOK_EVENT_INFO = {
    # Social
    "follow": "Someone followed you",
    "friend_request": "You received a friend request",
    "friend_accept": "Your friend request was accepted",
    "poke": "Someone poked you",
    # Posts
    "like": "Someone liked your post",
    "reply": "Someone replied to your post",
    "repost": "Someone reposted your post",
    "tag": "You were tagged or mentioned",
    # Messaging
    "message": "You received a direct message",
    "group_message": "New message in a group you're in",
    "group_invite": "You were invited to a group",
    "story_reply": "Someone replied to your story",
    # Money
    "tip": "You received a tip",
    "subscribe": "Someone subscribed to you",
    "payout": "A payout was processed",
    "wallet_topup": "Your wallet was topped up",
    # Services & ops
    "roadside": "A roadside assistance update",
    "support": "A support ticket update",
    "call": "An incoming call",
    "moderation": "A moderation action affected your content",
    # Forms
    "form.submission": "A custom form received a submission",
}
WEBHOOK_EVENTS = list(WEBHOOK_EVENT_INFO.keys())


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
    # `events` stays a flat list for back-compat; `event_info` adds descriptions.
    return {
        "events": WEBHOOK_EVENTS,
        "event_info": [{"event": e, "description": d} for e, d in WEBHOOK_EVENT_INFO.items()],
    }


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
    if not _webhook_url_ok(url):
        raise HTTPException(status_code=400, detail="That URL isn't allowed (it must be a public https endpoint).")
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


@router.post("/webhooks/{webhook_id}/test")
async def test_webhook(webhook_id: str, authorization: Optional[str] = Header(None)):
    """Send a signed sample `ping` event to the endpoint so developers can verify
    connectivity and signature checking. Returns the endpoint's HTTP status."""
    user = await get_current_user(authorization)
    hook = await db.dev_webhooks.find_one({"id": webhook_id, "user_id": user["user_id"]}, {"_id": 0})
    if not hook:
        raise HTTPException(status_code=404, detail="Webhook not found")
    payload = {
        "event": "ping",
        "data": {"message": "Test event from Nami", "webhook_id": webhook_id},
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    body = json.dumps(payload, default=str).encode("utf-8")
    sig = hmac.new(hook.get("secret", "").encode("utf-8"), body, hashlib.sha256).hexdigest()
    if not _webhook_url_ok(hook.get("url", "")):
        raise HTTPException(status_code=400, detail="This webhook's URL is no longer allowed.")
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.post(
                hook["url"], content=body,
                headers={"Content-Type": "application/json",
                         "X-Nami-Signature": f"sha256={sig}", "X-Nami-Event": "ping"},
            )
        return {"ok": 200 <= r.status_code < 300, "status": r.status_code}
    except Exception as e:
        return {"ok": False, "status": 0, "error": str(e)[:200]}


@router.get("/webhooks/{webhook_id}/deliveries")
async def list_deliveries(webhook_id: str, limit: int = 25, authorization: Optional[str] = Header(None)):
    """Recent delivery attempts for a webhook — status, attempts, errors."""
    user = await get_current_user(authorization)
    hook = await db.dev_webhooks.find_one({"id": webhook_id, "user_id": user["user_id"]}, {"_id": 0, "id": 1})
    if not hook:
        raise HTTPException(status_code=404, detail="Webhook not found")
    lim = max(1, min(int(limit or 25), 100))
    rows = await db.webhook_deliveries.find(
        {"webhook_id": webhook_id}, {"_id": 0, "payload": 0}   # payload kept server-side only
    ).sort("created_at", -1).limit(lim).to_list(lim)
    return {"deliveries": rows}


@router.post("/webhooks/{webhook_id}/deliveries/{delivery_id}/redeliver")
async def redeliver(webhook_id: str, delivery_id: str, authorization: Optional[str] = Header(None)):
    """Re-send a past delivery's original payload (e.g. after fixing your endpoint).
    Logs a fresh delivery attempt and returns its result."""
    user = await get_current_user(authorization)
    hook = await db.dev_webhooks.find_one({"id": webhook_id, "user_id": user["user_id"]}, {"_id": 0})
    if not hook:
        raise HTTPException(status_code=404, detail="Webhook not found")
    d = await db.webhook_deliveries.find_one(
        {"id": delivery_id, "webhook_id": webhook_id, "user_id": user["user_id"]}, {"_id": 0}
    )
    if not d:
        raise HTTPException(status_code=404, detail="Delivery not found")
    payload = d.get("payload") or {
        "event": d.get("event", ""), "data": {}, "created_at": datetime.now(timezone.utc).isoformat(),
    }
    rec = await _post(hook, payload)
    return {"ok": rec["ok"], "status": rec["status"], "attempts": rec["attempts"]}


async def _post(hook: dict, payload: dict) -> dict:
    """Deliver one event to one endpoint with a few retries + backoff, then log
    the outcome. Returns a delivery record (also persisted)."""
    url = hook.get("url", "")
    secret = hook.get("secret", "")
    body = json.dumps(payload, default=str).encode("utf-8")
    sig = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "X-Nami-Signature": f"sha256={sig}",
        "X-Nami-Event": payload.get("event", ""),
    }
    if not _webhook_url_ok(url):
        # Refuse SSRF targets (the host may now resolve to a private address).
        return {"status": 0, "ok": False, "error": "blocked_url", "attempts": 0}
    status, ok, err, attempts = 0, False, None, 0
    for delay in (0, 2, 6):   # 3 attempts: immediate, +2s, +6s
        if delay:
            await asyncio.sleep(delay)
        attempts += 1
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                r = await client.post(url, content=body, headers=headers)
            status = r.status_code
            if 200 <= status < 300:
                ok = True
                break
        except Exception as e:
            err = str(e)[:200]
    record = {
        "id": str(uuid.uuid4()),
        "webhook_id": hook.get("id"), "user_id": hook.get("user_id"),
        "event": payload.get("event", ""), "ok": ok, "status": status,
        "attempts": attempts, "error": err,
        "payload": payload,          # kept so a delivery can be re-sent later
        "created_at": datetime.now(timezone.utc),
    }
    try:
        await db.webhook_deliveries.insert_one(record.copy())
    except Exception:
        pass
    return record


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
    payload = {"event": event, "data": data, "created_at": datetime.now(timezone.utc).isoformat()}
    for h in hooks:
        asyncio.create_task(_post(h, payload))
