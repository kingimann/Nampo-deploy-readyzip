"""Tests for saved-listing price-drop alerts (routes.marketplace.patch_listing).

Lowering an active listing's price notifies everyone who saved it (except the
owner). Raising/unchanged price, or a sold edit, sends nothing.
"""
import pytest

from routes import marketplace
import routes.notifications as notifications
from models import ListingPatch
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    notes = []

    async def me(_a):
        return {"user_id": "owner"}

    async def hydrate(doc, *a, **k):
        return doc

    async def fake_emit(**kwargs):
        notes.append(kwargs)

    monkeypatch.setattr(marketplace, "db", db)
    monkeypatch.setattr(marketplace, "get_current_user", me)
    monkeypatch.setattr(marketplace, "_hydrate_listing", hydrate)
    monkeypatch.setattr(notifications, "emit_notification", fake_emit)
    db.listings.docs = [{"id": "l1", "user_id": "owner", "title": "Bike",
                         "description": "", "photos": [], "price": 100.0, "status": "active"}]
    db.listing_saves.docs = [
        {"id": "x1", "listing_id": "l1", "user_id": "alice"},
        {"id": "x2", "listing_id": "l1", "user_id": "bob"},
        {"id": "x3", "listing_id": "l1", "user_id": "owner"},   # owner shouldn't be pinged
    ]
    return db, notes


@pytest.mark.asyncio
async def test_price_drop_notifies_savers_not_owner(env):
    _, notes = env
    await marketplace.patch_listing("l1", ListingPatch(price=80))
    recipients = sorted(n["user_id"] for n in notes)
    assert recipients == ["alice", "bob"]
    assert all("Price dropped" in n["message"] for n in notes)
    assert all(n["post_id"] == "l1" for n in notes)


@pytest.mark.asyncio
async def test_price_increase_does_not_notify(env):
    _, notes = env
    await marketplace.patch_listing("l1", ListingPatch(price=120))
    assert notes == []


@pytest.mark.asyncio
async def test_same_price_does_not_notify(env):
    _, notes = env
    await marketplace.patch_listing("l1", ListingPatch(price=100))
    assert notes == []


@pytest.mark.asyncio
async def test_no_savers_no_notify(env):
    db, notes = env
    db.listing_saves.docs = []
    await marketplace.patch_listing("l1", ListingPatch(price=50))
    assert notes == []
