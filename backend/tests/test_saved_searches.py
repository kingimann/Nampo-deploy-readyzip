"""Tests for marketplace saved searches (routes.marketplace).

Pins: save creates a search (no badge at creation); listing reports the count of
active listings matching the criteria created since last_checked_at; marking
seen clears the badge; delete is owner-scoped.
"""
from datetime import datetime, timezone, timedelta

import pytest

from routes import marketplace
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def me(_a):
        return {"user_id": "u1"}

    monkeypatch.setattr(marketplace, "db", db)
    monkeypatch.setattr(marketplace, "get_current_user", me)
    return db


@pytest.mark.asyncio
async def test_save_creates_with_no_badge(env):
    out = await marketplace.save_search(
        marketplace.SavedSearchBody(query="bike", category="vehicles", max_price=200))
    assert out["new_count"] == 0
    assert out["query"] == "bike" and out["category"] == "vehicles"
    assert await env.marketplace_saved_searches.count_documents({"user_id": "u1"}) == 1


@pytest.mark.asyncio
async def test_list_counts_new_matches_since_last_checked(env):
    old = datetime.now(timezone.utc) - timedelta(days=1)
    new = datetime.now(timezone.utc)
    env.marketplace_saved_searches.docs = [{
        "id": "s1", "user_id": "u1", "name": "Bikes", "query": "bike",
        "category": "vehicles", "condition": None, "min_price": None, "max_price": 200.0,
        "sort": None, "created_at": old, "last_checked_at": old,
    }]
    env.listings.docs = [
        # matches: active, vehicles, price<=200, title has "bike", created after last check
        {"id": "l1", "status": "active", "category": "vehicles", "price": 100.0,
         "title": "Mountain bike", "description": "", "created_at": new},
        # too expensive
        {"id": "l2", "status": "active", "category": "vehicles", "price": 500.0,
         "title": "bike", "description": "", "created_at": new},
        # wrong text
        {"id": "l3", "status": "active", "category": "vehicles", "price": 50.0,
         "title": "skateboard", "description": "", "created_at": new},
        # old (created before last check)
        {"id": "l4", "status": "active", "category": "vehicles", "price": 80.0,
         "title": "bike", "description": "", "created_at": old - timedelta(days=2)},
        # sold
        {"id": "l5", "status": "sold", "category": "vehicles", "price": 80.0,
         "title": "bike", "description": "", "created_at": new},
    ]
    out = await marketplace.list_saved_searches()
    assert len(out["searches"]) == 1
    assert out["searches"][0]["new_count"] == 1   # only l1


@pytest.mark.asyncio
async def test_mark_seen_clears_badge(env):
    old = datetime.now(timezone.utc) - timedelta(days=1)
    env.marketplace_saved_searches.docs = [{
        "id": "s1", "user_id": "u1", "name": "All", "query": None, "category": None,
        "condition": None, "min_price": None, "max_price": None, "sort": None,
        "created_at": old, "last_checked_at": old,
    }]
    env.listings.docs = [{"id": "l1", "status": "active", "category": "x", "price": 5.0,
                          "title": "thing", "description": "", "created_at": datetime.now(timezone.utc)}]
    before = await marketplace.list_saved_searches()
    assert before["searches"][0]["new_count"] == 1
    await marketplace.mark_saved_search_seen("s1")
    after = await marketplace.list_saved_searches()
    assert after["searches"][0]["new_count"] == 0


@pytest.mark.asyncio
async def test_delete_owner_scoped(env):
    env.marketplace_saved_searches.docs = [{"id": "s1", "user_id": "other"}]
    with pytest.raises(Exception) as ei:
        await marketplace.delete_saved_search("s1")
    assert ei.value.status_code == 404
    assert await env.marketplace_saved_searches.count_documents({"id": "s1"}) == 1


@pytest.mark.asyncio
async def test_seen_missing_404(env):
    with pytest.raises(Exception) as ei:
        await marketplace.mark_saved_search_seen("nope")
    assert ei.value.status_code == 404
