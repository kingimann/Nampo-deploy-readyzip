"""Auth endpoints (email/password) and user profile updates."""
import os
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
    _norm_dt,
    is_admin,
    TOS_VERSION,
    PRIVACY_VERSION,
)
from models import AuthResponse, ProfilePatch, User

router = APIRouter()

USERNAME_RE = re.compile(r"^[a-z0-9_]{3,20}$")
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_MINUTES = 15
# Owner break-glass recovery: when set on the server, /auth/recover-password lets
# someone holding this secret reset any account's password (no email needed).
RECOVERY_SECRET = os.environ.get("RECOVERY_SECRET", "")





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
    # Public profile details (empty string clears the field).
    if body.location is not None:
        patch["location"] = body.location.strip()[:80] or None
    if body.pronouns is not None:
        patch["pronouns"] = body.pronouns.strip()[:40] or None
    if body.birthday is not None:
        # Only accept a YYYY-MM-DD date (the client uses a date picker).
        b = (body.birthday or "").strip()
        patch["birthday"] = b[:10] if re.match(r"^\d{4}-\d{2}-\d{2}$", b) else None
    if body.socials is not None:
        allowed = {"instagram", "twitter", "tiktok", "youtube", "facebook", "snapchat", "linkedin", "github"}
        cleaned = {}
        for k, v in (body.socials or {}).items():
            if k in allowed and isinstance(v, str) and v.strip():
                cleaned[k] = v.strip()[:120]
        patch["socials"] = cleaned
    for k in ("home_name", "home_longitude", "home_latitude",
              "work_name", "work_longitude", "work_latitude"):
        v = getattr(body, k)
        if v is not None:
            patch[k] = v
    if body.sub_price is not None:
        patch["sub_price"] = max(0.0, round(float(body.sub_price), 2))
    if body.payout_frequency in ("weekly", "biweekly", "monthly"):
        current_freq = user.get("payout_frequency", "weekly")
        if body.payout_frequency != current_freq:
            # Payout frequency can only be changed once a month.
            last_change = user.get("payout_frequency_changed_at")
            if last_change:
                try:
                    nxt = _norm_dt(last_change) + timedelta(days=30)
                    if datetime.now(timezone.utc) < nxt:
                        raise HTTPException(status_code=400, detail={
                            "code": "frequency_locked",
                            "message": f"You can only change your payout frequency once a month. You can change it again on {nxt.date().isoformat()}.",
                        })
                except HTTPException:
                    raise
                except Exception:
                    pass
            patch["payout_frequency"] = body.payout_frequency
            patch["payout_frequency_changed_at"] = datetime.now(timezone.utc)
    if body.payout_threshold is not None:
        patch["payout_threshold"] = max(0.0, round(float(body.payout_threshold), 2))
    if body.default_comment_policy in ("everyone", "followers", "friends", "nobody"):
        patch["default_comment_policy"] = body.default_comment_policy
    if body.default_likes_disabled is not None:
        patch["default_likes_disabled"] = bool(body.default_likes_disabled)
    if body.currency is not None:
        from core import normalize_currency
        patch["currency"] = normalize_currency(body.currency)
    if body.sms_notifications is not None:
        # SMS notifications need a verified phone to send to.
        if body.sms_notifications and not user.get("phone_verified"):
            raise HTTPException(status_code=400, detail={
                "code": "phone_unverified",
                "message": "Verify your phone number before turning on SMS notifications.",
            })
        patch["sms_notifications"] = bool(body.sms_notifications)
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
        from core import random_default_avatar
        await db.users.insert_one({
            "user_id": user_id, "email": email, "username": username, "name": name,
            "picture": random_default_avatar(username), "bio": "",
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


@router.post("/auth/login")
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
    # Banned / suspended accounts can't sign in (with the moderator's reason).
    from core import _enforce_moderation, _effective_role
    if _effective_role(user_doc) != "admin":
        _enforce_moderation(user_doc)
    await db.users.update_one(
        {"user_id": user_doc["user_id"]},
        {"$set": {"failed_login_attempts": 0, "locked_until": None}},
    )
    # Two-factor: if enabled (and a verified phone exists), don't mint a session
    # yet — text a one-time code and require /auth/login/2fa to finish.
    if user_doc.get("twofa_enabled") and user_doc.get("phone_verified") and user_doc.get("phone"):
        return await _begin_2fa_challenge(user_doc)
    token = await _mint_session(user_doc["user_id"])
    return AuthResponse(session_token=token, user=User(**_user_doc_to_model(user_doc)))


# ── Password recovery ────────────────────────────────────────────────────────
class RecoverPassword(BaseModel):
    secret: str
    identifier: str       # email OR username
    new_password: str


@router.post("/auth/recover-password")
async def recover_password(body: RecoverPassword):
    """Break-glass reset: anyone holding RECOVERY_SECRET (set on the server by the
    owner) can reset an account's password. Use this to regain access without
    email. Disabled unless RECOVERY_SECRET is configured."""
    if not RECOVERY_SECRET or not secrets.compare_digest(body.secret or "", RECOVERY_SECRET):
        raise HTTPException(status_code=403, detail="Recovery isn't enabled or the secret is wrong.")
    if len((body.new_password or "")) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    ident = (body.identifier or "").strip().lower()
    user_doc = await db.users.find_one({"$or": [{"email": ident}, {"username": ident}]}, {"_id": 0, "user_id": 1})
    if not user_doc:
        raise HTTPException(status_code=404, detail="No account with that email or username.")
    await db.users.update_one(
        {"user_id": user_doc["user_id"]},
        {"$set": {"hashed_password": _hash_password(body.new_password),
                  "failed_login_attempts": 0, "locked_until": None}},
    )
    return {"ok": True, "message": "Password reset — you can log in now."}


class ForgotPassword(BaseModel):
    email: str


@router.post("/auth/forgot-password")
async def forgot_password(body: ForgotPassword):
    """Email a one-time reset code. Always returns ok (never reveals whether an
    account exists). `email_configured` tells the UI whether a code was sent."""
    from services.email import send_email, email_enabled
    email = (body.email or "").strip().lower()
    sent = False
    if email:
        user = await db.users.find_one({"email": email}, {"_id": 0, "user_id": 1, "name": 1})
        if user and email_enabled():
            code = f"{secrets.randbelow(1000000):06d}"
            await db.users.update_one(
                {"user_id": user["user_id"]},
                {"$set": {"pw_reset_hash": _hash_password(code),
                          "pw_reset_expires": datetime.now(timezone.utc) + timedelta(minutes=15)}},
            )
            try:
                send_email(email, "Your Nami password reset code",
                           f"Hi {user.get('name', 'there')},\n\nYour password reset code is {code}.\n"
                           f"It expires in 15 minutes. If you didn't request this, you can ignore it.")
                sent = True
            except Exception:
                pass
    return {"ok": True, "sent": sent, "email_configured": email_enabled()}


class ResetPassword(BaseModel):
    email: str
    code: str
    new_password: str


@router.post("/auth/reset-password")
async def reset_password(body: ResetPassword):
    """Set a new password using the emailed code."""
    email = (body.email or "").strip().lower()
    if len((body.new_password or "")) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    user = await db.users.find_one({"email": email}, {"_id": 0})
    if not user or not user.get("pw_reset_hash"):
        raise HTTPException(status_code=400, detail="No reset in progress — request a new code.")
    exp = user.get("pw_reset_expires")
    try:
        if exp and _norm_dt(exp) < datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="That code expired — request a new one.")
    except HTTPException:
        raise
    except Exception:
        pass
    if not _verify_password(body.code, user["pw_reset_hash"]):
        raise HTTPException(status_code=400, detail="Incorrect code.")
    await db.users.update_one(
        {"user_id": user["user_id"]},
        {"$set": {"hashed_password": _hash_password(body.new_password),
                  "failed_login_attempts": 0, "locked_until": None,
                  "pw_reset_hash": "", "pw_reset_expires": None}},
    )
    return {"ok": True, "message": "Password updated — you can log in now."}


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
    # Usernames can only be changed once every 30 days (admins are exempt).
    changed_at = user.get("username_changed_at")
    if current and changed_at and not is_admin(user):
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


# ── Phone verification (SMS code) ───────────────────────────────────────────
PHONE_CODE_TTL_MIN = 10
PHONE_SEND_COOLDOWN_SEC = 30
PHONE_MAX_ATTEMPTS = 5


class PhoneSend(BaseModel):
    phone: str


class PhoneVerify(BaseModel):
    code: str


@router.post("/auth/phone/send-code")
async def phone_send_code(body: PhoneSend, authorization: Optional[str] = Header(None)):
    """Start phone verification: text a 6-digit code to the number. If no SMS
    provider is configured, the code is returned in `dev_code` so it can still be
    used (useful before Twilio is set up)."""
    user = await get_current_user(authorization)
    raw = (body.phone or "").strip()
    if not PHONE_RE.match(raw):
        raise HTTPException(status_code=400, detail="Enter a valid phone number (e.g. +14155551234)")
    now = datetime.now(timezone.utc)
    last = user.get("phone_code_sent_at")
    if last:
        try:
            if (now - _norm_dt(last)).total_seconds() < PHONE_SEND_COOLDOWN_SEC:
                raise HTTPException(status_code=429, detail="Please wait a moment before requesting another code")
        except HTTPException:
            raise
        except Exception:
            pass
    code = f"{secrets.randbelow(1000000):06d}"
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": {
        "phone_pending": raw,
        "phone_code_hash": bcrypt.hashpw(code.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("utf-8"),
        "phone_code_expires": now + timedelta(minutes=PHONE_CODE_TTL_MIN),
        "phone_code_attempts": 0,
        "phone_code_sent_at": now,
    }})
    from services.sms import send_sms, sms_enabled
    sent = await send_sms(raw, f"Your Nami verification code is {code}. It expires in {PHONE_CODE_TTL_MIN} minutes.")
    out = {"ok": True, "sent": sent}
    if not sms_enabled():
        out["dev_code"] = code
        out["note"] = "SMS isn't configured on this server; use dev_code to verify."
    return out


@router.post("/auth/phone/verify", response_model=User)
async def phone_verify(body: PhoneVerify, authorization: Optional[str] = Header(None)):
    """Finish phone verification with the texted code."""
    user = await get_current_user(authorization)
    h = user.get("phone_code_hash")
    pending = user.get("phone_pending")
    if not h or not pending:
        raise HTTPException(status_code=400, detail="Request a code first")
    now = datetime.now(timezone.utc)
    exp = user.get("phone_code_expires")
    try:
        if exp and _norm_dt(exp) < now:
            raise HTTPException(status_code=400, detail="That code expired — request a new one")
    except HTTPException:
        raise
    except Exception:
        pass
    if int(user.get("phone_code_attempts", 0) or 0) >= PHONE_MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Too many attempts — request a new code")
    code = (body.code or "").strip()
    ok = False
    try:
        ok = bcrypt.checkpw(code.encode("utf-8"), h.encode("utf-8"))
    except Exception:
        ok = False
    if not ok:
        await db.users.update_one({"user_id": user["user_id"]}, {"$inc": {"phone_code_attempts": 1}})
        raise HTTPException(status_code=400, detail="Incorrect code")
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": {
        "phone": pending, "phone_verified": True,
        "phone_pending": None, "phone_code_hash": None,
        "phone_code_expires": None, "phone_code_attempts": 0,
    }})
    updated = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})
    return User(**_user_doc_to_model(updated))


# ── SMS auth helpers (codes via Twilio; dev_code fallback when unconfigured) ──
CODE_TTL_MIN = 10
CODE_MAX_ATTEMPTS = 5
CODE_COOLDOWN_SEC = 30


def _gen_code() -> str:
    return f"{secrets.randbelow(1000000):06d}"


def _hash_code(code: str) -> str:
    return bcrypt.hashpw(code.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("utf-8")


def _check_code(code: str, hashed: Optional[str]) -> bool:
    if not hashed:
        return False
    try:
        return bcrypt.checkpw((code or "").strip().encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def _mask_phone(p: Optional[str]) -> str:
    digits = re.sub(r"\D", "", p or "")
    if len(digits) < 4:
        return "your phone"
    return f"•••• {digits[-4:]}"


def _cooldown_ok(last) -> bool:
    if not last:
        return True
    try:
        return (datetime.now(timezone.utc) - _norm_dt(last)).total_seconds() >= CODE_COOLDOWN_SEC
    except Exception:
        return True


async def _begin_2fa_challenge(user_doc: dict) -> dict:
    """Text a login code and return a 2fa_required payload."""
    from services.sms import send_sms, sms_enabled
    code = _gen_code()
    now = datetime.now(timezone.utc)
    await db.users.update_one({"user_id": user_doc["user_id"]}, {"$set": {
        "twofa_code_hash": _hash_code(code),
        "twofa_code_expires": now + timedelta(minutes=CODE_TTL_MIN),
        "twofa_code_attempts": 0,
        "twofa_code_sent_at": now,
    }})
    sent = await send_sms(user_doc["phone"], f"Your Nami login code is {code}. It expires in {CODE_TTL_MIN} minutes.")
    out = {
        "twofa_required": True,
        "identifier": user_doc.get("username") or user_doc.get("email"),
        "masked_phone": _mask_phone(user_doc.get("phone")),
        "sent": sent,
    }
    if not sms_enabled():
        out["dev_code"] = code
        out["note"] = "SMS isn't configured; use dev_code to finish signing in."
    return out


class TwoFALogin(BaseModel):
    identifier: str  # email OR username
    code: str


@router.post("/auth/login/2fa", response_model=AuthResponse)
async def login_2fa(body: TwoFALogin):
    """Finish a two-factor login with the texted code."""
    ident = (body.identifier or "").strip().lower()
    user_doc = await db.users.find_one(
        {"$or": [{"email": ident}, {"username": ident}]}, {"_id": 0}
    )
    if not user_doc or not user_doc.get("twofa_code_hash"):
        raise HTTPException(status_code=400, detail="No login in progress — start again.")
    exp = user_doc.get("twofa_code_expires")
    try:
        if exp and _norm_dt(exp) < datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="That code expired — sign in again.")
    except HTTPException:
        raise
    except Exception:
        pass
    if int(user_doc.get("twofa_code_attempts", 0) or 0) >= CODE_MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Too many attempts — sign in again.")
    if not _check_code(body.code, user_doc.get("twofa_code_hash")):
        await db.users.update_one({"user_id": user_doc["user_id"]}, {"$inc": {"twofa_code_attempts": 1}})
        raise HTTPException(status_code=400, detail="Incorrect code")
    await db.users.update_one({"user_id": user_doc["user_id"]}, {"$set": {
        "twofa_code_hash": "", "twofa_code_expires": None, "twofa_code_attempts": 0,
    }})
    token = await _mint_session(user_doc["user_id"])
    return AuthResponse(session_token=token, user=User(**_user_doc_to_model(user_doc)))


class TwoFAToggle(BaseModel):
    enabled: bool
    password: Optional[str] = None  # required to disable


@router.post("/auth/2fa", response_model=User)
async def set_twofa(body: TwoFAToggle, authorization: Optional[str] = Header(None)):
    """Turn SMS two-factor on/off. Enabling needs a verified phone; disabling
    needs the current password."""
    user = await get_current_user(authorization)
    if body.enabled:
        if not user.get("phone_verified"):
            raise HTTPException(status_code=400, detail={
                "code": "phone_unverified",
                "message": "Verify your phone number before enabling two-factor.",
            })
        await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"twofa_enabled": True}})
    else:
        if not _verify_password(body.password or "", user.get("hashed_password", "")):
            raise HTTPException(status_code=400, detail="Enter your current password to disable two-factor.")
        await db.users.update_one({"user_id": user["user_id"]}, {"$set": {
            "twofa_enabled": False, "twofa_code_hash": "", "twofa_code_expires": None,
        }})
    updated = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})
    return User(**_user_doc_to_model(updated))


# ── Phone OTP login (existing accounts with a verified phone) ────────────────
class PhoneLoginStart(BaseModel):
    phone: str


@router.post("/auth/login/phone/start")
async def login_phone_start(body: PhoneLoginStart):
    """Text a one-time login code to a known, verified phone. Returns exists:false
    (without sending) when no verified-phone account matches."""
    raw = (body.phone or "").strip()
    if not PHONE_RE.match(raw):
        raise HTTPException(status_code=400, detail="Enter a valid phone number (e.g. +14155551234)")
    user_doc = await db.users.find_one({"phone": raw, "phone_verified": True}, {"_id": 0})
    if not user_doc:
        return {"exists": False}
    if not _cooldown_ok(user_doc.get("login_code_sent_at")):
        raise HTTPException(status_code=429, detail="Please wait a moment before requesting another code")
    from services.sms import send_sms, sms_enabled
    code = _gen_code()
    now = datetime.now(timezone.utc)
    await db.users.update_one({"user_id": user_doc["user_id"]}, {"$set": {
        "login_code_hash": _hash_code(code),
        "login_code_expires": now + timedelta(minutes=CODE_TTL_MIN),
        "login_code_attempts": 0,
        "login_code_sent_at": now,
    }})
    sent = await send_sms(raw, f"Your Nami login code is {code}. It expires in {CODE_TTL_MIN} minutes.")
    out = {"exists": True, "sent": sent, "masked_phone": _mask_phone(raw)}
    if not sms_enabled():
        out["dev_code"] = code
    return out


class PhoneLoginVerify(BaseModel):
    phone: str
    code: str


@router.post("/auth/login/phone/verify", response_model=AuthResponse)
async def login_phone_verify(body: PhoneLoginVerify):
    raw = (body.phone or "").strip()
    user_doc = await db.users.find_one({"phone": raw, "phone_verified": True}, {"_id": 0})
    if not user_doc or not user_doc.get("login_code_hash"):
        raise HTTPException(status_code=400, detail="Request a code first")
    exp = user_doc.get("login_code_expires")
    try:
        if exp and _norm_dt(exp) < datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="That code expired — request a new one")
    except HTTPException:
        raise
    except Exception:
        pass
    if int(user_doc.get("login_code_attempts", 0) or 0) >= CODE_MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Too many attempts — request a new code")
    if not _check_code(body.code, user_doc.get("login_code_hash")):
        await db.users.update_one({"user_id": user_doc["user_id"]}, {"$inc": {"login_code_attempts": 1}})
        raise HTTPException(status_code=400, detail="Incorrect code")
    from core import _enforce_moderation, _effective_role
    if _effective_role(user_doc) != "admin":
        _enforce_moderation(user_doc)
    await db.users.update_one({"user_id": user_doc["user_id"]}, {"$set": {
        "login_code_hash": "", "login_code_expires": None, "login_code_attempts": 0,
        "failed_login_attempts": 0, "locked_until": None,
    }})
    token = await _mint_session(user_doc["user_id"])
    return AuthResponse(session_token=token, user=User(**_user_doc_to_model(user_doc)))


# ── Password reset via SMS ──────────────────────────────────────────────────
class ForgotSms(BaseModel):
    identifier: str  # email, username, or phone


@router.post("/auth/forgot-password/sms")
async def forgot_password_sms(body: ForgotSms):
    """Text a reset code to the account's verified phone. Always returns ok
    (never reveals whether an account/phone exists)."""
    from services.sms import send_sms, sms_enabled
    ident = (body.identifier or "").strip()
    low = ident.lower()
    user = await db.users.find_one(
        {"$or": [{"email": low}, {"username": low}, {"phone": ident}]}, {"_id": 0}
    )
    sent = False
    masked = None
    out_dev = None
    if user and user.get("phone_verified") and user.get("phone") and _cooldown_ok(user.get("pw_reset_sent_at")):
        code = _gen_code()
        await db.users.update_one({"user_id": user["user_id"]}, {"$set": {
            "pw_reset_hash": _hash_code(code),
            "pw_reset_expires": datetime.now(timezone.utc) + timedelta(minutes=CODE_TTL_MIN),
            "pw_reset_sent_at": datetime.now(timezone.utc),
        }})
        sent = await send_sms(user["phone"], f"Your Nami password reset code is {code}. It expires in {CODE_TTL_MIN} minutes.")
        masked = _mask_phone(user["phone"])
        if not sms_enabled():
            out_dev = code
    out = {"ok": True, "sent": sent, "sms_configured": sms_enabled(), "masked_phone": masked}
    if out_dev:
        out["dev_code"] = out_dev
    return out


class ResetWithCode(BaseModel):
    identifier: str  # email, username, or phone
    code: str
    new_password: str


@router.post("/auth/reset-password/code")
async def reset_password_code(body: ResetWithCode):
    """Set a new password using a code sent by SMS (or email). Accepts the
    account's email, username, or phone as the identifier."""
    if len((body.new_password or "")) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    ident = (body.identifier or "").strip()
    low = ident.lower()
    user = await db.users.find_one(
        {"$or": [{"email": low}, {"username": low}, {"phone": ident}]}, {"_id": 0}
    )
    if not user or not user.get("pw_reset_hash"):
        raise HTTPException(status_code=400, detail="No reset in progress — request a new code.")
    exp = user.get("pw_reset_expires")
    try:
        if exp and _norm_dt(exp) < datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="That code expired — request a new one.")
    except HTTPException:
        raise
    except Exception:
        pass
    if not _check_code(body.code, user.get("pw_reset_hash")):
        raise HTTPException(status_code=400, detail="Incorrect code.")
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": {
        "hashed_password": _hash_password(body.new_password),
        "failed_login_attempts": 0, "locked_until": None,
        "pw_reset_hash": "", "pw_reset_expires": None,
    }})
    return {"ok": True, "message": "Password updated — you can log in now."}


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


class KeyBackup(BaseModel):
    # Opaque, client-encrypted blob (private key sealed with a passphrase).
    # The server never sees the passphrase or the plaintext key.
    blob: str


@router.post("/auth/keys/backup")
async def upload_key_backup(body: KeyBackup, authorization: Optional[str] = Header(None)):
    """Store the user's passphrase-encrypted private-key backup (opaque blob)."""
    user = await get_current_user(authorization)
    blob = (body.blob or "").strip()
    if not blob or len(blob) > 20000:
        raise HTTPException(status_code=400, detail="Invalid backup")
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"e2e_key_backup": blob}})
    return {"ok": True}


@router.get("/auth/keys/backup")
async def get_key_backup(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0, "e2e_key_backup": 1})
    blob = (doc or {}).get("e2e_key_backup")
    return {"has_backup": bool(blob), "blob": blob}


@router.delete("/auth/keys/backup")
async def delete_key_backup(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"e2e_key_backup": None}})
    return {"ok": True}

