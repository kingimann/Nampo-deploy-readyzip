"""Behavioural tests for ETA sharing (routes.eta), replacing the REST half of
the old eta integration test.

Pins: create persists an active share; update is owner-only (403 otherwise, 404
when missing) and moves the current position + ETA; stop is owner-only and
deactivates; the public link needs no auth and lazily expires a stale share.
The WebSocket broadcast is stubbed.
"""
from datetime import datetime, timezone, timedelta

import pytest
from fastapi import HTTPException

from routes import eta
from models import EtaShareCreate, EtaUpdate
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "me", "name": "Me"}

    async def fake_broadcast(share_id, share_doc):
        return None

    monkeypatch.setattr(eta, "db", db)
    monkeypatch.setattr(eta, "get_current_user", fake_user)
    monkeypatch.setattr(eta, "_broadcast_eta", fake_broadcast)
    return db


def _seed_share(db, *, owner="me", active=True, expires_in_min=60):
    now = datetime.now(timezone.utc)
    db.eta_shares.docs = [{
        "id": "i1", "share_id": "s1", "user_id": owner, "name": "Me",
        "destination_name": "Home",
        "destination_longitude": 1.0, "destination_latitude": 2.0,
        "current_longitude": 0.0, "current_latitude": 0.0,
        "eta_minutes": 10, "active": active,
        "expires_at": now + timedelta(minutes=expires_in_min),
        "updated_at": now, "created_at": now,
    }]


@pytest.mark.asyncio
async def test_create_persists_active_share(env):
    body = EtaShareCreate(
        destination_longitude=1.0, destination_latitude=2.0,
        initial_longitude=0.0, initial_latitude=0.0, eta_minutes=15,
    )
    out = await eta.create_eta(body)
    assert out.active is True
    assert out.eta_minutes == 15
    assert await env.eta_shares.count_documents({"share_id": out.share_id}) == 1


@pytest.mark.asyncio
async def test_update_moves_position_and_eta(env):
    _seed_share(env)
    out = await eta.update_eta("s1", EtaUpdate(current_longitude=5.0, current_latitude=6.0, eta_minutes=3))
    assert (out.current_longitude, out.current_latitude) == (5.0, 6.0)
    assert out.eta_minutes == 3


@pytest.mark.asyncio
async def test_update_non_owner_403(env):
    _seed_share(env, owner="someone-else")
    with pytest.raises(HTTPException) as ei:
        await eta.update_eta("s1", EtaUpdate(current_longitude=5.0, current_latitude=6.0))
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_update_missing_404(env):
    _seed_share(env)
    with pytest.raises(HTTPException) as ei:
        await eta.update_eta("nope", EtaUpdate(current_longitude=5.0, current_latitude=6.0))
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_stop_deactivates(env):
    _seed_share(env)
    out = await eta.stop_eta("s1")
    assert out.active is False


@pytest.mark.asyncio
async def test_public_get_needs_no_auth(env):
    _seed_share(env)
    out = await eta.get_public_eta("s1")
    assert out.share_id == "s1" and out.active is True


@pytest.mark.asyncio
async def test_public_get_expires_stale_share(env):
    _seed_share(env, expires_in_min=-1)   # already expired
    out = await eta.get_public_eta("s1")
    assert out.active is False
    assert (await env.eta_shares.find_one({"share_id": "s1"}))["active"] is False
