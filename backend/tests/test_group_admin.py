"""Behavioural tests for group admin actions (routes.groups).

Pins promote/demote/pin/unpin/kick rules from the removed group-admin
integration test: owner-only role changes (404 for a non-member, can't touch the
owner), pin requires the post to be in the group and is idempotent, and an admin
can't kick another admin (only the owner can).
"""
import pytest
from fastapi import HTTPException

from routes import groups
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_hydrate(doc, viewer_id):
        return doc

    monkeypatch.setattr(groups, "db", db)
    monkeypatch.setattr(groups, "_hydrate_group", fake_hydrate)
    return db


def _as(monkeypatch, user_id):
    async def fake_user(_authorization):
        return {"user_id": user_id}
    monkeypatch.setattr(groups, "get_current_user", fake_user)


@pytest.mark.asyncio
async def test_owner_promotes_member_to_admin(env, monkeypatch):
    _as(monkeypatch, "owner")
    env.seed(
        groups=[{"id": "g1", "owner_id": "owner"}],
        group_members=[{"group_id": "g1", "user_id": "bob", "role": "member"}],
    )
    await groups.promote_member("g1", "bob")
    assert (await env.group_members.find_one({"group_id": "g1", "user_id": "bob"}))["role"] == "admin"


@pytest.mark.asyncio
async def test_non_owner_cannot_promote(env, monkeypatch):
    _as(monkeypatch, "bob")
    env.seed(
        groups=[{"id": "g1", "owner_id": "owner"}],
        group_members=[{"group_id": "g1", "user_id": "carol", "role": "member"}],
    )
    with pytest.raises(HTTPException) as ei:
        await groups.promote_member("g1", "carol")
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_promote_non_member_404s(env, monkeypatch):
    _as(monkeypatch, "owner")
    env.seed(groups=[{"id": "g1", "owner_id": "owner"}], group_members=[])
    with pytest.raises(HTTPException) as ei:
        await groups.promote_member("g1", "ghost")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_demote_back_to_member(env, monkeypatch):
    _as(monkeypatch, "owner")
    env.seed(
        groups=[{"id": "g1", "owner_id": "owner"}],
        group_members=[{"group_id": "g1", "user_id": "bob", "role": "admin"}],
    )
    await groups.demote_member("g1", "bob")
    assert (await env.group_members.find_one({"group_id": "g1", "user_id": "bob"}))["role"] == "member"


@pytest.mark.asyncio
async def test_pin_requires_post_in_group_then_is_idempotent(env, monkeypatch):
    _as(monkeypatch, "owner")
    env.seed(
        groups=[{"id": "g1", "owner_id": "owner", "pinned_post_ids": []}],
        posts=[{"id": "p1", "group_id": "g1"}],
    )
    # A post that isn't in the group can't be pinned.
    with pytest.raises(HTTPException) as ei:
        await groups.pin_post("g1", "not-in-group")
    assert ei.value.status_code == 404

    await groups.pin_post("g1", "p1")
    await groups.pin_post("g1", "p1")   # idempotent
    pins = (await env.groups.find_one({"id": "g1"}))["pinned_post_ids"]
    assert pins == ["p1"]


@pytest.mark.asyncio
async def test_unpin_removes_the_pin(env, monkeypatch):
    _as(monkeypatch, "owner")
    env.seed(groups=[{"id": "g1", "owner_id": "owner", "pinned_post_ids": ["p1", "p2"]}])
    await groups.unpin_post("g1", "p1")
    assert (await env.groups.find_one({"id": "g1"}))["pinned_post_ids"] == ["p2"]


@pytest.mark.asyncio
async def test_admin_cannot_kick_another_admin(env, monkeypatch):
    _as(monkeypatch, "adminA")
    env.seed(
        groups=[{"id": "g1", "owner_id": "owner"}],
        group_members=[
            {"group_id": "g1", "user_id": "adminA", "role": "admin"},
            {"group_id": "g1", "user_id": "adminB", "role": "admin"},
        ],
    )
    with pytest.raises(HTTPException) as ei:
        await groups.kick_member("g1", "adminB")
    assert ei.value.status_code == 403
    # adminB is still a member.
    assert await env.group_members.count_documents({"group_id": "g1", "user_id": "adminB"}) == 1
