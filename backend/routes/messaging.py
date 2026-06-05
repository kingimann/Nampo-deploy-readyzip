"""Conversations & Messages: 1:1 DMs, group chats, soft delete.

Conversation document shape:
  {
    id, kind: "dm"|"group",
    key (DM only, sorted pair) | None,
    participant_ids: [...],          # current members
    deleted_by: [user_id, ...],      # soft-delete per user (DM only)
    name, avatar, owner_id           # group only
    last_message_at, created_at,
    last_read: { user_id: datetime }
  }

Soft delete (DM): adds the requesting user to `deleted_by` and bumps
their `cleared_at` so old messages are hidden from them. Sending a new
message OR receiving one re-surfaces the conversation (removes them
from `deleted_by`).
"""
from datetime import datetime, timezone, timedelta
from typing import List, Optional
import uuid

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from core import _conv_key, _public_user, db, get_current_user, is_admin, _norm_dt
from models import (
    ConversationCreate,
    ConversationView,
    CustomEmoji,
    CustomEmojiCreate,
    GroupConversationCreate,
    GroupConversationPatch,
    Message,
    MessageCreate,
    MessageEdit,
    MessageReact,
    PublicUser,
)
import re as _re
from routes.notifications import emit_notification
from services.encryption import encrypt_text, decrypt_text
from services.link_preview import fetch_link_preview, first_url


def _decrypt_msg(doc: dict) -> dict:
    """Return a copy of `doc` with text fields decrypted for the API response."""
    if not doc:
        return doc
    out = dict(doc)
    out["text"] = decrypt_text(doc.get("text") or "")
    out["edit_history"] = [
        {"text": decrypt_text(h.get("text") or ""), "edited_at": h.get("edited_at")}
        for h in (doc.get("edit_history") or [])
    ]
    return out

router = APIRouter()


async def _hydrate_conv(conv: dict, viewer_id: str) -> ConversationView:
    """Hydrate a conversation into a ConversationView from `viewer_id`'s perspective."""
    kind = conv.get("kind", "dm")
    last_q = {"conversation_id": conv["id"], "deleted": {"$ne": True}}
    cleared_at = (conv.get("cleared_at") or {}).get(viewer_id)
    if cleared_at:
        last_q["created_at"] = {"$gt": cleared_at}
    last = await db.messages.find_one(last_q, {"_id": 0}, sort=[("created_at", -1)])
    if last:
        last = _decrypt_msg(last)
    last_read = (conv.get("last_read") or {}).get(viewer_id)
    # Unread = messages from others after last_read (or after cleared_at if never read)
    threshold = last_read or cleared_at
    unread_filter = {"conversation_id": conv["id"], "sender_id": {"$ne": viewer_id}}
    if threshold:
        unread_filter["created_at"] = {"$gt": threshold}
        unread = await db.messages.count_documents(unread_filter)
    elif last and last.get("sender_id") != viewer_id:
        unread = await db.messages.count_documents(unread_filter)
    else:
        unread = 0

    if kind == "group":
        members: List[PublicUser] = []
        for mid in conv.get("participant_ids", []):
            members.append(await _public_user(mid))
        return ConversationView(
            id=conv["id"], kind="group",
            name=conv.get("name") or "Group",
            avatar=conv.get("avatar"),
            members=members,
            owner_id=conv.get("owner_id"),
            last_message=Message(**last) if last else None,
            last_message_at=conv.get("last_message_at"),
            unread_count=unread,
            created_at=conv["created_at"],
        )
    # DM
    other_id = next(
        (x for x in conv.get("participant_ids", []) if x != viewer_id), None
    )
    is_self = other_id is None
    other = await _public_user(other_id or viewer_id)
    if is_self:
        other = PublicUser(
            user_id=viewer_id, name="Notes to self",
            picture=other.picture, bio="", stats=other.stats,
        )
    return ConversationView(
        id=conv["id"], kind="dm",
        other_user=other,
        last_message=Message(**last) if last else None,
        last_message_at=conv.get("last_message_at"),
        unread_count=unread,
        created_at=conv["created_at"],
    )


# ---------- DM creation ----------
@router.post("/conversations", response_model=ConversationView)
async def get_or_create_conversation(
    body: ConversationCreate, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    me_id = user["user_id"]
    target = body.recipient_user_id

    if target != me_id:
        other = await db.users.find_one({"user_id": target}, {"_id": 0})
        if not other:
            raise HTTPException(status_code=404, detail="Recipient not found")

    key = _conv_key(me_id, target) if target != me_id else _conv_key(me_id, me_id)
    existing = await db.conversations.find_one(
        {"key": key, "kind": {"$ne": "group"}}, {"_id": 0}
    )
    if existing:
        # Reopen if previously soft-deleted by viewer
        if me_id in (existing.get("deleted_by") or []):
            await db.conversations.update_one(
                {"id": existing["id"]}, {"$pull": {"deleted_by": me_id}}
            )
            existing = await db.conversations.find_one({"id": existing["id"]}, {"_id": 0})
        conv = existing
    else:
        participant_ids = [me_id] if target == me_id else sorted([me_id, target])
        conv = {
            "id": str(uuid.uuid4()),
            "kind": "dm",
            "key": key,
            "participant_ids": participant_ids,
            "deleted_by": [],
            "last_message_at": None,
            "created_at": datetime.now(timezone.utc),
        }
        await db.conversations.insert_one(conv.copy())
        conv.pop("_id", None)
    return await _hydrate_conv(conv, me_id)


# ---------- Group creation ----------
@router.post("/conversations/groups", response_model=ConversationView)
async def create_group_chat(
    body: GroupConversationCreate, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    name = (body.name or "").strip()[:80]
    if not name:
        raise HTTPException(status_code=400, detail="Group name required")
    # De-dup + ensure creator is a member
    members = list({m for m in (body.member_ids or []) if m})
    if user["user_id"] not in members:
        members.append(user["user_id"])
    if len(members) < 2:
        raise HTTPException(status_code=400, detail="Add at least one other member")
    # Validate every member exists
    existing_count = await db.users.count_documents({"user_id": {"$in": members}})
    if existing_count != len(members):
        raise HTTPException(status_code=400, detail="One or more members not found")

    conv = {
        "id": str(uuid.uuid4()),
        "kind": "group",
        "key": None,
        "name": name,
        "avatar": body.avatar,
        "owner_id": user["user_id"],
        "participant_ids": members,
        "deleted_by": [],
        "last_message_at": None,
        "created_at": datetime.now(timezone.utc),
    }
    await db.conversations.insert_one(conv.copy())
    conv.pop("_id", None)
    # Notify the other members
    for mid in members:
        if mid != user["user_id"]:
            await emit_notification(
                user_id=mid, actor_id=user["user_id"],
                ntype="group_invite",
                conversation_id=conv["id"],
                message=f"added you to “{name}”",
            )
    return await _hydrate_conv(conv, user["user_id"])


@router.patch("/conversations/{conv_id}", response_model=ConversationView)
async def patch_group_chat(
    conv_id: str,
    body: GroupConversationPatch,
    authorization: Optional[str] = Header(None),
):
    user = await get_current_user(authorization)
    conv = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    if not conv or conv.get("kind") != "group":
        raise HTTPException(status_code=404, detail="Group chat not found")
    if user["user_id"] not in conv["participant_ids"]:
        raise HTTPException(status_code=403, detail="Not a member")
    patch = {}
    if body.name is not None and body.name.strip():
        if conv.get("owner_id") != user["user_id"]:
            raise HTTPException(status_code=403, detail="Only owner can rename")
        patch["name"] = body.name.strip()[:80]
    if body.avatar is not None:
        if conv.get("owner_id") != user["user_id"]:
            raise HTTPException(status_code=403, detail="Only owner can change avatar")
        patch["avatar"] = body.avatar
    if patch:
        await db.conversations.update_one({"id": conv_id}, {"$set": patch})
    if body.add_member_ids:
        # Only owner can add
        if conv.get("owner_id") != user["user_id"]:
            raise HTTPException(status_code=403, detail="Only owner can add members")
        to_add = [m for m in body.add_member_ids if m and m not in conv["participant_ids"]]
        valid = await db.users.find({"user_id": {"$in": to_add}}, {"_id": 0, "user_id": 1}).to_list(50)
        valid_ids = [u["user_id"] for u in valid]
        if valid_ids:
            await db.conversations.update_one(
                {"id": conv_id},
                {"$addToSet": {"participant_ids": {"$each": valid_ids}}},
            )
            for mid in valid_ids:
                await emit_notification(
                    user_id=mid, actor_id=user["user_id"],
                    ntype="group_invite", conversation_id=conv_id,
                    message=f"added you to “{conv.get('name')}”",
                )
    if body.remove_member_ids:
        if conv.get("owner_id") != user["user_id"]:
            raise HTTPException(status_code=403, detail="Only owner can remove members")
        to_remove = [m for m in body.remove_member_ids if m and m != conv["owner_id"]]
        if to_remove:
            await db.conversations.update_one(
                {"id": conv_id},
                {"$pull": {"participant_ids": {"$in": to_remove}}},
            )
    updated = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    return await _hydrate_conv(updated, user["user_id"])


@router.post("/conversations/{conv_id}/leave")
async def leave_group_chat(conv_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    conv = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    if not conv or conv.get("kind") != "group":
        raise HTTPException(status_code=404, detail="Group chat not found")
    if user["user_id"] not in conv["participant_ids"]:
        raise HTTPException(status_code=404, detail="Not a member")
    if conv.get("owner_id") == user["user_id"]:
        # Owner leaving: if other members exist, transfer ownership; else delete.
        others = [m for m in conv["participant_ids"] if m != user["user_id"]]
        if others:
            await db.conversations.update_one(
                {"id": conv_id},
                {"$set": {"owner_id": others[0]},
                 "$pull": {"participant_ids": user["user_id"]}},
            )
        else:
            await db.conversations.delete_one({"id": conv_id})
            await db.messages.delete_many({"conversation_id": conv_id})
    else:
        await db.conversations.update_one(
            {"id": conv_id},
            {"$pull": {"participant_ids": user["user_id"]}},
        )
    return {"ok": True}


# ---------- Listing ----------
@router.get("/conversations", response_model=List[ConversationView])
async def list_conversations(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    me_id = user["user_id"]
    cursor = db.conversations.find(
        {
            "participant_ids": me_id,
            # hide soft-deleted-by-me convs
            "$or": [
                {"deleted_by": {"$exists": False}},
                {"deleted_by": {"$ne": me_id}},
            ],
        },
        {"_id": 0},
    ).sort([("last_message_at", -1), ("created_at", -1)])
    convs = await cursor.to_list(100)
    # Push convs with no last_message_at below ones that have messages
    convs.sort(
        key=lambda c: (c.get("last_message_at") is not None,
                       c.get("last_message_at") or c.get("created_at")),
        reverse=True,
    )
    out: List[ConversationView] = []
    for c in convs:
        out.append(await _hydrate_conv(c, me_id))
    return out


# ---------- Messages ----------
@router.get("/conversations/{conv_id}/messages", response_model=List[Message])
async def list_messages(
    conv_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    conv = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    if not conv or user["user_id"] not in conv["participant_ids"]:
        raise HTTPException(status_code=404, detail="Conversation not found")
    q = {"conversation_id": conv_id}
    cleared_at = (conv.get("cleared_at") or {}).get(user["user_id"])
    if cleared_at:
        q["created_at"] = {"$gt": cleared_at}
    cursor = (
        db.messages.find(q, {"_id": 0})
        .sort("created_at", 1)
        .limit(200)
    )
    docs = await cursor.to_list(200)
    # Fetching messages = they're delivered to this viewer. Record it so the
    # sender can show Sent → Delivered → Read (Snapchat-style).
    now = datetime.now(timezone.utc)
    await db.conversations.update_one(
        {"id": conv_id}, {"$set": {f"last_delivered.{user['user_id']}": now}}
    )
    last_read = conv.get("last_read") or {}
    last_delivered = conv.get("last_delivered") or {}
    last_delivered[user["user_id"]] = now  # reflect this fetch immediately
    out: List[Message] = []
    for d in docs:
        plain = _decrypt_msg(d)
        sender_id = plain.get("sender_id")
        others = [p for p in conv["participant_ids"] if p != sender_id]
        if others:
            created = plain["created_at"]
            read_by = [p for p in others if (last_read.get(p) is not None and last_read[p] >= created)]
            delivered_by = [p for p in others if (last_delivered.get(p) is not None and last_delivered[p] >= created)]
            plain["read_by"] = read_by
            plain["delivered_by"] = delivered_by
            if read_by and len(read_by) == len(others):
                plain["read_at"] = max(last_read[p] for p in read_by)
            if delivered_by and len(delivered_by) == len(others):
                plain["delivered_at"] = max(last_delivered[p] for p in delivered_by)
        out.append(Message(**plain))
    return out


class PresenceUpdate(BaseModel):
    typing: bool = False


@router.post("/conversations/{conv_id}/presence")
async def update_presence(conv_id: str, body: PresenceUpdate, authorization: Optional[str] = Header(None)):
    """Heartbeat: I'm viewing this chat (and maybe typing). Drives the
    'active in chat' + 'writing…' indicators."""
    user = await get_current_user(authorization)
    conv = await db.conversations.find_one({"id": conv_id}, {"_id": 0, "participant_ids": 1})
    if not conv or user["user_id"] not in conv["participant_ids"]:
        raise HTTPException(status_code=404, detail="Conversation not found")
    now = datetime.now(timezone.utc)
    patch = {f"last_active.{user['user_id']}": now}
    if body.typing:
        patch[f"typing_at.{user['user_id']}"] = now
    else:
        patch[f"typing_at.{user['user_id']}"] = None
    await db.conversations.update_one({"id": conv_id}, {"$set": patch})
    return {"ok": True}


@router.get("/conversations/{conv_id}/presence")
async def get_presence(conv_id: str, authorization: Optional[str] = Header(None)):
    """Other participants' live state: who's active in the chat and who's typing."""
    user = await get_current_user(authorization)
    conv = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    if not conv or user["user_id"] not in conv["participant_ids"]:
        raise HTTPException(status_code=404, detail="Conversation not found")
    now = datetime.now(timezone.utc)
    active_window = timedelta(seconds=20)
    typing_window = timedelta(seconds=6)
    last_active = conv.get("last_active") or {}
    typing_at = conv.get("typing_at") or {}

    def _recent(ts, window):
        if not ts:
            return False
        try:
            return (now - _norm_dt(ts)) < window
        except Exception:
            return False

    others = [p for p in conv["participant_ids"] if p != user["user_id"]]
    typing_ids = [p for p in others if _recent(typing_at.get(p), typing_window)]
    active_ids = [p for p in others if _recent(last_active.get(p), active_window)]
    return {
        "typing": bool(typing_ids),
        "active": bool(active_ids),
        "typing_ids": typing_ids,
        "active_ids": active_ids,
    }


@router.post("/conversations/{conv_id}/messages", response_model=Message)
async def send_message(
    conv_id: str,
    body: MessageCreate,
    authorization: Optional[str] = Header(None),
):
    user = await get_current_user(authorization)
    conv = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    if not conv or user["user_id"] not in conv["participant_ids"]:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if body.type == "text" and not (body.text or "").strip():
        raise HTTPException(status_code=400, detail="Empty message")
    if body.type == "place" and (body.place_longitude is None or body.place_latitude is None):
        raise HTTPException(status_code=400, detail="Place coords required")
    audio_b64: Optional[str] = None
    if body.type == "voice":
        audio_b64 = body.audio_base64 or ""
        if not audio_b64:
            raise HTTPException(status_code=400, detail="Audio required")
        if len(audio_b64) > 8 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Voice note too large (8MB limit)")
    media = []
    if body.type == "media":
        if not body.media:
            raise HTTPException(status_code=400, detail="Media required")
        for m in body.media[:4]:
            d = m.model_dump() if hasattr(m, "model_dump") else dict(m)
            url = d.get("url") or ""
            b = d.get("base64") or ""
            if not url and not b:
                continue
            if not url and len(b) > 25 * 1024 * 1024:
                raise HTTPException(status_code=413, detail="Media too large (25MB limit)")
            d["type"] = d.get("type") or "image"
            media.append(d)
        if not media:
            raise HTTPException(status_code=400, detail="Media required")
    post_id: Optional[str] = None
    if body.type == "post":
        post_id = body.post_id
        if not post_id:
            raise HTTPException(status_code=400, detail="post_id required")
        exists = await db.posts.find_one({"id": post_id}, {"_id": 0, "id": 1})
        if not exists:
            raise HTTPException(status_code=404, detail="Post not found")
    if body.type == "gif" and not (body.gif_url or "").strip():
        raise HTTPException(status_code=400, detail="gif_url required")
    if body.type == "file":
        if not (body.file_base64 or ""):
            raise HTTPException(status_code=400, detail="File required")
        if len(body.file_base64) > 8 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="File too large (8MB limit)")
    if body.type == "contact" and not (body.contact_user_id or body.contact_name):
        raise HTTPException(status_code=400, detail="Contact required")
    # Tip: send money to the other participant of a DM, recorded both as a wallet
    # earning for them and as a tip in the chat for display.
    tip_amount: Optional[float] = None
    if body.type == "tip":
        if conv.get("kind") == "group":
            raise HTTPException(status_code=400, detail="Tips can only be sent in direct messages")
        tip_amount = round(float(body.amount or 0), 2)
        if tip_amount <= 0:
            raise HTTPException(status_code=400, detail="Tip amount must be greater than 0")
        recipients = [p for p in conv["participant_ids"] if p != user["user_id"]]
        if not recipients:
            raise HTTPException(status_code=400, detail="No recipient")
        to_id = recipients[0]
        now0 = datetime.now(timezone.utc)
        await db.tips.insert_one({
            "id": str(uuid.uuid4()),
            "from_user_id": user["user_id"], "from_name": user.get("name", "Someone"),
            "to_user_id": to_id, "amount": tip_amount, "currency": "USD",
            "message": (body.text or "")[:200], "created_at": now0,
        })
        await db.earnings.insert_one({
            "id": str(uuid.uuid4()), "user_id": to_id, "amount": tip_amount, "kind": "tip",
            "from_user_id": user["user_id"], "from_name": user.get("name", "Someone"),
            "created_at": now0,
        })
    # Resolve an optional reply target — only if it's a real message in this conv.
    reply_to_id: Optional[str] = None
    if body.reply_to:
        ref = await db.messages.find_one(
            {"id": body.reply_to, "conversation_id": conv_id}, {"_id": 0, "id": 1}
        )
        if ref:
            reply_to_id = body.reply_to
    # Link preview for text messages (best-effort, mirrors post creation).
    link_prev: Optional[dict] = None
    if body.type == "text":
        url = first_url((body.text or ""))
        if url:
            try:
                link_prev = await fetch_link_preview(url)
            except Exception:
                link_prev = None
    now = datetime.now(timezone.utc)
    msg = {
        "id": str(uuid.uuid4()),
        "conversation_id": conv_id,
        "sender_id": user["user_id"],
        "type": body.type,
        "text": encrypt_text((body.text or "")[:2000]),
        "place_name": body.place_name,
        "place_address": body.place_address,
        "place_longitude": body.place_longitude,
        "place_latitude": body.place_latitude,
        "media": media,
        "audio_base64": audio_b64,
        "audio_duration_ms": body.audio_duration_ms if body.type == "voice" else None,
        "post_id": post_id,
        "gif_url": body.gif_url if body.type == "gif" else None,
        "file_base64": body.file_base64 if body.type == "file" else None,
        "file_name": (body.file_name or "file")[:200] if body.type == "file" else None,
        "file_size": body.file_size if body.type == "file" else None,
        "file_mime": body.file_mime if body.type == "file" else None,
        "contact_user_id": body.contact_user_id if body.type == "contact" else None,
        "contact_name": (body.contact_name or "")[:120] if body.type == "contact" else None,
        "contact_picture": body.contact_picture if body.type == "contact" else None,
        "amount": tip_amount,
        "link_preview": link_prev,
        "reactions": {},
        "reply_to_id": reply_to_id,
        "deleted": False,
        "created_at": now,
    }
    await db.messages.insert_one(msg.copy())
    # Resurface for anyone who had soft-deleted the conv (DM)
    await db.conversations.update_one(
        {"id": conv_id},
        {"$set": {"last_message_at": now}, "$pull": {"deleted_by": {"$in": conv["participant_ids"]}}},
    )
    # Notify other participants — use the plaintext we received in `body`, not the
    # encrypted version we just stored.
    is_group = conv.get("kind") == "group"
    plaintext = (body.text or "").strip()
    if body.type == "text":
        # End-to-end encrypted bodies are opaque to the server — never put the
        # ciphertext in a notification; show a generic preview instead.
        preview = "🔒 New message" if plaintext.startswith("e2e:v1:") else plaintext[:140]
    elif body.type == "place":
        preview = "📍 sent a place"
    elif body.type == "voice":
        preview = "🎤 sent a voice message"
    elif body.type == "post":
        preview = "📄 shared a post"
    elif body.type == "gif":
        preview = "🎞️ sent a GIF"
    elif body.type == "file":
        preview = f"📎 {(body.file_name or 'file')[:60]}"
    elif body.type == "contact":
        preview = f"👤 {(body.contact_name or 'contact')[:60]}"
    elif body.type == "tip":
        preview = f"💸 sent a ${tip_amount:.2f} tip"
    else:
        preview = "📎 sent media"
    for pid in conv["participant_ids"]:
        if pid == user["user_id"]:
            continue
        await emit_notification(
            user_id=pid, actor_id=user["user_id"],
            ntype="group_message" if is_group else "message",
            conversation_id=conv_id,
            message=preview,
        )
    return Message(**_decrypt_msg(msg))


@router.post("/conversations/{conv_id}/read")
async def mark_read(conv_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    conv = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    if not conv or user["user_id"] not in conv["participant_ids"]:
        raise HTTPException(status_code=404, detail="Conversation not found")
    await db.conversations.update_one(
        {"id": conv_id},
        {"$set": {f"last_read.{user['user_id']}": datetime.now(timezone.utc)}},
    )
    return {"ok": True}


@router.patch("/conversations/{conv_id}/messages/{msg_id}", response_model=Message)
async def edit_message(
    conv_id: str, msg_id: str, body: MessageEdit, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    conv = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    if not conv or user["user_id"] not in conv["participant_ids"]:
        raise HTTPException(status_code=404, detail="Conversation not found")
    m = await db.messages.find_one({"id": msg_id, "conversation_id": conv_id}, {"_id": 0})
    if not m or m.get("sender_id") != user["user_id"]:
        raise HTTPException(status_code=404, detail="Message not found or not yours")
    if m.get("deleted"):
        raise HTTPException(status_code=400, detail="Message was deleted")
    if (m.get("type") or "text") != "text":
        raise HTTPException(status_code=400, detail="Only text messages can be edited")
    new_text = (body.text or "").strip()
    if not new_text:
        raise HTTPException(status_code=400, detail="Empty message")
    now = datetime.now(timezone.utc)
    link_prev: Optional[dict] = None
    url = first_url(new_text)
    if url:
        try:
            link_prev = await fetch_link_preview(url)
        except Exception:
            link_prev = None
    # Keep prior versions so the edit history can be shown.
    history = list(m.get("edit_history") or [])
    history.append({"text": m.get("text", ""), "edited_at": m.get("edited_at") or m.get("created_at")})
    history = history[-20:]
    await db.messages.update_one(
        {"id": msg_id, "conversation_id": conv_id, "sender_id": user["user_id"]},
        {"$set": {"text": encrypt_text(new_text[:2000]), "edited_at": now, "link_preview": link_prev, "edit_history": history}},
    )
    m2 = await db.messages.find_one({"id": msg_id, "conversation_id": conv_id}, {"_id": 0})
    return Message(**_decrypt_msg(m2))


@router.post("/conversations/{conv_id}/messages/{msg_id}/react", response_model=Message)
async def react_to_message(
    conv_id: str, msg_id: str, body: MessageReact, authorization: Optional[str] = Header(None)
):
    """Toggle the current user's reaction on a message. Sending the same emoji
    again (or an empty emoji) clears it. One reaction per user."""
    user = await get_current_user(authorization)
    uid = user["user_id"]
    conv = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    if not conv or uid not in conv["participant_ids"]:
        raise HTTPException(status_code=404, detail="Conversation not found")
    m = await db.messages.find_one({"id": msg_id, "conversation_id": conv_id}, {"_id": 0})
    if not m or m.get("deleted"):
        raise HTTPException(status_code=404, detail="Message not found")
    reactions = dict(m.get("reactions") or {})
    emoji = (body.emoji or "").strip()
    if not emoji or reactions.get(uid) == emoji:
        reactions.pop(uid, None)          # toggle off
    else:
        reactions[uid] = emoji[:8]        # set / replace
    await db.messages.update_one(
        {"id": msg_id, "conversation_id": conv_id}, {"$set": {"reactions": reactions}}
    )
    # Notify the author when someone else reacts (not on un-react / self-react).
    if reactions.get(uid) and m.get("sender_id") != uid:
        try:
            await emit_notification(
                user_id=m["sender_id"], actor_id=uid,
                ntype="group_message" if conv.get("kind") == "group" else "message",
                conversation_id=conv_id, message=f"{reactions[uid]} reacted to your message",
            )
        except Exception:
            pass
    m2 = await db.messages.find_one({"id": msg_id, "conversation_id": conv_id}, {"_id": 0})
    return Message(**_decrypt_msg(m2))


@router.delete("/conversations/{conv_id}/messages/{msg_id}")
async def delete_message(
    conv_id: str, msg_id: str, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    conv = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    if not conv or user["user_id"] not in conv["participant_ids"]:
        raise HTTPException(status_code=404, detail="Conversation not found")
    m = await db.messages.find_one(
        {"id": msg_id, "conversation_id": conv_id, "sender_id": user["user_id"]}, {"_id": 0}
    )
    if not m:
        raise HTTPException(status_code=404, detail="Message not found or not yours")
    # Soft delete: keep a tombstone so the other side sees "message deleted"
    # (Facebook/Messenger-style) instead of the bubble silently vanishing.
    await db.messages.update_one(
        {"id": msg_id, "conversation_id": conv_id, "sender_id": user["user_id"]},
        {"$set": {
            "deleted": True, "text": "", "media": [], "audio_base64": None,
            "audio_duration_ms": None, "place_name": None, "place_address": None,
            "place_longitude": None, "place_latitude": None, "post_id": None,
            "link_preview": None, "reactions": {}, "reply_to_id": None,
        }},
    )
    return {"ok": True}


# ---------- Soft delete a chat (per user) ----------
@router.delete("/conversations/{conv_id}")
async def delete_conversation_for_me(
    conv_id: str, authorization: Optional[str] = Header(None)
):
    """Hide this conversation from MY inbox. For DM, the other side still has
    it. For groups, this is treated as "leave" so the user truly exits."""
    user = await get_current_user(authorization)
    conv = await db.conversations.find_one({"id": conv_id}, {"_id": 0})
    if not conv or user["user_id"] not in conv["participant_ids"]:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conv.get("kind") == "group":
        # Reuse leave semantics
        return await leave_group_chat(conv_id, authorization)
    now = datetime.now(timezone.utc)
    await db.conversations.update_one(
        {"id": conv_id},
        {
            "$addToSet": {"deleted_by": user["user_id"]},
            "$set": {f"cleared_at.{user['user_id']}": now},
        },
    )
    return {"ok": True}


# ---------- Custom emojis (uploadable, usable as :shortcode: in chat) ----------
_EMOJI_RE = _re.compile(r"^[a-z0-9_]{2,32}$")


@router.get("/emojis", response_model=List[CustomEmoji])
async def list_emojis(authorization: Optional[str] = Header(None)):
    """All custom emojis (global registry, so :shortcode: renders for everyone)."""
    await get_current_user(authorization)
    rows = await db.custom_emojis.find({}, {"_id": 0}).sort("created_at", -1).limit(500).to_list(500)
    return [CustomEmoji(**r) for r in rows]


@router.post("/emojis", response_model=CustomEmoji)
async def create_emoji(body: CustomEmojiCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    code = (body.shortcode or "").strip().lower().replace(":", "")
    if not _EMOJI_RE.match(code):
        raise HTTPException(status_code=400, detail="Shortcode must be 2-32 chars: a-z, 0-9, underscore")
    img = body.image_base64 or ""
    if not (img.startswith("data:") or img.startswith("http")):
        raise HTTPException(status_code=400, detail="Image required")
    if len(img) > 1_500_000:
        raise HTTPException(status_code=413, detail="Emoji image too large (keep it small)")
    doc = {
        "id": str(uuid.uuid4()),
        "shortcode": code,
        "image_base64": img,
        "owner_id": user["user_id"],
        "created_at": datetime.now(timezone.utc),
    }
    try:
        await db.custom_emojis.insert_one(doc.copy())
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail=f":{code}: already exists")
    return CustomEmoji(**doc)


@router.delete("/emojis/{emoji_id}")
async def delete_emoji(emoji_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.custom_emojis.find_one({"id": emoji_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Emoji not found")
    if doc["owner_id"] != user["user_id"] and not is_admin(user):
        raise HTTPException(status_code=403, detail="Not allowed")
    await db.custom_emojis.delete_one({"id": emoji_id})
    return {"ok": True}
