"""'Login with OkaySpace' — a minimal OAuth2 authorization-code provider so other
sites can let people sign in with their OkaySpace account (like Google/Facebook).

Flow:
  1. A developer registers an OAuth app → client_id + client_secret + redirect URIs.
  2. Their site sends the user to `/oauth/authorize?...`; our web app shows a
     consent screen and (on approve) `POST /oauth/authorize` mints a short-lived
     code, then redirects back to the site's redirect_uri with ?code=&state=.
  3. The site's server exchanges the code at `POST /oauth/token` (with the client
     secret) for an access token.
  4. The site calls `GET /oauth/userinfo` with that token to read the profile.
"""
import secrets
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from urllib.parse import urlencode

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from core import db, get_current_user, _norm_dt

router = APIRouter()

CODE_TTL_MIN = 10
TOKEN_TTL_DAYS = 30
VALID_SCOPES = {"profile", "email"}


class AppCreate(BaseModel):
    name: str
    redirect_uris: List[str]


class AuthorizeBody(BaseModel):
    client_id: str
    redirect_uri: str
    scope: Optional[str] = "profile"
    state: Optional[str] = None
    approve: bool = True


class TokenBody(BaseModel):
    grant_type: str = "authorization_code"
    code: str
    client_id: str
    client_secret: str
    redirect_uri: str


def _clean_scopes(scope: Optional[str]) -> str:
    parts = [s for s in (scope or "profile").split() if s in VALID_SCOPES]
    return " ".join(dict.fromkeys(parts or ["profile"]))


# ── App management (developer, session-authed) ──────────────────────────────
@router.post("/oauth/apps")
async def create_app(body: AppCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    name = (body.name or "").strip()[:80]
    uris = [u.strip() for u in (body.redirect_uris or []) if u.strip().startswith("http")]
    if not name or not uris:
        raise HTTPException(status_code=400, detail="App name and at least one https redirect URI are required")
    client_id = f"nami_cid_{secrets.token_urlsafe(12)}"
    client_secret = f"nami_csec_{secrets.token_urlsafe(24)}"
    await db.oauth_apps.insert_one({
        "client_id": client_id, "client_secret": client_secret,
        "name": name, "redirect_uris": uris[:5], "owner_id": user["user_id"],
        "created_at": datetime.now(timezone.utc),
    })
    return {"client_id": client_id, "client_secret": client_secret, "name": name, "redirect_uris": uris[:5]}


@router.get("/oauth/apps")
async def list_apps(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    rows = await db.oauth_apps.find({"owner_id": user["user_id"]}, {"_id": 0}).sort("created_at", -1).to_list(50)
    return {"apps": [
        {"client_id": r["client_id"], "name": r.get("name"), "redirect_uris": r.get("redirect_uris", []),
         "created_at": r.get("created_at")} for r in rows
    ]}


@router.delete("/oauth/apps/{client_id}")
async def delete_app(client_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    await db.oauth_apps.delete_one({"client_id": client_id, "owner_id": user["user_id"]})
    return {"deleted": True}


@router.get("/oauth/app/{client_id}")
async def app_info(client_id: str):
    """Public app metadata for the consent screen."""
    app = await db.oauth_apps.find_one({"client_id": client_id}, {"_id": 0})
    if not app:
        raise HTTPException(status_code=404, detail="Unknown app")
    return {"client_id": client_id, "name": app.get("name"), "redirect_uris": app.get("redirect_uris", [])}


# ── Authorization-code flow ─────────────────────────────────────────────────
@router.post("/oauth/authorize")
async def authorize(body: AuthorizeBody, authorization: Optional[str] = Header(None)):
    """Called by our consent screen once the logged-in user approves. Returns a
    redirect URL back to the third-party site with the code (or an error)."""
    user = await get_current_user(authorization)
    app = await db.oauth_apps.find_one({"client_id": body.client_id}, {"_id": 0})
    if not app:
        raise HTTPException(status_code=400, detail="Unknown client_id")
    if body.redirect_uri not in app.get("redirect_uris", []):
        raise HTTPException(status_code=400, detail="redirect_uri not registered for this app")
    if not body.approve:
        q = {"error": "access_denied"}
        if body.state:
            q["state"] = body.state
        return {"redirect_url": f"{body.redirect_uri}?{urlencode(q)}"}
    code = f"nami_code_{secrets.token_urlsafe(24)}"
    await db.oauth_codes.insert_one({
        "code": code, "client_id": body.client_id, "user_id": user["user_id"],
        "redirect_uri": body.redirect_uri, "scope": _clean_scopes(body.scope),
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=CODE_TTL_MIN),
    })
    q = {"code": code}
    if body.state:
        q["state"] = body.state
    return {"redirect_url": f"{body.redirect_uri}?{urlencode(q)}"}


@router.post("/oauth/token")
async def token(body: TokenBody):
    """Server-side code→token exchange (authenticated by client_secret)."""
    if body.grant_type != "authorization_code":
        raise HTTPException(status_code=400, detail="unsupported_grant_type")
    app = await db.oauth_apps.find_one({"client_id": body.client_id}, {"_id": 0})
    if not app or app.get("client_secret") != body.client_secret:
        raise HTTPException(status_code=401, detail="invalid_client")
    rec = await db.oauth_codes.find_one({"code": body.code}, {"_id": 0})
    if not rec or rec["client_id"] != body.client_id or rec["redirect_uri"] != body.redirect_uri:
        raise HTTPException(status_code=400, detail="invalid_grant")
    await db.oauth_codes.delete_one({"code": body.code})   # one-time use
    if _norm_dt(rec["expires_at"]) < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="invalid_grant (expired)")
    access_token = f"nami_at_{secrets.token_urlsafe(32)}"
    await db.oauth_tokens.insert_one({
        "access_token": access_token, "client_id": body.client_id, "user_id": rec["user_id"],
        "scope": rec.get("scope", "profile"),
        "expires_at": datetime.now(timezone.utc) + timedelta(days=TOKEN_TTL_DAYS),
        "created_at": datetime.now(timezone.utc),
    })
    return {
        "access_token": access_token, "token_type": "Bearer",
        "expires_in": TOKEN_TTL_DAYS * 86400, "scope": rec.get("scope", "profile"),
    }


class RevokeBody(BaseModel):
    token: str


@router.get("/oauth/connections")
async def my_connections(authorization: Optional[str] = Header(None)):
    """Third-party apps the current user has signed into (for a Connected Apps UI)."""
    user = await get_current_user(authorization)
    toks = await db.oauth_tokens.find({"user_id": user["user_id"]}, {"_id": 0}).sort("created_at", -1).to_list(200)
    by_client: dict = {}
    for t in toks:
        cid = t.get("client_id")
        if cid not in by_client:
            by_client[cid] = {"client_id": cid, "scope": t.get("scope", "profile"),
                              "granted_at": t.get("created_at"), "tokens": 0}
        by_client[cid]["tokens"] += 1
    if by_client:
        apps = await db.oauth_apps.find({"client_id": {"$in": list(by_client)}}, {"_id": 0, "client_id": 1, "name": 1}).to_list(200)
        names = {a["client_id"]: a.get("name", "App") for a in apps}
        for cid, c in by_client.items():
            c["name"] = names.get(cid, "App")
    return {"connections": list(by_client.values())}


@router.delete("/oauth/connections/{client_id}")
async def revoke_connection(client_id: str, authorization: Optional[str] = Header(None)):
    """Revoke a third-party app's access for the current user (all its tokens)."""
    user = await get_current_user(authorization)
    await db.oauth_tokens.delete_many({"user_id": user["user_id"], "client_id": client_id})
    await db.oauth_codes.delete_many({"user_id": user["user_id"], "client_id": client_id})
    return {"revoked": True}


@router.post("/oauth/revoke")
async def revoke_token(body: RevokeBody):
    """RFC 7009-style token revocation — always returns ok."""
    if body.token:
        await db.oauth_tokens.delete_one({"access_token": body.token})
    return {"ok": True}


@router.get("/oauth/userinfo")
async def userinfo(authorization: Optional[str] = Header(None)):
    """Third-party reads the signed-in user's profile with the access token."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    tok = authorization.split(" ", 1)[1].strip()
    rec = await db.oauth_tokens.find_one({"access_token": tok}, {"_id": 0})
    if not rec or _norm_dt(rec["expires_at"]) < datetime.now(timezone.utc):
        raise HTTPException(status_code=401, detail="invalid_token")
    u = await db.users.find_one({"user_id": rec["user_id"]}, {"_id": 0})
    if not u:
        raise HTTPException(status_code=401, detail="invalid_token")
    scopes = (rec.get("scope") or "profile").split()
    out = {
        "sub": u["user_id"],
        "name": u.get("name"),
        "preferred_username": u.get("username"),
        "picture": u.get("picture"),
        "verified": bool(u.get("verified", False)),
    }
    if "email" in scopes:
        out["email"] = u.get("email")
    return out
