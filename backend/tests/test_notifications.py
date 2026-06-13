"""Behavioural tests for notification read/delete (routes.notifications).

Pins: the unread count, marking one read (scoped to the owner, 404 otherwise),
marking all read, and deleting (scoped, 404 otherwise) — the half of the old
notifications integration test that doesn't need the emit/fan-out machinery.
"""
import pytest
from fastapi import HTTPException

from routes import notifications as notif
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "me"}

    monkeypatch.setattr(notif, "db", db)
    monkeypatch.setattr(notif, "get_current_user", fake_user)
    return db


def _seed(db):
    db.seed(notifications=[
        {"id": "n1", "user_id": "me", "read": False},
        {"id": "n2", "user_id": "me", "read": False},
        {"id": "n3", "user_id": "me", "read": True},
        {"id": "x1", "user_id": "other", "read": False},
    ])


@pytest.mark.asyncio
async def test_unread_count_is_scoped_to_user(env):
    _seed(env)
    assert (await notif.unread_count())["count"] == 2


@pytest.mark.asyncio
async def test_mark_one_read(env):
    _seed(env)
    await notif.mark_one_read("n1")
    assert (await env.notifications.find_one({"id": "n1"}))["read"] is True
    assert (await notif.unread_count())["count"] == 1


@pytest.mark.asyncio
async def test_mark_one_read_other_users_notif_404s(env):
    _seed(env)
    with pytest.raises(HTTPException) as ei:
        await notif.mark_one_read("x1")   # belongs to "other"
    assert ei.value.status_code == 404
    # untouched
    assert (await env.notifications.find_one({"id": "x1"}))["read"] is False


@pytest.mark.asyncio
async def test_mark_all_read(env):
    _seed(env)
    await notif.mark_all_read()
    assert (await notif.unread_count())["count"] == 0
    # The other user's notification is left alone.
    assert (await env.notifications.find_one({"id": "x1"}))["read"] is False


@pytest.mark.asyncio
async def test_list_hydrates_actors_from_one_batch(env):
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    env.seed(
        users=[
            {"user_id": "a1", "name": "Ada", "picture": "p1"},
            {"user_id": "a2", "name": "Bo", "picture": "p2"},
        ],
        notifications=[
            {"id": "n1", "user_id": "me", "type": "like", "actor_id": "a1",
             "read": False, "created_at": now},
            {"id": "n2", "user_id": "me", "type": "reply", "actor_id": "a2",
             "read": False, "created_at": now},
            {"id": "n3", "user_id": "me", "type": "system", "actor_id": None,
             "read": True, "created_at": now},
        ],
    )
    out = await notif.list_notifications()
    by_id = {n.id: n for n in out}
    assert by_id["n1"].actor_name == "Ada" and by_id["n1"].actor_picture == "p1"
    assert by_id["n2"].actor_name == "Bo"
    assert by_id["n3"].actor_name is None  # no actor → no lookup
    assert len(out) == 3


@pytest.mark.asyncio
async def test_delete_notification(env):
    _seed(env)
    await notif.delete_notification("n1")
    assert await env.notifications.find_one({"id": "n1"}) is None


@pytest.mark.asyncio
async def test_delete_other_users_notif_404s(env):
    _seed(env)
    with pytest.raises(HTTPException) as ei:
        await notif.delete_notification("x1")
    assert ei.value.status_code == 404
    assert await env.notifications.find_one({"id": "x1"}) is not None
