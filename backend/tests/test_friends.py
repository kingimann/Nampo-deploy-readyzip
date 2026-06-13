"""Behavioural tests for friend requests (routes.users).

Pins: a request to a stranger goes pending; you can't friend yourself or a
missing user; if the other side already requested you, requesting back makes you
friends immediately; accept turns a pending request into a friendship; accepting
or rejecting a non-existent request 404s; unfriend removes the friendship.
"""
import pytest
from fastapi import HTTPException

import routes.notifications as notifications
from routes import users
from tests._fakedb import FakeDB


def _pair(x, y):
    return tuple(sorted([x, y]))


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "me"}

    async def fake_notify(**kwargs):
        return None

    monkeypatch.setattr(users, "db", db)
    monkeypatch.setattr(users, "get_current_user", fake_user)
    # The handlers lazily `from routes.notifications import emit_notification`.
    monkeypatch.setattr(notifications, "emit_notification", fake_notify)
    db.users.docs = [{"user_id": "me"}, {"user_id": "bob"}]
    return db


async def _is_friends(db, x, y):
    a, b = _pair(x, y)
    return await db.friendships.count_documents({"a": a, "b": b}) == 1


@pytest.mark.asyncio
async def test_request_goes_pending(env):
    out = await users.send_friend_request("bob")
    assert out["status"] == "request_sent"
    req = await env.friend_requests.find_one({"from_id": "me", "to_id": "bob"})
    assert req["status"] == "pending"
    assert not await _is_friends(env, "me", "bob")


@pytest.mark.asyncio
async def test_cannot_friend_self(env):
    with pytest.raises(HTTPException) as ei:
        await users.send_friend_request("me")
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_request_to_missing_user_404s(env):
    with pytest.raises(HTTPException) as ei:
        await users.send_friend_request("ghost")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_mutual_request_becomes_friends(env):
    # bob already requested me → my request back accepts it.
    env.friend_requests.docs = [{"from_id": "bob", "to_id": "me", "status": "pending"}]
    out = await users.send_friend_request("bob")
    assert out["status"] == "friends"
    assert await _is_friends(env, "me", "bob")


@pytest.mark.asyncio
async def test_accept_pending_request(env):
    env.friend_requests.docs = [{"from_id": "bob", "to_id": "me", "status": "pending"}]
    out = await users.accept_friend_request("bob")
    assert out["status"] == "friends"
    assert await _is_friends(env, "me", "bob")
    assert (await env.friend_requests.find_one({"from_id": "bob", "to_id": "me"}))["status"] == "accepted"


@pytest.mark.asyncio
async def test_accept_without_pending_404s(env):
    with pytest.raises(HTTPException) as ei:
        await users.accept_friend_request("bob")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_reject_pending_then_missing(env):
    env.friend_requests.docs = [{"from_id": "bob", "to_id": "me", "status": "pending"}]
    out = await users.reject_friend_request("bob")
    assert out["status"] == "rejected"
    with pytest.raises(HTTPException) as ei:
        await users.reject_friend_request("carol")   # none pending
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_unfriend_removes_friendship(env):
    a, b = _pair("me", "bob")
    env.friendships.docs = [{"a": a, "b": b}]
    await users.unfriend("bob")
    assert not await _is_friends(env, "me", "bob")
