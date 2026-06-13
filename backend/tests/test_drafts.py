"""Behavioural tests for server-side post drafts (routes.drafts).

Pins: create persists a draft and round-trips the payload; the per-user cap
evicts the oldest; update/delete are owner-scoped (404 otherwise).
"""
from datetime import datetime, timezone, timedelta

import pytest
from fastapi import HTTPException

from routes import drafts
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "me"}

    monkeypatch.setattr(drafts, "db", db)
    monkeypatch.setattr(drafts, "get_current_user", fake_user)
    return db


@pytest.mark.asyncio
async def test_create_persists_payload(env):
    out = await drafts.create_draft(drafts.DraftBody(payload={"text": "wip"}))
    assert out.payload == {"text": "wip"}
    assert await env.drafts.count_documents({"user_id": "me"}) == 1


@pytest.mark.asyncio
async def test_cap_evicts_oldest(env):
    now = datetime.now(timezone.utc)
    env.drafts.docs = [
        {"id": f"d{i}", "user_id": "me", "payload": {}, "updated_at": now - timedelta(minutes=drafts.MAX_DRAFTS - i)}
        for i in range(drafts.MAX_DRAFTS)
    ]
    oldest_id = "d0"   # smallest updated_at
    await drafts.create_draft(drafts.DraftBody(payload={"text": "newest"}))
    assert await env.drafts.count_documents({"user_id": "me"}) == drafts.MAX_DRAFTS
    assert await env.drafts.find_one({"id": oldest_id}) is None


@pytest.mark.asyncio
async def test_update_own_draft(env):
    env.drafts.docs = [{"id": "d1", "user_id": "me", "payload": {"text": "old"},
                        "created_at": datetime.now(timezone.utc), "updated_at": datetime.now(timezone.utc)}]
    out = await drafts.update_draft("d1", drafts.DraftBody(payload={"text": "new"}))
    assert out.payload == {"text": "new"}


@pytest.mark.asyncio
async def test_update_others_draft_404s(env):
    env.drafts.docs = [{"id": "d1", "user_id": "other", "payload": {}}]
    with pytest.raises(HTTPException) as ei:
        await drafts.update_draft("d1", drafts.DraftBody(payload={"text": "x"}))
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_delete_own_then_others(env):
    env.drafts.docs = [
        {"id": "mine", "user_id": "me", "payload": {}},
        {"id": "theirs", "user_id": "other", "payload": {}},
    ]
    await drafts.delete_draft("mine")
    assert await env.drafts.find_one({"id": "mine"}) is None
    with pytest.raises(HTTPException) as ei:
        await drafts.delete_draft("theirs")
    assert ei.value.status_code == 404
