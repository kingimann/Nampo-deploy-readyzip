"""Support & disputes — users open tickets (incl. payment disputes) and message
back and forth with staff; admins triage and resolve them."""
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel

from core import db, get_current_user, is_admin, is_mod, _public_user
from routes.notifications import emit_notification

router = APIRouter()

CATEGORIES = {"dispute", "payment", "account", "content", "bug", "safety", "other"}
OPEN_STATUSES = {"open", "awaiting_staff", "awaiting_user"}


class TicketCreate(BaseModel):
    category: str
    subject: str
    message: str
    related_type: Optional[str] = None   # e.g. "transfer", "listing", "post"
    related_id: Optional[str] = None


class TicketReply(BaseModel):
    text: str


class TicketStatus(BaseModel):
    status: str  # open | awaiting_staff | awaiting_user | resolved | closed


def _staff(user: dict) -> bool:
    return is_admin(user) or is_mod(user)


async def _hydrate_ticket(t: dict, with_messages: bool = False) -> dict:
    out = {
        "id": t["id"],
        "user_id": t["user_id"],
        "category": t.get("category", "other"),
        "subject": t.get("subject", ""),
        "status": t.get("status", "open"),
        "related_type": t.get("related_type"),
        "related_id": t.get("related_id"),
        "created_at": t.get("created_at"),
        "updated_at": t.get("updated_at") or t.get("created_at"),
        "last_message_at": t.get("last_message_at") or t.get("created_at"),
        "unread_for_user": bool(t.get("unread_for_user", False)),
        "user": (await _public_user(t["user_id"])).model_dump() if t.get("user_id") else None,
    }
    if with_messages:
        rows = await db.support_messages.find(
            {"ticket_id": t["id"]}, {"_id": 0}
        ).sort("created_at", 1).to_list(500)
        out["messages"] = [{
            "id": m["id"],
            "sender_id": m.get("sender_id"),
            "is_staff": bool(m.get("is_staff", False)),
            "text": m.get("text", ""),
            "created_at": m.get("created_at"),
        } for m in rows]
    return out


@router.post("/support/tickets")
async def create_ticket(body: TicketCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    category = (body.category or "other").strip().lower()
    if category not in CATEGORIES:
        category = "other"
    subject = (body.subject or "").strip()[:140]
    message = (body.message or "").strip()[:4000]
    if not subject or not message:
        raise HTTPException(status_code=400, detail="A subject and a message are required.")
    now = datetime.now(timezone.utc)
    ticket_id = f"tkt_{uuid.uuid4().hex[:12]}"
    await db.support_tickets.insert_one({
        "id": ticket_id,
        "user_id": user["user_id"],
        "category": category,
        "subject": subject,
        "status": "awaiting_staff",
        "related_type": (body.related_type or None),
        "related_id": (body.related_id or None),
        "created_at": now,
        "updated_at": now,
        "last_message_at": now,
        "unread_for_user": False,
    })
    await db.support_messages.insert_one({
        "id": str(uuid.uuid4()),
        "ticket_id": ticket_id,
        "sender_id": user["user_id"],
        "is_staff": False,
        "text": message,
        "created_at": now,
    })
    # A roadside job is only flagged as disputed once a valid ticket actually
    # exists — so backing out of the composer never leaves a phantom dispute.
    if (body.related_type or "") == "roadside" and (body.related_id or "").strip():
        try:
            from routes.roadside import mark_roadside_disputed
            await mark_roadside_disputed(body.related_id.strip(), user["user_id"])
        except Exception:
            pass
    # Email the staff team (best-effort) so disputes don't sit unseen.
    try:
        import os
        from services.email import send_email, email_enabled
        admins = [e.strip() for e in (os.environ.get("ADMIN_EMAILS", "") or "").split(",") if e.strip()]
        if email_enabled() and admins:
            who = user.get("name") or user.get("username") or "A user"
            for ae in admins:
                send_email(
                    ae, f"[Support · {category}] {subject}",
                    f"{who} opened a support ticket.\n\nCategory: {category}\nSubject: {subject}\n\n{message[:1500]}\n\nReply from the staff inbox in the app.",
                )
    except Exception:
        pass
    doc = await db.support_tickets.find_one({"id": ticket_id}, {"_id": 0})
    return await _hydrate_ticket(doc, with_messages=True)


@router.get("/support/unread-count")
async def unread_count(authorization: Optional[str] = Header(None)):
    """Tickets needing the user's attention (a staff reply they haven't opened)."""
    user = await get_current_user(authorization)
    try:
        n = await db.support_tickets.count_documents({"user_id": user["user_id"], "unread_for_user": True})
    except Exception:
        n = 0
    return {"count": n}


@router.get("/support/tickets")
async def my_tickets(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    rows = await db.support_tickets.find(
        {"user_id": user["user_id"]}, {"_id": 0}
    ).sort("last_message_at", -1).to_list(100)
    return [await _hydrate_ticket(t) for t in rows]


@router.get("/support/tickets/{ticket_id}")
async def get_ticket(ticket_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    t = await db.support_tickets.find_one({"id": ticket_id}, {"_id": 0})
    if not t:
        raise HTTPException(status_code=404, detail="Ticket not found")
    if t["user_id"] != user["user_id"] and not _staff(user):
        raise HTTPException(status_code=403, detail="Not your ticket")
    # Opening your own ticket clears the unread flag.
    if t["user_id"] == user["user_id"] and t.get("unread_for_user"):
        await db.support_tickets.update_one({"id": ticket_id}, {"$set": {"unread_for_user": False}})
        t["unread_for_user"] = False
    return await _hydrate_ticket(t, with_messages=True)


@router.post("/support/tickets/{ticket_id}/messages")
async def reply_ticket(ticket_id: str, body: TicketReply, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    t = await db.support_tickets.find_one({"id": ticket_id}, {"_id": 0})
    if not t:
        raise HTTPException(status_code=404, detail="Ticket not found")
    staff = _staff(user)
    if t["user_id"] != user["user_id"] and not staff:
        raise HTTPException(status_code=403, detail="Not your ticket")
    text = (body.text or "").strip()[:4000]
    if not text:
        raise HTTPException(status_code=400, detail="Message can't be empty.")
    now = datetime.now(timezone.utc)
    await db.support_messages.insert_one({
        "id": str(uuid.uuid4()),
        "ticket_id": ticket_id,
        "sender_id": user["user_id"],
        "is_staff": staff,
        "text": text,
        "created_at": now,
    })
    patch = {
        "last_message_at": now,
        "updated_at": now,
        "status": "awaiting_user" if staff else "awaiting_staff",
        "unread_for_user": staff,  # a staff reply is unread for the ticket owner
    }
    await db.support_tickets.update_one({"id": ticket_id}, {"$set": patch})
    if staff:
        try:
            await emit_notification(
                user_id=t["user_id"], actor_id=user["user_id"], ntype="support",
                message=f"Support replied: {t.get('subject', '')[:80]}",
            )
        except Exception:
            pass
    doc = await db.support_tickets.find_one({"id": ticket_id}, {"_id": 0})
    return await _hydrate_ticket(doc, with_messages=True)


@router.post("/support/tickets/{ticket_id}/status")
async def set_status(ticket_id: str, body: TicketStatus, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    t = await db.support_tickets.find_one({"id": ticket_id}, {"_id": 0})
    if not t:
        raise HTTPException(status_code=404, detail="Ticket not found")
    status = (body.status or "").strip().lower()
    # Users may only close/reopen their own ticket; staff can set any status.
    if _staff(user):
        if status not in OPEN_STATUSES | {"resolved", "closed"}:
            raise HTTPException(status_code=400, detail="Invalid status")
    else:
        if t["user_id"] != user["user_id"] or status not in {"closed", "open"}:
            raise HTTPException(status_code=403, detail="Not allowed")
    await db.support_tickets.update_one(
        {"id": ticket_id}, {"$set": {"status": status, "updated_at": datetime.now(timezone.utc)}}
    )
    doc = await db.support_tickets.find_one({"id": ticket_id}, {"_id": 0})
    return await _hydrate_ticket(doc, with_messages=True)


@router.get("/admin/support/tickets")
async def admin_tickets(
    status: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    user = await get_current_user(authorization)
    if not _staff(user):
        raise HTTPException(status_code=403, detail="Staff only")
    q: dict = {}
    if status == "open":
        q = {"status": {"$in": list(OPEN_STATUSES)}}
    elif status:
        q = {"status": status}
    rows = await db.support_tickets.find(q, {"_id": 0}).sort("last_message_at", -1).to_list(200)
    return [await _hydrate_ticket(t) for t in rows]
