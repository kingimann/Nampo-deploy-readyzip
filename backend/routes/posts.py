"""Posts, feed, replies, likes, reposts."""
from datetime import datetime, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Header, HTTPException, Query
from db import DuplicateKeyError

from core import db, get_current_user, is_mod
from models import (
    LinkPreview, Poll, PollOption, Post, PostAuthor, PostCreate, PostMedia,
    PostPatch, PublicUser, ReportCreate, PromoteCreate,
)
from routes.notifications import emit_notification
from services.link_preview import fetch_link_preview, first_url
import re
import math
import asyncio
from datetime import timedelta

router = APIRouter()

_HASHTAG_RE = re.compile(r"(?<![A-Za-z0-9_])#([A-Za-z0-9_]{1,50})")


def _extract_hashtags(text: str) -> list:
    return list({m.group(1).lower() for m in _HASHTAG_RE.finditer(text or "")})


def _hydrate_poll(poll_doc: dict, viewer_id: Optional[str], votes: dict) -> Poll:
    options = []
    for opt in poll_doc.get("options", []):
        options.append(PollOption(
            id=opt["id"], text=opt["text"], votes=int(opt.get("votes", 0))
        ))
    total = sum(o.votes for o in options)
    voted = votes.get(viewer_id) if viewer_id else None
    ends_at = poll_doc.get("ends_at")
    closed = bool(poll_doc.get("closed")) or (
        ends_at and ends_at.replace(tzinfo=ends_at.tzinfo or timezone.utc)
        <= datetime.now(timezone.utc)
    )
    return Poll(
        options=options, total_votes=total, voted_option_id=voted,
        ends_at=ends_at, closed=closed,
    )


# Hard cap on individual media base64 payloads to keep Mongo docs sane.
MAX_MEDIA_PER_POST = 4
MAX_MEDIA_BYTES_EACH = 25 * 1024 * 1024  # ~25MB encoded (base64 ≈ +33%, so ~18MB of real video)


def _normalize_media(items: Optional[list]) -> list:
    if not items:
        return []
    out: list = []
    for m in items[:MAX_MEDIA_PER_POST]:
        if isinstance(m, PostMedia):
            d = m.model_dump()
        else:
            d = dict(m)
        url = d.get("url") or ""
        b = d.get("base64") or ""
        # A CDN URL (Cloudinary) is preferred and has no size cap; base64 is the
        # inline fallback and is still bounded so we don't bloat the DB row.
        if not url and not b:
            continue
        if not url and len(b) > MAX_MEDIA_BYTES_EACH:
            raise HTTPException(status_code=413, detail="Media too large (25MB limit)")
        d["type"] = d.get("type") or "image"
        out.append(d)
    return out


async def _hydrate_post(doc: dict, viewer_id: Optional[str]) -> Post:
    _community_name = None
    if doc.get("community_id"):
        _c = await db.communities.find_one({"id": doc["community_id"]}, {"_id": 0, "name": 1})
        _community_name = _c.get("name") if _c else None
    author_doc = await db.users.find_one({"user_id": doc["user_id"]}, {"_id": 0})
    author = PostAuthor(
        user_id=doc["user_id"],
        name=author_doc.get("name", "Unknown") if author_doc else "Unknown",
        username=author_doc.get("username") if author_doc else None,
        picture=author_doc.get("picture") if author_doc else None,
        verified=bool(author_doc.get("verified", False)) if author_doc else False,
    )
    liked = False
    disliked = False
    reposted = False
    bookmarked = False
    if viewer_id:
        liked = bool(
            await db.post_likes.find_one(
                {"post_id": doc["id"], "user_id": viewer_id}, {"_id": 0}
            )
        )
        disliked = bool(
            await db.post_dislikes.find_one(
                {"post_id": doc["id"], "user_id": viewer_id}, {"_id": 0}
            )
        )
        reposted = bool(
            await db.posts.find_one(
                {"user_id": viewer_id, "repost_of": doc["id"]}, {"_id": 0, "id": 1}
            )
        )
        bookmarked = bool(
            await db.post_bookmarks.find_one(
                {"post_id": doc["id"], "user_id": viewer_id}, {"_id": 0}
            )
        )
    reposted_post: Optional[Post] = None
    if doc.get("repost_of"):
        orig = await db.posts.find_one({"id": doc["repost_of"]}, {"_id": 0})
        if orig:
            reposted_post = await _hydrate_post(orig, viewer_id)
    quoted_post: Optional[Post] = None
    if doc.get("quote_of"):
        orig = await db.posts.find_one({"id": doc["quote_of"]}, {"_id": 0})
        if orig:
            quoted_post = await _hydrate_post(orig, viewer_id)
    poll_obj: Optional[Poll] = None
    if doc.get("poll"):
        votes_doc = await db.poll_votes.find(
            {"post_id": doc["id"]}, {"_id": 0}
        ).to_list(None)
        votes = {v["user_id"]: v["option_id"] for v in votes_doc}
        poll_obj = _hydrate_poll(doc["poll"], viewer_id, votes)
    link_prev_obj: Optional[LinkPreview] = None
    if doc.get("link_preview"):
        lp = doc["link_preview"]
        link_prev_obj = LinkPreview(**{k: lp.get(k) for k in (
            "url", "title", "description", "image", "site_name"
        )})
    return Post(
        id=doc["id"], user_id=doc["user_id"], author=author, text=doc["text"],
        parent_id=doc.get("parent_id"),
        repost_of=doc.get("repost_of"),
        quote_of=doc.get("quote_of"),
        reposted_post=reposted_post,
        quoted_post=quoted_post,
        place_name=doc.get("place_name"),
        place_longitude=doc.get("place_longitude"),
        place_latitude=doc.get("place_latitude"),
        media=doc.get("media", []) or [],
        link_preview=link_prev_obj,
        poll=poll_obj,
        hashtags=doc.get("hashtags", []) or [],
        likes_count=doc.get("likes_count", 0),
        dislikes_count=doc.get("dislikes_count", 0),
        replies_count=doc.get("replies_count", 0),
        reposts_count=doc.get("reposts_count", 0),
        quotes_count=doc.get("quotes_count", 0),
        bookmarks_count=doc.get("bookmarks_count", 0),
        views_count=doc.get("views_count", 0),
        liked_by_me=liked,
        disliked_by_me=disliked,
        reposted_by_me=reposted,
        bookmarked_by_me=bookmarked,
        promoted=_is_promoted(doc),
        promoted_until=doc.get("promoted_until") if _is_promoted(doc) else None,
        edited_at=doc.get("edited_at"),
        pinned=bool(doc.get("pinned", False)),
        community_id=doc.get("community_id"),
        community_name=_community_name,
        title=doc.get("title"),
        created_at=doc["created_at"],
    )


def _is_promoted(doc: dict) -> bool:
    until = doc.get("promoted_until")
    if not until:
        return False
    try:
        return until > datetime.now(timezone.utc)
    except Exception:
        return False


@router.post("/posts", response_model=Post)
async def create_post(body: PostCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    text = (body.text or "").strip()[:500]
    media = _normalize_media(body.media)
    has_quote = bool(body.quote_of)
    has_poll = bool(body.poll and (body.poll.options or []))
    title = (body.title or "").strip()[:200] or None
    community_id = None
    if body.community_id:
        comm = await db.communities.find_one({"id": body.community_id}, {"_id": 0, "id": 1})
        if not comm:
            raise HTTPException(status_code=404, detail="Community not found")
        if not await db.community_members.find_one(
            {"community_id": body.community_id, "user_id": user["user_id"]}, {"_id": 0, "id": 1}
        ):
            raise HTTPException(status_code=403, detail="Join the community to post here")
        community_id = body.community_id
    if not text and not media and not has_quote and not has_poll and not title:
        raise HTTPException(status_code=400, detail="Empty post")
    parent_id = None
    if body.parent_id:
        parent = await db.posts.find_one({"id": body.parent_id}, {"_id": 0})
        if not parent:
            raise HTTPException(status_code=404, detail="Parent post not found")
        parent_id = body.parent_id
    quote_of = None
    if body.quote_of:
        # If quoting a repost-entry, retarget to the original.
        target = await db.posts.find_one({"id": body.quote_of}, {"_id": 0})
        if not target:
            raise HTTPException(status_code=404, detail="Quoted post not found")
        if target.get("repost_of"):
            target = await db.posts.find_one({"id": target["repost_of"]}, {"_id": 0})
            if not target:
                raise HTTPException(status_code=404, detail="Quoted post not found")
        quote_of = target["id"]

    hashtags = _extract_hashtags(text)
    poll_doc = None
    if has_poll:
        opts = [(o or "").strip()[:60] for o in body.poll.options if (o or "").strip()]
        # Deduplicate while preserving order
        seen = set(); opts = [o for o in opts if not (o in seen or seen.add(o))]
        if len(opts) < 2 or len(opts) > 4:
            raise HTTPException(status_code=400, detail="Poll needs 2-4 options")
        hours = max(1, min(int(body.poll.duration_hours or 24), 24 * 7))
        poll_doc = {
            "options": [
                {"id": str(uuid.uuid4())[:8], "text": o, "votes": 0} for o in opts
            ],
            "ends_at": datetime.now(timezone.utc) + timedelta(hours=hours),
            "closed": False,
        }

    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["user_id"],
        "text": text,
        "parent_id": parent_id,
        "quote_of": quote_of,
        "place_name": body.place_name,
        "place_longitude": body.place_longitude,
        "place_latitude": body.place_latitude,
        "media": media,
        "poll": poll_doc,
        "hashtags": hashtags,
        "community_id": community_id,
        "title": title,
        "likes_count": 0,
        "replies_count": 0,
        "reposts_count": 0,
        "quotes_count": 0,
        "bookmarks_count": 0,
        "created_at": datetime.now(timezone.utc),
    }
    await db.posts.insert_one(doc.copy())
    if community_id and not parent_id:
        await db.communities.update_one({"id": community_id}, {"$inc": {"post_count": 1}})
    if parent_id:
        await db.posts.update_one({"id": parent_id}, {"$inc": {"replies_count": 1}})
        parent = await db.posts.find_one({"id": parent_id}, {"_id": 0, "user_id": 1})
        if parent:
            await emit_notification(
                user_id=parent["user_id"], actor_id=user["user_id"],
                ntype="reply", post_id=parent_id,
                message=(text or "📎 media")[:140],
            )
    if quote_of:
        await db.posts.update_one({"id": quote_of}, {"$inc": {"quotes_count": 1}})
        q = await db.posts.find_one({"id": quote_of}, {"_id": 0, "user_id": 1})
        if q:
            await emit_notification(
                user_id=q["user_id"], actor_id=user["user_id"],
                ntype="repost", post_id=quote_of,
                message=(text or "")[:140],
            )

    # Link preview: fetch async, persist on the post in-place.
    url = first_url(text)
    if url:
        try:
            preview = await fetch_link_preview(url)
            if preview:
                await db.posts.update_one(
                    {"id": doc["id"]}, {"$set": {"link_preview": preview}}
                )
                doc["link_preview"] = preview
        except Exception:
            pass

    return await _hydrate_post(doc, user["user_id"])


@router.patch("/posts/{post_id}", response_model=Post)
async def edit_post(
    post_id: str, body: PostPatch, authorization: Optional[str] = Header(None)
):
    user = await get_current_user(authorization)
    doc = await db.posts.find_one({"id": post_id, "user_id": user["user_id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Post not found")
    patch = {}
    if body.text is not None:
        patch["text"] = body.text.strip()[:500]
    if body.media is not None:
        patch["media"] = _normalize_media(body.media)
    if not patch:
        return await _hydrate_post(doc, user["user_id"])
    new_text = patch.get("text", doc.get("text", ""))
    new_media = patch.get("media", doc.get("media", []) or [])
    if not new_text and not new_media:
        raise HTTPException(status_code=400, detail="Post cannot be empty")
    patch["edited_at"] = datetime.now(timezone.utc)
    await db.posts.update_one({"id": post_id}, {"$set": patch})
    updated = await db.posts.find_one({"id": post_id}, {"_id": 0})
    return await _hydrate_post(updated, user["user_id"])


@router.delete("/posts/{post_id}")
async def delete_post(post_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    # Owner can always delete; mods/admins can remove anyone's post (moderation).
    if is_mod(user):
        doc = await db.posts.find_one({"id": post_id}, {"_id": 0})
    else:
        doc = await db.posts.find_one({"id": post_id, "user_id": user["user_id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Post not found")
    await db.posts.delete_one({"id": post_id})
    if doc.get("parent_id"):
        await db.posts.update_one({"id": doc["parent_id"]}, {"$inc": {"replies_count": -1}})
    await db.post_likes.delete_many({"post_id": post_id})
    return {"ok": True}


@router.get("/posts/{post_id}", response_model=Post)
async def get_post(post_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.posts.find_one({"id": post_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Post not found")
    return await _hydrate_post(doc, user["user_id"])


@router.get("/posts/{post_id}/replies", response_model=List[Post])
async def list_replies(post_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    cursor = db.posts.find({"parent_id": post_id}, {"_id": 0}).sort("created_at", 1)
    docs = await cursor.to_list(200)
    docs.sort(key=lambda d: not d.get("pinned", False))  # pinned comments first
    return [await _hydrate_post(d, user["user_id"]) for d in docs]


@router.get("/posts/{post_id}/thread", response_model=List[Post])
async def post_thread(post_id: str, authorization: Optional[str] = Header(None)):
    """The full comment tree under a post (all descendants, flat). The client
    nests them by parent_id and shows 'replying to @user'."""
    user = await get_current_user(authorization)
    out_docs: list = []
    seen: set = set()
    frontier = [post_id]
    for _ in range(8):  # cap thread depth
        if not frontier:
            break
        children = await db.posts.find(
            {"parent_id": {"$in": frontier}}, {"_id": 0}
        ).to_list(1000)
        frontier = []
        for c in children:
            if c["id"] in seen:
                continue
            seen.add(c["id"])
            out_docs.append(c)
            frontier.append(c["id"])
    out_docs.sort(key=lambda d: d.get("created_at"))
    return [await _hydrate_post(d, user["user_id"]) for d in out_docs]


async def _viewer_affinity(viewer_id: str):
    """Build the viewer's affinity to authors and hashtags from what they
    like / bookmark / view. Heavier weight for stronger signals."""
    async def _ids(coll, limit, weight):
        rows = await coll.find(
            {"user_id": viewer_id}, {"_id": 0, "post_id": 1}
        ).sort("created_at", -1).limit(limit).to_list(limit)
        return [(r["post_id"], weight) for r in rows if r.get("post_id")]

    pairs = (
        await _ids(db.post_bookmarks, 100, 4.0)
        + await _ids(db.post_likes, 200, 3.0)
        + await _ids(db.post_views, 300, 1.0)
    )
    weight_by_post: dict = {}
    for pid, w in pairs:
        weight_by_post[pid] = weight_by_post.get(pid, 0.0) + w
    author_aff: dict = {}
    tag_aff: dict = {}
    pids = list(weight_by_post.keys())
    if pids:
        docs = await db.posts.find(
            {"id": {"$in": pids}}, {"_id": 0, "id": 1, "user_id": 1, "hashtags": 1}
        ).to_list(len(pids))
        for d in docs:
            w = weight_by_post.get(d["id"], 0.0)
            author_aff[d.get("user_id")] = author_aff.get(d.get("user_id"), 0.0) + w
            for t in (d.get("hashtags") or []):
                tag_aff[t] = tag_aff.get(t, 0.0) + w
    return author_aff, tag_aff


def _rank_score(doc: dict, author_aff: dict, tag_aff: dict, now: datetime) -> float:
    """Blend personal affinity, overall engagement, and recency into one score."""
    score = 2.0 * author_aff.get(doc.get("user_id"), 0.0)
    for t in (doc.get("hashtags") or []):
        score += 1.0 * tag_aff.get(t, 0.0)
    eng = (
        doc.get("likes_count", 0)
        + 2.0 * doc.get("replies_count", 0)
        + 1.5 * doc.get("reposts_count", 0)
        + 0.2 * doc.get("views_count", 0)
    )
    score += 0.6 * math.log1p(max(0.0, eng))
    created = doc.get("created_at")
    age_h = 1e6
    try:
        age_h = max(0.0, (now - created).total_seconds() / 3600.0)
    except Exception:
        pass
    score += 6.0 * math.exp(-age_h / 36.0)  # decays over ~1.5 days
    pu = doc.get("promoted_until")
    if pu:
        try:
            if pu > now:
                score += 50.0  # promoted posts surface first
        except Exception:
            pass
    return score


async def _rank_docs(docs: list, viewer_id: str, top: int) -> list:
    """Personalized re-rank: best matches for this viewer first."""
    if not docs:
        return docs
    author_aff, tag_aff = await _viewer_affinity(viewer_id)
    now = datetime.now(timezone.utc)
    ranked = sorted(docs, key=lambda d: _rank_score(d, author_aff, tag_aff, now), reverse=True)
    return ranked[:top]


@router.get("/feed/explore", response_model=List[Post])
async def explore_feed(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    # Pull a broad recent candidate set, then rank it for this viewer.
    cursor = db.posts.find(
        {"parent_id": None, "group_id": {"$in": [None, ""]}, "community_id": {"$in": [None, ""]}},
        {"_id": 0},
    ).sort("created_at", -1).limit(300)
    docs = await cursor.to_list(300)
    ranked = await _rank_docs(docs, user["user_id"], 100)
    return [await _hydrate_post(d, user["user_id"]) for d in ranked]


@router.get("/feed/home", response_model=List[Post])
async def home_feed(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    followees = await db.follows.find(
        {"follower_id": user["user_id"]}, {"_id": 0, "followee_id": 1}
    ).to_list(500)
    ids = [f["followee_id"] for f in followees] + [user["user_id"]]
    cursor = (
        db.posts.find(
            {"parent_id": None, "user_id": {"$in": ids}, "group_id": {"$in": [None, ""]}, "community_id": {"$in": [None, ""]}},
            {"_id": 0},
        ).sort("created_at", -1).limit(200)
    )
    docs = await cursor.to_list(200)
    ranked = await _rank_docs(docs, user["user_id"], 100)
    return [await _hydrate_post(d, user["user_id"]) for d in ranked]


@router.get("/posts/user/{user_id}", response_model=List[Post])
async def user_posts(user_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    cursor = (
        db.posts.find({"user_id": user_id, "parent_id": None}, {"_id": 0})
        .sort("created_at", -1).limit(100)
    )
    docs = await cursor.to_list(100)
    docs.sort(key=lambda d: not d.get("pinned", False))  # pinned posts first
    return [await _hydrate_post(d, me["user_id"]) for d in docs]


@router.post("/posts/{post_id}/like", response_model=Post)
async def toggle_like(post_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.posts.find_one({"id": post_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Post not found")
    existing = await db.post_likes.find_one(
        {"post_id": post_id, "user_id": user["user_id"]}, {"_id": 0}
    )
    if existing:
        await db.post_likes.delete_one({"post_id": post_id, "user_id": user["user_id"]})
        await db.posts.update_one({"id": post_id}, {"$inc": {"likes_count": -1}})
    else:
        # Like and dislike are mutually exclusive — clear any dislike first.
        dis = await db.post_dislikes.find_one({"post_id": post_id, "user_id": user["user_id"]}, {"_id": 0})
        if dis:
            await db.post_dislikes.delete_one({"post_id": post_id, "user_id": user["user_id"]})
            await db.posts.update_one({"id": post_id}, {"$inc": {"dislikes_count": -1}})
        try:
            await db.post_likes.insert_one({
                "post_id": post_id, "user_id": user["user_id"],
                "created_at": datetime.now(timezone.utc),
            })
            await db.posts.update_one({"id": post_id}, {"$inc": {"likes_count": 1}})
            await emit_notification(
                user_id=doc["user_id"],
                actor_id=user["user_id"],
                ntype="like",
                post_id=post_id,
                message=(doc.get("text") or "")[:140],
            )
        except DuplicateKeyError:
            pass
    updated = await db.posts.find_one({"id": post_id}, {"_id": 0})
    return await _hydrate_post(updated, user["user_id"])


@router.post("/posts/{post_id}/dislike", response_model=Post)
async def toggle_dislike(post_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    uid = user["user_id"]
    doc = await db.posts.find_one({"id": post_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Post not found")
    existing = await db.post_dislikes.find_one({"post_id": post_id, "user_id": uid}, {"_id": 0})
    if existing:
        await db.post_dislikes.delete_one({"post_id": post_id, "user_id": uid})
        await db.posts.update_one({"id": post_id}, {"$inc": {"dislikes_count": -1}})
    else:
        # Clear any like first (mutually exclusive).
        like = await db.post_likes.find_one({"post_id": post_id, "user_id": uid}, {"_id": 0})
        if like:
            await db.post_likes.delete_one({"post_id": post_id, "user_id": uid})
            await db.posts.update_one({"id": post_id}, {"$inc": {"likes_count": -1}})
        try:
            await db.post_dislikes.insert_one({
                "post_id": post_id, "user_id": uid, "created_at": datetime.now(timezone.utc),
            })
            await db.posts.update_one({"id": post_id}, {"$inc": {"dislikes_count": 1}})
        except DuplicateKeyError:
            pass
    updated = await db.posts.find_one({"id": post_id}, {"_id": 0})
    return await _hydrate_post(updated, uid)


@router.post("/posts/{post_id}/promote", response_model=Post)
async def promote_post(
    post_id: str, body: PromoteCreate, authorization: Optional[str] = Header(None)
):
    """Boost your own post for N days — it surfaces higher and shows a
    'Sponsored' badge."""
    user = await get_current_user(authorization)
    doc = await db.posts.find_one({"id": post_id, "user_id": user["user_id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Post not found or not yours")
    days = max(1, min(30, int(body.days or 7)))
    until = datetime.now(timezone.utc) + timedelta(days=days)
    patch = {"promoted_until": until}
    # Optional pay-per-click campaign: fund a budget, charged per click at the CPC.
    if body.budget is not None and body.budget > 0:
        patch["ad_budget"] = round(float(body.budget), 2)
        patch["ad_cpc"] = round(float(body.cpc or 0.10), 2)
        patch["ad_spent"] = float(doc.get("ad_spent", 0) or 0)
    await db.posts.update_one({"id": post_id}, {"$set": patch})
    updated = await db.posts.find_one({"id": post_id}, {"_id": 0})
    return await _hydrate_post(updated, user["user_id"])


@router.post("/posts/{post_id}/repost", response_model=Post)
async def toggle_repost(post_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    orig = await db.posts.find_one({"id": post_id}, {"_id": 0})
    if not orig:
        raise HTTPException(status_code=404, detail="Post not found")
    if orig.get("repost_of"):
        post_id = orig["repost_of"]
        orig = await db.posts.find_one({"id": post_id}, {"_id": 0})
        if not orig:
            raise HTTPException(status_code=404, detail="Post not found")
    existing = await db.posts.find_one(
        {"user_id": user["user_id"], "repost_of": post_id}, {"_id": 0}
    )
    if existing:
        await db.posts.delete_one({"id": existing["id"]})
        await db.posts.update_one({"id": post_id}, {"$inc": {"reposts_count": -1}})
    else:
        await db.posts.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": user["user_id"],
            "text": "",
            "parent_id": None,
            "repost_of": post_id,
            "place_name": None, "place_longitude": None, "place_latitude": None,
            "likes_count": 0, "replies_count": 0, "reposts_count": 0,
            "created_at": datetime.now(timezone.utc),
        })
        await db.posts.update_one({"id": post_id}, {"$inc": {"reposts_count": 1}})
        await emit_notification(
            user_id=orig["user_id"],
            actor_id=user["user_id"],
            ntype="repost",
            post_id=post_id,
            message=(orig.get("text") or "")[:140],
        )
    updated = await db.posts.find_one({"id": post_id}, {"_id": 0})
    return await _hydrate_post(updated, user["user_id"])



@router.post("/posts/{post_id}/bookmark", response_model=Post)
async def toggle_bookmark(post_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.posts.find_one({"id": post_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Post not found")
    existing = await db.post_bookmarks.find_one(
        {"post_id": post_id, "user_id": user["user_id"]}, {"_id": 0}
    )
    if existing:
        await db.post_bookmarks.delete_one(
            {"post_id": post_id, "user_id": user["user_id"]}
        )
        await db.posts.update_one(
            {"id": post_id}, {"$inc": {"bookmarks_count": -1}}
        )
    else:
        try:
            await db.post_bookmarks.insert_one({
                "post_id": post_id,
                "user_id": user["user_id"],
                "created_at": datetime.now(timezone.utc),
            })
            await db.posts.update_one(
                {"id": post_id}, {"$inc": {"bookmarks_count": 1}}
            )
        except DuplicateKeyError:
            pass
    updated = await db.posts.find_one({"id": post_id}, {"_id": 0})
    return await _hydrate_post(updated, user["user_id"])


@router.get("/bookmarks", response_model=List[Post])
async def list_bookmarks(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    bookmarks = await (
        db.post_bookmarks.find({"user_id": user["user_id"]}, {"_id": 0})
        .sort("created_at", -1)
        .limit(200)
        .to_list(200)
    )
    if not bookmarks:
        return []
    post_ids = [b["post_id"] for b in bookmarks]
    docs = await db.posts.find({"id": {"$in": post_ids}}, {"_id": 0}).to_list(200)
    order = {pid: i for i, pid in enumerate(post_ids)}
    docs.sort(key=lambda d: order.get(d["id"], 0))
    return [await _hydrate_post(d, user["user_id"]) for d in docs]


# ---------- Hashtags ----------
@router.get("/hashtags/{tag}", response_model=List[Post])
async def posts_for_hashtag(tag: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    t = (tag or "").lstrip("#").lower()
    if not t:
        raise HTTPException(status_code=400, detail="Empty tag")
    cursor = (
        db.posts.find({"hashtags": t, "parent_id": None}, {"_id": 0})
        .sort("created_at", -1).limit(100)
    )
    docs = await cursor.to_list(100)
    return [await _hydrate_post(d, user["user_id"]) for d in docs]


@router.get("/hashtags/{tag}/count")
async def hashtag_count(tag: str, authorization: Optional[str] = Header(None)):
    await get_current_user(authorization)
    t = (tag or "").lstrip("#").lower()
    n = await db.posts.count_documents({"hashtags": t, "parent_id": None})
    return {"tag": t, "count": n}


# ---------- Who liked / reposted ----------
@router.get("/posts/{post_id}/likers", response_model=List[PublicUser])
async def post_likers(post_id: str, authorization: Optional[str] = Header(None)):
    from core import _public_user
    await get_current_user(authorization)
    likes = await (
        db.post_likes.find({"post_id": post_id}, {"_id": 0})
        .sort("created_at", -1).limit(200).to_list(200)
    )
    return [await _public_user(l["user_id"]) for l in likes]


@router.get("/posts/{post_id}/reposters", response_model=List[PublicUser])
async def post_reposters(post_id: str, authorization: Optional[str] = Header(None)):
    from core import _public_user
    await get_current_user(authorization)
    reposts = await (
        db.posts.find({"repost_of": post_id}, {"_id": 0})
        .sort("created_at", -1).limit(200).to_list(200)
    )
    return [await _public_user(r["user_id"]) for r in reposts]


# ---------- Polls ----------
@router.post("/posts/{post_id}/vote", response_model=Post)
async def vote_poll(
    post_id: str,
    body: dict,
    authorization: Optional[str] = Header(None),
):
    user = await get_current_user(authorization)
    option_id = (body or {}).get("option_id")
    if not option_id:
        raise HTTPException(status_code=400, detail="option_id required")
    doc = await db.posts.find_one({"id": post_id}, {"_id": 0})
    if not doc or not doc.get("poll"):
        raise HTTPException(status_code=404, detail="Poll not found")
    poll = doc["poll"]
    ends_at = poll.get("ends_at")
    if ends_at and ends_at.replace(tzinfo=ends_at.tzinfo or timezone.utc) \
       <= datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Poll closed")
    if not any(o["id"] == option_id for o in poll.get("options", [])):
        raise HTTPException(status_code=400, detail="Invalid option")
    # Prevent double-vote; allow changing vote
    existing = await db.poll_votes.find_one(
        {"post_id": post_id, "user_id": user["user_id"]}, {"_id": 0}
    )
    if existing:
        if existing["option_id"] == option_id:
            # Same option => no-op
            updated = await db.posts.find_one({"id": post_id}, {"_id": 0})
            return await _hydrate_post(updated, user["user_id"])
        # Decrement previous, increment new
        await db.posts.update_one(
            {"id": post_id, "poll.options.id": existing["option_id"]},
            {"$inc": {"poll.options.$.votes": -1}},
        )
        await db.poll_votes.update_one(
            {"post_id": post_id, "user_id": user["user_id"]},
            {"$set": {"option_id": option_id,
                      "updated_at": datetime.now(timezone.utc)}},
        )
    else:
        await db.poll_votes.insert_one({
            "post_id": post_id, "user_id": user["user_id"],
            "option_id": option_id,
            "created_at": datetime.now(timezone.utc),
        })
    await db.posts.update_one(
        {"id": post_id, "poll.options.id": option_id},
        {"$inc": {"poll.options.$.votes": 1}},
    )
    updated = await db.posts.find_one({"id": post_id}, {"_id": 0})
    return await _hydrate_post(updated, user["user_id"])


@router.post("/posts/{post_id}/view")
async def record_view(post_id: str, authorization: Optional[str] = Header(None)):
    """Record a unique view (idempotent per user per post)."""
    user = await get_current_user(authorization)
    try:
        await db.post_views.insert_one({
            "post_id": post_id, "user_id": user["user_id"],
            "created_at": datetime.now(timezone.utc),
        })
        await db.posts.update_one(
            {"id": post_id}, {"$inc": {"views_count": 1}}
        )
        return {"viewed": True}
    except DuplicateKeyError:
        return {"viewed": False}


@router.post("/posts/{post_id}/report")
async def report_post(
    post_id: str, body: ReportCreate, authorization: Optional[str] = Header(None)
):
    """Flag a post or reel for moderation (one report per user per post)."""
    user = await get_current_user(authorization)
    post = await db.posts.find_one({"id": post_id}, {"_id": 0, "id": 1})
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    existing = await db.reports.find_one(
        {"post_id": post_id, "reporter_id": user["user_id"]}, {"_id": 0, "id": 1}
    )
    if not existing:
        await db.reports.insert_one({
            "id": str(uuid.uuid4()),
            "post_id": post_id,
            "reporter_id": user["user_id"],
            "reason": (body.reason or "other")[:200],
            "created_at": datetime.now(timezone.utc),
        })
    return {"ok": True}


@router.post("/posts/{post_id}/pin", response_model=Post)
async def toggle_pin(post_id: str, authorization: Optional[str] = Header(None)):
    """Pin/unpin a post. A top-level post is pinned by its author (to the top of
    their profile); a reply/comment is pinned by the parent post's author (to the
    top of the thread)."""
    user = await get_current_user(authorization)
    doc = await db.posts.find_one({"id": post_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Post not found")
    parent_id = doc.get("parent_id")
    if parent_id:
        parent = await db.posts.find_one({"id": parent_id}, {"_id": 0, "user_id": 1})
        owner = parent.get("user_id") if parent else None
    else:
        owner = doc.get("user_id")
    if owner != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only the owner can pin this")
    new_pinned = not bool(doc.get("pinned", False))
    await db.posts.update_one({"id": post_id}, {"$set": {"pinned": new_pinned}})
    updated = await db.posts.find_one({"id": post_id}, {"_id": 0})
    return await _hydrate_post(updated, user["user_id"])


def _has_playable_video(doc: dict) -> bool:
    """A reel must have a video whose data is actually loadable (data URI or
    remote URL) — filters out black screens from old file:// uploads."""
    for m in (doc.get("media") or []):
        if m.get("type") == "video":
            b = m.get("base64") or ""
            if b.startswith("data:") or b.startswith("http"):
                return True
    return False


@router.get("/feed/reels", response_model=List[Post])
async def reels_feed(
    focus: Optional[str] = Query(None), authorization: Optional[str] = Header(None)
):
    """Vertical video feed: every playable video post (watched or not),
    de-duplicated and personalized. A `focus` post is pinned first."""
    user = await get_current_user(authorization)
    uid = user["user_id"]
    cursor = (
        db.posts.find(
            {"parent_id": None, "media": {"$elemMatch": {"type": "video"}}},
            {"_id": 0},
        ).sort("created_at", -1).limit(250)
    )
    docs = await cursor.to_list(250)
    seen: set = set()
    playable: list = []
    for d in docs:
        if d["id"] in seen:
            continue
        seen.add(d["id"])
        if _has_playable_video(d):
            playable.append(d)
    ranked = await _rank_docs(playable, uid, 60)
    if focus:
        ranked.sort(key=lambda d: 0 if d["id"] == focus else 1)
    return [await _hydrate_post(d, uid) for d in ranked]


@router.get("/posts/user/{user_id}/all", response_model=List[Post])
async def user_posts_with_reposts(
    user_id: str, authorization: Optional[str] = Header(None)
):
    """User's profile feed: their original posts AND their reposts/quotes."""
    me = await get_current_user(authorization)
    cursor = (
        db.posts.find({"user_id": user_id, "parent_id": None}, {"_id": 0})
        .sort("created_at", -1).limit(100)
    )
    docs = await cursor.to_list(100)
    docs.sort(key=lambda d: not d.get("pinned", False))  # pinned posts first
    return [await _hydrate_post(d, me["user_id"]) for d in docs]
