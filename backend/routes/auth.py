"""Auth endpoints (email/password) and user profile updates."""
import re
import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional
import uuid

import bcrypt
from email_validator import EmailNotValidError, validate_email
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel
from db import DuplicateKeyError

from core import (
    _user_doc_to_model,
    _has_api_access,
    _active_plan,
    db,
    get_current_user,
    TOS_VERSION,
    PRIVACY_VERSION,
)
from models import AuthResponse, ProfilePatch, User

router = APIRouter()

USERNAME_RE = re.compile(r"^[a-z0-9_]{3,20}$")
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_MINUTES = 15





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


class EmailUpdate(BaseModel):
    current_password: str
    new_email: str


class PasswordUpdate(BaseModel):
    current_password: str
    new_password: str


class PhoneUpdate(BaseModel):
    phone: str  # empty string clears it


class ApiKeyCreate(BaseModel):
    label: Optional[str] = None
    scopes: Optional[list] = None   # subset of ["read", "write"]; defaults to both


PHONE_RE = re.compile(r"^\+?[0-9\s\-().]{7,20}$")


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




@router.get("/policies")
async def get_policies():
    """Current legal policy versions (public)."""
    return {
        "tos_version": TOS_VERSION,
        "privacy_version": PRIVACY_VERSION,
        "effective_date": TOS_VERSION,
    }


@router.post("/auth/accept-policies", response_model=User)
async def accept_policies(authorization: Optional[str] = Header(None)):
    """Record that the user agrees to the current ToS + Privacy Policy."""
    user = await get_current_user(authorization)
    await db.users.update_one(
        {"user_id": user["user_id"]},
        {"$set": {
            "tos_version": TOS_VERSION,
            "privacy_version": PRIVACY_VERSION,
            "policies_agreed_at": datetime.now(timezone.utc),
        }},
    )
    updated = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})
    return User(**_user_doc_to_model(updated))


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
    if body.sub_price is not None:
        patch["sub_price"] = max(0.0, round(float(body.sub_price), 2))
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
        now = datetime.now(timezone.utc)
        await db.users.insert_one({
            "user_id": user_id, "email": email, "username": username, "name": name,
            "picture": None, "bio": "",
            "hashed_password": _hash_password(body.password),
            "auth_providers": ["local"],
            "failed_login_attempts": 0, "locked_until": None,
            # Signing up requires agreeing to the current ToS + Privacy Policy.
            "tos_version": TOS_VERSION, "privacy_version": PRIVACY_VERSION,
            "policies_agreed_at": now,
            "created_at": now,
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


@router.patch("/auth/me/email", response_model=User)
async def change_email(body: EmailUpdate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    if not _verify_password(body.current_password or "", user.get("hashed_password", "")):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    try:
        valid = validate_email(body.new_email, check_deliverability=False)
        new_email = valid.normalized.lower()
    except EmailNotValidError:
        raise HTTPException(status_code=400, detail="Enter a valid email address")
    if new_email == (user.get("email") or "").lower():
        return User(**_user_doc_to_model(user))
    existing = await db.users.find_one(
        {"email": new_email, "user_id": {"$ne": user["user_id"]}}, {"_id": 0, "user_id": 1}
    )
    if existing:
        raise HTTPException(status_code=409, detail="That email is already in use")
    try:
        await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"email": new_email}})
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="That email is already in use")
    updated = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})
    return User(**_user_doc_to_model(updated))


@router.patch("/auth/me/password")
async def change_password(body: PasswordUpdate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    if not _verify_password(body.current_password or "", user.get("hashed_password", "")):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    new_pw = body.new_password or ""
    if not (8 <= len(new_pw) <= 128):
        raise HTTPException(status_code=400, detail="Password must be 8-128 characters")
    if new_pw == body.current_password:
        raise HTTPException(status_code=400, detail="New password must be different")
    await db.users.update_one(
        {"user_id": user["user_id"]}, {"$set": {"hashed_password": _hash_password(new_pw)}}
    )
    return {"ok": True}


@router.patch("/auth/me/phone", response_model=User)
async def change_phone(body: PhoneUpdate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    raw = (body.phone or "").strip()
    if raw == "":
        # Clear the phone number.
        await db.users.update_one(
            {"user_id": user["user_id"]}, {"$set": {"phone": None, "phone_verified": False}}
        )
    else:
        if not PHONE_RE.match(raw):
            raise HTTPException(status_code=400, detail="Enter a valid phone number")
        # Stored unverified for now; a verification step can be added later.
        await db.users.update_one(
            {"user_id": user["user_id"]}, {"$set": {"phone": raw, "phone_verified": False}}
        )
    updated = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})
    return User(**_user_doc_to_model(updated))


# ── Developer API keys ──────────────────────────────────────────────────────
# An API key is a long-lived bearer token stored in the same `user_sessions`
# collection as login sessions (so get_current_user authenticates it for free),
# tagged with kind="api_key" + a label. Listing shows only a masked prefix.

@router.post("/auth/api-keys")
async def create_api_key(body: ApiKeyCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    # Paywall: the Developer API is a paid add-on with tiered plans.
    plan = _active_plan(user)
    if not plan:
        raise HTTPException(status_code=402, detail={
            "code": "api_plan_required",
            "message": "An active Developer API plan is required to create keys.",
        })
    max_keys = int(plan.get("max_keys", 2))
    existing = await db.user_sessions.count_documents({"user_id": user["user_id"], "kind": "api_key"})
    if existing >= max_keys:
        raise HTTPException(status_code=400, detail={
            "code": "key_limit_reached",
            "message": f"Your {plan['name']} plan allows {max_keys} keys. Revoke one or upgrade.",
        })
    # Scopes: read-only keys can only call GET endpoints (enforced in middleware).
    # "write" scope requires a plan tier that allows writes.
    scopes = [s for s in (body.scopes or ["read", "write"]) if s in ("read", "write")] or ["read"]
    if not plan.get("write"):
        scopes = ["read"]
    token = f"nami_sk_{secrets.token_urlsafe(32)}"
    key_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    label = (body.label or "API key").strip()[:60] or "API key"
    await db.user_sessions.insert_one({
        "session_token": token,
        "user_id": user["user_id"],
        "expires_at": now + timedelta(days=365 * 5),
        "created_at": now,
        "kind": "api_key",
        "key_id": key_id,
        "label": label,
        "scopes": scopes,
        "key_prefix": token[:16],
    })
    # The full token is returned exactly once — it can't be retrieved again.
    return {"id": key_id, "label": label, "scopes": scopes, "token": token, "created_at": now}


@router.get("/auth/api-keys")
async def list_api_keys(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    rows = await db.user_sessions.find(
        {"user_id": user["user_id"], "kind": "api_key"}, {"_id": 0}
    ).sort("created_at", -1).to_list(50)
    return {
        "keys": [
            {
                "id": r.get("key_id", ""),
                "label": r.get("label", "API key"),
                "scopes": r.get("scopes", ["read", "write"]),
                "key_prefix": r.get("key_prefix", ""),
                "created_at": r.get("created_at"),
                "last_used_at": r.get("last_used_at"),
            }
            for r in rows
        ]
    }


@router.delete("/auth/api-keys/{key_id}")
async def revoke_api_key(key_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    await db.user_sessions.delete_one(
        {"user_id": user["user_id"], "kind": "api_key", "key_id": key_id}
    )
    return {"revoked": True}


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

