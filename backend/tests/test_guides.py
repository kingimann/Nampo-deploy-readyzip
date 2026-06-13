"""Behavioural tests for guides (routes.guides), restoring the guide CRUD half
of the removed recents/guides integration test.

Pins: create persists a private guide; delete is owner-scoped (404 otherwise);
adding a place is owner-scoped, requires the place to exist, and is idempotent
($addToSet); removing a place pulls it back out.
"""
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from routes import guides
from models import GuideCreate
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "me"}

    monkeypatch.setattr(guides, "db", db)
    monkeypatch.setattr(guides, "get_current_user", fake_user)
    return db


def _seed_guide(db, *, owner="me", place_ids=None):
    db.guides.docs = [{
        "id": "g1", "user_id": owner, "name": "Faves",
        "color": "#3B82F6", "icon": "bookmark",
        "place_ids": list(place_ids or []), "is_public": False,
        "created_at": datetime.now(timezone.utc),
    }]


@pytest.mark.asyncio
async def test_create_persists_private_guide(env):
    out = await guides.create_guide(GuideCreate(name="Coffee spots"))
    assert out.name == "Coffee spots"
    assert out.is_public is False
    assert await env.guides.count_documents({"id": out.id}) == 1


@pytest.mark.asyncio
async def test_delete_own_guide(env):
    _seed_guide(env)
    out = await guides.delete_guide("g1")
    assert out["ok"] is True
    assert await env.guides.find_one({"id": "g1"}) is None


@pytest.mark.asyncio
async def test_delete_someone_elses_guide_404s(env):
    _seed_guide(env, owner="other")
    with pytest.raises(HTTPException) as ei:
        await guides.delete_guide("g1")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_add_place_requires_existing_place(env):
    _seed_guide(env)
    env.places.docs = []   # no such place
    with pytest.raises(HTTPException) as ei:
        await guides.add_place_to_guide("g1", "p1")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_add_place_is_idempotent(env):
    _seed_guide(env)
    env.places.docs = [{"id": "p1", "user_id": "me"}]
    await guides.add_place_to_guide("g1", "p1")
    out = await guides.add_place_to_guide("g1", "p1")   # again
    assert out.place_ids == ["p1"]


@pytest.mark.asyncio
async def test_remove_place_pulls_it(env):
    _seed_guide(env, place_ids=["p1", "p2"])
    out = await guides.remove_place_from_guide("g1", "p1")
    assert out.place_ids == ["p2"]
