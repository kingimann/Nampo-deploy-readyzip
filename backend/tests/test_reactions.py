"""Behavioural tests for emoji reactions (routes.posts._apply_reaction), which
backs POST /posts/{id}/like and /dislike.

Pins the one-reaction-per-user-per-post rules the old integration suite covered:
  * a fresh reaction inserts a row, bumps reactions[emoji] + likes_count, notifies
  * the same emoji again toggles off (counts back to zero)
  * a different emoji switches the tally without touching likes_count net
  * subscriber-only and likes-disabled posts are gated
"""
import pytest
from fastapi import HTTPException

from routes import posts
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    notifications = []

    async def fake_user(_authorization):
        return {"user_id": "viewer"}

    async def fake_hydrate(doc, viewer_id):
        return doc

    async def fake_notify(**kwargs):
        notifications.append(kwargs)

    async def sub_level_zero(viewer_id, creator_id):
        return 0

    monkeypatch.setattr(posts, "db", db)
    monkeypatch.setattr(posts, "get_current_user", fake_user)
    monkeypatch.setattr(posts, "_hydrate_post", fake_hydrate)
    monkeypatch.setattr(posts, "emit_notification", fake_notify)
    monkeypatch.setattr(posts, "_viewer_sub_level", sub_level_zero)
    monkeypatch.setattr(posts, "is_admin", lambda u: False)
    return db, notifications


async def _react(emoji="👍"):
    return await posts._apply_reaction("p1", {"user_id": "viewer"}, emoji)


@pytest.mark.asyncio
async def test_fresh_like_tallies_and_notifies(env):
    db, notifications = env
    db.seed(posts=[{"id": "p1", "user_id": "author", "text": "hi", "likes_count": 0}])

    await _react("👍")

    post = await db.posts.find_one({"id": "p1"})
    assert post["likes_count"] == 1
    assert post["reactions"]["👍"] == 1
    assert await db.post_reactions.count_documents({"post_id": "p1", "user_id": "viewer"}) == 1
    assert len(notifications) == 1 and notifications[0]["ntype"] == "like"


@pytest.mark.asyncio
async def test_same_emoji_toggles_off(env):
    db, _ = env
    db.seed(posts=[{"id": "p1", "user_id": "author", "likes_count": 0}])

    await _react("👍")
    await _react("👍")   # toggle off

    post = await db.posts.find_one({"id": "p1"})
    assert post["likes_count"] == 0
    assert post["reactions"]["👍"] == 0
    assert await db.post_reactions.count_documents({"post_id": "p1"}) == 0


@pytest.mark.asyncio
async def test_switching_emoji_moves_the_tally(env):
    db, _ = env
    db.seed(posts=[{"id": "p1", "user_id": "author", "likes_count": 0}])

    await _react("👍")
    await _react("👎")   # switch

    post = await db.posts.find_one({"id": "p1"})
    assert post["reactions"]["👍"] == 0
    assert post["reactions"]["👎"] == 1
    # Net one reaction by this user, so likes_count stays at 1 (not 2).
    assert post["likes_count"] == 1
    assert await db.post_reactions.count_documents({"post_id": "p1", "user_id": "viewer"}) == 1


@pytest.mark.asyncio
async def test_subscriber_only_post_blocks_reaction(env):
    db, _ = env
    db.seed(posts=[{"id": "p1", "user_id": "author", "min_sub_tier": 2, "likes_count": 0}])
    with pytest.raises(HTTPException) as ei:
        await _react("👍")
    assert ei.value.status_code == 403
    assert ei.value.detail["code"] == "subscribers_only"


@pytest.mark.asyncio
async def test_likes_disabled_post_blocks_new_reaction(env):
    db, _ = env
    db.seed(posts=[{"id": "p1", "user_id": "author", "likes_disabled": True, "likes_count": 0}])
    with pytest.raises(HTTPException) as ei:
        await _react("👍")
    assert ei.value.status_code == 403
