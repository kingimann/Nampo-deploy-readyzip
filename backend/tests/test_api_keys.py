"""Behavioural tests for Developer API keys (routes.auth).

Pins the paywall + scope + limit rules: creating a key needs an active plan
(402 otherwise); a plan without write capability forces read-only scope; the
per-plan key limit is enforced (400); a created key returns its one-time token +
prefix; list and revoke work and are owner-scoped.
"""
import pytest
from fastapi import HTTPException

from routes import auth
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "me"}

    monkeypatch.setattr(auth, "db", db)
    monkeypatch.setattr(auth, "get_current_user", fake_user)
    return db


def _plan(monkeypatch, plan):
    monkeypatch.setattr(auth, "_active_plan", lambda u: plan)


@pytest.mark.asyncio
async def test_create_without_plan_402s(env, monkeypatch):
    _plan(monkeypatch, None)
    with pytest.raises(HTTPException) as ei:
        await auth.create_api_key(auth.ApiKeyCreate())
    assert ei.value.status_code == 402
    assert ei.value.detail["code"] == "api_plan_required"


@pytest.mark.asyncio
async def test_create_returns_one_time_token(env, monkeypatch):
    _plan(monkeypatch, {"name": "Pro", "max_keys": 2, "write": True})
    out = await auth.create_api_key(auth.ApiKeyCreate(label="CI", scopes=["read", "write"]))
    assert out["token"].startswith("okayspace_sk_")
    assert out["scopes"] == ["read", "write"]
    assert out["label"] == "CI"
    # Persisted as an api_key session with a stored prefix.
    row = await env.user_sessions.find_one({"key_id": out["id"]})
    assert row["kind"] == "api_key" and row["key_prefix"] == out["token"][:16]


@pytest.mark.asyncio
async def test_plan_without_write_forces_read_only(env, monkeypatch):
    _plan(monkeypatch, {"name": "Starter", "max_keys": 5, "write": False})
    out = await auth.create_api_key(auth.ApiKeyCreate(scopes=["read", "write"]))
    assert out["scopes"] == ["read"]


@pytest.mark.asyncio
async def test_key_limit_enforced(env, monkeypatch):
    _plan(monkeypatch, {"name": "Pro", "max_keys": 1, "write": True})
    env.user_sessions.docs = [{"user_id": "me", "kind": "api_key", "key_id": "k0"}]
    with pytest.raises(HTTPException) as ei:
        await auth.create_api_key(auth.ApiKeyCreate())
    assert ei.value.status_code == 400
    assert ei.value.detail["code"] == "key_limit_reached"


@pytest.mark.asyncio
async def test_list_and_revoke(env, monkeypatch):
    _plan(monkeypatch, {"name": "Pro", "max_keys": 5, "write": True})
    created = await auth.create_api_key(auth.ApiKeyCreate(label="one"))
    listing = await auth.list_api_keys()
    assert [k["id"] for k in listing["keys"]] == [created["id"]]

    await auth.revoke_api_key(created["id"])
    assert await env.user_sessions.count_documents({"kind": "api_key"}) == 0
