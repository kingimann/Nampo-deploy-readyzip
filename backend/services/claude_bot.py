"""@claude assistant bot — wires the @claude account to the local Ollama model
so it replies inside OkaySpace (DMs + post mentions) to an allowlist of users.

Runs on the local Ollama model (text AI is Ollama-only; Claude is reserved for
photo/vision). Disabled unless OLLAMA_HOST is set. Owner-gated via
CLAUDE_BOT_ALLOW (comma-separated usernames; default "iman"). Polls every few
seconds — no realtime infra needed. Best-effort: failures never crash the app.
"""
import asyncio
import logging
import os
import uuid
from datetime import datetime, timezone, timedelta

import httpx

from core import db
from services.encryption import encrypt_text, decrypt_text
from services.ollama import OLLAMA_HOST, OLLAMA_TEXT_MODEL, ollama_enabled

logger = logging.getLogger("claude_bot")

ALLOW_USERNAMES = [u.strip().lower() for u in os.environ.get("CLAUDE_BOT_ALLOW", "iman").split(",") if u.strip()]
POLL_SECONDS = int(os.environ.get("CLAUDE_BOT_POLL_SECONDS", "6") or 6)
MAX_TOKENS = 600

SYSTEM = (
    "You are the friendly AI assistant living inside the OkaySpace app — a social "
    "network with maps, chat, a marketplace, payments and more. You're chatting with the "
    "app's owner. Be warm, concise and helpful. Plain text only (no markdown headers). "
    "Keep replies short unless asked for detail."
)


def _enabled() -> bool:
    return ollama_enabled()


async def _ask_ai(messages: list) -> str:
    """Call the local Ollama chat API and return the reply text."""
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            r = await client.post(
                f"{OLLAMA_HOST}/api/chat",
                json={
                    "model": OLLAMA_TEXT_MODEL,
                    "stream": False,
                    "options": {"temperature": 0.6, "num_predict": MAX_TOKENS},
                    "messages": [{"role": "system", "content": SYSTEM}, *messages],
                },
            )
            if r.status_code >= 400:
                logger.warning("Ollama API %s: %s", r.status_code, r.text[:300])
                return ""
            return (((r.json() or {}).get("message") or {}).get("content") or "").strip()
    except Exception as e:
        logger.warning("Assistant bot API call failed: %s", e)
        return ""


def _readable(text: str) -> str | None:
    """Decrypted plaintext, or None if it's an E2E ciphertext the bot can't read."""
    t = decrypt_text(text or "")
    if isinstance(t, str) and t.startswith("e2e:v1:"):
        return None
    return t or ""


async def _bot_user():
    return await db.users.find_one({"username": "claude"}, {"_id": 0, "user_id": 1, "name": 1})


async def _allowed_ids() -> set:
    if not ALLOW_USERNAMES:
        return set()
    rows = await db.users.find({"username": {"$in": ALLOW_USERNAMES}}, {"_id": 0, "user_id": 1}).to_list(50)
    return {r["user_id"] for r in rows}


async def _send_dm(conv_id: str, bot_id: str, bot_name: str, owner_id: str, reply: str):
    now = datetime.now(timezone.utc)
    msg = {
        "id": str(uuid.uuid4()), "conversation_id": conv_id, "sender_id": bot_id,
        "type": "text", "text": encrypt_text(reply[:2000]),
        "media": [], "reactions": {}, "deleted": False, "reply_to_id": None,
        "edit_history": [], "created_at": now,
    }
    await db.messages.insert_one(msg.copy())
    await db.conversations.update_one(
        {"id": conv_id},
        {"$set": {"last_message_at": now}, "$pull": {"deleted_by": {"$in": [owner_id, bot_id]}}},
    )
    try:
        from routes.notifications import emit_notification
        await emit_notification(user_id=owner_id, actor_id=bot_id, ntype="message",
                                conversation_id=conv_id, message=reply[:140])
    except Exception:
        pass


async def _handle_dms(bot, allowed: set):
    bot_id = bot["user_id"]
    convs = await db.conversations.find(
        {"participant_ids": bot_id, "kind": {"$ne": "group"}}, {"_id": 0}
    ).limit(100).to_list(100)
    handled = 0
    for conv in convs:
        if handled >= 5:
            break
        last = await db.messages.find_one(
            {"conversation_id": conv["id"], "deleted": {"$ne": True}}, {"_id": 0}, sort=[("created_at", -1)]
        )
        if not last or last.get("sender_id") == bot_id:
            continue  # nothing new / already replied
        if last.get("sender_id") not in allowed or (last.get("type") or "text") != "text":
            continue
        owner_id = last["sender_id"]
        # Build a short transcript for context.
        recent = await db.messages.find(
            {"conversation_id": conv["id"], "deleted": {"$ne": True}}, {"_id": 0}
        ).sort("created_at", -1).limit(12).to_list(12)
        recent.reverse()
        history = []
        for m in recent:
            if (m.get("type") or "text") != "text":
                continue
            t = _readable(m.get("text") or "")
            if not t:
                continue
            history.append({"role": "assistant" if m.get("sender_id") == bot_id else "user", "content": t[:4000]})
        if not history or history[-1]["role"] != "user":
            continue
        reply = await _ask_ai(history)
        if reply:
            await _send_dm(conv["id"], bot_id, bot.get("name", "Claude"), owner_id, reply)
            handled += 1


async def _handle_mentions(bot, allowed: set):
    bot_id = bot["user_id"]
    since = datetime.now(timezone.utc) - timedelta(minutes=15)
    posts = await db.posts.find(
        {"created_at": {"$gte": since}, "user_id": {"$in": list(allowed)},
         "text": {"$regex": "@claude", "$options": "i"}},
        {"_id": 0},
    ).sort("created_at", -1).limit(20).to_list(20)
    handled = 0
    for p in posts:
        if handled >= 3:
            break
        if p.get("user_id") == bot_id:
            continue
        if await db.bot_seen.find_one({"id": p["id"]}, {"_id": 0, "id": 1}):
            continue
        await db.bot_seen.insert_one({"id": p["id"], "created_at": datetime.now(timezone.utc)})
        reply = await _ask_ai([{"role": "user", "content": (p.get("text") or "")[:4000]}])
        if not reply:
            continue
        now = datetime.now(timezone.utc)
        doc = {
            "id": str(uuid.uuid4()), "user_id": bot_id, "text": reply[:500],
            "parent_id": p["id"], "quote_of": None, "media": [], "poll": None,
            "hashtags": [], "community_id": None, "title": None,
            "likes_count": 0, "replies_count": 0, "reposts_count": 0, "quotes_count": 0,
            "bookmarks_count": 0, "created_at": now,
        }
        await db.posts.insert_one(doc.copy())
        await db.posts.update_one({"id": p["id"]}, {"$inc": {"replies_count": 1}})
        try:
            from routes.notifications import emit_notification
            await emit_notification(user_id=p["user_id"], actor_id=bot_id, ntype="reply",
                                    post_id=p["id"], message=reply[:140])
        except Exception:
            pass
        handled += 1


async def _loop():
    logger.info("Assistant bot running (model=%s, allow=%s)", OLLAMA_TEXT_MODEL, ALLOW_USERNAMES)
    while True:
        try:
            bot = await _bot_user()
            allowed = await _allowed_ids()
            if bot and allowed:
                await _handle_dms(bot, allowed)
                await _handle_mentions(bot, allowed)
        except Exception as e:
            logger.warning("Claude bot loop error: %s", e)
        await asyncio.sleep(POLL_SECONDS)


def start_bot():
    """Start the bot loop if an API key is configured."""
    if not _enabled():
        logger.info("Assistant bot disabled (OLLAMA_HOST not set)")
        return
    asyncio.create_task(_loop())
