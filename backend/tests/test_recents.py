"""Behavioural tests for recent locations (routes.places recents).

Pins: create persists a recent and de-dupes a near-identical same-name entry;
the per-user list is capped (oldest beyond 20 are dropped); delete is
owner-scoped (404 otherwise); clear removes only the caller's recents.
"""
from datetime import datetime, timezone, timedelta

import pytest
from fastapi import HTTPException

from routes import places
from models import RecentCreate
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "me"}

    monkeypatch.setattr(places, "db", db)
    monkeypatch.setattr(places, "get_current_user", fake_user)
    return db


@pytest.mark.asyncio
async def test_create_dedupes_nearby_same_name(env):
    await places.create_recent(RecentCreate(name="Cafe", longitude=1.0, latitude=2.0))
    await places.create_recent(RecentCreate(name="Cafe", longitude=1.00001, latitude=2.00001))
    # The near-identical re-search replaces the first, leaving one row.
    assert await env.recents.count_documents({"user_id": "me", "name": "Cafe"}) == 1


@pytest.mark.asyncio
async def test_create_caps_at_twenty(env):
    now = datetime.now(timezone.utc)
    env.recents.docs = [
        {"id": f"r{i}", "user_id": "me", "name": f"n{i}",
         "longitude": float(i), "latitude": 0.0, "full_address": "",
         "created_at": now - timedelta(minutes=100 - i)}
        for i in range(20)
    ]
    await places.create_recent(RecentCreate(name="newest", longitude=999.0, latitude=0.0))
    assert await env.recents.count_documents({"user_id": "me"}) == 20
    # The oldest (r0) was evicted; the newest is present.
    assert await env.recents.count_documents({"name": "n0"}) == 0
    assert await env.recents.count_documents({"name": "newest"}) == 1


@pytest.mark.asyncio
async def test_delete_owner_scoped(env):
    env.recents.docs = [{"id": "r1", "user_id": "other", "name": "x",
                         "longitude": 0.0, "latitude": 0.0}]
    with pytest.raises(HTTPException) as ei:
        await places.delete_recent("r1")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_clear_only_my_recents(env):
    env.recents.docs = [
        {"id": "r1", "user_id": "me", "name": "a", "longitude": 0.0, "latitude": 0.0},
        {"id": "r2", "user_id": "me", "name": "b", "longitude": 0.0, "latitude": 0.0},
        {"id": "r3", "user_id": "other", "name": "c", "longitude": 0.0, "latitude": 0.0},
    ]
    await places.clear_recents()
    assert await env.recents.count_documents({"user_id": "me"}) == 0
    assert await env.recents.count_documents({"user_id": "other"}) == 1
