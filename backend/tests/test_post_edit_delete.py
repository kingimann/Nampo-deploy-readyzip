"""Behavioural tests for editing and deleting posts (routes.posts).

Pins: an edit updates text and stamps edited_at; editing a post you don't own
404s; an edit that empties the post 400s; delete is owner-or-mod only, cascades
the engagement rows, and decrements a parent's reply count.
"""
import pytest
from fastapi import HTTPException

from routes import posts
from models import PostPatch
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "me"}

    async def fake_hydrate(doc, viewer_id):
        return doc

    async def clean_tags(ids, exclude=None):
        return list(ids or [])

    async def notify_tags(*a, **k):
        return None

    monkeypatch.setattr(posts, "db", db)
    monkeypatch.setattr(posts, "get_current_user", fake_user)
    monkeypatch.setattr(posts, "_hydrate_post", fake_hydrate)
    monkeypatch.setattr(posts, "_normalize_media", lambda m: list(m or []))
    monkeypatch.setattr(posts, "_clean_tag_ids", clean_tags)
    monkeypatch.setattr(posts, "_notify_tags", notify_tags)
    monkeypatch.setattr(posts, "is_mod", lambda u: False)
    return db


@pytest.mark.asyncio
async def test_edit_updates_text_and_stamps_edited_at(env):
    env.seed(posts=[{"id": "p1", "user_id": "me", "text": "old"}])
    await posts.edit_post("p1", PostPatch(text="new text"))
    doc = await env.posts.find_one({"id": "p1"})
    assert doc["text"] == "new text"
    assert doc.get("edited_at") is not None


@pytest.mark.asyncio
async def test_edit_someone_elses_post_404s(env):
    env.seed(posts=[{"id": "p1", "user_id": "author", "text": "old"}])
    with pytest.raises(HTTPException) as ei:
        await posts.edit_post("p1", PostPatch(text="hi"))
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_edit_to_empty_400s(env):
    env.seed(posts=[{"id": "p1", "user_id": "me", "text": "old", "media": []}])
    with pytest.raises(HTTPException) as ei:
        await posts.edit_post("p1", PostPatch(text="   "))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_delete_owner_cascades_and_decrements_parent(env):
    env.seed(
        posts=[
            {"id": "parent", "user_id": "x", "replies_count": 1},
            {"id": "p1", "user_id": "me", "parent_id": "parent"},
        ],
        post_reactions=[{"post_id": "p1", "user_id": "a"}],
        post_bookmarks=[{"post_id": "p1", "user_id": "b"}],
        post_views=[{"post_id": "p1", "user_id": "c"}],
    )
    await posts.delete_post("p1")
    assert await env.posts.find_one({"id": "p1"}) is None
    assert (await env.posts.find_one({"id": "parent"}))["replies_count"] == 0
    assert await env.post_reactions.count_documents({"post_id": "p1"}) == 0
    assert await env.post_bookmarks.count_documents({"post_id": "p1"}) == 0
    assert await env.post_views.count_documents({"post_id": "p1"}) == 0


@pytest.mark.asyncio
async def test_delete_non_owner_non_mod_404s(env):
    env.seed(posts=[{"id": "p1", "user_id": "author"}])
    with pytest.raises(HTTPException) as ei:
        await posts.delete_post("p1")
    assert ei.value.status_code == 404
    assert await env.posts.find_one({"id": "p1"}) is not None


@pytest.mark.asyncio
async def test_mod_can_delete_anyones_post(env, monkeypatch):
    monkeypatch.setattr(posts, "is_mod", lambda u: True)
    env.seed(posts=[{"id": "p1", "user_id": "author"}])
    await posts.delete_post("p1")
    assert await env.posts.find_one({"id": "p1"}) is None
