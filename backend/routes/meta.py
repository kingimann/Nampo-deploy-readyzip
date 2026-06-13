"""API meta endpoints — version + machine-readable capability info for developers."""
import os
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from core import db

router = APIRouter()

# --- §1 response models (extra="allow") ---
class AppConfigOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    web_build: str = ""
    mobile_web_gate: bool = True
    mobile_only: bool = False
    registration_mode: str = "open"


class VersionOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    api: str = ""
    version: str = ""


class ErrorsOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    codes: list = []


class InfoOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    api: str = ""
    version: str = ""


class ChangelogOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    api: str = ""
    version: str = ""
    entries: list = []



def resolve_web_build(override: Optional[str]) -> str:
    """The build token the web app compares against to decide whether to hard-
    refresh (the update kill switch). An explicit admin override wins; otherwise
    fall back to a deploy-provided env var (RENDER injects RENDER_GIT_COMMIT) so
    every deploy changes the token and nudges open web clients to update."""
    if override:
        return str(override)
    return (
        os.environ.get("WEB_BUILD")
        or (os.environ.get("RENDER_GIT_COMMIT") or "")[:12]
        or ""
    )


@router.get("/public/app-config", response_model=AppConfigOut)
async def public_app_config():
    """Public client config read at app load (no auth) — the web-update
    kill-switch token and the mobile-web gate flag."""
    try:
        wb = await db.app_settings.find_one({"key": "web_build"}, {"_id": 0, "value": 1})
        web_build = resolve_web_build(wb.get("value") if wb else None)
    except Exception:
        web_build = resolve_web_build(None)
    try:
        doc = await db.app_settings.find_one({"key": "mobile_web_gate"}, {"_id": 0, "value": 1})
        # Default ON: phone browsers are pushed to the native app unless an admin
        # turns the gate off here (an explicit True/False always wins).
        mobile_web_gate = bool(doc.get("value")) if doc and doc.get("value") is not None else True
    except Exception:
        mobile_web_gate = True
    try:
        modoc = await db.app_settings.find_one({"key": "mobile_only"}, {"_id": 0, "value": 1})
        # Default OFF: desktop/PC access stays open unless an admin enables the gate.
        mobile_only = bool(modoc.get("value")) if modoc and modoc.get("value") is not None else False
    except Exception:
        mobile_only = False
    try:
        rdoc = await db.app_settings.find_one({"key": "registration_mode"}, {"_id": 0, "value": 1})
        rmode = (rdoc or {}).get("value")
        registration_mode = rmode if rmode in ("open", "invite", "closed") else "open"
    except Exception:
        registration_mode = "open"
    return {"web_build": web_build, "mobile_web_gate": mobile_web_gate,
            "mobile_only": mobile_only, "registration_mode": registration_mode}

API_VERSION = "1.0.0"

# High-level catalog of what the API exposes (handy for clients / dashboards).
CAPABILITIES = [
    {"group": "auth", "base": "/auth", "summary": "Register, login, profile, API keys, policies"},
    {"group": "users", "base": "/users", "summary": "Search, public profiles, follow/friends, pokes, tips, subscriptions (tiers)"},
    {"group": "posts", "base": "/posts", "summary": "Posts, feeds, replies, likes, reposts, polls, hashtags, per-post privacy, viewers"},
    {"group": "stories", "base": "/stories", "summary": "24h stories, tray, views, replies"},
    {"group": "messaging", "base": "/conversations", "summary": "DMs & groups, media/voice/gif/tip, reactions, presence/typing, read receipts, E2E keys"},
    {"group": "money", "base": "/money", "summary": "P2P send (security question) + accept, request money, pay-by-QR"},
    {"group": "admin", "base": "/admin", "summary": "User management: verify, roles, ban/suspend/remove, audit log (admin only)"},
    {"group": "ads", "base": "/promoted", "summary": "Sponsored serving, impression/click events, campaigns, prepaid ad balance, link ads"},
    {"group": "publisher", "base": "/pub", "summary": "Display OkaySpace ads on your site & earn — sites, customizable embed snippet, public ad serving"},
    {"group": "forms", "base": "/forms", "summary": "Build forms, embed them anywhere (themeable), collect responses, CSV export, submission webhooks"},
    {"group": "factchecks", "base": "/posts/{id}/factchecks", "summary": "Community notes on posts (source required), Helpful/Not-helpful rating, auto-show on consensus"},
    {"group": "hazards", "base": "/hazards", "summary": "Driver hazard reports (Waze-style) — cluster by location, show on consensus, confirm/dismiss"},
    {"group": "games", "base": "/games", "summary": "User-uploaded games + leaderboards; OkaySpace Games SDK (3D engine over Three.js) at /pub/games/sdk.js"},
    {"group": "oauth", "base": "/oauth", "summary": "Login with OkaySpace (OAuth2 provider), apps, connections, revocation"},
    {"group": "webhooks", "base": "/webhooks", "summary": "Developer event webhooks (Pro+) — signed delivery, test pings, 20+ event types"},
    {"group": "payouts", "base": "/payouts", "summary": "Creator payout balance, schedule, history"},
    {"group": "communities", "base": "/communities", "summary": "Reddit-style forums, threads, Hot/New/Top"},
    {"group": "groups", "base": "/groups", "summary": "Public/private groups, posts, members, roles"},
    {"group": "marketplace", "base": "/listings", "summary": "Listings, location/radius search, trade codes, reviews"},
    {"group": "places", "base": "/places", "summary": "Saved places (pins) & recent searches"},
    {"group": "foursquare", "base": "/foursquare", "summary": "Nearby place search & business-profile match (hours, phone, rating)"},
    {"group": "transit", "base": "/transit", "summary": "Real-time public-transit stops, departures & route planning (TransitLand)"},
    {"group": "guides", "base": "/guides", "summary": "Curated place collections, public/cloneable"},
    {"group": "reviews", "base": "/reviews", "summary": "Place reviews (1–5★)"},
    {"group": "eta", "base": "/eta", "summary": "Live ETA shares (+ WebSocket /ws/eta/{id})"},
    {"group": "calls", "base": "/calls", "summary": "Voice/video call room tokens (LiveKit) & ringing"},
    {"group": "circles", "base": "/circles", "summary": "Private friend circles for scoped sharing"},
    {"group": "drafts", "base": "/drafts", "summary": "Saved post drafts"},
    {"group": "roadside", "base": "/roadside", "summary": "Peer roadside assistance — requests, quotes, live status, reviews"},
    {"group": "support", "base": "/support", "summary": "Help-desk tickets & messages"},
    {"group": "push", "base": "/push", "summary": "Push-notification device registration"},
    {"group": "integrations", "base": "/integrations", "summary": "Third-party service connections"},
    {"group": "embed", "base": "/pub", "summary": "Public oEmbed & shareable content cards (posts, profiles, listings, guides, communities)"},
    {"group": "notifications", "base": "/notifications", "summary": "Notification feed, unread counts"},
    {"group": "payments", "base": "/payments", "summary": "Stripe payouts, checkout, webhook (when configured)"},
]


@router.get("/version", response_model=VersionOut)
async def version():
    return {"api": "OkaySpace API", "version": API_VERSION}


# Canonical error contract (§2). Every non-2xx reply uses the envelope below;
# SDKs should switch on `error.code`, never on the human message. Codes never
# change meaning once published — new behaviour gets a new code.
_ERROR_ENVELOPE = {
    "error": {
        "code": "string — stable, machine-readable (switch on this)",
        "message": "string — human-readable, may change",
        "fields": "optional [{field, message}] — present on validation_error",
    },
    "detail": "deprecated mirror of `error`, kept for backwards compatibility",
}

# Default code per HTTP status (mirrors the server's error handler).
_STATUS_CODES = {
    400: "bad_request", 401: "unauthorized", 402: "payment_required",
    403: "forbidden", 404: "not_found", 405: "method_not_allowed",
    409: "conflict", 413: "payload_too_large", 415: "unsupported_media_type",
    422: "validation_error", 429: "rate_limited", 500: "server_error",
    502: "bad_gateway", 503: "unavailable",
}

# Domain-specific codes raised by the app, with the HTTP status each maps to.
_ERROR_CODES = [
    {"code": "validation_error", "http_status": 422, "domain": "request", "description": "Request body/params failed validation; see error.fields."},
    {"code": "unauthorized", "http_status": 401, "domain": "auth", "description": "Missing or invalid credentials."},
    {"code": "forbidden", "http_status": 403, "domain": "auth", "description": "Authenticated but not allowed."},
    {"code": "write_not_allowed", "http_status": 403, "domain": "auth", "description": "Read-only API key used for a write; create a key with the 'write' scope."},
    {"code": "not_found", "http_status": 404, "domain": "request", "description": "Resource does not exist."},
    {"code": "conflict", "http_status": 409, "domain": "request", "description": "State conflict."},
    {"code": "in_progress", "http_status": 409, "domain": "idempotency", "description": "A request with the same Idempotency-Key is still being processed; retry shortly."},
    {"code": "rate_limited", "http_status": 429, "domain": "limits", "description": "Throttled; honor Retry-After / X-RateLimit-* headers."},
    {"code": "quota_exceeded", "http_status": 429, "domain": "limits", "description": "API-key monthly request quota reached; buy a pack or wait for reset."},
    {"code": "insufficient_balance", "http_status": 400, "domain": "wallet", "description": "Wallet balance doesn't cover the amount; top up first."},
    {"code": "test_mode", "http_status": 400, "domain": "payments", "description": "Operation unavailable while test/simulated payments are on."},
    {"code": "recipient_no_account", "http_status": 400, "domain": "payments", "description": "Transfer recipient hasn't set up payments."},
    {"code": "recipient_not_ready", "http_status": 400, "domain": "payments", "description": "Transfer recipient can't receive yet (incomplete payout setup)."},
    {"code": "no_account", "http_status": 400, "domain": "payments", "description": "Caller has no Stripe account; create one first."},
    {"code": "payouts_not_ready", "http_status": 400, "domain": "payments", "description": "Finish payout onboarding before cashing out."},
    {"code": "nothing_to_pay_out", "http_status": 400, "domain": "payments", "description": "No available balance to pay out."},
    {"code": "transfer_failed", "http_status": 400, "domain": "payments", "description": "Stripe rejected the transfer; message has detail."},
    {"code": "payout_failed", "http_status": 400, "domain": "payments", "description": "Stripe rejected the payout; message has detail."},
    {"code": "stripe_account_failed", "http_status": 400, "domain": "payments", "description": "Couldn't create/fetch the Stripe Connect account."},
]


@router.get("/errors", response_model=ErrorsOut)
async def error_registry():
    """The error contract (§2): the canonical envelope and the registry of every
    `error.code` with the HTTP status it maps to. SDKs switch on `code`."""
    return {
        "envelope": _ERROR_ENVELOPE,
        "by_status": {str(k): v for k, v in _STATUS_CODES.items()},
        "codes": _ERROR_CODES,
        "notes": [
            "Switch on error.code, not the human message.",
            "Codes never change meaning once published; new behaviour gets a new code.",
            "`detail` mirrors `error` and is deprecated.",
        ],
    }


@router.get("/v1/info", response_model=InfoOut)
async def info():
    """Machine-readable API overview: version, auth, conventions, capabilities."""
    return {
        "api": "OkaySpace API",
        "version": API_VERSION,
        "base_url": "/api/v1",
        "legacy_base_url": "/api",
        "docs_url": "/docs",
        "openapi_url": "/openapi.json",
        "changelog_url": "/api/v1/changelog",
        "health_url": "/health",
        "group_count": len(CAPABILITIES),
        "auth": {
            "scheme": "bearer",
            "header": "Authorization: Bearer <token>",
            "tokens": ["api_key", "session_token"],
            "how_to_get_a_key": "In-app: Settings → Developer API → Generate",
        },
        "conventions": {
            "content_type": "application/json",
            "errors": "Non-2xx responses use {\"error\":{\"code\",\"message\"}} (mirrored under \"detail\")",
            "rate_limit": "Fair-use; heavy automated traffic may be throttled (429)",
            "pagination": "List endpoints accept ?limit= and ?offset=; some also support cursor (?cursor=, returns next_cursor)",
            "idempotency": "Send 'Idempotency-Key: <unique>' on writes; retries replay the first response",
            "versioned_base": "/api/v1 (stable); /api is a legacy alias",
            "cors": "Open (Access-Control-Allow-Origin: *) so browser & mobile apps can call directly",
        },
        "capabilities": CAPABILITIES,
    }


# Public, machine-readable API changelog. Newest first. Entries describe
# developer-facing API capabilities (not internal app changes), so integrators
# can track what's available. `changelog_url` is exposed from /v1/info too.
CHANGELOG = [
    {
        "date": "2026-06-10",
        "title": "Discovery, tags & multi-language kits",
        "changes": [
            "OpenAPI spec groups endpoints into named, described tags; servers[] always advertised for codegen.",
            "/v1/info capability catalog now lists every resource group.",
            "Added GET /v1/changelog (this endpoint).",
            "Documented the full admin surface and added Swift, Kotlin, Go & Rust client kits in the in-app Developer API reference.",
        ],
    },
    {
        "date": "2026-01-01",
        "title": "API v1 stable",
        "changes": [
            "Stable versioned base /api/v1 (the unversioned /api remains a permanent alias).",
            "Consistent error envelope on every non-2xx: {\"error\":{\"code\",\"message\"}} mirrored under \"detail\".",
            "Idempotency-Key header on writes replays the first response on retry.",
            "OAuth2 authorization-code provider (\"Login with OkaySpace\") with profile/email scopes.",
            "Developer webhooks (signed, 21 event types) with test pings and delivery history.",
            "Read/write API-key scopes; open CORS for browser & mobile callers.",
        ],
    },
]


@router.get("/v1/changelog", response_model=ChangelogOut)
async def changelog():
    """Public, machine-readable API changelog (newest first)."""
    return {"api": "OkaySpace API", "version": API_VERSION, "entries": CHANGELOG}
