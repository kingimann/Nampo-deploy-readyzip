"""Behavioural tests for audience circles (routes.circles).

Pins: create requires a name and persists the owner's circle; the per-owner cap
is enforced; patch adds/removes members and renames; delete is owner-scoped
(404 otherwise). Members can never include the owner.
"""
import pytest
from fastapi import HTTPException

from routes import circles
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "me"}

    monkeypatch.setattr(circles, "db", db)
    monkeypatch.setattr(circles, "get_current_user", fake_user)
    return db


@pytest.mark.asyncio
async def test_create_requires_a_name(env):
    with pytest.raises(HTTPException) as ei:
        await circles.create_circle(circles.CircleCreate(name="   "))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_create_persists_and_excludes_owner_from_members(env):
    out = await circles.create_circle(
        circles.CircleCreate(name="Work", member_ids=["a", "me", "b", "a"])
    )
    assert out["name"] == "Work"
    # owner stripped, duplicates collapsed
    assert sorted(out["member_ids"]) == ["a", "b"]
    assert out["member_count"] == 2
    assert await env.circles.count_documents({"owner_id": "me"}) == 1


@pytest.mark.asyncio
async def test_cap_is_enforced(env):
    env.circles.docs = [{"id": f"c{i}", "owner_id": "me", "name": "x"} for i in range(50)]
    with pytest.raises(HTTPException) as ei:
        await circles.create_circle(circles.CircleCreate(name="One too many"))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_patch_adds_and_removes_members_and_renames(env):
    env.circles.docs = [{"id": "c1", "owner_id": "me", "name": "Old", "member_ids": ["a", "b"]}]
    out = await circles.update_circle(
        "c1",
        circles.CirclePatch(name="New", add_member_ids=["c"], remove_member_ids=["a"]),
    )
    assert out["name"] == "New"
    assert sorted(out["member_ids"]) == ["b", "c"]


@pytest.mark.asyncio
async def test_delete_missing_circle_404s(env):
    env.circles.docs = []
    with pytest.raises(HTTPException) as ei:
        await circles.delete_circle("nope")
    assert ei.value.status_code == 404
