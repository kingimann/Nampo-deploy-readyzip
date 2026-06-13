"""Regression test for marketplace listing sort values (routes.marketplace).

The app used to send price_asc/price_desc, which the backend didn't recognise
(it silently fell back to "recent"). The accepted values are price_low /
price_high / popular / nearby — pin them so the UI/backend can't drift apart.
"""
import pytest

from routes import marketplace
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def me(_a):
        return {"user_id": "viewer"}

    async def hydrate(doc, *args, **kwargs):
        return doc

    monkeypatch.setattr(marketplace, "db", db)
    monkeypatch.setattr(marketplace, "get_current_user", me)
    monkeypatch.setattr(marketplace, "_hydrate_listing", hydrate)
    db.listings.docs = [
        {"id": "cheap", "user_id": "s", "title": "A", "status": "active", "price": 10.0, "views_count": 1, "created_at": 1},
        {"id": "mid", "user_id": "s", "title": "B", "status": "active", "price": 50.0, "views_count": 99, "created_at": 2},
        {"id": "dear", "user_id": "s", "title": "C", "status": "active", "price": 90.0, "views_count": 5, "created_at": 3},
    ]
    return db


async def _ids(sort):
    # Pass every param explicitly — calling the endpoint directly (not through
    # FastAPI) would otherwise leave Query(...) default objects in place.
    out = await marketplace.list_listings(
        category=None, q=None, status="active", condition=None,
        min_price=None, max_price=None, sort=sort,
        lat=None, lng=None, radius_km=None, authorization=None,
    )
    return [o["id"] for o in out]


@pytest.mark.asyncio
async def test_price_low_sorts_ascending(env):
    assert await _ids("price_low") == ["cheap", "mid", "dear"]


@pytest.mark.asyncio
async def test_price_high_sorts_descending(env):
    assert await _ids("price_high") == ["dear", "mid", "cheap"]


@pytest.mark.asyncio
async def test_popular_sorts_by_views(env):
    assert (await _ids("popular"))[0] == "mid"   # 99 views


@pytest.mark.asyncio
async def test_default_recent_sorts_by_created_desc(env):
    assert await _ids("recent") == ["dear", "mid", "cheap"]
