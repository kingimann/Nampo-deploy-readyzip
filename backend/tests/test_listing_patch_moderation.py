"""Tests for the listing PATCH status/moderation rules (routes.marketplace).

Regression guard for a moderation-bypass: re-moderation used to be skipped
whenever the client set ANY status, so a flagged listing could be silently
un-flagged with {status:"active"}. Now: marking sold skips moderation, but
activating a flagged listing re-moderates the content (so a bad listing can't
be re-activated without fixing it).
"""
import pytest

from routes import marketplace
import services.ollama as ollama
from models import ListingPatch
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    calls = {"moderate": 0}

    async def me(_a):
        return {"user_id": "owner"}

    async def hydrate(doc, viewer_id=None, with_counts=False):
        return doc

    # Default: moderation passes (not flagged). Tests override per-case.
    async def moderate_ok(title, description, photos, dup=False):
        calls["moderate"] += 1
        return {"flagged": False, "reasons": []}

    monkeypatch.setattr(marketplace, "db", db)
    monkeypatch.setattr(marketplace, "get_current_user", me)
    monkeypatch.setattr(marketplace, "_hydrate_listing", hydrate)
    monkeypatch.setattr(ollama, "moderate_listing", moderate_ok)
    return db, calls


def _seed(db, status="active", **extra):
    db.listings.docs = [{
        "id": "l1", "user_id": "owner", "title": "Bike", "description": "nice",
        "photos": [], "price": 50.0, "status": status, **extra,
    }]


@pytest.mark.asyncio
async def test_mark_sold_skips_moderation(env):
    db, calls = env
    _seed(db, status="active")
    await marketplace.patch_listing("l1", ListingPatch(status="sold"))
    assert (await db.listings.find_one({"id": "l1"}))["status"] == "sold"
    assert calls["moderate"] == 0


@pytest.mark.asyncio
async def test_activating_flagged_listing_re_moderates(env, monkeypatch):
    db, calls = env
    _seed(db, status="flagged")

    # Existing (unchanged) content is still bad → re-moderation keeps it flagged,
    # so {status:"active"} can NOT silently un-flag it.
    async def moderate_bad(title, description, photos, dup=False):
        calls["moderate"] += 1
        return {"flagged": True, "reasons": ["spam"]}
    monkeypatch.setattr(ollama, "moderate_listing", moderate_bad)

    await marketplace.patch_listing("l1", ListingPatch(status="active"))
    assert calls["moderate"] == 1
    assert (await db.listings.find_one({"id": "l1"}))["status"] == "flagged"


@pytest.mark.asyncio
async def test_fixing_flagged_content_republishes(env):
    db, calls = env
    _seed(db, status="flagged")
    # Edit the content (moderation now passes via the default ok stub).
    await marketplace.patch_listing("l1", ListingPatch(title="Clean title now"))
    assert calls["moderate"] == 1
    assert (await db.listings.find_one({"id": "l1"}))["status"] == "active"


@pytest.mark.asyncio
async def test_plain_reactivate_of_active_listing_no_moderation(env):
    db, calls = env
    _seed(db, status="active")
    await marketplace.patch_listing("l1", ListingPatch(status="active"))
    # Already active + no content change → no needless moderation call.
    assert calls["moderate"] == 0
    assert (await db.listings.find_one({"id": "l1"}))["status"] == "active"
