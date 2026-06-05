"""Map App backend entry point."""
import logging
import os

from fastapi import APIRouter, FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from core import init_pool, logger
from routes import (
    auth as auth_routes,
    eta as eta_routes,
    foursquare as fsq_routes,
    groups as groups_routes,
    guides as guides_routes,
    marketplace as marketplace_routes,
    messaging as messaging_routes,
    notifications as notifications_routes,
    places as places_routes,
    posts as posts_routes,
    reviews as reviews_routes,
    stories as stories_routes,
    users as users_routes,
)

app = FastAPI()

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


@app.get("/")
async def root():
    return {"status": "ok", "app": "Nami App API"}

@app.get("/health")
async def health():
    return {"status": "ok"}


api_router = APIRouter(prefix="/api")
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
api_router.include_router(fsq_routes.router)
api_router.include_router(stories_routes.router)

app.include_router(api_router)


@app.websocket("/api/ws/eta/{share_id}")
async def _ws_eta(websocket: WebSocket, share_id: str):
    await eta_routes.ws_eta(websocket, share_id)


@app.on_event("startup")
async def startup():
    await init_pool()
    logger.info("Startup complete")
