"""Push delivery for calls (and future alerts).

Uses Expo's push service, which fans out to APNs/FCM using the credentials EAS
already manages for your build — so a `ring` can wake the device and surface a
call notification without you wiring raw APNs/FCM here. For a full-screen
CallKit experience you additionally need a VoIP (PushKit) push; see
docs/README "Background call ringing".
"""
import os
from typing import Iterable, Optional

import httpx

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
EXPO_ACCESS_TOKEN = os.environ.get("EXPO_ACCESS_TOKEN", "")  # optional, raises rate limits


async def send_expo_push(
    tokens: Iterable[str],
    *,
    title: str,
    body: str,
    data: Optional[dict] = None,
    channel_id: str = "calls",
    priority: str = "high",
) -> bool:
    """Best-effort high-priority push to Expo push tokens. Returns True if Expo
    accepted the batch. No-ops (returns False) when there are no tokens."""
    toks = [t for t in tokens if t]
    if not toks:
        return False
    messages = [{
        "to": t,
        "title": title,
        "body": body,
        "data": data or {},
        "sound": "default",
        "priority": priority,
        "channelId": channel_id,
    } for t in toks]
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if EXPO_ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {EXPO_ACCESS_TOKEN}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.post(EXPO_PUSH_URL, json=messages, headers=headers)
        return r.status_code == 200
    except httpx.HTTPError:
        return False
