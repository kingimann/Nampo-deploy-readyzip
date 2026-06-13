"""Behavioural tests for support tickets (routes.support).

Pins: create requires subject + message and opens an awaiting_staff ticket with
the first message; replying needs ownership-or-staff (404/403) and non-empty
text, and a staff reply flips the ticket to awaiting_user + marks it unread for
the owner + notifies; a user can close their own ticket but not set arbitrary
statuses; opening your own ticket clears the unread flag.
"""
import pytest
from fastapi import HTTPException

from routes import support
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    notifications = []

    async def fake_user(_authorization):
        return {"user_id": "me"}

    async def fake_hydrate(t, with_messages=False):
        return t

    async def fake_notify(**kwargs):
        notifications.append(kwargs)

    monkeypatch.setattr(support, "db", db)
    monkeypatch.setattr(support, "get_current_user", fake_user)
    monkeypatch.setattr(support, "_hydrate_ticket", fake_hydrate)
    monkeypatch.setattr(support, "emit_notification", fake_notify)
    monkeypatch.setattr(support, "_staff", lambda u: False)
    return db, notifications


@pytest.mark.asyncio
async def test_create_requires_subject_and_message(env):
    with pytest.raises(HTTPException) as ei:
        await support.create_ticket(support.TicketCreate(category="bug", subject="", message="hi"))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_create_opens_ticket_with_first_message(env):
    db, _ = env
    await support.create_ticket(support.TicketCreate(subject="Help", message="It broke", category="bug"))
    tickets = db.support_tickets.docs
    assert len(tickets) == 1
    assert tickets[0]["status"] == "awaiting_staff" and tickets[0]["category"] == "bug"
    assert await db.support_messages.count_documents({"ticket_id": tickets[0]["id"]}) == 1


@pytest.mark.asyncio
async def test_reply_requires_ownership(env):
    db, _ = env
    db.support_tickets.docs = [{"id": "t1", "user_id": "someone-else", "subject": "x"}]
    with pytest.raises(HTTPException) as ei:
        await support.reply_ticket("t1", support.TicketReply(text="hi"))
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_reply_missing_ticket_404s(env):
    with pytest.raises(HTTPException) as ei:
        await support.reply_ticket("nope", support.TicketReply(text="hi"))
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_user_reply_sets_awaiting_staff(env):
    db, _ = env
    db.support_tickets.docs = [{"id": "t1", "user_id": "me", "subject": "x", "status": "awaiting_user"}]
    await support.reply_ticket("t1", support.TicketReply(text="any update?"))
    t = await db.support_tickets.find_one({"id": "t1"})
    assert t["status"] == "awaiting_staff"
    assert t["unread_for_user"] is False


@pytest.mark.asyncio
async def test_staff_reply_marks_unread_and_notifies(env, monkeypatch):
    db, notifications = env
    monkeypatch.setattr(support, "_staff", lambda u: True)
    db.support_tickets.docs = [{"id": "t1", "user_id": "customer", "subject": "Broken"}]
    await support.reply_ticket("t1", support.TicketReply(text="Looking into it"))
    t = await db.support_tickets.find_one({"id": "t1"})
    assert t["status"] == "awaiting_user"
    assert t["unread_for_user"] is True
    assert len(notifications) == 1 and notifications[0]["ntype"] == "support"


@pytest.mark.asyncio
async def test_get_ticket_clears_unread_for_owner(env):
    db, _ = env
    db.support_tickets.docs = [{"id": "t1", "user_id": "me", "subject": "x", "unread_for_user": True}]
    await support.get_ticket("t1")
    assert (await db.support_tickets.find_one({"id": "t1"}))["unread_for_user"] is False


@pytest.mark.asyncio
async def test_user_cannot_set_arbitrary_status(env):
    db, _ = env
    db.support_tickets.docs = [{"id": "t1", "user_id": "me", "subject": "x", "status": "awaiting_staff"}]
    with pytest.raises(HTTPException) as ei:
        await support.set_status("t1", support.TicketStatus(status="resolved"))
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_reply_accepts_message_as_alias_for_text(env):
    # Older app builds send {"message": ...}; the backend treats it as `text`.
    db, _ = env
    db.support_tickets.docs = [{"id": "t1", "user_id": "me", "subject": "x", "status": "awaiting_staff"}]
    await support.reply_ticket("t1", support.TicketReply(message="via alias"))
    assert await db.support_messages.count_documents({"ticket_id": "t1"}) == 1
    msg = (await db.support_messages.find_one({"ticket_id": "t1"}))
    assert msg["text"] == "via alias"


@pytest.mark.asyncio
async def test_reply_empty_text_still_rejected(env):
    db, _ = env
    db.support_tickets.docs = [{"id": "t1", "user_id": "me", "subject": "x"}]
    with pytest.raises(HTTPException) as ei:
        await support.reply_ticket("t1", support.TicketReply())   # neither text nor message
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_user_can_close_own_ticket(env):
    db, _ = env
    db.support_tickets.docs = [{"id": "t1", "user_id": "me", "subject": "x", "status": "awaiting_staff"}]
    await support.set_status("t1", support.TicketStatus(status="closed"))
    assert (await db.support_tickets.find_one({"id": "t1"}))["status"] == "closed"
