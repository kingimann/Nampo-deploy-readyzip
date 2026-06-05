"""Auth endpoints (Google OAuth + custom email/password) and user profile updates."""
import os
import re
import secrets
import time
from datetime import datetime, timezone, timedelta
from typing import Optional
from urllib.parse import urlencode, urlparse
import uuid

import bcrypt
import httpx
from email_validator import EmailNotValidError, validate_email
from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from db import DuplicateKeyError

from core import (
    _norm_dt,
    _user_doc_to_model,
    db,
    get_current_user,
)
from models import AuthResponse, ProfilePatch, User

router = APIRouter()

USERNAME_RE = re.compile(r"^[a-z0-9_]{3,20}$")
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_MINUTES = 15

# ---------------------------------------------------------------------------
# Google OAuth 2.0 / OpenID Connect
# ---------------------------------------------------------------------------
GOOGLE_DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration"
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")

_google_cfg_cache: dict = {"data": None, "exp": 0.0}


def _public_base_url() -> str:
    """The externally reachable https origin for this deployment (dev or prod)."""
    # Explicit override first, then Render's auto-provided URL, then Replit (legacy).
    explicit = (os.environ.get("PUBLIC_BASE_URL") or "").strip()
    if explicit:
        return explicit.rstrip("/")
    render_url = (os.environ.get("RENDER_EXTERNAL_URL") or "").strip()
    if render_url:
        return render_url.rstrip("/")
    domains = os.environ.get("REPLIT_DOMAINS") or os.environ.get("REPLIT_DEV_DOMAIN") or ""
    host = domains.split(",")[0].strip()
    return f"https://{host}" if host else ""


def _google_redirect_uri() -> str:
    return f"{_public_base_url()}/api/auth/google/callback"


async def _google_config() -> dict:
    now = time.time()
    if _google_cfg_cache["data"] and _google_cfg_cache["exp"] > now:
        return _google_cfg_cache["data"]
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(GOOGLE_DISCOVERY_URL)
        resp.raise_for_status()
        data = resp.json()
    _google_cfg_cache["data"] = data
    _google_cfg_cache["exp"] = now + 3600
    return data


# Native app deep-link schemes we trust for post-auth redirects. "atlas" is the
# standalone app scheme (app.json); "exp"/"exps" cover Expo Go dev clients.
_ALLOWED_NATIVE_SCHEMES = {"atlas", "exp", "exps"}


def _allowed_redirect_hosts() -> set:
    """Hosts we will redirect back to after OAuth: our own origin plus any
    configured frontend origins. In a split deploy the web app is served from a
    different host than the API (e.g. nampo-web vs nampo-backend), so the web
    origin must be whitelisted via OAUTH_REDIRECT_ORIGINS."""
    hosts = set()
    our = urlparse(_public_base_url()).netloc
    if our:
        hosts.add(our)
    for o in (os.environ.get("OAUTH_REDIRECT_ORIGINS") or "").split(","):
        o = o.strip()
        if o:
            hosts.add(urlparse(o).netloc or o)
    return hosts


def _validate_redirect(target: str) -> str:
    """Return a safe post-auth redirect target. Prevents open-redirect/token
    exfiltration by allowing only whitelisted https origins or known native
    schemes; anything else falls back to our default origin."""
    default = _public_base_url() + "/"
    if not target:
        return default
    try:
        parsed = urlparse(target)
    except Exception:
        return default
    scheme = (parsed.scheme or "").lower()
    if scheme == "https":
        if parsed.netloc and parsed.netloc in _allowed_redirect_hosts():
            return target
        return default
    if scheme in _ALLOWED_NATIVE_SCHEMES or scheme.startswith("exp+"):
        return target
    return default


async def _store_oauth_state(redirect: str) -> str:
    """Persist a one-time, random CSRF state (shared DB so it survives across
    autoscale instances between /login and /callback)."""
    state = secrets.token_urlsafe(24)
    await db.oauth_states.insert_one({
        "state": state,
        "redirect": redirect,
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
        "created_at": datetime.now(timezone.utc),
    })
    return state


async def _consume_oauth_state(state: str) -> Optional[str]:
    """Validate and single-use-consume a state. Returns the stored (already
    validated) redirect target, or None if the state is missing/expired/forged."""
    if not state:
        return None
    doc = await db.oauth_states.find_one({"state": state})
    if not doc:
        return None
    await db.oauth_states.delete_one({"state": state})  # one-time use
    try:
        if _norm_dt(doc["expires_at"]) < datetime.now(timezone.utc):
            return None
    except Exception:
        return None
    return doc.get("redirect") or (_public_base_url() + "/")


class RegisterRequest(BaseModel):
    email: str
    password: str
    name: str
    username: str


class LoginRequest(BaseModel):
    identifier: str  # email OR username
    password: str


class UsernameUpdate(BaseModel):
    username: str


def _hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8")[:72], bcrypt.gensalt(rounds=12)).decode("utf-8")


def _verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8")[:72], hashed.encode("utf-8"))
    except Exception:
        return False


def _validate_username(u: str) -> str:
    u = (u or "").strip().lower()
    if not USERNAME_RE.match(u):
        raise HTTPException(
            status_code=400,
            detail="Username must be 3-20 chars, lowercase a-z, 0-9, underscore",
        )
    return u


async def _mint_session(user_id: str) -> str:
    token = f"sess_{secrets.token_urlsafe(32)}"
    await db.user_sessions.insert_one({
        "session_token": token,
        "user_id": user_id,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=30),
        "created_at": datetime.now(timezone.utc),
    })
    return token


@router.get("/")
async def root():
    return {"message": "Map App API"}


async def _upsert_google_user(email: str, name: str, picture: Optional[str]) -> dict:
    user_doc = await db.users.find_one({"email": email})
    if not user_doc:
        user_id = f"user_{uuid.uuid4().hex[:12]}"
        try:
            await db.users.insert_one({
                "user_id": user_id, "email": email, "name": name,
                "username": None, "picture": picture, "bio": "",
                "hashed_password": None,
                "auth_providers": ["google"],
                "failed_login_attempts": 0, "locked_until": None,
                "created_at": datetime.now(timezone.utc),
            })
        except DuplicateKeyError:
            user_doc = await db.users.find_one({"email": email})
        else:
            user_doc = await db.users.find_one({"user_id": user_id})
    else:
        upd = {}
        if picture and not user_doc.get("picture"):
            upd["picture"] = picture
        providers = user_doc.get("auth_providers") or []
        if "google" not in providers:
            upd["auth_providers"] = providers + ["google"]
        if upd:
            await db.users.update_one({"user_id": user_doc["user_id"]}, {"$set": upd})
            user_doc = await db.users.find_one({"user_id": user_doc["user_id"]})
    return user_doc


@router.get("/auth/google/login")
async def google_login(redirect: str = ""):
    """Start the Google OAuth flow. Redirects the browser to Google's consent screen."""
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured")
    cfg = await _google_config()
    safe_redirect = _validate_redirect(redirect)
    state = await _store_oauth_state(safe_redirect)
    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": _google_redirect_uri(),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "access_type": "online",
        "prompt": "select_account",
    }
    return RedirectResponse(cfg["authorization_endpoint"] + "?" + urlencode(params))


def _final_redirect(target: str, fragment: str) -> RedirectResponse:
    base = target or (_public_base_url() + "/")
    sep = "&" if "#" in base else "#"
    return RedirectResponse(f"{base}{sep}{fragment}")


@router.get("/auth/google/callback")
async def google_callback(code: str = "", state: str = "", error: str = ""):
    """Google redirects here with an auth code. Exchange it, upsert the user, and
    bounce back to the frontend with a freshly minted session token in the URL fragment."""
    stored = await _consume_oauth_state(state)
    if stored is None:
        # Missing/expired/forged state -> never honor a client-supplied target.
        return _final_redirect(_public_base_url() + "/", "auth_error=state")
    target = _validate_redirect(stored)  # defense in depth
    if error or not code:
        return _final_redirect(target, "auth_error=1")
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        return _final_redirect(target, "auth_error=not_configured")

    try:
        cfg = await _google_config()
        async with httpx.AsyncClient(timeout=15) as client:
            token_resp = await client.post(
                cfg["token_endpoint"],
                data={
                    "code": code,
                    "client_id": GOOGLE_CLIENT_ID,
                    "client_secret": GOOGLE_CLIENT_SECRET,
                    "redirect_uri": _google_redirect_uri(),
                    "grant_type": "authorization_code",
                },
            )
            token_resp.raise_for_status()
            access_token = token_resp.json().get("access_token")
            if not access_token:
                return _final_redirect(target, "auth_error=token")
            ui_resp = await client.get(
                cfg["userinfo_endpoint"],
                headers={"Authorization": f"Bearer {access_token}"},
            )
            ui_resp.raise_for_status()
            info = ui_resp.json()
    except Exception:
        return _final_redirect(target, "auth_error=exchange")

    if not info.get("email_verified", True):
        return _final_redirect(target, "auth_error=unverified")
    email = (info.get("email") or "").strip().lower()
    if not email:
        return _final_redirect(target, "auth_error=no_email")
    name = (info.get("name") or info.get("given_name") or email.split("@")[0]).strip()[:80]
    picture = info.get("picture")

    user_doc = await _upsert_google_user(email, name, picture)
    token = await _mint_session(user_doc["user_id"])
    return _final_redirect(target, f"session_token={token}")


@router.get("/auth/me", response_model=User)
async def me(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    return User(**_user_doc_to_model(user))


@router.patch("/auth/me", response_model=User)
async def update_me(body: ProfilePatch, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    patch = {}
    if body.name is not None and body.name.strip():
        patch["name"] = body.name.strip()[:80]
    if body.bio is not None:
        patch["bio"] = body.bio.strip()[:280]
    if body.picture is not None:
        patch["picture"] = body.picture
    for k in ("home_name", "home_longitude", "home_latitude",
              "work_name", "work_longitude", "work_latitude"):
        v = getattr(body, k)
        if v is not None:
            patch[k] = v
    if patch:
        await db.users.update_one({"user_id": user["user_id"]}, {"$set": patch})
    updated = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})
    return User(**_user_doc_to_model(updated))


@router.post("/auth/logout")
async def logout(authorization: Optional[str] = Header(None)):
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ", 1)[1].strip()
        await db.user_sessions.delete_one({"session_token": token})
    return {"ok": True}


@router.post("/auth/register", response_model=AuthResponse)
async def register(body: RegisterRequest):
    # Validate email + password
    try:
        v = validate_email(body.email, check_deliverability=False)
        email = v.normalized.lower()
    except EmailNotValidError:
        raise HTTPException(status_code=400, detail="Invalid email")
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    if len(body.password) > 128:
        raise HTTPException(status_code=400, detail="Password too long")
    username = _validate_username(body.username)
    name = (body.name or "").strip()[:80]
    if not name:
        raise HTTPException(status_code=400, detail="Name required")

    if await db.users.find_one({"email": email}, {"_id": 0, "user_id": 1}):
        raise HTTPException(status_code=400, detail="Email already registered")
    if await db.users.find_one({"username": username}, {"_id": 0, "user_id": 1}):
        raise HTTPException(status_code=400, detail="Username taken")

    user_id = f"user_{uuid.uuid4().hex[:12]}"
    try:
        await db.users.insert_one({
            "user_id": user_id, "email": email, "username": username, "name": name,
            "picture": None, "bio": "",
            "hashed_password": _hash_password(body.password),
            "auth_providers": ["local"],
            "failed_login_attempts": 0, "locked_until": None,
            "created_at": datetime.now(timezone.utc),
        })
    except DuplicateKeyError:
        raise HTTPException(status_code=400, detail="Email or username taken")
    token = await _mint_session(user_id)
    user_doc = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    return AuthResponse(session_token=token, user=User(**_user_doc_to_model(user_doc)))


@router.post("/auth/login", response_model=AuthResponse)
async def login(body: LoginRequest):
    ident = (body.identifier or "").strip().lower()
    if not ident:
        raise HTTPException(status_code=400, detail="Identifier required")
    user_doc = await db.users.find_one(
        {"$or": [{"email": ident}, {"username": ident}]}, {"_id": 0}
    )
    if not user_doc or not user_doc.get("hashed_password"):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    now = datetime.now(timezone.utc)
    locked_until = user_doc.get("locked_until")
    if locked_until:
        lu = locked_until.replace(tzinfo=locked_until.tzinfo or timezone.utc) \
             if isinstance(locked_until, datetime) else None
        if lu and lu > now:
            raise HTTPException(status_code=423, detail="Account locked. Try later.")
    if not _verify_password(body.password, user_doc["hashed_password"]):
        fails = int(user_doc.get("failed_login_attempts", 0)) + 1
        upd = {"failed_login_attempts": fails}
        if fails >= MAX_FAILED_ATTEMPTS:
            upd["locked_until"] = now + timedelta(minutes=LOCKOUT_MINUTES)
        await db.users.update_one({"user_id": user_doc["user_id"]}, {"$set": upd})
        raise HTTPException(status_code=401, detail="Invalid credentials")
    await db.users.update_one(
        {"user_id": user_doc["user_id"]},
        {"$set": {"failed_login_attempts": 0, "locked_until": None}},
    )
    token = await _mint_session(user_doc["user_id"])
    return AuthResponse(session_token=token, user=User(**_user_doc_to_model(user_doc)))


@router.get("/auth/username-available")
async def username_available(u: str):
    try:
        username = _validate_username(u)
    except HTTPException:
        return {"available": False, "reason": "invalid"}
    existing = await db.users.find_one({"username": username}, {"_id": 0, "user_id": 1})
    return {"available": not existing}


@router.post("/auth/username", response_model=User)
async def set_username(body: UsernameUpdate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    username = _validate_username(body.username)
    current = user.get("username") or ""
    # No-op if unchanged.
    if username == current:
        updated = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})
        return User(**_user_doc_to_model(updated))
    # Usernames can only be changed once every 30 days (display name is free).
    changed_at = user.get("username_changed_at")
    if current and changed_at:
        try:
            delta = datetime.now(timezone.utc) - changed_at
            if delta < timedelta(days=30):
                days_left = max(1, 30 - delta.days)
                raise HTTPException(
                    status_code=429,
                    detail=f"You can change your username again in {days_left} day(s).",
                )
        except HTTPException:
            raise
        except Exception:
            pass
    existing = await db.users.find_one(
        {"username": username, "user_id": {"$ne": user["user_id"]}}, {"_id": 0, "user_id": 1}
    )
    if existing:
        raise HTTPException(status_code=400, detail="Username taken")
    await db.users.update_one(
        {"user_id": user["user_id"]},
        {"$set": {"username": username, "username_changed_at": datetime.now(timezone.utc)}},
    )
    updated = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})
    return User(**_user_doc_to_model(updated))


@router.get("/users/by-username/{username}")
async def get_user_by_username(username: str, authorization: Optional[str] = Header(None)):
    await get_current_user(authorization)
    u = username.strip().lower().lstrip("@")
    doc = await db.users.find_one({"username": u}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="User not found")
    return {"user_id": doc["user_id"], "name": doc.get("name"), "username": doc.get("username")}


class KeyUpload(BaseModel):
    public_key: str  # base64-encoded 32-byte X25519 public key


@router.post("/auth/keys")
async def upload_public_key(body: KeyUpload, authorization: Optional[str] = Header(None)):
    """Register the user's E2E public key (X25519). Idempotent."""
    user = await get_current_user(authorization)
    pk = (body.public_key or "").strip()
    if not pk or len(pk) > 256:
        raise HTTPException(status_code=400, detail="Invalid public_key")
    await db.users.update_one(
        {"user_id": user["user_id"]}, {"$set": {"e2e_public_key": pk}}
    )
    return {"ok": True}


@router.get("/users/{user_id}/key")
async def get_user_public_key(user_id: str, authorization: Optional[str] = Header(None)):
    await get_current_user(authorization)
    doc = await db.users.find_one({"user_id": user_id}, {"_id": 0, "e2e_public_key": 1})
    return {"public_key": (doc or {}).get("e2e_public_key")}

