"""Map App backend entry point."""
import hashlib
import logging
import os
import time

from fastapi import APIRouter, FastAPI, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from starlette.exceptions import HTTPException as StarletteHTTPException

from core import init_pool, logger
from routes import (
    adnetwork as adnetwork_routes,
    ads as ads_routes,
    auth as auth_routes,
    calls as calls_routes,
    communities as communities_routes,
    drafts as drafts_routes,
    embed as embed_routes,
    eta as eta_routes,
    forms as forms_routes,
    foursquare as fsq_routes,
    groups as groups_routes,
    guides as guides_routes,
    integrations as integrations_routes,
    marketplace as marketplace_routes,
    messaging as messaging_routes,
    meta as meta_routes,
    money as money_routes,
    notifications as notifications_routes,
    oauth as oauth_routes,
    payments as payments_routes,
    payouts as payouts_routes,
    places as places_routes,
    posts as posts_routes,
    push as push_routes,
    render_admin as render_admin_routes,
    reviews as reviews_routes,
    roadside as roadside_routes,
    stories as stories_routes,
    support as support_routes,
    transit as transit_routes,
    users as users_routes,
    webhooks as webhooks_routes,
    factchecks as factchecks_routes,
    hazards as hazards_routes,
    games as games_routes,
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
from starlette.responses import JSONResponse as _JSON, Response as _Resp
from core import db as _db


# ── Consistent error envelope ────────────────────────────────────────────────
# Every non-2xx reply uses one shape so any client parses errors the same way:
#   { "error": { "code", "message", ... }, "detail": { "code", "message", ... } }
# `detail` is kept (and always structured) for backwards compatibility.
_ERR_CODES = {
    400: "bad_request", 401: "unauthorized", 402: "payment_required",
    403: "forbidden", 404: "not_found", 405: "method_not_allowed",
    409: "conflict", 413: "payload_too_large", 415: "unsupported_media_type",
    422: "validation_error", 429: "rate_limited", 500: "server_error",
    502: "bad_gateway", 503: "unavailable",
}


def _err_body(status, code, message, extra=None):
    err = {"code": code, "message": message}
    if extra:
        err.update(extra)
    return {"error": err, "detail": err}


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
                    content=_err_body(
                        403, "write_not_allowed",
                        "This API key is read-only. Create a key with the 'write' scope (Pro plan or higher).",
                    ),
                )
    return await call_next(request)


# ── Idempotency keys ─────────────────────────────────────────────────────────
# A client may send `Idempotency-Key: <unique>` on any write (POST/PUT/PATCH/
# DELETE). The first call runs normally and we cache the response; retries with
# the same key (scoped to the caller) replay that exact response instead of
# re-running the operation — so a flaky network can't double-post or double-pay.
# In-memory (single instance), 24h TTL.
_IDEMP: dict = {}
_IDEMP_TTL = 86400.0
_IDEMP_MAX = 5000


@app.middleware("http")
async def idempotency(request: _Req, call_next):
    key = request.headers.get("idempotency-key") if request.method in ("POST", "PUT", "PATCH", "DELETE") else None
    if not key:
        return await call_next(request)
    # Scope the key to the caller so two users can't collide. Hash the full
    # Authorization header — slicing the last N chars let distinct tokens that
    # share a trailing slice collide and be served each other's cached response.
    auth = request.headers.get("authorization", "")
    scope = hashlib.sha256(auth.encode()).hexdigest() if auth else ""
    ck = f"{scope}|{request.method}|{request.url.path}|{key[:200]}"
    now = time.time()
    hit = _IDEMP.get(ck)
    if hit and now - hit["ts"] < _IDEMP_TTL:
        headers = dict(hit["headers"]); headers["Idempotent-Replay"] = "true"
        return _Resp(content=hit["body"], status_code=hit["status"], headers=headers)
    resp = await call_next(request)
    # Cache only final (non server-error) responses so transient 5xx can retry.
    if resp.status_code < 500:
        body = b""
        async for chunk in resp.body_iterator:
            body += chunk
        headers = {k: v for k, v in resp.headers.items() if k.lower() != "content-length"}
        if len(_IDEMP) >= _IDEMP_MAX:
            for k2 in [k for k, v in list(_IDEMP.items()) if now - v["ts"] > _IDEMP_TTL]:
                _IDEMP.pop(k2, None)
            if len(_IDEMP) >= _IDEMP_MAX:
                _IDEMP.clear()
        _IDEMP[ck] = {"status": resp.status_code, "body": body, "headers": headers, "ts": now}
        return _Resp(content=body, status_code=resp.status_code, headers=headers,
                     background=getattr(resp, "background", None))
    return resp


@app.exception_handler(StarletteHTTPException)
async def _on_http_exc(request: Request, exc: StarletteHTTPException):
    d = exc.detail
    if isinstance(d, dict):
        code = d.get("code") or _ERR_CODES.get(exc.status_code, f"http_{exc.status_code}")
        message = d.get("message") or d.get("detail") or _ERR_CODES.get(exc.status_code, "error")
        extra = {k: v for k, v in d.items() if k not in ("code", "message")} or None
    else:
        code = _ERR_CODES.get(exc.status_code, f"http_{exc.status_code}")
        message = str(d) if d not in (None, "") else _ERR_CODES.get(exc.status_code, "error")
        extra = None
    return _JSON(
        status_code=exc.status_code,
        content=_err_body(exc.status_code, code, message, extra),
        headers=getattr(exc, "headers", None),
    )


@app.exception_handler(RequestValidationError)
async def _on_validation_exc(request: Request, exc: RequestValidationError):
    fields = []
    for e in exc.errors():
        loc = ".".join(str(x) for x in e.get("loc", []) if x != "body")
        fields.append({"field": loc or "body", "message": e.get("msg", "invalid")})
    summary = "; ".join(f"{f['field']}: {f['message']}" for f in fields[:6]) or "Invalid request"
    return _JSON(
        status_code=422,
        content=_err_body(422, "validation_error", f"Request validation failed — {summary}", {"fields": fields}),
    )


@app.get("/")
async def root():
    return {"status": "ok", "app": "Nami App API"}

@app.get("/health")
async def health():
    return {"status": "ok"}


def _register(parent: APIRouter):
    parent.include_router(meta_routes.router)
    parent.include_router(auth_routes.router)
    parent.include_router(users_routes.router)
    parent.include_router(places_routes.router)
    parent.include_router(guides_routes.router)
    parent.include_router(reviews_routes.router)
    parent.include_router(messaging_routes.router)
    parent.include_router(notifications_routes.router)
    parent.include_router(eta_routes.router)
    parent.include_router(posts_routes.router)
    parent.include_router(drafts_routes.router)
    parent.include_router(marketplace_routes.router)
    parent.include_router(groups_routes.router)
    parent.include_router(communities_routes.router)
    parent.include_router(fsq_routes.router)
    parent.include_router(stories_routes.router)
    parent.include_router(payments_routes.router)
    parent.include_router(webhooks_routes.router)
    parent.include_router(ads_routes.router)
    parent.include_router(adnetwork_routes.router)
    parent.include_router(payouts_routes.router)
    parent.include_router(oauth_routes.router)
    parent.include_router(money_routes.router)
    parent.include_router(transit_routes.router)
    parent.include_router(integrations_routes.router)
    parent.include_router(calls_routes.router)
    parent.include_router(push_routes.router)
    parent.include_router(roadside_routes.router)
    parent.include_router(support_routes.router)
    parent.include_router(forms_routes.router)
    parent.include_router(factchecks_routes.router)
    parent.include_router(hazards_routes.router)
    parent.include_router(games_routes.router)
    parent.include_router(embed_routes.router)
    parent.include_router(render_admin_routes.router)


# `/api/v1` is the documented, stable base. `/api` stays as a back-compat alias
# (hidden from the OpenAPI schema so the docs present a single, versioned API).
_v1_router = APIRouter(prefix="/api/v1")
_register(_v1_router)
app.include_router(_v1_router)

_legacy_router = APIRouter(prefix="/api")
_register(_legacy_router)
app.include_router(_legacy_router, include_in_schema=False)


def _custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(
        title=app.title, version=API_VERSION, description=app.description, routes=app.routes,
    )
    comps = schema.setdefault("components", {})
    comps.setdefault("securitySchemes", {})["BearerAuth"] = {
        "type": "http", "scheme": "bearer", "bearerFormat": "Token",
        "description": (
            "Send `Authorization: Bearer <API key or session token>` on every request. "
            "Create API keys in the app under Settings → Developer API."
        ),
    }
    schema["security"] = [{"BearerAuth": []}]
    base = os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")
    if base:
        schema["servers"] = [
            {"url": f"{base}/api/v1", "description": "Production · v1"},
            {"url": f"{base}/api", "description": "Production · unversioned (legacy)"},
        ]
    app.openapi_schema = schema
    return schema


app.openapi = _custom_openapi


@app.websocket("/api/ws/eta/{share_id}")
async def _ws_eta(websocket: WebSocket, share_id: str):
    await eta_routes.ws_eta(websocket, share_id)


@app.websocket("/api/v1/ws/eta/{share_id}")
async def _ws_eta_v1(websocket: WebSocket, share_id: str):
    await eta_routes.ws_eta(websocket, share_id)


async def _keepalive_loop():
    """Ping our own /health every ~10 min so Render's free tier doesn't spin the
    service down (which causes slow 30-60s cold-start logins). No-op locally."""
    import asyncio
    import httpx
    base = os.environ.get("RENDER_EXTERNAL_URL", "")
    if not base:
        return
    url = base.rstrip("/") + "/health"
    while True:
        await asyncio.sleep(600)
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                await c.get(url)
        except Exception:
            pass


@app.on_event("startup")
async def startup():
    import asyncio
    await init_pool()
    payouts_routes.start_scheduler()   # hourly auto-payout loop (best-effort)
    try:
        asyncio.create_task(_keepalive_loop())   # keep the free instance warm
    except Exception:
        pass
    try:
        from services.claude_bot import start_bot
        start_bot()                               # @claude replies in-app (if API key set)
    except Exception:
        pass
    try:
        asyncio.create_task(_backfill_avatars())  # give pictureless users a default avatar (one-time)
    except Exception:
        pass
    logger.info("Startup complete")


async def _backfill_avatars():
    """One-time: give every existing user without a profile picture a default
    avatar. Idempotent and flagged so it only does work once."""
    try:
        from core import db, random_default_avatar
        done = await db.app_settings.find_one({"key": "avatars_backfilled"}, {"_id": 0, "value": 1})
        if done and done.get("value"):
            return
        users = await db.users.find({}, {"_id": 0, "user_id": 1, "username": 1, "picture": 1}).to_list(100000)
        n = 0
        for u in users:
            if not u.get("picture"):
                await db.users.update_one(
                    {"user_id": u["user_id"]},
                    {"$set": {"picture": random_default_avatar(u.get("username") or u["user_id"])}},
                )
                n += 1
        if done:
            await db.app_settings.update_one({"key": "avatars_backfilled"}, {"$set": {"value": True}})
        else:
            await db.app_settings.insert_one({"key": "avatars_backfilled", "value": True})
        logger.info("Avatar backfill complete (%d users updated)", n)
    except Exception as e:
        logger.warning("Avatar backfill skipped: %s", e)
