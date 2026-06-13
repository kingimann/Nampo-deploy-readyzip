"""Behavioural tests for bookmarks (routes.posts.toggle_bookmark / list_bookmarks).

Pins: toggling a bookmark on inserts a row and bumps bookmarks_count; toggling
off removes it and decrements; a missing post 404s; and the list returns the
bookmarked posts newest-first.
"""
import pytest
from fastapi import HTTPException

from routes import posts
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "viewer"}

    async def fake_hydrate(doc, viewer_id):
        return doc

    async def fake_hydrate_many(docs, viewer_id):
        return docs

    monkeypatch.setattr(posts, "db", db)
    monkeypatch.setattr(posts, "get_current_user", fake_user)
    monkeypatch.setattr(posts, "_hydrate_post", fake_hydrate)
    monkeypatch.setattr(posts, "_hydrate_many", fake_hydrate_many)
    return db


@pytest.mark.asyncio
async def test_bookmark_on_then_off(env):
    db = env
    db.seed(posts=[{"id": "p1", "user_id": "author", "bookmarks_count": 0}])

    await posts.toggle_bookmark("p1")
    assert await db.post_bookmarks.count_documents({"post_id": "p1", "user_id": "viewer"}) == 1
    assert (await db.posts.find_one({"id": "p1"}))["bookmarks_count"] == 1

    await posts.toggle_bookmark("p1")   # toggle off
    assert await db.post_bookmarks.count_documents({"post_id": "p1"}) == 0
    assert (await db.posts.find_one({"id": "p1"}))["bookmarks_count"] == 0


@pytest.mark.asyncio
async def test_bookmark_missing_post_404s(env):
    env.seed(posts=[])
    with pytest.raises(HTTPException) as ei:
        await posts.toggle_bookmark("nope")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_list_bookmarks_is_newest_first(env):
    db = env
    db.seed(
        posts=[
            {"id": "old", "user_id": "a"},
            {"id": "new", "user_id": "b"},
        ],
        post_bookmarks=[
            {"post_id": "old", "user_id": "viewer", "created_at": 1},
            {"post_id": "new", "user_id": "viewer", "created_at": 2},
        ],
    )
    out = await posts.list_bookmarks()
    assert [d["id"] for d in out] == ["new", "old"]


@pytest.mark.asyncio
async def test_list_bookmarks_empty(env):
    env.seed(posts=[{"id": "p1", "user_id": "a"}], post_bookmarks=[])
    assert await posts.list_bookmarks() == []
