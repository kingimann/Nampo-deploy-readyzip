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
    db,
    get_current_user,
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

