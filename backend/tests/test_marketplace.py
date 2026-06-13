"""Behavioural tests for marketplace save / unsave / delete (routes.marketplace).

Pins: saving a listing is idempotent and 404s on a missing listing; unsaving
removes the save row; deleting is owner-scoped (404 for someone else's listing).
"""
import pytest
from fastapi import HTTPException

from routes import marketplace
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "me"}

    monkeypatch.setattr(marketplace, "db", db)
    monkeypatch.setattr(marketplace, "get_current_user", fake_user)
    return db


@pytest.mark.asyncio
async def test_save_is_idempotent(env):
    env.seed(listings=[{"id": "l1", "user_id": "seller"}])
    out = await marketplace.save_listing("l1")
    assert out["saved"] is True
    await marketplace.save_listing("l1")   # again
    assert await env.listing_saves.count_documents({"listing_id": "l1", "user_id": "me"}) == 1


@pytest.mark.asyncio
async def test_save_missing_listing_404s(env):
    env.seed(listings=[])
    with pytest.raises(HTTPException) as ei:
        await marketplace.save_listing("nope")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_unsave_removes_the_row(env):
    env.seed(
        listings=[{"id": "l1", "user_id": "seller"}],
        listing_saves=[{"id": "s1", "listing_id": "l1", "user_id": "me"}],
    )
    out = await marketplace.unsave_listing("l1")
    assert out["saved"] is False
    assert await env.listing_saves.count_documents({"listing_id": "l1", "user_id": "me"}) == 0


@pytest.mark.asyncio
async def test_delete_own_listing(env):
    env.seed(listings=[{"id": "l1", "user_id": "me"}])
    out = await marketplace.delete_listing("l1")
    assert out["ok"] is True
    assert await env.listings.find_one({"id": "l1"}) is None


@pytest.mark.asyncio
async def test_delete_someone_elses_listing_404s(env):
    env.seed(listings=[{"id": "l1", "user_id": "seller"}])
    with pytest.raises(HTTPException) as ei:
        await marketplace.delete_listing("l1")
    assert ei.value.status_code == 404
    assert await env.listings.find_one({"id": "l1"}) is not None
