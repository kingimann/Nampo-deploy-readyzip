"""Behavioural tests for group join/leave (routes.groups).

Pins the membership rules the old integration suite covered:
  * joining a public group adds a member row (idempotent)
  * joining a private group creates a pending join request + notifies the owner
    (no member row yet)
  * leaving removes the member row and any pending request
  * the owner cannot leave their own group
  * join/leave on a missing group 404s
"""
import pytest
from fastapi import HTTPException

from routes import groups
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    notifications = []

    async def fake_user(_authorization):
        return {"user_id": "viewer"}

    async def fake_hydrate(doc, viewer_id):
        return doc

    async def fake_notify(user_id, actor_id, ntype, group_id):
        notifications.append((user_id, actor_id, ntype, group_id))

    monkeypatch.setattr(groups, "db", db)
    monkeypatch.setattr(groups, "get_current_user", fake_user)
    monkeypatch.setattr(groups, "_hydrate_group", fake_hydrate)
    monkeypatch.setattr(groups, "_notify", fake_notify)
    return db, notifications


@pytest.mark.asyncio
async def test_join_public_group_adds_member(env):
    db, _ = env
    db.seed(groups=[{"id": "g1", "owner_id": "owner", "is_private": False}])

    await groups.join_group("g1")

    assert await db.group_members.count_documents({"group_id": "g1", "user_id": "viewer"}) == 1


@pytest.mark.asyncio
async def test_join_public_group_is_idempotent(env):
    db, _ = env
    db.seed(groups=[{"id": "g1", "owner_id": "owner", "is_private": False}])

    await groups.join_group("g1")
    await groups.join_group("g1")

    assert await db.group_members.count_documents({"group_id": "g1", "user_id": "viewer"}) == 1


@pytest.mark.asyncio
async def test_join_private_group_creates_request_and_notifies(env):
    db, notifications = env
    db.seed(groups=[{"id": "g1", "owner_id": "owner", "is_private": True}])

    await groups.join_group("g1")

    # No member yet — a pending request instead.
    assert await db.group_members.count_documents({"group_id": "g1"}) == 0
    req = await db.group_join_requests.find_one({"group_id": "g1", "user_id": "viewer"})
    assert req and req["status"] == "pending"
    assert notifications == [("owner", "viewer", "group_join_request", "g1")]


@pytest.mark.asyncio
async def test_leave_removes_member_and_request(env):
    db, _ = env
    db.seed(
        groups=[{"id": "g1", "owner_id": "owner", "is_private": False}],
        group_members=[{"group_id": "g1", "user_id": "viewer", "role": "member"}],
        group_join_requests=[{"group_id": "g1", "user_id": "viewer", "status": "pending"}],
    )

    await groups.leave_group("g1")

    assert await db.group_members.count_documents({"group_id": "g1", "user_id": "viewer"}) == 0
    assert await db.group_join_requests.count_documents({"group_id": "g1", "user_id": "viewer"}) == 0


@pytest.mark.asyncio
async def test_owner_cannot_leave(env, monkeypatch):
    db, _ = env
    db.seed(groups=[{"id": "g1", "owner_id": "viewer", "is_private": False}])

    with pytest.raises(HTTPException) as ei:
        await groups.leave_group("g1")
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_join_missing_group_404s(env):
    env[0].seed(groups=[])
    with pytest.raises(HTTPException) as ei:
        await groups.join_group("nope")
    assert ei.value.status_code == 404
