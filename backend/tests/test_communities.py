"""Behavioural tests for community membership + favorites (routes.communities).

Pins: join is idempotent (unique member index) and case-insensitive on the
name, missing community 404s, leave removes the member row, and favorite /
unfavorite toggle the favorite row.
"""
import pytest
from fastapi import HTTPException

from routes import communities
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    db.community_members.ensure_unique("community_id", "user_id")
    db.community_favorites.ensure_unique("community_id", "user_id")

    async def fake_user(_authorization):
        return {"user_id": "me"}

    monkeypatch.setattr(communities, "db", db)
    monkeypatch.setattr(communities, "get_current_user", fake_user)
    db.communities.docs = [{"id": "c1", "name": "coffee"}]
    return db


@pytest.mark.asyncio
async def test_join_is_idempotent_and_case_insensitive(env):
    out = await communities.join_community("Coffee")   # mixed case
    assert out["joined"] is True
    await communities.join_community("coffee")          # again
    assert await env.community_members.count_documents({"community_id": "c1", "user_id": "me"}) == 1


@pytest.mark.asyncio
async def test_join_missing_community_404s(env):
    with pytest.raises(HTTPException) as ei:
        await communities.join_community("ghosttown")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_leave_removes_member(env):
    await communities.join_community("coffee")
    out = await communities.leave_community("coffee")
    assert out["joined"] is False
    assert await env.community_members.count_documents({"community_id": "c1"}) == 0


@pytest.mark.asyncio
async def test_favorite_then_unfavorite(env):
    fav = await communities.favorite_community("coffee")
    assert fav["favorite"] is True
    assert await env.community_favorites.count_documents({"community_id": "c1", "user_id": "me"}) == 1

    unfav = await communities.unfavorite_community("coffee")
    assert unfav["favorite"] is False
    assert await env.community_favorites.count_documents({"community_id": "c1"}) == 0


@pytest.mark.asyncio
async def test_favorite_is_idempotent(env):
    await communities.favorite_community("coffee")
    await communities.favorite_community("coffee")
    assert await env.community_favorites.count_documents({"community_id": "c1", "user_id": "me"}) == 1
