"""Test the admin cleanup of deleted-user (orphaned) posts.

routes.posts.cleanup_orphaned_posts removes posts whose author no longer exists,
plus their engagement, and fixes surviving parents' reply counts. Admin-only.
"""
import pytest

from routes import posts
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    monkeypatch.setattr(posts, "db", db)
    return db


def _as_admin(monkeypatch, admin=True):
    async def me(_a):
        return {"user_id": "admin"}
    monkeypatch.setattr(posts, "get_current_user", me)
    monkeypatch.setattr(posts, "is_admin", lambda u: admin)


@pytest.mark.asyncio
async def test_non_admin_forbidden(env, monkeypatch):
    _as_admin(monkeypatch, admin=False)
    with pytest.raises(Exception) as ei:
        await posts.cleanup_orphaned_posts()
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_removes_orphans_keeps_live_posts(env, monkeypatch):
    _as_admin(monkeypatch)
    env.users.docs = [{"user_id": "alive"}]
    env.posts.docs = [
        {"id": "p1", "user_id": "alive", "parent_id": None},      # keep
        {"id": "p2", "user_id": "ghost", "parent_id": None},      # orphan → remove
        {"id": "p3", "user_id": "ghost", "parent_id": "p1"},      # orphan reply → remove + dec parent
    ]
    env.posts.docs[0]["replies_count"] = 1
    env.post_reactions.docs = [{"post_id": "p2", "user_id": "x"}]
    env.post_views.docs = [{"post_id": "p3", "user_id": "y"}]

    out = await posts.cleanup_orphaned_posts()
    assert out["removed"] == 2
    ids = {p["id"] for p in env.posts.docs}
    assert ids == {"p1"}
    # Surviving parent's reply count was decremented for the removed orphan reply.
    assert (await env.posts.find_one({"id": "p1"}))["replies_count"] == 0
    # Engagement for the removed posts is gone.
    assert await env.post_reactions.count_documents({"post_id": "p2"}) == 0
    assert await env.post_views.count_documents({"post_id": "p3"}) == 0


@pytest.mark.asyncio
async def test_no_orphans_is_zero(env, monkeypatch):
    _as_admin(monkeypatch)
    env.users.docs = [{"user_id": "alive"}]
    env.posts.docs = [{"id": "p1", "user_id": "alive", "parent_id": None}]
    out = await posts.cleanup_orphaned_posts()
    assert out["removed"] == 0 and out["scanned"] == 1
    assert await env.posts.count_documents({}) == 1
