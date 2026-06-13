"""Behavioural tests for stories (routes.stories).

Pins: viewing a story records a unique view (idempotent via upsert), the owner
viewing their own story doesn't count, an expired/missing story 404s; the
viewer list is owner-only; delete is owner-only and cascades the view rows;
replying to your own story or with empty text is rejected.
"""
from datetime import datetime, timezone, timedelta

import pytest
from fastapi import HTTPException

from routes import stories
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "viewer"}

    monkeypatch.setattr(stories, "db", db)
    monkeypatch.setattr(stories, "get_current_user", fake_user)
    return db


def _seed_story(db, *, owner="author", expired=False):
    now = datetime.now(timezone.utc)
    db.stories.docs = [{
        "id": "s1", "user_id": owner,
        "expires_at": now - timedelta(hours=1) if expired else now + timedelta(hours=23),
    }]


@pytest.mark.asyncio
async def test_first_view_counts_then_repeat_is_noop(env):
    _seed_story(env)
    assert (await stories.view_story("s1"))["viewed"] is True
    assert (await stories.view_story("s1"))["viewed"] is False   # already viewed
    assert await env.story_views.count_documents({"story_id": "s1", "viewer_id": "viewer"}) == 1


@pytest.mark.asyncio
async def test_owner_viewing_own_story_does_not_count(env, monkeypatch):
    async def as_owner(_a):
        return {"user_id": "author"}
    monkeypatch.setattr(stories, "get_current_user", as_owner)
    _seed_story(env, owner="author")
    assert (await stories.view_story("s1"))["viewed"] is False
    assert await env.story_views.count_documents({"story_id": "s1"}) == 0


@pytest.mark.asyncio
async def test_view_expired_story_404s(env):
    _seed_story(env, expired=True)
    with pytest.raises(HTTPException) as ei:
        await stories.view_story("s1")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_viewers_list_is_owner_only(env):
    _seed_story(env, owner="author")   # viewer != author
    with pytest.raises(HTTPException) as ei:
        await stories.list_story_viewers("s1")
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_delete_owner_only_and_cascades(env, monkeypatch):
    async def as_owner(_a):
        return {"user_id": "author"}
    monkeypatch.setattr(stories, "get_current_user", as_owner)
    _seed_story(env, owner="author")
    env.story_views.docs = [{"story_id": "s1", "viewer_id": "x"}]
    await stories.delete_story("s1")
    assert await env.stories.find_one({"id": "s1"}) is None
    assert await env.story_views.count_documents({"story_id": "s1"}) == 0


@pytest.mark.asyncio
async def test_delete_non_owner_403s(env):
    _seed_story(env, owner="author")
    with pytest.raises(HTTPException) as ei:
        await stories.delete_story("s1")
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_reply_to_own_story_rejected(env, monkeypatch):
    async def as_owner(_a):
        return {"user_id": "author"}
    monkeypatch.setattr(stories, "get_current_user", as_owner)
    _seed_story(env, owner="author")
    with pytest.raises(HTTPException) as ei:
        await stories.reply_to_story("s1", stories.StoryReply(text="hi"))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_reply_empty_text_rejected(env):
    _seed_story(env, owner="author")
    with pytest.raises(HTTPException) as ei:
        await stories.reply_to_story("s1", stories.StoryReply(text="   "))
    assert ei.value.status_code == 400
