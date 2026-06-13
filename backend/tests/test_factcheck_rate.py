"""Behavioural tests for rating community-note factchecks (routes.factchecks).

Pins: a first rating is recorded and the tallies recomputed; re-rating switches
the vote (not double-counts); clearing (helpful=None) removes it; once a note
clears the helpful threshold (and leads) its status flips to "shown"; rating a
missing note 404s.
"""
import pytest
from fastapi import HTTPException

from routes import factchecks
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "voter"}

    async def fake_refresh(post_id):
        return None

    async def fake_notify(**kwargs):
        return None

    monkeypatch.setattr(factchecks, "db", db)
    monkeypatch.setattr(factchecks, "get_current_user", fake_user)
    monkeypatch.setattr(factchecks, "_refresh_post_factcheck", fake_refresh)
    monkeypatch.setattr(factchecks, "emit_notification", fake_notify)
    db.factchecks.docs = [{"id": "fc1", "post_id": "p1", "author_id": "author",
                           "helpful_count": 0, "not_helpful_count": 0, "status": "pending"}]
    return db


async def _rate(value, user="voter"):
    return await factchecks.rate_factcheck("fc1", factchecks.FactcheckRate(helpful=value))


@pytest.mark.asyncio
async def test_first_helpful_rating_recorded(env):
    await _rate(True)
    assert await env.factcheck_ratings.count_documents({"factcheck_id": "fc1", "user_id": "voter"}) == 1
    assert (await env.factchecks.find_one({"id": "fc1"}))["helpful_count"] == 1


@pytest.mark.asyncio
async def test_re_rating_switches_not_double_counts(env):
    await _rate(True)
    await _rate(False)   # same user switches
    fc = await env.factchecks.find_one({"id": "fc1"})
    assert fc["helpful_count"] == 0
    assert fc["not_helpful_count"] == 1
    assert await env.factcheck_ratings.count_documents({"factcheck_id": "fc1", "user_id": "voter"}) == 1


@pytest.mark.asyncio
async def test_clearing_removes_rating(env):
    await _rate(True)
    await _rate(None)   # clear
    assert await env.factcheck_ratings.count_documents({"factcheck_id": "fc1"}) == 0


@pytest.mark.asyncio
async def test_crossing_threshold_marks_shown(env):
    # Seed enough helpful votes from other users, then this voter tips it over.
    env.factcheck_ratings.docs = [
        {"factcheck_id": "fc1", "user_id": f"u{i}", "helpful": True}
        for i in range(factchecks.HELPFUL_THRESHOLD - 1)
    ]
    await _rate(True)
    fc = await env.factchecks.find_one({"id": "fc1"})
    assert fc["helpful_count"] == factchecks.HELPFUL_THRESHOLD
    assert fc["status"] == "shown"


@pytest.mark.asyncio
async def test_rate_missing_note_404s(env):
    with pytest.raises(HTTPException) as ei:
        await factchecks.rate_factcheck("nope", factchecks.FactcheckRate(helpful=True))
    assert ei.value.status_code == 404
