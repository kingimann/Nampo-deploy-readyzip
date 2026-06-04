"""Map App backend entry point.

Composes the modular routers under /api and registers WebSocket + startup hooks.
"""
import logging
import os

from fastapi import APIRouter, FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from core import client, db, logger
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

# CORS — set CORS_ORIGINS in env to a comma-separated list of allowed origins.
# Defaults to "*" so the Expo app / web build can reach the API out of the box.
_origins = os.environ.get("CORS_ORIGINS", "*")
allow_origins = ["*"] if _origins.strip() == "*" else [o.strip() for o in _origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    """Liveness probe for AWS App Runner / load balancers."""
    return {"status": "ok"}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)

api_router = APIRouter(prefix="/api")
# Order chosen so static path prefixes resolve cleanly.
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
async def startup_indexes():
    await db.users.create_index("email", unique=True)
    await db.users.create_index("user_id", unique=True)
    await db.users.create_index("username", unique=True, sparse=True)
    await db.post_views.create_index([("post_id", 1), ("user_id", 1)], unique=True)
    await db.post_views.create_index("post_id")
    await db.user_sessions.create_index("session_token", unique=True)
    await db.user_sessions.create_index("user_id")
    await db.user_sessions.create_index("expires_at", expireAfterSeconds=0)
    await db.places.create_index("user_id")
    await db.recents.create_index("user_id")
    await db.guides.create_index("user_id")
    await db.guides.create_index("slug", unique=True, sparse=True)
    await db.reviews.create_index("place_key")
    await db.reviews.create_index([("user_id", 1), ("place_key", 1)], unique=True)
    await db.conversations.create_index("key", unique=True)
    await db.conversations.create_index("participant_ids")
    await db.messages.create_index([("conversation_id", 1), ("created_at", 1)])
    await db.eta_shares.create_index("share_id", unique=True)
    await db.eta_shares.create_index("user_id")
    await db.eta_shares.create_index("expires_at", expireAfterSeconds=0)
    await db.posts.create_index([("created_at", -1)])
    await db.posts.create_index("user_id")
    await db.posts.create_index("parent_id")
    await db.posts.create_index("repost_of")
    await db.posts.create_index("quote_of")
    await db.posts.create_index("hashtags")
    await db.posts.create_index([("group_id", 1), ("created_at", -1)], sparse=True)
    await db.poll_votes.create_index([("post_id", 1), ("user_id", 1)], unique=True)
    await db.link_previews.create_index("url", unique=True)
    await db.post_likes.create_index([("post_id", 1), ("user_id", 1)], unique=True)
    await db.post_likes.create_index("post_id")
    await db.post_bookmarks.create_index([("post_id", 1), ("user_id", 1)], unique=True)
    await db.post_bookmarks.create_index([("user_id", 1), ("created_at", -1)])
    await db.follows.create_index([("follower_id", 1), ("followee_id", 1)], unique=True)
    await db.follows.create_index("followee_id")
    await db.listings.create_index([("created_at", -1)])
    await db.listings.create_index("user_id")
    await db.listings.create_index("category")
    await db.listings.create_index("status")
    await db.groups.create_index([("created_at", -1)])
    await db.groups.create_index("owner_id")
    await db.group_members.create_index([("group_id", 1), ("user_id", 1)], unique=True)
    await db.group_members.create_index("user_id")
    await db.group_join_requests.create_index([("group_id", 1), ("user_id", 1)], unique=True)
    await db.group_join_requests.create_index([("group_id", 1), ("status", 1), ("created_at", 1)])
    # Stories — TTL index auto-deletes expired stories
    await db.stories.create_index("expires_at", expireAfterSeconds=0)
    await db.stories.create_index([("user_id", 1), ("created_at", -1)])
    await db.story_views.create_index([("story_id", 1), ("viewer_id", 1)], unique=True)
    await db.story_views.create_index([("story_id", 1), ("viewed_at", -1)])
    # Friends — symmetric pair (a < b lexicographically)
    await db.friendships.create_index([("a", 1), ("b", 1)], unique=True)
    await db.friendships.create_index("b")
    await db.friend_requests.create_index([("from_id", 1), ("to_id", 1)], unique=True)
    await db.friend_requests.create_index([("to_id", 1), ("status", 1), ("created_at", -1)])
    await db.group_posts.create_index([("group_id", 1), ("created_at", -1)])
    await db.notifications.create_index([("user_id", 1), ("created_at", -1)])
    await db.notifications.create_index([("user_id", 1), ("read", 1)])
    logger.info("MongoDB indexes ready")


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
