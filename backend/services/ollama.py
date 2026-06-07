"""Local AI document check via Ollama (a vision model).

Used to auto-verify a roadside requester's insurance + proof of ownership: the
model confirms the docs look genuine and that the vehicle/owner are consistent
across both (and match what the user entered). Images are passed through in
memory and never persisted here.

Configure with:
  OLLAMA_HOST           e.g. http://localhost:11434  (unset → verifier disabled)
  OLLAMA_VISION_MODEL   e.g. llama3.2-vision (default)

Note: the backend is Python, so we call Ollama's HTTP API directly. The Vercel
AI SDK is a JavaScript library — a Node sidecar using it would hit this same
Ollama endpoint, so the result is identical.
"""
import json
import os
import re
from typing import Optional

import httpx

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "").rstrip("/")
OLLAMA_VISION_MODEL = os.environ.get("OLLAMA_VISION_MODEL", "llama3.2-vision")
OLLAMA_TEXT_MODEL = os.environ.get("OLLAMA_TEXT_MODEL", "llama3.2")

_FUEL_OK = {"regular", "midgrade", "premium"}


def ollama_enabled() -> bool:
    return bool(OLLAMA_HOST)


def _rule_issues(d: dict) -> list:
    """Deterministic baseline checks — always run, with or without the AI."""
    svc = (d.get("service") or "").strip().lower()
    issues: list = []

    def add(field, message):
        issues.append({"field": field, "message": message})

    if not svc:
        add("service", "Choose what you need help with.")
    if not d.get("has_location"):
        add("location", "Set your location so a helper can reach you.")
    elif not (d.get("place_name") or "").strip():
        add("location", "Add an address or landmark so the helper can find you.")
    if not (d.get("vehicle_make") or "").strip():
        add("vehicle", "Add your vehicle make so the helper can spot it.")
    if not (d.get("vehicle_model") or "").strip():
        add("vehicle", "Add your vehicle model.")
    if not (d.get("vehicle_year") or "").strip():
        add("vehicle", "Add the vehicle year.")
    if svc == "tow":
        if not (d.get("dest_name") or "").strip():
            add("dest_name", "Add where you'd like the vehicle towed.")
        if not (d.get("vehicle_plate") or "").strip():
            add("vehicle_plate", "Add your licence plate — handy for a tow.")
    if svc == "gas":
        ft = (d.get("fuel_type") or "").strip().lower()
        if ft == "diesel":
            add("fuel_type", "We don't deliver diesel — pick regular, mid-grade or premium.")
        elif ft not in _FUEL_OK:
            add("fuel_type", "Choose a fuel type (regular, mid-grade or premium).")
        if not (d.get("fuel_amount") or "").strip():
            add("fuel_amount", "Tell the driver how much gas you want.")
    return issues


async def review_form(d: dict) -> dict:
    """Check a roadside request form is filled out correctly and suggest fixes.
    Always returns the deterministic checks; the AI (when configured) adds extra
    clarity/quality suggestions on top. Shape: {ok, issues:[{field,message}]}."""
    issues = _rule_issues(d)
    if not ollama_enabled():
        return {"ok": len(issues) == 0, "issues": issues, "source": "rules"}

    safe = {k: d.get(k) for k in (
        "service", "place_name", "dest_name", "fuel_type", "fuel_amount",
        "vehicle_year", "vehicle_make", "vehicle_model", "vehicle_color", "vehicle_plate", "note",
    )}
    prompt = (
        "You help users fill out a roadside-assistance request correctly. Given this form "
        "(JSON), list anything that is missing, inconsistent, implausible or unclear, with a "
        "short, friendly fix for each — so a helper can find them and bring the right thing. "
        "Don't invent problems with fields that look fine. Service types: tow, lockout, "
        "battery, tire, gas. Gas needs a fuel type (regular/midgrade/premium — never diesel) "
        "and an amount. A tow needs a destination.\n"
        f"Form: {json.dumps(safe)}\n"
        'Reply with ONLY JSON: {"issues":[{"field":"<name>","message":"<short fix>"}]}'
    )
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(f"{OLLAMA_HOST}/api/chat", json={
                "model": OLLAMA_TEXT_MODEL, "stream": False, "format": "json",
                "options": {"temperature": 0},
                "messages": [{"role": "user", "content": prompt}],
            })
            resp.raise_for_status()
            content = ((resp.json() or {}).get("message") or {}).get("content") or ""
        parsed = json.loads(content)
        ai = parsed.get("issues") if isinstance(parsed, dict) else None
    except Exception:
        ai = None

    if ai:
        seen = {(i.get("field"), i.get("message")) for i in issues}
        for it in ai:
            if not isinstance(it, dict):
                continue
            field = str(it.get("field") or "general")[:40]
            msg = str(it.get("message") or "").strip()[:200]
            if msg and (field, msg) not in seen:
                issues.append({"field": field, "message": msg})
                seen.add((field, msg))
    return {"ok": len(issues) == 0, "issues": issues, "source": "ai" if ai is not None else "rules"}


def _raw_b64(s: str) -> str:
    """Ollama wants bare base64 (no `data:image/...;base64,` prefix)."""
    s = (s or "").strip()
    if s.startswith("data:") and "," in s:
        return s.split(",", 1)[1]
    return s


async def verify_documents(
    insurance_b64: str,
    ownership_b64: str,
    vehicle: Optional[str],
    name: Optional[str],
) -> dict:
    """Returns {"decision": "approve"|"reject"|"unavailable", "reason": str}.
    `unavailable` means the caller should fall back (e.g. manual review)."""
    if not ollama_enabled():
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
    payload = {
        "model": OLLAMA_VISION_MODEL,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0},
        "messages": [{
            "role": "user",
            "content": prompt,
            "images": [_raw_b64(insurance_b64), _raw_b64(ownership_b64)],
        }],
    }
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(f"{OLLAMA_HOST}/api/chat", json=payload)
            resp.raise_for_status()
            data = resp.json()
        content = ((data or {}).get("message") or {}).get("content") or ""
    except Exception as e:
        return {"decision": "unavailable", "reason": f"verifier error: {e}"[:200]}

    parsed = None
    try:
        parsed = json.loads(content)
    except Exception:
        m = re.search(r"\{.*\}", content, re.S)
        if m:
            try:
                parsed = json.loads(m.group(0))
            except Exception:
                parsed = None
    if not isinstance(parsed, dict):
        return {"decision": "unavailable", "reason": "verifier returned an unreadable response"}

    match = bool(parsed.get("match"))
    reason = str(parsed.get("reason") or "")[:300]
    return {"decision": "approve" if match else "reject", "reason": reason}
