"""Map App backend entry point."""
import logging
import os

from fastapi import APIRouter, FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from core import init_pool, logger
from routes import (
    ads as ads_routes,
    auth as auth_routes,
    communities as communities_routes,
    eta as eta_routes,
    foursquare as fsq_routes,
    groups as groups_routes,
    guides as guides_routes,
    marketplace as marketplace_routes,
    messaging as messaging_routes,
    meta as meta_routes,
    notifications as notifications_routes,
    payments as payments_routes,
    payouts as payouts_routes,
    places as places_routes,
    posts as posts_routes,
    reviews as reviews_routes,
    stories as stories_routes,
    users as users_routes,
    webhooks as webhooks_routes,
)

API_VERSION = "1.0.0"

app = FastAPI(
    title="Nami API",
    version=API_VERSION,
    description=(
        "REST API for Nami — social feed, maps & directions, messaging, "
        "communities, marketplace, creator monetization and more.\n\n"
        "**Auth:** send `Authorization: Bearer <API key or session token>` on every "
        "request. Generate API keys in the app under Settings → Developer API.\n\n"
        "All endpoints are under the `/api` prefix. Interactive docs: `/docs` · "
        "OpenAPI schema: `/openapi.json`."
    ),
    contact={"name": "Nami", "url": "https://nampo-web.onrender.com"},
    license_info={"name": "Proprietary"},
)

_origins = os.environ.get("CORS_ORIGINS", "*")
allow_origins = (
    ["*"] if _origins.strip() == "*"
    else [o.strip() for o in _origins.split(",") if o.strip()]
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)

from starlette.requests import Request as _Req
from starlette.responses import JSONResponse as _JSON
from core import db as _db


@app.middleware("http")
async def enforce_api_key_scopes(request: _Req, call_next):
    """Read-only API keys may only call safe (GET/HEAD/OPTIONS) methods.
    Returns a structured 403 so client code can branch on the error `code`."""
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer "):
            token = auth.split(" ", 1)[1].strip()
            try:
                sess = await _db.user_sessions.find_one(
                    {"session_token": token}, {"_id": 0, "kind": 1, "scopes": 1}
                )
            except Exception:
                sess = None
            if sess and sess.get("kind") == "api_key" and "write" not in (sess.get("scopes") or []):
                return _JSON(
                    status_code=403,
                    content={"detail": {
                        "code": "write_not_allowed",
                        "message": "This API key is read-only. Create a key with the 'write' scope (Pro plan or higher).",
                    }},
                )
    return await call_next(request)


@app.get("/")
async def root():
    return {"status": "ok", "app": "Nami App API"}

@app.get("/health")
async def health():
    return {"status": "ok"}


api_router = APIRouter(prefix="/api")
api_router.include_router(meta_routes.router)
api_router.include_router(auth_routes.router)
api_router.include_router(users_routes.router)
api_router.include_router(places_routes.router)
api_router.include_router(guides_routes.router)
api_router.include_router(reviews_routes.router)
api_router.include_router(messaging_routes.router)
api_router.include_router(notifications_routes.router)
api_router.include_router(eta_routes.router)
api_router.include_router(posts_routes.router)
api_router.include_router(marketplace_routes.router)
api_router.include_router(groups_routes.router)
api_router.include_router(communities_routes.router)
api_router.include_router(fsq_routes.router)
api_router.include_router(stories_routes.router)
api_router.include_router(payments_routes.router)
api_router.include_router(webhooks_routes.router)
api_router.include_router(ads_routes.router)
api_router.include_router(payouts_routes.router)

app.include_router(api_router)


@app.websocket("/api/ws/eta/{share_id}")
async def _ws_eta(websocket: WebSocket, share_id: str):
    await eta_routes.ws_eta(websocket, share_id)


@app.on_event("startup")
async def startup():
    await init_pool()
    payouts_routes.start_scheduler()   # hourly auto-payout loop (best-effort)
    logger.info("Startup complete")
