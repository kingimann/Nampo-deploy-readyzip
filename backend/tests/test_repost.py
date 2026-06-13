"""Behavioural tests for the repost toggle (routes.posts.toggle_repost).

Re-creates the coverage of the old Emergent-era integration test as a fast
in-process test: it drives the real handler against a FakeDB and stubs only the
heavy edges (post hydration, notification fan-out, subscription lookup). Pins:
  * first repost creates a repost doc + bumps reposts_count + notifies the author
  * a second call toggles it off (idempotent per user + original post)
  * reposting a repost resolves to the ORIGINAL post
  * a missing post 404s
  * subscriber-only posts gate reposting with 403
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
        return doc  # passthrough — we assert on the raw doc / db side effects

    async def fake_notify(**kwargs):
        notifications.append(kwargs)

    async def sub_level_zero(viewer_id, creator_id):
        return 0

    monkeypatch.setattr(posts, "db", db)
    monkeypatch.setattr(posts, "get_current_user", fake_user)
    monkeypatch.setattr(posts, "_hydrate_post", fake_hydrate)
    monkeypatch.setattr(posts, "emit_notification", fake_notify)
    monkeypatch.setattr(posts, "_viewer_sub_level", sub_level_zero)
    monkeypatch.setattr(posts, "_has_playable_video", lambda doc: False)
    return db, notifications


def _reposts_of(db, original_id):
    return [d for d in db.posts.docs if d.get("repost_of") == original_id]


@pytest.mark.asyncio
async def test_first_repost_creates_doc_bumps_count_and_notifies(env):
    db, notifications = env
    db.seed(posts=[{"id": "p1", "user_id": "author", "text": "hello", "reposts_count": 0}])

    await posts.toggle_repost("p1")

    assert len(_reposts_of(db, "p1")) == 1
    original = await db.posts.find_one({"id": "p1"})
    assert original["reposts_count"] == 1
    assert len(notifications) == 1
    assert notifications[0]["ntype"] == "repost"
    assert notifications[0]["user_id"] == "author"
    assert notifications[0]["actor_id"] == "viewer"


@pytest.mark.asyncio
async def test_second_repost_toggles_off(env):
    db, notifications = env
    db.seed(posts=[{"id": "p1", "user_id": "author", "text": "hello", "reposts_count": 0}])

    await posts.toggle_repost("p1")
    await posts.toggle_repost("p1")   # toggle off

    assert _reposts_of(db, "p1") == []
    original = await db.posts.find_one({"id": "p1"})
    assert original["reposts_count"] == 0
    # No notification fires on the un-repost.
    assert len(notifications) == 1


@pytest.mark.asyncio
async def test_repost_of_a_repost_resolves_to_original(env):
    db, _ = env
    db.seed(posts=[
        {"id": "orig", "user_id": "author", "text": "hi", "reposts_count": 0},
        {"id": "rp", "user_id": "someone", "repost_of": "orig", "reposts_count": 0},
    ])

    await posts.toggle_repost("rp")

    # The new repost points at the ORIGINAL, and the original's count moves.
    mine = [d for d in _reposts_of(db, "orig") if d["user_id"] == "viewer"]
    assert len(mine) == 1
    assert (await db.posts.find_one({"id": "orig"}))["reposts_count"] == 1


@pytest.mark.asyncio
async def test_missing_post_404s(env):
    db, _ = env
    db.seed(posts=[])
    with pytest.raises(HTTPException) as ei:
        await posts.toggle_repost("nope")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_subscriber_only_post_blocks_non_subscriber(env, monkeypatch):
    db, _ = env
    db.seed(posts=[{"id": "p1", "user_id": "author", "min_sub_tier": 2, "reposts_count": 0}])
    # viewer's sub level is 0 (< tier 2) via the fixture stub.

    with pytest.raises(HTTPException) as ei:
        await posts.toggle_repost("p1")
    assert ei.value.status_code == 403
    assert ei.value.detail["code"] == "subscribers_only"
    # Nothing was created and the count is untouched.
    assert _reposts_of(db, "p1") == []
    assert (await db.posts.find_one({"id": "p1"}))["reposts_count"] == 0
