"""API meta endpoints — version + machine-readable capability info for developers."""
from fastapi import APIRouter

from core import db

router = APIRouter()


@router.get("/public/app-config")
async def public_app_config():
    """Public client config read at app load (no auth) — e.g. the mobile-only gate."""
    try:
        doc = await db.app_settings.find_one({"key": "mobile_only"}, {"_id": 0, "value": 1})
        mobile_only = bool(doc and doc.get("value"))
    except Exception:
        mobile_only = False
    return {"mobile_only": mobile_only}

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


@router.get("/version")
async def version():
    return {"api": "OkaySpace API", "version": API_VERSION}


@router.get("/v1/info")
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


@router.get("/v1/changelog")
async def changelog():
    """Public, machine-readable API changelog (newest first)."""
    return {"api": "OkaySpace API", "version": API_VERSION, "entries": CHANGELOG}
