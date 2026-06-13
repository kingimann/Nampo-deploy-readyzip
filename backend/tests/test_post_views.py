"""Behavioural tests for post views (routes.posts.record_view / post_viewers).

Pins: a first view inserts a row + bumps views_count; a repeat view by the same
user is a no-op (idempotent via the unique index); viewing a missing post 404s;
the viewer list is author-or-mod only.
"""
import pytest
from fastapi import HTTPException

from routes import posts
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    # The real post_views collection has a unique (post_id, user_id) index.
    db.post_views.ensure_unique("post_id", "user_id")

    async def fake_user(_authorization):
        return {"user_id": "viewer"}

    monkeypatch.setattr(posts, "db", db)
    monkeypatch.setattr(posts, "get_current_user", fake_user)
    monkeypatch.setattr(posts, "is_mod", lambda u: False)
    monkeypatch.setattr(posts, "is_admin", lambda u: False)
    return db


@pytest.mark.asyncio
async def test_first_view_counts(env):
    env.seed(posts=[{"id": "p1", "user_id": "author", "views_count": 0}])
    out = await posts.record_view("p1")
    assert out["viewed"] is True
    assert (await env.posts.find_one({"id": "p1"}))["views_count"] == 1
    assert await env.post_views.count_documents({"post_id": "p1", "user_id": "viewer"}) == 1


@pytest.mark.asyncio
async def test_repeat_view_is_noop(env):
    env.seed(posts=[{"id": "p1", "user_id": "author", "views_count": 0}])
    await posts.record_view("p1")
    out = await posts.record_view("p1")   # same user again
    assert out["viewed"] is False
    assert (await env.posts.find_one({"id": "p1"}))["views_count"] == 1
    assert await env.post_views.count_documents({"post_id": "p1"}) == 1


@pytest.mark.asyncio
async def test_view_missing_post_404s(env):
    env.seed(posts=[])
    with pytest.raises(HTTPException) as ei:
        await posts.record_view("nope")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_viewers_list_is_author_only(env):
    # viewer is NOT the author and not a mod → 403
    env.seed(posts=[{"id": "p1", "user_id": "author", "views_count": 3}])
    with pytest.raises(HTTPException) as ei:
        await posts.post_viewers("p1")
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_viewers_missing_post_404s(env):
    env.seed(posts=[])
    with pytest.raises(HTTPException) as ei:
        await posts.post_viewers("nope")
    assert ei.value.status_code == 404
