"""Auth endpoints (email/password) and user profile updates."""
import os
import re
import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional
import uuid

import bcrypt
from email_validator import EmailNotValidError, validate_email
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict
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
from models import AuthResponse, LoginResultOut, ProfilePatch, User

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
    invite_code: Optional[str] = None   # required when registration_mode == "invite"


class RegistrationModeBody(BaseModel):
    mode: str   # open | invite | closed


class InvitesBody(BaseModel):
    count: int = 1


class RegistrationModeOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    mode: str = "open"


class InvitesListOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    data: list = []


class InvitesCreatedOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    codes: list = []


class AdminOkOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    ok: bool = True


# --- §1 response models (extra="allow" so no field is ever dropped) ----------
class _AOut(BaseModel):
    model_config = ConfigDict(extra="allow")


class OkOut(_AOut):
    ok: bool = True


class MessageOut(_AOut):
    message: str = ""


class OkMessageOut(_AOut):
    ok: bool = True
    message: Optional[str] = None


class SentOut(_AOut):
    ok: bool = True
    sent: bool = False
    email_configured: bool = False


class AvailableOut(_AOut):
    available: bool = False
    reason: Optional[str] = None


class SendCodeOut(_AOut):
    ok: Optional[bool] = None
    sent: Optional[bool] = None


class PoliciesOut(_AOut):
    tos_version: str = ""
    privacy_version: str = ""
    effective_date: str = ""


class ApiKeyCreateOut(_AOut):
    id: str = ""
    label: str = ""
    scopes: list = []
    token: str = ""
    created_at: Optional[datetime] = None


class ApiKeysListOut(_AOut):
    keys: list = []


class RevokedOut(_AOut):
    revoked: bool = False


class PublicKeyOut(_AOut):
    public_key: Optional[str] = None


class KeyBackupOut(_AOut):
    has_backup: bool = False
    blob: Optional[str] = None


class UserLookupOut(_AOut):
    exists: Optional[bool] = None
    user_id: Optional[str] = None
    name: Optional[str] = None
    username: Optional[str] = None


_INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # no 0/O/1/I


def _gen_invite_code() -> str:
    return "".join(secrets.choice(_INVITE_ALPHABET) for _ in range(8))


async def _registration_mode() -> str:
    try:
        doc = await db.app_settings.find_one({"key": "registration_mode"}, {"_id": 0, "value": 1})
        m = (doc or {}).get("value")
        return m if m in ("open", "invite", "closed") else "open"
    except Exception:
        return "open"


def _admin_or_403(user: dict):
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Admins only")


async def _require_admin(user: dict = Depends(get_current_user)) -> dict:
    """Auth-as-a-dependency: FastAPI resolves it before validating the request
    body, so an unauthenticated/non-admin call to a bodied admin route returns
    401/403 instead of a 422 that leaks the body schema (API guide §5)."""
    _admin_or_403(user)
    return user


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


@router.get("/", response_model=MessageOut)
async def root():
    return {"message": "Map App API"}




@router.get("/policies", response_model=PoliciesOut)
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
    if body.status is not None:
        patch["status"] = body.status.strip()[:50] or None
    if body.headline is not None:
        patch["headline"] = body.headline.strip()[:60] or None
    if body.shop_policies is not None:
        patch["shop_policies"] = body.shop_policies.strip()[:500] or None
    if body.shop_name is not None:
        patch["shop_name"] = body.shop_name.strip()[:60] or None
    if body.shop_tagline is not None:
        patch["shop_tagline"] = body.shop_tagline.strip()[:100] or None
    if body.shop_logo is not None:
        patch["shop_logo"] = body.shop_logo or None
    if body.shop_banner is not None:
        patch["shop_banner"] = body.shop_banner or None
    if body.shop_accent is not None:
        c = (body.shop_accent or "").strip()
        patch["shop_accent"] = c if re.match(r"^#[0-9a-fA-F]{6}$", c) else None
    if body.cover_photo is not None:
        # A banner image URL / data URI; empty string clears it.
        patch["cover_photo"] = body.cover_photo or None
    if body.accent_color is not None:
        # Only accept a #RRGGBB hex; anything else (incl. "") clears it.
        c = (body.accent_color or "").strip()
        patch["accent_color"] = c if re.match(r"^#[0-9a-fA-F]{6}$", c) else None
    if body.interests is not None:
        # Trim, drop empties, dedupe case-insensitively (keep first casing), cap at 12.
        cleaned_int: list = []
        seen_int = set()
        for w in body.interests:
            t = (w or "").strip()[:30]
            key = t.lower()
            if t and key not in seen_int:
                seen_int.add(key)
                cleaned_int.append(t)
            if len(cleaned_int) >= 12:
                break
        patch["interests"] = cleaned_int
    if body.featured_links is not None:
        # Link-in-bio rows: [{label, url}]. Require a valid http(s) url; cap at 5.
        cleaned_links: list = []
        for item in body.featured_links:
            if not isinstance(item, dict):
                continue
            url = str(item.get("url") or "").strip()[:300]
            if not re.match(r"^https?://", url, re.IGNORECASE):
                continue
            label = str(item.get("label") or "").strip()[:40]
            cleaned_links.append({"label": label, "url": url})
            if len(cleaned_links) >= 5:
                break
        patch["featured_links"] = cleaned_links
    if body.avatar_frame is not None:
        # Steam-style decorative ring; must be a known preset (else clear).
        frames = {"none", "gold", "emerald", "ruby", "sapphire", "amethyst", "rgb",
                  "frost", "molten", "mono", "ocean", "rose", "sunset", "lime", "midnight"}
        f = (body.avatar_frame or "").strip()
        patch["avatar_frame"] = f if f in frames and f != "none" else None
    if body.profile_background is not None:
        # Full-profile themed background; must be a known preset (else clear).
        bgs = {"default", "midnight", "sunset", "aurora", "crimson", "forest", "nebula",
               "carbon", "ocean", "rosewood", "dusk", "slate", "emerald"}
        b = (body.profile_background or "").strip()
        patch["profile_background"] = b if b in bgs and b != "default" else None
    for k in ("home_name", "home_longitude", "home_latitude",
              "work_name", "work_longitude", "work_latitude"):
        v = getattr(body, k)
        if v is not None:
            patch[k] = v
    if body.sub_price is not None:
        patch["sub_price"] = max(0.0, round(float(body.sub_price), 2))
    if body.payout_frequency in ("weekly", "biweekly", "monthly"):
        current_freq = user.get("payout_frequency") or "monthly"
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
        new_thr = max(0.0, round(float(body.payout_threshold), 2))
        current_thr = float(user.get("payout_threshold", 0) or 0)
        if new_thr != current_thr:
            # The minimum payout balance can only be changed once a month.
            last_thr = user.get("payout_threshold_changed_at")
            if last_thr:
                try:
                    nxt = _norm_dt(last_thr) + timedelta(days=30)
                    if datetime.now(timezone.utc) < nxt:
                        raise HTTPException(status_code=400, detail={
                            "code": "threshold_locked",
                            "message": f"You can only change your minimum payout balance once a month. You can change it again on {nxt.date().isoformat()}.",
                        })
                except HTTPException:
                    raise
                except Exception:
                    pass
            patch["payout_threshold"] = new_thr
            patch["payout_threshold_changed_at"] = datetime.now(timezone.utc)
    if body.default_comment_policy in ("everyone", "followers", "friends", "nobody"):
        patch["default_comment_policy"] = body.default_comment_policy
    if body.message_policy in ("everyone", "followers", "friends", "nobody"):
        patch["message_policy"] = body.message_policy
    if body.default_likes_disabled is not None:
        patch["default_likes_disabled"] = bool(body.default_likes_disabled)
    if body.is_private is not None:
        patch["is_private"] = bool(body.is_private)
    if body.searchable is not None:
        patch["searchable"] = bool(body.searchable)
    if body.hide_online is not None:
        patch["hide_online"] = bool(body.hide_online)
    if body.connections_visibility in ("everyone", "followers", "nobody"):
        patch["connections_visibility"] = body.connections_visibility
    if body.hide_likes is not None:
        patch["hide_likes"] = bool(body.hide_likes)
    if body.show_points is not None:
        patch["show_points"] = bool(body.show_points)
    if body.tag_policy in ("everyone", "followers", "nobody"):
        patch["tag_policy"] = body.tag_policy
    if body.muted_keywords is not None:
        # Clean: trim, lowercase, drop empties, dedupe (keep order), cap.
        cleaned: list = []
        seen = set()
        for w in body.muted_keywords:
            t = (w or "").strip().lower()[:60]
            if t and t not in seen:
                seen.add(t)
                cleaned.append(t)
            if len(cleaned) >= 200:
                break
        patch["muted_keywords"] = cleaned
    if body.boost_keywords is not None:
        cleaned2: list = []
        seen2 = set()
        for w in body.boost_keywords:
            t = (w or "").strip().lower()[:60]
            if t and t not in seen2:
                seen2.add(t)
                cleaned2.append(t)
            if len(cleaned2) >= 200:
                break
        patch["boost_keywords"] = cleaned2
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


@router.post("/auth/logout", response_model=OkOut)
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

    # Registration mode (admin-controlled): open | invite | closed.
    mode = await _registration_mode()
    if mode == "closed":
        raise HTTPException(status_code=403, detail={"code": "registration_closed", "message": "Sign-ups are currently closed."})
    _invite_code: Optional[str] = None
    if mode == "invite":
        code = (body.invite_code or "").strip().upper()
        if not code:
            raise HTTPException(status_code=403, detail={"code": "invite_required", "message": "An invite code is required to sign up."})
        # Consume atomically so a code can't be used twice (released below if the
        # user insert then fails).
        claim = await db.invite_codes.update_one(
            {"code": code, "used": {"$ne": True}},
            {"$set": {"used": True, "used_at": datetime.now(timezone.utc)}},
        )
        if getattr(claim, "matched_count", 0) != 1:
            raise HTTPException(status_code=403, detail={"code": "invalid_invite", "message": "That invite code is invalid or already used."})
        _invite_code = code

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
        # Release the invite we consumed so it isn't burned on a lost race.
        if _invite_code:
            await db.invite_codes.update_one({"code": _invite_code}, {"$set": {"used": False, "used_at": None}})
        raise HTTPException(status_code=400, detail="Email or username taken")
    if _invite_code:
        await db.invite_codes.update_one({"code": _invite_code}, {"$set": {"used_by": user_id}})
    token = await _mint_session(user_id)
    user_doc = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    return AuthResponse(session_token=token, user=User(**_user_doc_to_model(user_doc)))


# ── Registration mode + invite codes (admin) ─────────────────────────────────
@router.get("/admin/registration", response_model=RegistrationModeOut)
async def admin_get_registration(_admin: dict = Depends(_require_admin)):
    return {"mode": await _registration_mode()}


@router.post("/admin/registration", response_model=RegistrationModeOut)
async def admin_set_registration(body: RegistrationModeBody, _admin: dict = Depends(_require_admin)):
    mode = (body.mode or "").strip().lower()
    if mode not in ("open", "invite", "closed"):
        raise HTTPException(status_code=400, detail="mode must be open, invite, or closed")
    await db.app_settings.update_one({"key": "registration_mode"}, {"$set": {"value": mode}}, upsert=True)
    return {"mode": mode}


@router.get("/admin/invites", response_model=InvitesListOut)
async def admin_list_invites(_admin: dict = Depends(_require_admin)):
    rows = await db.invite_codes.find({}, {"_id": 0}).sort("created_at", -1).limit(500).to_list(500)
    return {"data": [{
        "code": r.get("code"), "used": bool(r.get("used")),
        "used_by": r.get("used_by"), "created_at": r.get("created_at"),
    } for r in rows]}


@router.post("/admin/invites", response_model=InvitesCreatedOut)
async def admin_create_invites(body: InvitesBody, _admin: dict = Depends(_require_admin)):
    n = max(1, min(int(body.count or 1), 200))
    now = datetime.now(timezone.utc)
    codes: list = []
    for _ in range(n):
        for _try in range(5):
            code = _gen_invite_code()
            try:
                await db.invite_codes.insert_one({"code": code, "used": False, "used_by": None, "created_at": now})
                codes.append(code)
                break
            except DuplicateKeyError:
                continue
    return {"codes": codes}


@router.delete("/admin/invites/{code}", response_model=AdminOkOut)
async def admin_delete_invite(code: str, _admin: dict = Depends(_require_admin)):
    await db.invite_codes.delete_one({"code": (code or "").strip().upper()})
    return {"ok": True}


@router.post("/auth/login", response_model=LoginResultOut)
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


@router.post("/auth/recover-password", response_model=OkMessageOut)
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


@router.post("/auth/forgot-password", response_model=SentOut)
async def forgot_password(body: ForgotPassword):
    """Email a one-time reset code. Always returns ok (never reveals whether an
    account exists). `email_configured` tells the UI whether a code was sent."""
    from services.email import send_email, email_enabled
    email = (body.email or "").strip().lower()
    sent = False
    if email:
        user = await db.users.find_one({"email": email}, {"_id": 0, "user_id": 1, "name": 1, "pw_reset_sent_at": 1})
        if user and email_enabled() and _cooldown_ok(user.get("pw_reset_sent_at")):
            code = f"{secrets.randbelow(1000000):06d}"
            await db.users.update_one(
                {"user_id": user["user_id"]},
                {"$set": {"pw_reset_hash": _hash_password(code),
                          "pw_reset_expires": datetime.now(timezone.utc) + timedelta(minutes=15),
                          "pw_reset_sent_at": datetime.now(timezone.utc),
                          "pw_reset_attempts": 0}},
            )
            try:
                send_email(email, "Your OkaySpace password reset code",
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


@router.post("/auth/reset-password", response_model=OkMessageOut)
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
    if int(user.get("pw_reset_attempts", 0) or 0) >= CODE_MAX_ATTEMPTS:
        await db.users.update_one(
            {"user_id": user["user_id"]},
            {"$set": {"pw_reset_hash": "", "pw_reset_expires": None, "pw_reset_attempts": 0}})
        raise HTTPException(status_code=429, detail="Too many incorrect attempts — request a new code.")
    if not _verify_password(body.code, user["pw_reset_hash"]):
        await db.users.update_one({"user_id": user["user_id"]}, {"$inc": {"pw_reset_attempts": 1}})
        raise HTTPException(status_code=400, detail="Incorrect code.")
    await db.users.update_one(
        {"user_id": user["user_id"]},
        {"$set": {"hashed_password": _hash_password(body.new_password),
                  "failed_login_attempts": 0, "locked_until": None,
                  "pw_reset_hash": "", "pw_reset_expires": None, "pw_reset_attempts": 0}},
    )
    return {"ok": True, "message": "Password updated — you can log in now."}


@router.get("/auth/username-available", response_model=AvailableOut)
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
    # Admin is derived from the email being in ADMIN_EMAILS, so a non-admin must
    # not be able to grant themselves admin by changing their (unverified) email
    # to a privileged address.
    from core import ADMIN_EMAILS
    if new_email in ADMIN_EMAILS and (user.get("email") or "").strip().lower() not in ADMIN_EMAILS:
        raise HTTPException(status_code=403, detail="That email address can't be used.")
    existing = await db.users.find_one(
        {"email": new_email, "user_id": {"$ne": user["user_id"]}}, {"_id": 0, "user_id": 1}
    )
    if existing:
        raise HTTPException(status_code=409, detail="That email is already in use")
    try:
        # New email is unproven — drop the verified flag until it's re-verified.
        await db.users.update_one(
            {"user_id": user["user_id"]},
            {"$set": {"email": new_email, "email_verified": False}},
        )
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="That email is already in use")
    updated = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})
    return User(**_user_doc_to_model(updated))


@router.patch("/auth/me/password", response_model=OkMessageOut)
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


@router.post("/auth/phone/send-code", response_model=SendCodeOut)
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
    sent = await send_sms(raw, f"Your OkaySpace verification code is {code}. It expires in {PHONE_CODE_TTL_MIN} minutes.")
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


class EmailVerify(BaseModel):
    code: str


@router.post("/auth/email/send-code", response_model=SendCodeOut)
async def email_send_code(authorization: Optional[str] = Header(None)):
    """Email a 6-digit code to the account's email address to verify it."""
    user = await get_current_user(authorization)
    email = (user.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="No email on file")
    if user.get("email_verified"):
        raise HTTPException(status_code=400, detail="Your email is already verified")
    now = datetime.now(timezone.utc)
    last = user.get("email_code_sent_at")
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
        "email_code_hash": bcrypt.hashpw(code.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("utf-8"),
        "email_code_expires": now + timedelta(minutes=PHONE_CODE_TTL_MIN),
        "email_code_attempts": 0,
        "email_code_sent_at": now,
    }})
    from services.email import send_email, email_enabled
    sent = send_email(email, "Verify your OkaySpace email",
                      f"Your OkaySpace email verification code is {code}. It expires in {PHONE_CODE_TTL_MIN} minutes.")
    out = {"ok": True, "sent": bool(sent)}
    if not email_enabled():
        out["dev_code"] = code
        out["note"] = "Email isn't configured on this server; use dev_code to verify."
    return out


@router.post("/auth/email/verify", response_model=User)
async def email_verify(body: EmailVerify, authorization: Optional[str] = Header(None)):
    """Finish email verification with the emailed code."""
    user = await get_current_user(authorization)
    h = user.get("email_code_hash")
    if not h:
        raise HTTPException(status_code=400, detail="Request a code first")
    now = datetime.now(timezone.utc)
    exp = user.get("email_code_expires")
    try:
        if exp and _norm_dt(exp) < now:
            raise HTTPException(status_code=400, detail="That code expired — request a new one")
    except HTTPException:
        raise
    except Exception:
        pass
    if int(user.get("email_code_attempts", 0) or 0) >= PHONE_MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Too many attempts — request a new code")
    code = (body.code or "").strip()
    ok = False
    try:
        ok = bcrypt.checkpw(code.encode("utf-8"), h.encode("utf-8"))
    except Exception:
        ok = False
    if not ok:
        await db.users.update_one({"user_id": user["user_id"]}, {"$inc": {"email_code_attempts": 1}})
        raise HTTPException(status_code=400, detail="Incorrect code")
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": {
        "email_verified": True, "email_code_hash": None,
        "email_code_expires": None, "email_code_attempts": 0,
    }})
    updated = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})
    return User(**_user_doc_to_model(updated))


# ── SMS auth helpers (codes via Twilio; dev_code fallback when unconfigured) ──
CODE_TTL_MIN = 10
CODE_MAX_ATTEMPTS = 5
CODE_COOLDOWN_SEC = 30

# Only ever echo a live login/2FA/reset code back in the API response when this
# is explicitly enabled (local dev). Gating on "is SMS configured?" meant a prod
# deploy that simply hadn't finished Twilio/SMTP setup would hand out 2FA and
# password-reset codes to anyone who could reach the endpoint.
_EXPOSE_DEV_CODES = os.environ.get("EXPOSE_DEV_CODES", "").strip().lower() in ("1", "true", "yes")


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
    base = {
        "twofa_required": True,
        "identifier": user_doc.get("username") or user_doc.get("email"),
        "masked_phone": _mask_phone(user_doc.get("phone")),
    }
    # Don't re-send (and re-roll) a code on every login attempt — that lets an
    # attacker with the password spam SMS. Within the cooldown the previously
    # texted code is still valid.
    if not _cooldown_ok(user_doc.get("twofa_code_sent_at")):
        return {**base, "sent": False}
    code = _gen_code()
    now = datetime.now(timezone.utc)
    await db.users.update_one({"user_id": user_doc["user_id"]}, {"$set": {
        "twofa_code_hash": _hash_code(code),
        "twofa_code_expires": now + timedelta(minutes=CODE_TTL_MIN),
        "twofa_code_attempts": 0,
        "twofa_code_sent_at": now,
    }})
    sent = await send_sms(user_doc["phone"], f"Your OkaySpace login code is {code}. It expires in {CODE_TTL_MIN} minutes.")
    out = {
        "twofa_required": True,
        "identifier": user_doc.get("username") or user_doc.get("email"),
        "masked_phone": _mask_phone(user_doc.get("phone")),
        "sent": sent,
    }
    if not sms_enabled() and _EXPOSE_DEV_CODES:
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


@router.post("/auth/login/phone/start", response_model=SendCodeOut)
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
    sent = await send_sms(raw, f"Your OkaySpace login code is {code}. It expires in {CODE_TTL_MIN} minutes.")
    out = {"exists": True, "sent": sent, "masked_phone": _mask_phone(raw)}
    if not sms_enabled() and _EXPOSE_DEV_CODES:
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


@router.post("/auth/forgot-password/sms", response_model=SendCodeOut)
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
            "pw_reset_attempts": 0,
        }})
        sent = await send_sms(user["phone"], f"Your OkaySpace password reset code is {code}. It expires in {CODE_TTL_MIN} minutes.")
        masked = _mask_phone(user["phone"])
        if not sms_enabled() and _EXPOSE_DEV_CODES:
            out_dev = code
    out = {"ok": True, "sent": sent, "sms_configured": sms_enabled(), "masked_phone": masked}
    if out_dev:
        out["dev_code"] = out_dev
    return out


class ResetWithCode(BaseModel):
    identifier: str  # email, username, or phone
    code: str
    new_password: str


@router.post("/auth/reset-password/code", response_model=OkMessageOut)
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
    if int(user.get("pw_reset_attempts", 0) or 0) >= CODE_MAX_ATTEMPTS:
        await db.users.update_one({"user_id": user["user_id"]}, {"$set": {
            "pw_reset_hash": "", "pw_reset_expires": None, "pw_reset_attempts": 0}})
        raise HTTPException(status_code=429, detail="Too many incorrect attempts — request a new code.")
    if not _check_code(body.code, user.get("pw_reset_hash")):
        await db.users.update_one({"user_id": user["user_id"]}, {"$inc": {"pw_reset_attempts": 1}})
        raise HTTPException(status_code=400, detail="Incorrect code.")
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": {
        "hashed_password": _hash_password(body.new_password),
        "failed_login_attempts": 0, "locked_until": None,
        "pw_reset_hash": "", "pw_reset_expires": None, "pw_reset_attempts": 0,
    }})
    return {"ok": True, "message": "Password updated — you can log in now."}


# ── Developer API keys ──────────────────────────────────────────────────────
# An API key is a long-lived bearer token stored in the same `user_sessions`
# collection as login sessions (so get_current_user authenticates it for free),
# tagged with kind="api_key" + a label. Listing shows only a masked prefix.

@router.post("/auth/api-keys", response_model=ApiKeyCreateOut)
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
    token = f"okayspace_sk_{secrets.token_urlsafe(32)}"
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


@router.get("/auth/api-keys", response_model=ApiKeysListOut)
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


@router.delete("/auth/api-keys/{key_id}", response_model=RevokedOut)
async def revoke_api_key(key_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    await db.user_sessions.delete_one(
        {"user_id": user["user_id"], "kind": "api_key", "key_id": key_id}
    )
    return {"revoked": True}


@router.get("/users/by-username/{username}", response_model=UserLookupOut)
async def get_user_by_username(username: str, authorization: Optional[str] = Header(None)):
    await get_current_user(authorization)
    u = username.strip().lower().lstrip("@")
    doc = await db.users.find_one({"username": u}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="User not found")
    return {"user_id": doc["user_id"], "name": doc.get("name"), "username": doc.get("username")}


class KeyUpload(BaseModel):
    public_key: str  # base64-encoded 32-byte X25519 public key


@router.post("/auth/keys", response_model=OkOut)
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


@router.get("/users/{user_id}/key", response_model=PublicKeyOut)
async def get_user_public_key(user_id: str, authorization: Optional[str] = Header(None)):
    await get_current_user(authorization)
    doc = await db.users.find_one({"user_id": user_id}, {"_id": 0, "e2e_public_key": 1})
    return {"public_key": (doc or {}).get("e2e_public_key")}


class KeyBackup(BaseModel):
    # Opaque, client-encrypted blob (private key sealed with a passphrase).
    # The server never sees the passphrase or the plaintext key.
    blob: str


@router.post("/auth/keys/backup", response_model=OkOut)
async def upload_key_backup(body: KeyBackup, authorization: Optional[str] = Header(None)):
    """Store the user's passphrase-encrypted private-key backup (opaque blob)."""
    user = await get_current_user(authorization)
    blob = (body.blob or "").strip()
    if not blob or len(blob) > 20000:
        raise HTTPException(status_code=400, detail="Invalid backup")
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"e2e_key_backup": blob}})
    return {"ok": True}


@router.get("/auth/keys/backup", response_model=KeyBackupOut)
async def get_key_backup(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0, "e2e_key_backup": 1})
    blob = (doc or {}).get("e2e_key_backup")
    return {"has_backup": bool(blob), "blob": blob}


@router.delete("/auth/keys/backup", response_model=OkOut)
async def delete_key_backup(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"e2e_key_backup": None}})
    return {"ok": True}

