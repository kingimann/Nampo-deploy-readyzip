"""Test for the purchases view (routes.marketplace.my_purchases)."""
import pytest

from routes import marketplace
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def me(_a):
        return {"user_id": "buyer"}

    async def hydrate(doc, *a, **k):
        return doc

    async def saved_ids(_uid):
        return set()

    monkeypatch.setattr(marketplace, "db", db)
    monkeypatch.setattr(marketplace, "get_current_user", me)
    monkeypatch.setattr(marketplace, "_hydrate_listing", hydrate)
    monkeypatch.setattr(marketplace, "_saved_ids_for", saved_ids)
    return db


@pytest.mark.asyncio
async def test_purchases_returns_only_my_sold_items_newest_first(env):
    env.listings.docs = [
        {"id": "a", "status": "sold", "sold_to": "buyer", "sold_at": 1},
        {"id": "b", "status": "sold", "sold_to": "buyer", "sold_at": 2},
        {"id": "c", "status": "sold", "sold_to": "someone_else", "sold_at": 3},
        {"id": "d", "status": "active", "sold_to": None, "sold_at": None},
    ]
    out = await marketplace.my_purchases()
    assert [o["id"] for o in out] == ["b", "a"]   # mine, newest sold_at first


@pytest.mark.asyncio
async def test_no_purchases_is_empty(env):
    env.listings.docs = [{"id": "x", "status": "active"}]
    assert await marketplace.my_purchases() == []
