"""Behavioural tests for saved places (routes.places).

Pins: create persists a place; get/delete are owner-scoped (404 otherwise);
deleting a place also pulls it out of any of the owner's guides.
"""
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from routes import places
from models import PlaceCreate
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
async def test_create_persists_place(env):
    out = await places.create_place(
        PlaceCreate(title="Cafe", longitude=1.0, latitude=2.0, category="coffee")
    )
    assert out.title == "Cafe"
    assert await env.places.count_documents({"user_id": "me"}) == 1


@pytest.mark.asyncio
async def test_get_someone_elses_place_404s(env):
    env.places.docs = [{"id": "p1", "user_id": "other", "title": "x",
                        "longitude": 0.0, "latitude": 0.0, "category": "marker",
                        "created_at": datetime.now(timezone.utc)}]
    with pytest.raises(HTTPException) as ei:
        await places.get_place("p1")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_delete_pulls_from_guides(env):
    env.places.docs = [{"id": "p1", "user_id": "me", "title": "x",
                        "longitude": 0.0, "latitude": 0.0, "category": "marker",
                        "created_at": datetime.now(timezone.utc)}]
    env.guides.docs = [
        {"id": "g1", "user_id": "me", "place_ids": ["p1", "p2"]},
        {"id": "g2", "user_id": "me", "place_ids": ["p3"]},
    ]
    await places.delete_place("p1")
    assert await env.places.find_one({"id": "p1"}) is None
    assert (await env.guides.find_one({"id": "g1"}))["place_ids"] == ["p2"]
    assert (await env.guides.find_one({"id": "g2"}))["place_ids"] == ["p3"]


@pytest.mark.asyncio
async def test_delete_missing_404s(env):
    env.places.docs = []
    with pytest.raises(HTTPException) as ei:
        await places.delete_place("nope")
    assert ei.value.status_code == 404
