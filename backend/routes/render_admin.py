"""Admin: manage the Render deployment from inside the app.

Lets an admin view services, deploys and environment variables, edit env vars,
trigger deploys / restarts, and suspend/resume services — so they don't have to
keep opening the Render dashboard. All endpoints are admin-only and require a
`RENDER_API_KEY` (owner-level Render API token) on the backend.

Security note: env-var values are secrets. They're only returned to admins and
the UI masks them behind a tap-to-reveal. Editing an env var triggers a redeploy.
"""
import os
import re
from typing import Optional

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict

from core import get_current_user, is_admin

router = APIRouter()

# --- §1 response models (extra="allow") ---
class OkOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    ok: bool = True


class ServicesOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    configured: bool = False
    services: list = []


class DeploysOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    deploys: list = []


class EnvVarsOut(BaseModel):
    model_config = ConfigDict(extra="allow")
    env_vars: list = []


RENDER_API = "https://api.render.com/v1"

# Only allow safe path characters so a service id / env-var key taken from the
# URL can't inject extra path segments, query strings, or `..` traversal into
# the upstream Render API call (Render ids look like "srv-…", env keys are
# [A-Za-z0-9_]; neither contains dots, slashes, or query characters).
_SAFE_PATH_RE = re.compile(r"^/[A-Za-z0-9_/-]+$")


def _render_key() -> str:
    return os.environ.get("RENDER_API_KEY", "")


async def _require_admin(authorization: Optional[str]) -> dict:
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    return me


async def _render(method: str, path: str, **kw) -> httpx.Response:
    key = _render_key()
    if not key:
        raise HTTPException(status_code=400, detail="RENDER_API_KEY is not set on the backend.")
    if ".." in path or not _SAFE_PATH_RE.match(path):
        raise HTTPException(status_code=400, detail="Invalid service id or env-var key.")
    async with httpx.AsyncClient(timeout=25) as c:
        r = await c.request(
            method, f"{RENDER_API}{path}",
            headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
            **kw,
        )
    if r.status_code >= 400:
        # Don't echo the upstream Render response body (it can contain account
        # detail / reflected input); surface only the status to the admin.
        raise HTTPException(
            status_code=(r.status_code if 400 <= r.status_code < 500 else 502),
            detail=f"Render API request failed ({r.status_code}).",
        )
    return r


def _svc_view(s: dict) -> dict:
    det = s.get("serviceDetails") or {}
    return {
        "id": s.get("id"), "name": s.get("name"), "type": s.get("type"),
        "suspended": s.get("suspended") == "suspended",
        "auto_deploy": s.get("autoDeploy"),
        "branch": s.get("branch"), "repo": s.get("repo"),
        "url": det.get("url"),
        "dashboard_url": s.get("dashboardUrl"),
        "updated_at": s.get("updatedAt"),
    }


# ── Services ──────────────────────────────────────────────────────────────────
@router.get("/admin/render/services", response_model=ServicesOut)
async def render_services(authorization: Optional[str] = Header(None)):
    await _require_admin(authorization)
    self_id = os.environ.get("RENDER_SERVICE_ID")
    if not _render_key():
        return {"configured": False, "services": [], "self_id": self_id}
    r = await _render("GET", "/services", params={"limit": 50})
    services = [_svc_view(row.get("service", row)) for row in (r.json() or [])]
    return {"configured": True, "services": services, "self_id": self_id}


@router.get("/admin/render/services/{sid}/deploys", response_model=DeploysOut)
async def render_deploys(sid: str, authorization: Optional[str] = Header(None)):
    await _require_admin(authorization)
    r = await _render("GET", f"/services/{sid}/deploys", params={"limit": 10})
    out = []
    for row in (r.json() or []):
        d = row.get("deploy", row)
        commit = d.get("commit") or {}
        out.append({
            "id": d.get("id"), "status": d.get("status"),
            "created_at": d.get("createdAt"), "finished_at": d.get("finishedAt"),
            "commit_message": (commit.get("message") or "").split("\n")[0][:140],
            "commit_id": (commit.get("id") or "")[:7],
        })
    return {"deploys": out}


class RenderDeploy(BaseModel):
    clear_cache: bool = False


@router.post("/admin/render/services/{sid}/deploys", response_model=OkOut)
async def render_trigger_deploy(sid: str, body: RenderDeploy = RenderDeploy(), authorization: Optional[str] = Header(None)):
    await _require_admin(authorization)
    r = await _render("POST", f"/services/{sid}/deploys",
                      json={"clearCache": "clear" if body.clear_cache else "do_not_clear"})
    d = r.json() or {}
    return {"ok": True, "deploy_id": d.get("id"), "status": d.get("status")}


@router.post("/admin/render/services/{sid}/restart", response_model=OkOut)
async def render_restart(sid: str, authorization: Optional[str] = Header(None)):
    await _require_admin(authorization)
    await _render("POST", f"/services/{sid}/restart")
    return {"ok": True}


@router.post("/admin/render/services/{sid}/suspend", response_model=OkOut)
async def render_suspend(sid: str, authorization: Optional[str] = Header(None)):
    await _require_admin(authorization)
    await _render("POST", f"/services/{sid}/suspend")
    return {"ok": True}


@router.post("/admin/render/services/{sid}/resume", response_model=OkOut)
async def render_resume(sid: str, authorization: Optional[str] = Header(None)):
    await _require_admin(authorization)
    await _render("POST", f"/services/{sid}/resume")
    return {"ok": True}


# ── Environment variables ─────────────────────────────────────────────────────
@router.get("/admin/render/services/{sid}/env-vars", response_model=EnvVarsOut)
async def render_env_list(sid: str, authorization: Optional[str] = Header(None)):
    await _require_admin(authorization)
    r = await _render("GET", f"/services/{sid}/env-vars", params={"limit": 100})
    out = []
    for row in (r.json() or []):
        e = row.get("envVar", row)
        out.append({"key": e.get("key"), "value": e.get("value")})
    out.sort(key=lambda x: (x.get("key") or "").lower())
    return {"env_vars": out}


class RenderEnvSet(BaseModel):
    value: str


@router.put("/admin/render/services/{sid}/env-vars/{key}", response_model=OkOut)
async def render_env_set(sid: str, key: str, body: RenderEnvSet, authorization: Optional[str] = Header(None)):
    await _require_admin(authorization)
    r = await _render("PUT", f"/services/{sid}/env-vars/{key}", json={"value": body.value})
    e = r.json() or {}
    # Updating env vars triggers a redeploy on Render.
    return {"ok": True, "key": e.get("key", key)}


@router.delete("/admin/render/services/{sid}/env-vars/{key}", response_model=OkOut)
async def render_env_delete(sid: str, key: str, authorization: Optional[str] = Header(None)):
    await _require_admin(authorization)
    await _render("DELETE", f"/services/{sid}/env-vars/{key}")
    return {"ok": True}
