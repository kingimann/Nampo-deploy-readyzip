"""API meta endpoints — version + machine-readable capability info for developers."""
from fastapi import APIRouter

router = APIRouter()

API_VERSION = "1.0.0"

# High-level catalog of what the API exposes (handy for clients / dashboards).
CAPABILITIES = [
    {"group": "auth", "base": "/auth", "summary": "Register, login, profile, API keys, policies"},
    {"group": "users", "base": "/users", "summary": "Search, public profiles, follow/friends, pokes, tips, subscriptions (tiers)"},
    {"group": "posts", "base": "/posts", "summary": "Posts, feeds, replies, likes, reposts, polls, hashtags, per-post privacy, viewers"},
    {"group": "stories", "base": "/stories", "summary": "24h stories, tray, views, replies"},
    {"group": "messaging", "base": "/conversations", "summary": "DMs & groups, media/voice/gif/tip, reactions, presence/typing, read receipts, E2E keys"},
    {"group": "money", "base": "/money", "summary": "Peer-to-peer send (security question) & request money"},
    {"group": "ads", "base": "/ads", "summary": "Sponsored serving, impression/click events, campaigns, prepaid ad balance, link ads"},
    {"group": "publisher", "base": "/pub", "summary": "Display Nami ads on your site & earn — sites, embed snippet, public ad serving"},
    {"group": "oauth", "base": "/oauth", "summary": "Login with Nami (OAuth2 provider), apps, connections, revocation"},
    {"group": "webhooks", "base": "/webhooks", "summary": "Developer event webhooks (Pro+)"},
    {"group": "payouts", "base": "/payouts", "summary": "Creator payout balance, schedule, history"},
    {"group": "communities", "base": "/communities", "summary": "Reddit-style forums, threads, Hot/New/Top"},
    {"group": "groups", "base": "/groups", "summary": "Public/private groups, posts, members, roles"},
    {"group": "marketplace", "base": "/listings", "summary": "Listings, location/radius search, trade codes, reviews"},
    {"group": "places", "base": "/places", "summary": "Saved places & recent searches"},
    {"group": "guides", "base": "/guides", "summary": "Curated place collections, public/cloneable"},
    {"group": "reviews", "base": "/reviews", "summary": "Place reviews (1–5★)"},
    {"group": "eta", "base": "/eta", "summary": "Live ETA shares (+ WebSocket /ws/eta/{id})"},
    {"group": "notifications", "base": "/notifications", "summary": "Notification feed, unread counts"},
    {"group": "payments", "base": "/payments", "summary": "Stripe payouts, checkout, webhook (when configured)"},
]


@router.get("/version")
async def version():
    return {"api": "Nami API", "version": API_VERSION}


@router.get("/v1/info")
async def info():
    """Machine-readable API overview: version, auth, conventions, capabilities."""
    return {
        "api": "Nami API",
        "version": API_VERSION,
        "base_url": "/api",
        "docs_url": "/docs",
        "openapi_url": "/openapi.json",
        "auth": {
            "scheme": "bearer",
            "header": "Authorization: Bearer <token>",
            "tokens": ["api_key", "session_token"],
            "how_to_get_a_key": "In-app: Settings → Developer API → Generate",
        },
        "conventions": {
            "content_type": "application/json",
            "errors": "Non-2xx responses return {\"detail\": \"message\"}",
            "rate_limit": "Fair-use; heavy automated traffic may be throttled",
            "pagination": "List endpoints accept ?limit= and ?offset= where applicable",
        },
        "capabilities": CAPABILITIES,
    }
