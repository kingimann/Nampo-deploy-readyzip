"""Behavioural tests for form submissions (routes.forms).

Pins: the owner-only submission list is scoped (404 for someone else's form) and
returns the total + the form's fields; the public submit endpoint 404s on an
unknown form key and silently accepts (stores nothing) when the honeypot is
filled.
"""
import pytest
from fastapi import HTTPException

from routes import forms
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "me"}

    monkeypatch.setattr(forms, "db", db)
    monkeypatch.setattr(forms, "get_current_user", fake_user)
    return db


@pytest.mark.asyncio
async def test_list_submissions_owner_scoped_404(env):
    env.forms.docs = [{"id": "f1", "owner_id": "other", "fields": []}]
    with pytest.raises(HTTPException) as ei:
        await forms.list_submissions("f1")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_list_submissions_returns_total_and_fields(env):
    env.forms.docs = [{"id": "f1", "owner_id": "me", "fields": [{"id": "q1", "label": "Name"}]}]
    env.form_submissions.docs = [
        {"form_id": "f1", "values": {"q1": "A"}, "submitted_at": 2},
        {"form_id": "f1", "values": {"q1": "B"}, "submitted_at": 1},
    ]
    out = await forms.list_submissions("f1", limit=50, offset=0)
    assert out["total"] == 2
    assert out["fields"] == [{"id": "q1", "label": "Name"}]
    assert len(out["submissions"]) == 2


@pytest.mark.asyncio
async def test_public_submit_unknown_form_404(env):
    with pytest.raises(HTTPException) as ei:
        await forms.public_submit(None, forms.FormSubmit(values={"q1": "x"}), form="missing-key")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_public_submit_honeypot_is_silently_dropped(env):
    env.forms.docs = [{"id": "f1", "form_key": "k1", "owner_id": "me", "fields": []}]
    out = await forms.public_submit(None, forms.FormSubmit(values={"q1": "x"}, hp="bot"), form="k1")
    assert out == {"ok": True}
    # Honeypot submissions store nothing.
    assert await env.form_submissions.count_documents({"form_id": "f1"}) == 0
