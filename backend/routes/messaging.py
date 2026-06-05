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
from datetime import datetime, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Header, HTTPException

from core import _conv_key, _public_user, db, get_current_user
from models import (
    ConversationCreate,
    ConversationView,
    GroupConversationCreate,
    GroupConversationPatch,
    Message,
    MessageCreate,
    MessageEdit,
    PublicUser,
)
from routes.notifications import emit_notification
from services.encryption import encrypt_text, decrypt_text
from services.link_preview import fetch_link_preview, first_url


def _decrypt_msg(doc: dict) -> dict:
    """Return a copy of `doc` with text fields decrypted for the API response."""
    if not doc:
        return doc
    out = dict(doc)
    out["text"] = decrypt_text(doc.get("text") or "")
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
    # Compute read receipts (WhatsApp ✓/✓✓ style).
    # A message is "read" when EVERY non-sender participant's last_read
    # timestamp is >= message.created_at. For 1:1 chats that's just the peer.
    last_read = conv.get("last_read") or {}
    out: List[Message] = []
    for d in docs:
        plain = _decrypt_msg(d)
        sender_id = plain.get("sender_id")
        others = [p for p in conv["participant_ids"] if p != sender_id]
        if others:
            timestamps = [last_read.get(p) for p in others]
            if all(t is not None and t >= plain["created_at"] for t in timestamps):
                # Soonest moment when the LAST recipient read this message
                plain["read_at"] = max(timestamps)  # type: ignore[arg-type]
        out.append(Message(**plain))
    return out


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
            b = d.get("base64") or ""
            if not b:
                continue
            if len(b) > 8 * 1024 * 1024:
                raise HTTPException(status_code=413, detail="Media too large (8MB limit)")
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
        "link_preview": link_prev,
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
        preview = plaintext[:140]
    elif body.type == "place":
        preview = "📍 sent a place"
    elif body.type == "voice":
        preview = "🎤 sent a voice message"
    elif body.type == "post":
        preview = "📄 shared a post"
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
    await db.messages.update_one(
        {"id": msg_id, "conversation_id": conv_id, "sender_id": user["user_id"]},
        {"$set": {"text": encrypt_text(new_text[:2000]), "edited_at": now, "link_preview": link_prev}},
    )
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
            "link_preview": None,
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
