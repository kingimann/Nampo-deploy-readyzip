"""OkayAI + OkayFacts — the two built-in assistant accounts.

Both run on the local Ollama model (text AI is Ollama-only; Claude is reserved
for photo/vision). Disabled unless OLLAMA_HOST is set. A single poll loop drives
both accounts — no realtime infra needed. Best-effort: failures never crash the
app.

  • @OkayAI    — a general assistant. Replies to ANYONE: in DMs, and on posts
                 that mention @okayai.
  • @OkayFacts — a fact-checker only. When a post (or a reply) mentions
                 @okayfacts, it fact-checks the claim and publishes the verdict
                 as a Factcheck note on the post, shown through the factchecker.
"""
import asyncio
import logging
import os
import uuid
from datetime import datetime, timezone, timedelta

import httpx

from core import db, random_default_avatar
from services.encryption import encrypt_text, decrypt_text
from services.ollama import OLLAMA_HOST, OLLAMA_TEXT_MODEL, ollama_enabled, fact_check

logger = logging.getLogger("okay_bots")

POLL_SECONDS = int(os.environ.get("OKAY_BOTS_POLL_SECONDS", "6") or 6)
MAX_TOKENS = 600

# (username, display name, bio) for the accounts we keep seeded.
OKAYAI = ("okayai", "OkayAI", "Your friendly AI assistant inside OkaySpace. Mention @OkayAI or DM me anything.")
OKAYFACTS = ("okayfacts", "OkayFacts", "I fact-check claims. Mention @OkayFacts on a post to get it checked.")

AI_SYSTEM = (
    "You are OkayAI, the friendly AI assistant living inside the OkaySpace app — a "
    "social network with maps, chat, a marketplace, payments and more. Be warm, concise "
    "and helpful. Plain text only (no markdown headers). Keep replies short unless asked "
    "for detail."
)

_VERDICT = {
    "true": "✅ True",
    "false": "❌ False",
    "misleading": "⚠️ Misleading",
    "unverifiable": "🔍 Unverifiable",
}


def _enabled() -> bool:
    return ollama_enabled()


# ── Account seeding ──────────────────────────────────────────────────────────
async def _ensure_bot(username: str, name: str, bio: str) -> dict:
    """Create the bot account if it's missing (idempotent); return its user doc."""
    existing = await db.users.find_one({"username": username}, {"_id": 0})
    if existing:
        return existing
    now = datetime.now(timezone.utc)
    doc = {
        "user_id": f"user_{uuid.uuid4().hex[:12]}",
        "email": f"{username}@okayspace.bot",
        "username": username,
        "name": name,
        "picture": random_default_avatar(),
        "bio": bio,
        "hashed_password": None,
        "auth_providers": [],
        "role": "user",
        "is_bot": True,
        "verified": True,
        "created_at": now,
    }
    try:
        await db.users.insert_one(doc.copy())
        logger.info("Seeded bot account @%s", username)
    except Exception as e:
        # Lost a race or a unique conflict — re-read whatever's there.
        logger.warning("Seed @%s skipped: %s", username, e)
        return await db.users.find_one({"username": username}, {"_id": 0}) or doc
    return doc


# ── Ollama text ──────────────────────────────────────────────────────────────
async def _ask_ai(messages: list, system: str = AI_SYSTEM) -> str:
    """Call the local Ollama chat API and return the reply text."""
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            r = await client.post(
                f"{OLLAMA_HOST}/api/chat",
                json={
                    "model": OLLAMA_TEXT_MODEL,
                    "stream": False,
                    "options": {"temperature": 0.6, "num_predict": MAX_TOKENS},
                    "messages": [{"role": "system", "content": system}, *messages],
                },
            )
            if r.status_code >= 400:
                logger.warning("Ollama API %s: %s", r.status_code, r.text[:300])
                return ""
            return (((r.json() or {}).get("message") or {}).get("content") or "").strip()
    except Exception as e:
        logger.warning("OkayAI API call failed: %s", e)
        return ""


def _readable(text: str):
    """Decrypted plaintext, or None if it's an E2E ciphertext the bot can't read."""
    t = decrypt_text(text or "")
    if isinstance(t, str) and t.startswith("e2e:v1:"):
        return None
    return t or ""


# ── OkayAI: DMs (from anyone) ────────────────────────────────────────────────
async def _send_dm(conv_id: str, bot_id: str, peer_id: str, reply: str):
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
        {"$set": {"last_message_at": now}, "$pull": {"deleted_by": {"$in": [peer_id, bot_id]}}},
    )
    try:
        from routes.notifications import emit_notification
        await emit_notification(user_id=peer_id, actor_id=bot_id, ntype="message",
                                conversation_id=conv_id, message=reply[:140])
    except Exception:
        pass


async def _handle_ai_dms(bot: dict):
    """OkayAI replies to the latest message in any DM where it's a participant."""
    bot_id = bot["user_id"]
    convs = await db.conversations.find(
        {"participant_ids": bot_id, "kind": {"$ne": "group"}}, {"_id": 0}
    ).limit(100).to_list(100)
    handled = 0
    for conv in convs:
        if handled >= 8:
            break
        last = await db.messages.find_one(
            {"conversation_id": conv["id"], "deleted": {"$ne": True}}, {"_id": 0}, sort=[("created_at", -1)]
        )
        if not last or last.get("sender_id") == bot_id:
            continue  # nothing new / already replied
        if (last.get("type") or "text") != "text":
            continue
        peer_id = last["sender_id"]
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
            await _send_dm(conv["id"], bot_id, peer_id, reply)
            handled += 1


# ── OkayAI: @okayai post mentions ────────────────────────────────────────────
async def _reply_to_post(bot_id: str, parent: dict, text: str) -> None:
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()), "user_id": bot_id, "text": text[:1000],
        "parent_id": parent["id"], "quote_of": None, "media": [], "poll": None,
        "hashtags": [], "community_id": parent.get("community_id"), "title": None,
        "likes_count": 0, "replies_count": 0, "reposts_count": 0, "quotes_count": 0,
        "bookmarks_count": 0, "created_at": now,
    }
    await db.posts.insert_one(doc.copy())
    await db.posts.update_one({"id": parent["id"]}, {"$inc": {"replies_count": 1}})
    try:
        from routes.notifications import emit_notification
        await emit_notification(user_id=parent["user_id"], actor_id=bot_id, ntype="reply",
                                post_id=parent["id"], message=text[:140])
    except Exception:
        pass


async def _handle_ai_mentions(bot: dict):
    """OkayAI replies to recent posts that mention @okayai."""
    bot_id = bot["user_id"]
    since = datetime.now(timezone.utc) - timedelta(minutes=15)
    posts = await db.posts.find(
        {"created_at": {"$gte": since}, "text": {"$regex": "@okayai", "$options": "i"}},
        {"_id": 0},
    ).sort("created_at", -1).limit(30).to_list(30)
    handled = 0
    for p in posts:
        if handled >= 5:
            break
        if p.get("user_id") == bot_id:
            continue
        seen_id = f"okayai:{p['id']}"
        if await db.bot_seen.find_one({"id": seen_id}, {"_id": 0, "id": 1}):
            continue
        await db.bot_seen.insert_one({"id": seen_id, "created_at": datetime.now(timezone.utc)})
        prompt = (p.get("text") or "").replace("@okayai", "").replace("@OkayAI", "").strip()
        reply = await _ask_ai([{"role": "user", "content": prompt[:4000]}])
        if reply:
            await _reply_to_post(bot_id, p, reply)
            handled += 1


# ── OkayFacts: fact-check on @okayfacts mention ──────────────────────────────
async def _refresh_post_factcheck(post_id: str) -> None:
    """Mirror of routes.factchecks._refresh_post_factcheck — denormalize the best
    shown note onto the post so feeds render it for free."""
    shown = await db.factchecks.find({"post_id": post_id, "status": "shown"}, {"_id": 0}).to_list(50)
    if not shown:
        await db.posts.update_one({"id": post_id}, {"$set": {"factcheck": None}})
        return
    best = max(shown, key=lambda d: int(d.get("helpful_count", 0)) - int(d.get("not_helpful_count", 0)))
    await db.posts.update_one({"id": post_id}, {"$set": {"factcheck": {
        "id": best["id"], "text": best.get("text", ""), "source_url": best.get("source_url", ""),
    }}})


async def _handle_factcheck_mentions(bot: dict):
    """OkayFacts checks any recent post/reply that mentions @okayfacts and
    publishes a shown Factcheck note on the relevant post."""
    bot_id = bot["user_id"]
    since = datetime.now(timezone.utc) - timedelta(minutes=15)
    posts = await db.posts.find(
        {"created_at": {"$gte": since}, "text": {"$regex": "@okayfacts", "$options": "i"}},
        {"_id": 0},
    ).sort("created_at", -1).limit(30).to_list(30)
    handled = 0
    for p in posts:
        if handled >= 5:
            break
        if p.get("user_id") == bot_id:
            continue
        seen_id = f"okayfacts:{p['id']}"
        if await db.bot_seen.find_one({"id": seen_id}, {"_id": 0, "id": 1}):
            continue
        await db.bot_seen.insert_one({"id": seen_id, "created_at": datetime.now(timezone.utc)})
        # Check the parent post's claim when this is a reply (e.g. someone replies
        # "@okayfacts" under a claim); otherwise check the post's own text.
        target = p
        if p.get("parent_id"):
            parent = await db.posts.find_one({"id": p["parent_id"]}, {"_id": 0})
            if parent:
                target = parent
        claim = (target.get("text") or "").replace("@okayfacts", "").replace("@OkayFacts", "").strip()
        if not claim:
            continue
        result = await fact_check(claim)
        if not result:
            continue
        label = _VERDICT.get(result["verdict"], "🔍 Unverifiable")
        note_text = f"{label}. {result.get('explanation', '')}".strip()[:1000]
        now = datetime.now(timezone.utc)
        fc = {
            "id": str(uuid.uuid4()),
            "post_id": target["id"],
            "author_id": bot_id,
            "author_name": bot.get("name", "OkayFacts"),
            "text": note_text,
            "source_url": result.get("source_url", ""),
            "helpful_count": 0,
            "not_helpful_count": 0,
            # OkayFacts is the official checker — publish straight to "shown".
            "status": "shown",
            "by_bot": True,
            "created_at": now,
        }
        await db.factchecks.insert_one(fc.copy())
        await _refresh_post_factcheck(target["id"])
        try:
            from routes.notifications import emit_notification
            await emit_notification(user_id=p["user_id"], actor_id=bot_id, ntype="factcheck",
                                    post_id=target["id"], message=note_text[:140])
        except Exception:
            pass
        handled += 1


# ── Loop ─────────────────────────────────────────────────────────────────────
async def _run():
    # Always make sure the accounts exist, even when AI isn't configured, so they
    # show up in search and people can find/DM them.
    try:
        await _ensure_bot(*OKAYAI)
        await _ensure_bot(*OKAYFACTS)
    except Exception as e:
        logger.warning("OkayBots seeding error: %s", e)
    if not _enabled():
        logger.info("OkayAI + OkayFacts accounts seeded; replies disabled (OLLAMA_HOST not set)")
        return
    logger.info("OkayAI + OkayFacts running (model=%s)", OLLAMA_TEXT_MODEL)
    while True:
        try:
            okayai = await _ensure_bot(*OKAYAI)
            okayfacts = await _ensure_bot(*OKAYFACTS)
            await _handle_ai_dms(okayai)
            await _handle_ai_mentions(okayai)
            await _handle_factcheck_mentions(okayfacts)
        except Exception as e:
            logger.warning("OkayBots loop error: %s", e)
        await asyncio.sleep(POLL_SECONDS)


_BG_TASKS: set = set()


def start_bots():
    """Seed the OkayAI + OkayFacts accounts and (when Ollama is configured) run
    their reply loop."""
    # Keep a strong reference: asyncio only holds a weak ref to a running task,
    # so without this the loop could be garbage-collected mid-`await sleep`.
    t = asyncio.create_task(_run())
    _BG_TASKS.add(t)
    t.add_done_callback(_BG_TASKS.discard)
