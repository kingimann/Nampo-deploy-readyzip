"""Hosted AI (Anthropic) checks for the roadside + marketplace flows.

Runs when no local Ollama model is configured (``OLLAMA_HOST`` unset), which is
the default on hosted deployments — no AI server to run, just one API key:
  - ``classify_vehicle_photo``  — roadside photo shows a vehicle / the problem
  - ``verify_documents_claude`` — roadside insurance + ownership documents match
  - ``classify_listing_spam``   — marketplace listing is spam / a scam

Disabled unless ``ANTHROPIC_API_KEY`` is set (the same key the @claude bot uses).
Best-effort: each helper fails open / returns "unavailable" when unconfigured or
on any API/parse error — they never hard-block a user on an AI hiccup.

Configure with:
  ANTHROPIC_API_KEY     enables these checks (set in your host's dashboard)
  CLAUDE_VISION_MODEL   vision model id (default: claude-haiku-4-5 — cheapest)
  CLAUDE_TEXT_MODEL     text model id   (default: claude-haiku-4-5)
"""
import json
import logging
import os
import re
from typing import Optional

import httpx

logger = logging.getLogger("claude_ai")

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
CLAUDE_VISION_MODEL = os.environ.get("CLAUDE_VISION_MODEL", "claude-haiku-4-5")
CLAUDE_TEXT_MODEL = os.environ.get("CLAUDE_TEXT_MODEL", "claude-haiku-4-5")
_API_URL = "https://api.anthropic.com/v1/messages"


def claude_ai_enabled() -> bool:
    return bool(ANTHROPIC_API_KEY)


def _media_type(b64: str) -> str:
    m = re.match(r"data:(image/[a-zA-Z0-9.+-]+);base64,", b64 or "")
    return m.group(1) if m else "image/jpeg"


def _raw_b64(s: str) -> str:
    return re.sub(r"^data:[^;]+;base64,", "", (s or "").strip())


def _image_block(b64: str) -> dict:
    s = (b64 or "").strip()
    if s.startswith("http://") or s.startswith("https://"):
        # A hosted image URL (e.g. a Cloudinary upload) — let Anthropic fetch it
        # directly instead of trying to read it as base64.
        return {"type": "image", "source": {"type": "url", "url": s}}
    return {"type": "image", "source": {"type": "base64", "media_type": _media_type(s), "data": _raw_b64(s)}}


def _extract_json(text: str) -> str:
    """Pull the JSON object out of the model reply, tolerating code fences or a
    stray sentence around it."""
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    if not text.startswith("{"):
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            return m.group(0)
    return text


async def _ask(model: str, content, max_tokens: int = 200) -> Optional[str]:
    """POST one user message (``content`` is a string or a list of content
    blocks) to the Anthropic Messages API; return the reply text, or None on any
    HTTP/network error."""
    payload = {"model": model, "max_tokens": max_tokens, "messages": [{"role": "user", "content": content}]}
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            r = await client.post(
                _API_URL,
                headers={
                    "x-api-key": ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json=payload,
            )
            if r.status_code >= 400:
                logger.warning("Anthropic API %s: %s", r.status_code, r.text[:300])
                return None
            data = r.json()
        return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    except Exception as e:
        logger.warning("Anthropic API call failed: %s", e)
        return None


_PHOTO_PROMPT = (
    "This is a photo from a roadside-assistance request. Does it clearly show a "
    "motor vehicle, or a part of one relevant to the problem (e.g. a flat or "
    "damaged tyre, engine bay, dead battery, a locked door/window, fuel cap)? "
    "Answer false for an unrelated subject (a person, a room, food, a screenshot, "
    "random objects) or a blank/black/too-dark image.\n"
    'Reply with ONLY JSON: {"shows_vehicle": true|false, "reason": "<one short sentence>"}'
)


async def classify_vehicle_photo(b64: str) -> dict:
    """Return ``{"ok": bool, "reason": str}``. ``ok`` is False only when Claude
    confidently says the photo isn't a vehicle/the problem; fails open (ok=True)
    when not configured or on any error so a hiccup never hard-blocks a user."""
    if not claude_ai_enabled():
        return {"ok": True, "reason": ""}
    text = await _ask(CLAUDE_VISION_MODEL, [_image_block(b64), {"type": "text", "text": _PHOTO_PROMPT}])
    if text is None:
        return {"ok": True, "reason": ""}
    try:
        parsed = json.loads(_extract_json(text))
    except Exception:
        return {"ok": True, "reason": ""}
    if isinstance(parsed, dict) and parsed.get("shows_vehicle") is False:
        reason = str(parsed.get("reason") or "").strip()[:200]
        return {"ok": False, "reason": reason or "That photo doesn't look like your vehicle or the problem. Take a clear photo of the car or the issue."}
    return {"ok": True, "reason": ""}


async def verify_documents_claude(
    insurance_b64: str,
    ownership_b64: str,
    vehicle: Optional[str],
    name: Optional[str],
) -> dict:
    """Return ``{"decision": "approve"|"reject"|"unavailable", "reason": str}``.
    ``unavailable`` means the caller should fall back (e.g. manual review)."""
    if not claude_ai_enabled():
        return {"decision": "unavailable", "reason": "AI verifier not configured"}
    prompt = (
        "You verify members for a peer-to-peer roadside assistance app, to stop "
        "bots and fraud. Image 1 is the member's AUTO INSURANCE document. Image 2 "
        "is their PROOF OF VEHICLE OWNERSHIP (registration or title).\n"
        f"Member-entered vehicle: {vehicle or 'not provided'}\n"
        f"Member-entered name: {name or 'not provided'}\n\n"
        "Approve ONLY if: both images are legible, real documents; image 1 is auto "
        "insurance; image 2 is a vehicle registration or title; and the owner name "
        "and the vehicle are consistent across both documents (and match the "
        "member-entered details when those are provided). Reject blurry, edited, "
        "mismatched, expired, or wrong-type documents.\n"
        'Reply with ONLY JSON: {"match": true|false, "reason": "<one short sentence>"}'
    )
    content = [_image_block(insurance_b64), _image_block(ownership_b64), {"type": "text", "text": prompt}]
    text = await _ask(CLAUDE_VISION_MODEL, content, max_tokens=300)
    if text is None:
        return {"decision": "unavailable", "reason": "verifier error"}
    try:
        parsed = json.loads(_extract_json(text))
    except Exception:
        parsed = None
    if not isinstance(parsed, dict):
        return {"decision": "unavailable", "reason": "verifier returned an unreadable response"}
    match = bool(parsed.get("match"))
    reason = str(parsed.get("reason") or "")[:300]
    return {"decision": "approve" if match else "reject", "reason": reason}


async def classify_listing_spam(title: str, description: str) -> Optional[dict]:
    """Return ``{"spam": bool, "reason": str}``, or None when unavailable
    (not configured or on error) so the caller keeps its rule-based result."""
    if not claude_ai_enabled():
        return None
    prompt = (
        "You moderate a peer-to-peer marketplace. Decide if this listing is spam, a scam, "
        "or an obviously low-quality placeholder. Genuine items for sale are fine — don't "
        "flag those.\n"
        f"Title: {title}\nDescription: {description}\n"
        'Reply with ONLY JSON: {"spam": true|false, "reason": "<one short sentence>"}'
    )
    text = await _ask(CLAUDE_TEXT_MODEL, prompt)
    if text is None:
        return None
    try:
        parsed = json.loads(_extract_json(text))
    except Exception:
        return None
    if isinstance(parsed, dict):
        return {"spam": bool(parsed.get("spam")), "reason": str(parsed.get("reason") or "").strip()[:200]}
    return None
