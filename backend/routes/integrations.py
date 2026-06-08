"""Admin: integration / SDK status board.

Lists every external service the backend talks to, whether it's configured,
and — on demand (?live=1) — whether a live call actually succeeds, plus exactly
what to set if it's not working. Admin-only.
"""
import asyncio
import os
import time
from typing import Optional

import httpx
from fastapi import APIRouter, Header, HTTPException, Query

from core import db, get_current_user, is_admin

router = APIRouter()


def _present(*names: str) -> bool:
    return all(bool(os.environ.get(n)) for n in names)


async def _check_db() -> tuple[bool, str]:
    try:
        await db.users.find_one({}, {"_id": 1})
        return True, "Connected."
    except Exception as e:  # pragma: no cover - defensive
        return False, f"Query failed: {e}"


async def _check_stripe() -> tuple[bool, str]:
    try:
        from routes.payments import stripe, stripe_enabled
        if not stripe_enabled():
            return False, "STRIPE_SECRET_KEY not set."
        await asyncio.to_thread(stripe.Balance.retrieve)
        return True, "Authenticated with Stripe."
    except Exception as e:
        return False, f"Stripe call failed: {str(e)[:120]}"


async def _check_twilio() -> tuple[bool, str]:
    sid = os.environ.get("TWILIO_ACCOUNT_SID", "")
    tok = os.environ.get("TWILIO_AUTH_TOKEN", "")
    if not (sid and tok and os.environ.get("TWILIO_FROM_NUMBER")):
        return False, "Twilio credentials not fully set."
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(f"https://api.twilio.com/2010-04-01/Accounts/{sid}.json", auth=(sid, tok))
        return (r.status_code == 200), (f"Account reachable." if r.status_code == 200 else f"HTTP {r.status_code}")
    except Exception as e:
        return False, f"Twilio call failed: {str(e)[:120]}"


async def _check_transitland() -> tuple[bool, str]:
    key = os.environ.get("TRANSITLAND_API_KEY", "")
    if not key:
        return False, "TRANSITLAND_API_KEY not set."
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get("https://transit.land/api/v2/rest/feeds", params={"apikey": key, "limit": 1})
        return (r.status_code == 200), (f"API reachable." if r.status_code == 200 else f"HTTP {r.status_code}")
    except Exception as e:
        return False, f"TransitLand call failed: {str(e)[:120]}"


async def _check_foursquare() -> tuple[bool, str]:
    try:
        from core import FSQ_API_KEY, FSQ_BASE
        if not FSQ_API_KEY:
            return False, "FSQ_API_KEY not set."
        headers = {"Authorization": f"Bearer {FSQ_API_KEY}", "X-Places-Api-Version": "2025-06-17"}
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(f"{FSQ_BASE}/search", headers=headers,
                            params={"query": "coffee", "ll": "40.7128,-74.006", "radius": "4000", "limit": "5"})
        if r.status_code != 200:
            return False, f"HTTP {r.status_code}"   # don't echo the upstream body — it can reflect the key
        n = len((r.json() or {}).get("results", []))
        if n > 0:
            return True, f"OK — {n} results for a test 'coffee' search in NYC."
        return False, "200 OK but 0 results — check the key's plan/permissions for Place Search."
    except Exception as e:
        return False, f"Foursquare call failed: {str(e)[:120]}"


async def _check_ollama() -> tuple[bool, str]:
    host = os.environ.get("OLLAMA_HOST", "")
    if not host:
        return False, "OLLAMA_HOST not set."
    base = host.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(f"{base}/api/tags")
        if r.status_code == 200:
            models = [m.get("name") for m in (r.json() or {}).get("models", []) if m.get("name")][:6]
            return True, f"Reachable. Models: {', '.join(models) if models else 'none pulled'}."
        return False, f"HTTP {r.status_code}"
    except Exception as e:
        return False, f"Ollama call failed: {str(e)[:120]}"


async def _check_email() -> tuple[bool, str]:
    host = os.environ.get("SMTP_HOST", "")
    frm = os.environ.get("SMTP_FROM", "")
    if not (host and frm):
        return False, "SMTP_HOST / SMTP_FROM not set."
    port = int(os.environ.get("SMTP_PORT", "587") or 587)
    user = os.environ.get("SMTP_USER", "")
    pw = os.environ.get("SMTP_PASS", "")

    def _connect() -> tuple[bool, str]:
        import smtplib
        s = smtplib.SMTP(host, port, timeout=12)
        try:
            s.ehlo()
            try:
                s.starttls(); s.ehlo()
            except Exception:
                pass
            if user and pw:
                s.login(user, pw)
                return True, "Connected and authenticated (no test email sent)."
            return True, "Connected (no SMTP_USER/PASS auth configured)."
        finally:
            try:
                s.quit()
            except Exception:
                pass

    try:
        return await asyncio.to_thread(_connect)
    except Exception as e:
        return False, f"SMTP failed: {str(e)[:120]}"


async def _check_livekit() -> tuple[bool, str]:
    url = os.environ.get("LIVEKIT_URL", "")
    if not (os.environ.get("LIVEKIT_API_KEY") and os.environ.get("LIVEKIT_API_SECRET") and url):
        return False, "LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL not fully set."
    https = url.replace("wss://", "https://").replace("ws://", "http://").rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(https)
        # Any HTTP response means the LiveKit host resolves and is reachable.
        return True, f"Host reachable (HTTP {r.status_code}). Credentials are used to mint room tokens."
    except Exception as e:
        return False, f"Host unreachable: {str(e)[:120]}"


async def _check_render() -> tuple[bool, str]:
    key = os.environ.get("RENDER_API_KEY", "")
    if not key:
        return False, "RENDER_API_KEY not set."
    try:
        async with httpx.AsyncClient(timeout=12) as c:
            r = await c.get("https://api.render.com/v1/services",
                            headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
                            params={"limit": 1})
        if r.status_code == 200:
            return True, "Authenticated — manage services in Settings → Render."
        return False, f"HTTP {r.status_code}"   # don't echo the upstream body — it can reflect the token
    except Exception as e:
        return False, f"Render call failed: {str(e)[:120]}"


async def _check_anthropic() -> tuple[bool, str]:
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        return False, "ANTHROPIC_API_KEY not set."
    model = os.environ.get("CLAUDE_VISION_MODEL", "claude-haiku-4-5")
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                json={"model": model, "max_tokens": 1, "messages": [{"role": "user", "content": "ping"}]},
            )
        if r.status_code == 200:
            return True, f"Authenticated — {model} ready for the roadside photo check."
        return False, f"HTTP {r.status_code}"   # don't echo the upstream body — it can reflect the key
    except Exception as e:
        return False, f"Anthropic call failed: {str(e)[:120]}"


# Each entry: live() is optional (only run when ?live=1).
_INTEGRATIONS = [
    {
        "key": "database", "name": "PostgreSQL database", "category": "Core",
        "required": True, "env": ["DATABASE_URL"],
        "summary": "Primary data store (users, posts, payments, everything).",
        "fix": "Set DATABASE_URL to your PostgreSQL connection string (asyncpg DSN).",
        "docs": "https://code.claude.com/docs",
        "configured": lambda: _present("DATABASE_URL"), "live": _check_db,
    },
    {
        "key": "stripe", "name": "Stripe (payments & payouts)", "category": "Payments",
        "required": False, "env": ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PUBLISHABLE_KEY"],
        "summary": "Real card payments, Connect payouts, cash-out. Without it, the app uses simulated payments.",
        "fix": "Set STRIPE_SECRET_KEY (sk_live_… / sk_test_…). Add STRIPE_WEBHOOK_SECRET for the webhook and STRIPE_PUBLISHABLE_KEY for inline card entry.",
        "docs": "https://dashboard.stripe.com/apikeys",
        "configured": lambda: _present("STRIPE_SECRET_KEY"), "live": _check_stripe,
    },
    {
        "key": "twilio", "name": "Twilio (SMS)", "category": "Auth & messaging",
        "required": False, "env": ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
        "summary": "Phone verification, OTP login, SMS two-factor, password reset by text, SMS notifications. Falls back to dev codes when unset.",
        "fix": "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER from your Twilio console.",
        "docs": "https://console.twilio.com/",
        "configured": lambda: _present("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"),
        "live": _check_twilio,
    },
    {
        "key": "transitland", "name": "TransitLand (transit)", "category": "Maps",
        "required": False, "env": ["TRANSITLAND_API_KEY"],
        "summary": "Live bus/train departures in Directions → Transit.",
        "fix": "Create a free key at transit.land and set TRANSITLAND_API_KEY.",
        "docs": "https://www.transit.land/",
        "configured": lambda: _present("TRANSITLAND_API_KEY"), "live": _check_transitland,
    },
    {
        "key": "foursquare", "name": "Foursquare Places", "category": "Maps",
        "required": False, "env": ["FSQ_API_KEY"],
        "summary": "Business profiles / place enrichment on the map.",
        "fix": "Set FSQ_API_KEY from the Foursquare developer console.",
        "docs": "https://location.foursquare.com/developer/",
        "configured": lambda: _present("FSQ_API_KEY"), "live": _check_foursquare,
    },
    {
        "key": "email", "name": "Email (SMTP)", "category": "Auth & messaging",
        "required": False, "env": ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"],
        "summary": "Password-reset emails. Without it, email reset is unavailable (use SMS or owner recovery).",
        "fix": "Set SMTP_HOST and SMTP_FROM (plus SMTP_USER / SMTP_PASS / SMTP_PORT) for your mail provider.",
        "docs": "https://code.claude.com/docs",
        "configured": lambda: _present("SMTP_HOST", "SMTP_FROM"), "live": _check_email,
    },
    {
        "key": "livekit", "name": "LiveKit (voice/video calls)", "category": "Calls",
        "required": False, "env": ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_URL"],
        "summary": "In-app 1:1 voice calls (WebRTC). Without it, the call button is disabled.",
        "fix": "Self-host LiveKit or use LiveKit Cloud; set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and LIVEKIT_URL (wss://…).",
        "docs": "https://cloud.livekit.io/",
        "configured": lambda: _present("LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_URL"), "live": None,
    },
    {
        "key": "anthropic", "name": "Anthropic (Claude bot + AI checks)", "category": "AI",
        "required": False, "env": ["ANTHROPIC_API_KEY"],
        "summary": "Powers the @claude assistant and the roadside photo/document checks + marketplace listing moderation. Without it, photos are accepted with no automotive check.",
        "fix": "Set ANTHROPIC_API_KEY from the Anthropic console, then run a live check here to confirm.",
        "docs": "https://console.anthropic.com/",
        "configured": lambda: _present("ANTHROPIC_API_KEY"), "live": _check_anthropic,
    },
    {
        "key": "ollama", "name": "Ollama (self-hosted AI vision)", "category": "AI",
        "required": False, "env": ["OLLAMA_HOST"],
        "summary": "Optional self-hosted vision model for the roadside photo check, used instead of Anthropic when set.",
        "fix": "Run Ollama somewhere reachable (with a vision model pulled) and set OLLAMA_HOST to its base URL.",
        "docs": "https://ollama.com/",
        "configured": lambda: _present("OLLAMA_HOST"), "live": _check_ollama,
    },
    {
        "key": "expo_push", "name": "Expo Push (notifications)", "category": "Calls",
        "required": False, "env": ["EXPO_ACCESS_TOKEN"],
        "summary": "Background push for call ringing & alerts. Works out of the box with a dev/prod build; EXPO_ACCESS_TOKEN only raises rate limits.",
        "fix": "Optional: set EXPO_ACCESS_TOKEN to raise push rate limits. Push otherwise works once you ship an EAS build.",
        "docs": "https://docs.expo.dev/push-notifications/overview/",
        "configured": lambda: True, "live": None,
    },
    {
        "key": "message_encryption", "name": "Message encryption at rest", "category": "Security",
        "required": False, "env": ["MESSAGE_ENC_KEY"],
        "summary": "Encrypts stored messages with a Fernet key. Without it, messaging still works in plaintext at rest.",
        "fix": "Generate a Fernet key and set MESSAGE_ENC_KEY to enable encryption at rest.",
        "docs": "https://code.claude.com/docs",
        "configured": lambda: _present("MESSAGE_ENC_KEY"), "live": None,
    },
    {
        "key": "recovery", "name": "Owner password recovery", "category": "Security",
        "required": False, "env": ["RECOVERY_SECRET"],
        "summary": "Break-glass: lets the owner reset any account's password without email.",
        "fix": "Set RECOVERY_SECRET to a long random string to enable /auth/recover-password.",
        "docs": "https://code.claude.com/docs",
        "configured": lambda: _present("RECOVERY_SECRET"), "live": None,
    },
    {
        "key": "render", "name": "Render (hosting management)", "category": "Hosting",
        "required": False, "env": ["RENDER_API_KEY"],
        "summary": "Manage services, deploys and env vars from Settings → Render. Without it, that admin screen can't load.",
        "fix": "Create an owner API key in Render → Account Settings → API Keys and set RENDER_API_KEY.",
        "docs": "https://render.com/docs/api",
        "configured": lambda: _present("RENDER_API_KEY"), "live": _check_render,
    },
]


@router.get("/admin/integrations")
async def admin_integrations(
    live: int = Query(0, description="1 = run live health checks for everything (slower)"),
    only: Optional[str] = Query(None, description="run the live check for just this integration key"),
    authorization: Optional[str] = Header(None),
):
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")

    out = []
    for spec in _INTEGRATIONS:
        configured = bool(spec["configured"]())
        item = {
            "key": spec["key"], "name": spec["name"], "category": spec["category"],
            "required": spec["required"], "env": spec["env"],
            "env_detail": [{"name": n, "set": bool(os.environ.get(n))} for n in spec["env"]],
            "summary": spec["summary"], "fix": spec["fix"], "docs": spec["docs"],
            "configured": configured,
            "can_test": bool(spec.get("live")),
        }
        if not configured:
            item["status"] = "not_configured" if spec["required"] else "optional_off"
            item["detail"] = "Not configured."
        else:
            item["status"] = "configured"
            item["detail"] = "Configured."
        run_live = bool(spec.get("live")) and (bool(live) or (only is not None and only == spec["key"]))
        if run_live:
            t0 = time.perf_counter()
            try:
                ok, detail = await spec["live"]()
            except Exception as e:  # pragma: no cover - defensive
                ok, detail = False, f"Check error: {str(e)[:120]}"
            item["latency_ms"] = int((time.perf_counter() - t0) * 1000)
            item["status"] = "operational" if ok else ("error" if configured else item["status"])
            item["detail"] = detail
            item["tested"] = True
        out.append(item)

    summary = {
        "total": len(out),
        "configured": sum(1 for i in out if i["configured"]),
        "operational": sum(1 for i in out if i["status"] == "operational"),
        "errors": sum(1 for i in out if i["status"] == "error"),
        "needs_setup": sum(1 for i in out if not i["configured"] and i["required"]),
    }
    return {"integrations": out, "summary": summary, "live": bool(live), "only": only}
