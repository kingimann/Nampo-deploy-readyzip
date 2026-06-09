"""Posts, feed, replies, likes, reposts."""
from datetime import datetime, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel
from db import DuplicateKeyError

from core import db, get_current_user, is_mod, is_admin
from models import (
    LinkPreview, Poll, PollOption, Post, PostAuthor, PostCreate, PostMedia,
    PostPatch, PostPrivacyPatch, PublicUser, ReactionCount, ReportCreate, PromoteCreate,
    TaggedUser,
)
from routes.notifications import emit_notification
from services.link_preview import fetch_link_preview, first_url
import re
import math
import asyncio
import httpx
from urllib.parse import urlparse
from datetime import timedelta

router = APIRouter()

_HASHTAG_RE = re.compile(r"(?<![A-Za-z0-9_])#([A-Za-z0-9_]{1,50})")


def _reaction_list(reactions: Optional[dict]) -> list:
    """Turn the {emoji: count} tally into a list sorted by count desc."""
    items = [{"emoji": k, "count": int(v)} for k, v in (reactions or {}).items() if int(v) > 0]
    items.sort(key=lambda r: r["count"], reverse=True)
    return items


def _extract_hashtags(text: str) -> list:
    return list({m.group(1).lower() for m in _HASHTAG_RE.finditer(text or "")})


COMMENT_POLICIES = {"everyone", "followers", "friends", "nobody"}


async def _viewer_can_comment(post: dict, viewer_id: Optional[str]) -> bool:
    """Whether `viewer_id` may comment on `post`, per its comment policy."""
    author = post.get("user_id")
    if viewer_id and viewer_id == author:
        return True   # authors can always reply on their own posts
    policy = post.get("comment_policy") or "everyone"
    if policy == "everyone":
        return True
    # Policy is restrictive from here — admins are immune to it. Only look up
    # the viewer when needed so the common "everyone" path stays a no-op.
    if viewer_id:
        viewer = await db.users.find_one({"user_id": viewer_id}, {"_id": 0, "role": 1, "email": 1})
        if viewer and is_admin(viewer):
            return True
    if policy == "nobody" or not viewer_id:
        return False
    if policy == "followers":
        return bool(await db.follows.find_one(
            {"follower_id": viewer_id, "followee_id": author}, {"_id": 0, "follower_id": 1}))
    if policy == "friends":
        a, b = sorted([viewer_id, author])
        return bool(await db.friendships.find_one({"a": a, "b": b}, {"_id": 0, "a": 1}))
    return True


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


def _trusted_video_url(url: str) -> bool:
    """A video URL is allowed if it's our CDN or a **direct** https video file
    (so pasted reel links from imgur/streamable/etc. play inline like an upload)."""
    u = (url or "").strip().lower()
    if not u.startswith("https://"):
        return False
    if "cloudinary.com" in u:
        return True
    path = u.split("?", 1)[0]
    return path.endswith((".mp4", ".webm", ".mov", ".m4v", ".ogg"))


_VIDEO_EXT_RE = re.compile(r"\.(mp4|webm|mov|m4v|ogg)(\?|$)", re.I)


async def _resolve_video_url(url: str) -> Optional[dict]:
    """Turn a video page link (imgur, streamable, or any page with an og:video)
    into a direct, playable video URL so it can be embedded like an upload."""
    u = (url or "").strip()
    if not u.lower().startswith(("http://", "https://")):
        return None
    if _VIDEO_EXT_RE.search(u.split("?")[0]) or "cloudinary.com" in u.lower():
        return {"url": u}

    # Player embeds (can't be served as a raw file) — play via their iframe.
    yt = re.search(r"(?:youtube\.com/(?:watch\?v=|shorts/|live/)|youtu\.be/)([A-Za-z0-9_-]{11})", u)
    if yt:
        vid = yt.group(1)
        return {"embed": "youtube",
                "url": f"https://www.youtube.com/embed/{vid}?autoplay=1&mute=1&loop=1&playlist={vid}&playsinline=1&rel=0&modestbranding=1",
                "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"}
    vm = re.search(r"vimeo\.com/(?:video/)?(\d+)", u)
    if vm:
        return {"embed": "vimeo",
                "url": f"https://player.vimeo.com/video/{vm.group(1)}?autoplay=1&muted=1&loop=1&playsinline=1",
                "thumbnail": None}
    tt = re.search(r"tiktok\.com/.*?/video/(\d+)", u) or re.search(r"tiktok\.com/v/(\d+)", u)
    if tt:
        return {"embed": "tiktok", "url": f"https://www.tiktok.com/embed/v2/{tt.group(1)}", "thumbnail": None}

    try:
        parsed = urlparse(u)
    except Exception:
        return None
    host, path = parsed.netloc.lower(), parsed.path
    headers = {"User-Agent": "Mozilla/5.0 (compatible; NamiBot/1.0)"}
    async with httpx.AsyncClient(timeout=10, follow_redirects=True, headers=headers) as client:
        if "imgur.com" in host:
            m = re.search(r"/([a-zA-Z0-9]{5,8})(?:\.|/|$)", path)
            if m:
                cand = f"https://i.imgur.com/{m.group(1)}.mp4"
                try:
                    r = await client.head(cand)
                    if r.status_code == 200 and "video" in r.headers.get("content-type", ""):
                        return {"url": cand}
                except Exception:
                    pass
        if "streamable.com" in host:
            m = re.search(r"/([a-zA-Z0-9]+)", path)
            if m:
                try:
                    r = await client.get(f"https://api.streamable.com/videos/{m.group(1)}")
                    if r.status_code == 200:
                        j = r.json()
                        murl = (((j.get("files") or {}).get("mp4") or {}).get("url"))
                        if murl:
                            murl = ("https:" + murl) if murl.startswith("//") else murl
                            thumb = j.get("thumbnail_url")
                            thumb = ("https:" + thumb) if (thumb and thumb.startswith("//")) else thumb
                            return {"url": murl, "thumbnail": thumb}
                except Exception:
                    pass
        # Generic: look for an og:video meta tag or a <source>.mp4 on the page.
        try:
            r = await client.get(u)
            html = (r.text or "")[:200000]
            for pat in (
                r'(?:property|name)=["\']og:video(?::secure_url|:url)?["\']\s+content=["\']([^"\']+)["\']',
                r'<source[^>]+src=["\']([^"\']+\.(?:mp4|webm)[^"\']*)["\']',
            ):
                mm = re.search(pat, html, re.I)
                if mm:
                    vurl = mm.group(1)
                    vurl = ("https:" + vurl) if vurl.startswith("//") else vurl
                    if _VIDEO_EXT_RE.search(vurl.split("?")[0]):
                        return {"url": vurl}
        except Exception:
            pass
    return None


class ResolveVideo(BaseModel):
    url: str


@router.post("/media/resolve-video")
async def resolve_video(body: ResolveVideo, authorization: Optional[str] = Header(None)):
    """Resolve an imgur/streamable/page link to a direct, playable video URL."""
    await get_current_user(authorization)
    res = await _resolve_video_url(body.url)
    if not res or not res.get("url"):
        raise HTTPException(status_code=400, detail="Couldn't find a playable video at that link. Try the direct .mp4 link.")
    return res


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
        d.pop("embed", None)   # player embeds (YouTube/TikTok) are never reel media
        # Pasted video links must be a direct, playable https video file.
        if d["type"] == "video" and url and not b and not _trusted_video_url(url):
            raise HTTPException(status_code=400, detail="Video links must be a direct https video file (.mp4, .webm, …), e.g. an i.imgur.com/…mp4 link.")
        out.append(d)
    return out


async def _viewer_sub_level(viewer_id: Optional[str], creator_id: str) -> int:
    """The viewer's active subscription level (1-3) for this creator, 0 if none.
    The creator always sees their own gated content (treated as max level)."""
    if not viewer_id:
        return 0
    if viewer_id == creator_id:
        return 3
    sub = await db.subscriptions.find_one(
        {"subscriber_id": viewer_id, "creator_id": creator_id, "status": "active"},
        {"_id": 0, "tier": 1},
    )
    if sub:
        from core import SUBSCRIPTION_TIER_LEVEL
        return SUBSCRIPTION_TIER_LEVEL.get(sub.get("tier"), 1)
    # Admins are immune to creator paywalls — they can see all gated content.
    viewer = await db.users.find_one({"user_id": viewer_id}, {"_id": 0, "role": 1, "email": 1})
    if viewer and is_admin(viewer):
        return 3
    return 0


async def _hydrate_tagged(ids: Optional[list]) -> List[TaggedUser]:
    """Resolve stored tagged user-ids into display objects (name + avatar).
    Silently drops ids that no longer map to a user."""
    out: List[TaggedUser] = []
    for uid in (ids or [])[:30]:
        if not isinstance(uid, str):
            continue
        u = await db.users.find_one(
            {"user_id": uid}, {"_id": 0, "user_id": 1, "name": 1, "username": 1, "picture": 1}
        )
        if u:
            out.append(TaggedUser(
                user_id=u["user_id"], name=u.get("name", "Unknown"),
                username=u.get("username"), picture=u.get("picture"),
            ))
    return out


async def _clean_tag_ids(ids: Optional[list], exclude: Optional[str] = None) -> list:
    """Dedupe, drop self/unknown ids, honor each taggee's tag_policy
    (everyone | followers | nobody), and cap how many people can be tagged.
    `exclude` is the author — used both to skip self and as the actor for the
    "followers" policy check."""
    out: list = []
    seen: set = set()
    for uid in (ids or []):
        if not isinstance(uid, str) or uid in seen or uid == exclude:
            continue
        u = await db.users.find_one({"user_id": uid}, {"_id": 0, "user_id": 1, "tag_policy": 1})
        if not u:
            continue
        policy = u.get("tag_policy") or "everyone"
        if policy == "nobody":
            continue
        if policy == "followers" and exclude:
            # Only allow the tag if the author follows this person.
            if not await db.follows.find_one(
                {"follower_id": exclude, "followee_id": uid}, {"_id": 0, "follower_id": 1}
            ):
                continue
        seen.add(uid)
        out.append(uid)
        if len(out) >= 20:
            break
    return out


async def _notify_tags(tagged_ids: list, actor_id: str, post_id: str, preview: str) -> None:
    for uid in tagged_ids:
        await emit_notification(
            user_id=uid, actor_id=actor_id, ntype="tag",
            post_id=post_id, message=preview,
        )


async def _hydrate_post(doc: dict, viewer_id: Optional[str]) -> Post:
    _community_name = None
    if doc.get("community_id"):
        _c = await db.communities.find_one({"id": doc["community_id"]}, {"_id": 0, "name": 1})
        _community_name = _c.get("name") if _c else None
    author_doc = await db.users.find_one({"user_id": doc["user_id"]}, {"_id": 0})
    from core import _resolve_badges
    author = PostAuthor(
        user_id=doc["user_id"],
        name=author_doc.get("name", "Unknown") if author_doc else "Unknown",
        username=author_doc.get("username") if author_doc else None,
        picture=author_doc.get("picture") if author_doc else None,
        verified=bool(author_doc.get("verified", False)) if author_doc else False,
        badges=(await _resolve_badges(author_doc.get("badge_ids")) if author_doc else []),
    )
    liked = False
    disliked = False
    reposted = False
    bookmarked = False
    my_reaction: Optional[str] = None
    if viewer_id:
        mine = await db.post_reactions.find_one(
            {"post_id": doc["id"], "user_id": viewer_id}, {"_id": 0, "emoji": 1}
        )
        my_reaction = mine.get("emoji") if mine else None
        # Back-compat flags derived from the unified reaction system.
        liked = my_reaction == "👍"
        disliked = my_reaction == "👎"
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
    # Subscribers-only gating (Twitch-style). When the viewer's subscription
    # level is below the required tier, strip the content so it can't be read
    # off the wire — the client shows a paywall instead.
    min_tier = int(doc.get("min_sub_tier") or 0)
    locked = False
    if min_tier > 0:
        locked = (await _viewer_sub_level(viewer_id, doc["user_id"])) < min_tier
    return Post(
        id=doc["id"], user_id=doc["user_id"], author=author,
        text="" if locked else doc["text"],
        parent_id=doc.get("parent_id"),
        repost_of=doc.get("repost_of"),
        quote_of=doc.get("quote_of"),
        reposted_post=reposted_post,
        quoted_post=quoted_post,
        place_name=None if locked else doc.get("place_name"),
        place_longitude=None if locked else doc.get("place_longitude"),
        place_latitude=None if locked else doc.get("place_latitude"),
        media=[] if locked else (doc.get("media", []) or []),
        tagged_users=[] if locked else (await _hydrate_tagged(doc.get("tagged_user_ids"))),
        link_preview=None if locked else link_prev_obj,
        poll=None if locked else poll_obj,
        hashtags=[] if locked else (doc.get("hashtags", []) or []),
        likes_count=doc.get("likes_count", 0),
        dislikes_count=doc.get("dislikes_count", 0),
        reactions=_reaction_list(doc.get("reactions")),
        reactions_total=sum((doc.get("reactions") or {}).values()),
        my_reaction=my_reaction,
        replies_count=doc.get("replies_count", 0),
        reposts_count=doc.get("reposts_count", 0),
        quotes_count=doc.get("quotes_count", 0),
        bookmarks_count=doc.get("bookmarks_count", 0),
        views_count=doc.get("views_count", 0),
        likes_disabled=bool(doc.get("likes_disabled", False)),
        comment_policy=doc.get("comment_policy") or "everyone",
        min_sub_tier=min_tier,
        locked=locked,
        can_comment=await _viewer_can_comment(doc, viewer_id),
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
        factcheck=None if locked else doc.get("factcheck"),
        created_at=doc["created_at"],
    )


async def _hydrate_many(docs: list, viewer_id: Optional[str]) -> list:
    """Hydrate a list of post docs concurrently. Each _hydrate_post makes several
    sequential DB round-trips; running a feed of ~100 posts one-at-a-time was the
    main feed-load latency. gather() preserves input order, so the ranked/sorted
    order of `docs` is unchanged."""
    return list(await asyncio.gather(*(_hydrate_post(d, viewer_id) for d in docs)))


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
    if user.get("posting_disabled"):
        raise HTTPException(status_code=403, detail={
            "code": "posting_disabled",
            "message": "Posting has been disabled on your account by an administrator.",
        })
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
        if not is_admin(user) and not await db.community_members.find_one(
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
        if not await _viewer_can_comment(parent, user["user_id"]):
            raise HTTPException(status_code=403, detail="The author has limited who can comment on this post")
        # Subscriber-only posts: only subscribers (at the required tier), the
        # author, and admins may comment.
        _ptier = int(parent.get("min_sub_tier") or 0)
        if _ptier > 0 and (await _viewer_sub_level(user["user_id"], parent["user_id"])) < _ptier:
            raise HTTPException(status_code=403, detail={
                "code": "subscribers_only",
                "message": f"Subscribe at Tier {_ptier} or higher to comment on this post.",
            })
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

    # Privacy: per-post overrides fall back to the author's defaults.
    likes_disabled = (
        bool(body.likes_disabled) if body.likes_disabled is not None
        else bool(user.get("default_likes_disabled", False))
    )
    comment_policy = (body.comment_policy or user.get("default_comment_policy") or "everyone")
    if comment_policy not in COMMENT_POLICIES:
        comment_policy = "everyone"

    # Subscribers-only gating (only on top-level posts, never replies).
    min_sub_tier = int(body.min_sub_tier or 0)
    if min_sub_tier not in (0, 1, 2, 3) or parent_id:
        min_sub_tier = 0

    tagged_ids = await _clean_tag_ids(body.tagged_user_ids, exclude=user["user_id"])

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
        "likes_disabled": likes_disabled,
        "comment_policy": comment_policy,
        "min_sub_tier": min_sub_tier,
        "tagged_user_ids": tagged_ids,
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
        parent = await db.posts.find_one({"id": parent_id}, {"_id": 0})
        if parent:
            await emit_notification(
                user_id=parent["user_id"], actor_id=user["user_id"],
                ntype="reply", post_id=parent_id,
                message=(text or "📎 media")[:140],
            )
            # Billable engagement: a comment on a funded promoted post debits
            # the advertiser's prepaid ad balance.
            if parent.get("promoted_until"):
                try:
                    from routes.ads import bill_ad_interaction
                    await bill_ad_interaction(parent, user["user_id"], "comment")
                except Exception:
                    pass
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

    if tagged_ids:
        await _notify_tags(tagged_ids, user["user_id"], doc["id"], (text or "📷 tagged you")[:140])

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
    if body.place_name is not None:
        name = body.place_name.strip()[:120]
        if name:
            patch["place_name"] = name
            patch["place_longitude"] = body.place_longitude
            patch["place_latitude"] = body.place_latitude
        else:
            # Empty name = remove location entirely (name + coords).
            patch["place_name"] = None
            patch["place_longitude"] = None
            patch["place_latitude"] = None
    if body.comment_policy is not None:
        patch["comment_policy"] = (
            body.comment_policy if body.comment_policy in COMMENT_POLICIES else "everyone"
        )
    new_tag_ids = None
    if body.tagged_user_ids is not None:
        new_tag_ids = await _clean_tag_ids(body.tagged_user_ids, exclude=user["user_id"])
        patch["tagged_user_ids"] = new_tag_ids
    if not patch:
        return await _hydrate_post(doc, user["user_id"])
    new_text = patch.get("text", doc.get("text", ""))
    new_media = patch.get("media", doc.get("media", []) or [])
    if not new_text and not new_media:
        raise HTTPException(status_code=400, detail="Post cannot be empty")
    patch["edited_at"] = datetime.now(timezone.utc)
    await db.posts.update_one({"id": post_id}, {"$set": patch})
    # Notify anyone newly tagged in this edit.
    if new_tag_ids:
        prev = set(doc.get("tagged_user_ids") or [])
        added = [uid for uid in new_tag_ids if uid not in prev]
        await _notify_tags(added, user["user_id"], post_id, (new_text or "📷 tagged you")[:140])
    updated = await db.posts.find_one({"id": post_id}, {"_id": 0})
    return await _hydrate_post(updated, user["user_id"])


@router.patch("/posts/{post_id}/privacy", response_model=Post)
async def edit_post_privacy(
    post_id: str, body: PostPrivacyPatch, authorization: Optional[str] = Header(None)
):
    """Change a single post's privacy individually: turn likes on/off and set
    who can comment. Author only."""
    user = await get_current_user(authorization)
    doc = await db.posts.find_one({"id": post_id, "user_id": user["user_id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Post not found")
    patch = {}
    if body.likes_disabled is not None:
        patch["likes_disabled"] = bool(body.likes_disabled)
    if body.comment_policy is not None:
        if body.comment_policy not in COMMENT_POLICIES:
            raise HTTPException(status_code=400, detail="Invalid comment policy")
        patch["comment_policy"] = body.comment_policy
    if body.min_sub_tier is not None and not doc.get("parent_id"):
        tier = int(body.min_sub_tier)
        patch["min_sub_tier"] = tier if tier in (0, 1, 2, 3) else 0
    if patch:
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


class BulkDeletePostsBody(BaseModel):
    post_ids: Optional[List[str]] = None   # omit/empty = delete ALL your posts


@router.post("/posts/delete-bulk")
async def delete_posts_bulk(body: BulkDeletePostsBody, authorization: Optional[str] = Header(None)):
    """Delete many of your own posts at once. With post_ids: just those.
    Without: purge every post you've made."""
    user = await get_current_user(authorization)
    q: dict = {"user_id": user["user_id"]}
    if body.post_ids:
        q["id"] = {"$in": [p for p in body.post_ids if isinstance(p, str)][:2000]}
    docs = await db.posts.find(q, {"_id": 0, "id": 1, "parent_id": 1}).to_list(5000)
    ids = [d["id"] for d in docs]
    if not ids:
        return {"ok": True, "deleted": 0}
    await db.posts.delete_many({"id": {"$in": ids}})
    # Keep reply counts correct on any surviving parent posts.
    for d in docs:
        if d.get("parent_id"):
            await db.posts.update_one({"id": d["parent_id"]}, {"$inc": {"replies_count": -1}})
    await db.post_likes.delete_many({"post_id": {"$in": ids}})
    return {"ok": True, "deleted": len(ids)}


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
    return await _hydrate_many(docs, user["user_id"])


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
    return await _hydrate_many(out_docs, user["user_id"])


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


async def _not_interested_ids(viewer_id: str) -> set:
    """Post ids the viewer marked 'not interested' — skipped in the feeds."""
    try:
        rows = await db.post_not_interested.find(
            {"user_id": viewer_id}, {"_id": 0, "post_id": 1}
        ).to_list(1000)
        return {r.get("post_id") for r in rows}
    except Exception:
        return set()


def _muted_patterns(words: Optional[list]) -> list:
    """Compile a viewer's muted keywords into (bareword, regex) pairs. Single
    tokens match on word boundaries (so "art" doesn't hide "start"); phrases
    match as a substring."""
    pats = []
    for w in (words or []):
        t = (w or "").strip().lower()
        if not t:
            continue
        bare = t.lstrip("#")
        try:
            rx = re.compile(r"\b" + re.escape(bare) + r"\b", re.IGNORECASE)
        except re.error:
            continue
        pats.append((bare, rx))
    return pats


def _filter_muted(docs: list, patterns: list) -> list:
    """Drop posts whose text or hashtags match any muted keyword."""
    if not patterns:
        return docs
    out = []
    for d in docs:
        hay = (d.get("text") or "")
        tags = {str(t).lower().lstrip("#") for t in (d.get("hashtags") or [])}
        if any(bare in tags or rx.search(hay) for bare, rx in patterns):
            continue
        out.append(d)
    return out


@router.get("/feed/explore", response_model=List[Post])
async def explore_feed(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    # Pull a broad recent candidate set, then rank it for this viewer.
    cursor = db.posts.find(
        {"parent_id": None, "group_id": {"$in": [None, ""]}, "community_id": {"$in": [None, ""]},
         "repost_is_video": {"$ne": True}},  # reposted reels live in the Reels feed
        {"_id": 0},
    ).sort("created_at", -1).limit(300)
    docs = await cursor.to_list(300)
    skip = await _not_interested_ids(user["user_id"])
    docs = [d for d in docs if d.get("id") not in skip]
    docs = _filter_muted(docs, _muted_patterns(user.get("muted_keywords")))
    ranked = await _rank_docs(docs, user["user_id"], 100)
    return await _hydrate_many(ranked, user["user_id"])


@router.get("/feed/home", response_model=List[Post])
async def home_feed(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    followees = await db.follows.find(
        {"follower_id": user["user_id"]}, {"_id": 0, "followee_id": 1}
    ).to_list(500)
    ids = [f["followee_id"] for f in followees] + [user["user_id"]]
    cursor = (
        db.posts.find(
            {"parent_id": None, "user_id": {"$in": ids}, "group_id": {"$in": [None, ""]}, "community_id": {"$in": [None, ""]},
             "repost_is_video": {"$ne": True}},  # reposted reels live in the Reels feed
            {"_id": 0},
        ).sort("created_at", -1).limit(200)
    )
    docs = await cursor.to_list(200)
    skip = await _not_interested_ids(user["user_id"])
    docs = [d for d in docs if d.get("id") not in skip]
    docs = _filter_muted(docs, _muted_patterns(user.get("muted_keywords")))
    ranked = await _rank_docs(docs, user["user_id"], 100)
    return await _hydrate_many(ranked, user["user_id"])


@router.get("/posts/user/{user_id}", response_model=List[Post])
async def user_posts(user_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    # Private account: only the owner and their followers see their posts.
    if user_id != me["user_id"]:
        owner = await db.users.find_one({"user_id": user_id}, {"_id": 0, "is_private": 1})
        if owner and owner.get("is_private"):
            follows = await db.follows.find_one(
                {"follower_id": me["user_id"], "followee_id": user_id}, {"_id": 0, "follower_id": 1})
            if not follows:
                return []
    cursor = (
        db.posts.find({"user_id": user_id, "parent_id": None}, {"_id": 0})
        .sort("created_at", -1).limit(100)
    )
    docs = await cursor.to_list(100)
    docs.sort(key=lambda d: not d.get("pinned", False))  # pinned posts first
    return await _hydrate_many(docs, me["user_id"])


async def _user_posts_visible(me: dict, user_id: str) -> bool:
    """False if the target is private and the viewer doesn't follow them."""
    if user_id == me["user_id"]:
        return True
    owner = await db.users.find_one({"user_id": user_id}, {"_id": 0, "is_private": 1})
    if owner and owner.get("is_private"):
        follows = await db.follows.find_one(
            {"follower_id": me["user_id"], "followee_id": user_id}, {"_id": 0, "follower_id": 1})
        return bool(follows)
    return True


@router.get("/posts/user/{user_id}/replies", response_model=List[Post])
async def user_replies(user_id: str, authorization: Optional[str] = Header(None)):
    """The user's replies (posts that are comments on something)."""
    me = await get_current_user(authorization)
    if not await _user_posts_visible(me, user_id):
        return []
    docs = await db.posts.find(
        {"user_id": user_id, "parent_id": {"$ne": None}}, {"_id": 0}
    ).sort("created_at", -1).limit(100).to_list(100)
    return await _hydrate_many(docs, me["user_id"])


@router.get("/posts/user/{user_id}/reposts", response_model=List[Post])
async def user_reposts(user_id: str, authorization: Optional[str] = Header(None)):
    """The user's reposts (repost entries pointing at an original)."""
    me = await get_current_user(authorization)
    if not await _user_posts_visible(me, user_id):
        return []
    docs = await db.posts.find(
        {"user_id": user_id, "repost_of": {"$ne": None}}, {"_id": 0}
    ).sort("created_at", -1).limit(100).to_list(100)
    return await _hydrate_many(docs, me["user_id"])


@router.get("/posts/user/{user_id}/likes", response_model=List[Post])
async def user_likes(user_id: str, authorization: Optional[str] = Header(None)):
    """Posts the user has liked (👍), most recently liked first."""
    me = await get_current_user(authorization)
    if not await _user_posts_visible(me, user_id):
        return []
    # Respect the "hide my likes" privacy setting — only the owner sees the list.
    if me["user_id"] != user_id:
        owner = await db.users.find_one({"user_id": user_id}, {"_id": 0, "hide_likes": 1})
        if (owner or {}).get("hide_likes"):
            return []
    rows = await db.post_reactions.find(
        {"user_id": user_id, "emoji": "👍"}, {"_id": 0, "post_id": 1, "created_at": 1}
    ).sort("created_at", -1).limit(100).to_list(100)
    ids = [r["post_id"] for r in rows if r.get("post_id")]
    if not ids:
        return []
    found = await db.posts.find({"id": {"$in": ids}}, {"_id": 0}).to_list(len(ids))
    by_id = {d["id"]: d for d in found}
    docs = [by_id[i] for i in ids if i in by_id]   # preserve like order
    return await _hydrate_many(docs, me["user_id"])


class ReactBody(BaseModel):
    emoji: str


def _norm_emoji(raw: str) -> str:
    """Accept a single emoji / short token, capped so nobody stuffs the field."""
    e = (raw or "").strip()
    if not e:
        raise HTTPException(status_code=400, detail="Pick an emoji to react with")
    if len(e) > 16:
        raise HTTPException(status_code=400, detail="That's not a valid reaction")
    return e


async def _apply_reaction(post_id: str, user: dict, emoji: str) -> Post:
    """Unified emoji reactions (replaces separate like/dislike). One reaction per
    user per post: same emoji again removes it; a different emoji switches it.
    `reactions` is kept as an {emoji: count} tally on the post doc; `likes_count`
    mirrors the total so feed ranking keeps working."""
    uid = user["user_id"]
    doc = await db.posts.find_one({"id": post_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Post not found")
    # Subscriber-only posts: only subscribers (at the required tier), the author,
    # and admins may react/like.
    _mtier = int(doc.get("min_sub_tier") or 0)
    if _mtier > 0 and (await _viewer_sub_level(uid, doc["user_id"])) < _mtier:
        raise HTTPException(status_code=403, detail={
            "code": "subscribers_only",
            "message": f"Subscribe at Tier {_mtier} or higher to react to this post.",
        })
    # Track the tally change as per-key deltas applied with $inc, so concurrent
    # reactions from different users serialize on the locked row (update_one is
    # SELECT ... FOR UPDATE) instead of clobbering a $set of the whole recomputed
    # dict. _reaction_list already hides any key left at <= 0.
    inc: dict = {}

    existing = await db.post_reactions.find_one({"post_id": post_id, "user_id": uid}, {"_id": 0})
    if existing and existing.get("emoji") == emoji:
        # Toggle off.
        await db.post_reactions.delete_one({"post_id": post_id, "user_id": uid})
        inc[f"reactions.{emoji}"] = inc.get(f"reactions.{emoji}", 0) - 1
        inc["likes_count"] = inc.get("likes_count", 0) - 1
    elif existing:
        # Switch reaction.
        await db.post_reactions.update_one(
            {"post_id": post_id, "user_id": uid},
            {"$set": {"emoji": emoji, "created_at": datetime.now(timezone.utc)}},
        )
        old = existing.get("emoji", "")
        if old:
            inc[f"reactions.{old}"] = inc.get(f"reactions.{old}", 0) - 1
        inc[f"reactions.{emoji}"] = inc.get(f"reactions.{emoji}", 0) + 1
    else:
        if doc.get("likes_disabled") and not is_admin(user):
            raise HTTPException(status_code=403, detail="Reactions are turned off for this post")
        try:
            await db.post_reactions.insert_one({
                "post_id": post_id, "user_id": uid, "emoji": emoji,
                "created_at": datetime.now(timezone.utc),
            })
            inc[f"reactions.{emoji}"] = inc.get(f"reactions.{emoji}", 0) + 1
            inc["likes_count"] = inc.get("likes_count", 0) + 1
            await emit_notification(
                user_id=doc["user_id"], actor_id=uid, ntype="like",
                post_id=post_id, message=f"{emoji} {(doc.get('text') or '')[:120]}".strip(),
            )
        except DuplicateKeyError:
            pass
    if inc:
        await db.posts.update_one({"id": post_id}, {"$inc": inc})
    updated = await db.posts.find_one({"id": post_id}, {"_id": 0})
    return await _hydrate_post(updated, uid)


@router.post("/posts/{post_id}/react", response_model=Post)
async def react_to_post(post_id: str, body: ReactBody, authorization: Optional[str] = Header(None)):
    """React to a post with any emoji (toggles / switches)."""
    user = await get_current_user(authorization)
    return await _apply_reaction(post_id, user, _norm_emoji(body.emoji))


@router.post("/posts/{post_id}/like", response_model=Post)
async def toggle_like(post_id: str, authorization: Optional[str] = Header(None)):
    """Back-compat: a 👍 reaction."""
    user = await get_current_user(authorization)
    return await _apply_reaction(post_id, user, "👍")


@router.post("/posts/{post_id}/dislike", response_model=Post)
async def toggle_dislike(post_id: str, authorization: Optional[str] = Header(None)):
    """Back-compat: a 👎 reaction."""
    user = await get_current_user(authorization)
    return await _apply_reaction(post_id, user, "👎")


@router.post("/posts/{post_id}/promote", response_model=Post)
async def promote_post(
    post_id: str, body: PromoteCreate, authorization: Optional[str] = Header(None)
):
    """Boost your own post for N days — it surfaces higher and shows a
    'Sponsored' badge."""
    user = await get_current_user(authorization)
    from routes.payments import payments_live
    if await payments_live():
        raise HTTPException(status_code=409, detail={"code": "use_stripe", "message": "Real payments are on — promote through Stripe checkout."})
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
        # Subscriber-only posts: gate reposting the same way reactions/comments are
        # gated, so a non-subscriber can't inflate a locked post's repost count.
        _mtier = int(orig.get("min_sub_tier") or 0)
        if _mtier > 0 and (await _viewer_sub_level(user["user_id"], orig["user_id"])) < _mtier:
            raise HTTPException(status_code=403, detail={
                "code": "subscribers_only",
                "message": f"Subscribe at Tier {_mtier} or higher to repost this.",
            })
        await db.posts.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": user["user_id"],
            "text": "",
            "parent_id": None,
            "repost_of": post_id,
            # Reposts of reels (video posts) belong in the Reels feed, not the
            # newsfeed — the feeds filter on this flag.
            "repost_is_video": _has_playable_video(orig),
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
    return await _hydrate_many(docs, user["user_id"])


# ---------- Hashtags ----------
@router.get("/hashtags/trending")
async def trending_hashtags(authorization: Optional[str] = Header(None)):
    """Most-used hashtags across recent posts (defined before /hashtags/{tag})."""
    await get_current_user(authorization)
    since = datetime.now(timezone.utc) - timedelta(days=30)
    rows = await db.posts.find(
        {"hashtags": {"$exists": True, "$ne": []}, "created_at": {"$gte": since}},
        {"_id": 0, "hashtags": 1},
    ).sort("created_at", -1).limit(3000).to_list(3000)
    counts: dict = {}
    for r in rows:
        for t in (r.get("hashtags") or []):
            counts[t] = counts.get(t, 0) + 1
    top = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:15]
    return {"hashtags": [{"tag": t, "count": n} for t, n in top]}


def _engagement_score(d: dict) -> float:
    return (
        (d.get("likes_count", 0) or 0)
        + 2.0 * (d.get("reposts_count", 0) or 0)
        + 1.5 * (d.get("replies_count", 0) or 0)
        + 0.1 * (d.get("views_count", 0) or 0)
    )


@router.get("/posts/popular", response_model=List[Post])
async def popular_posts(limit: int = Query(8, ge=1, le=20), authorization: Optional[str] = Header(None)):
    """Top recent non-video posts by engagement (for discovery)."""
    user = await get_current_user(authorization)
    since = datetime.now(timezone.utc) - timedelta(days=21)
    docs = await db.posts.find(
        {"parent_id": None, "group_id": {"$in": [None, ""]}, "community_id": {"$in": [None, ""]},
         "created_at": {"$gte": since}},
        {"_id": 0},
    ).sort("likes_count", -1).limit(120).to_list(120)
    skip = await _not_interested_ids(user["user_id"])
    docs = [d for d in docs
            if d.get("id") not in skip and not d.get("repost_of")
            and not any(m.get("type") == "video" for m in (d.get("media") or []))]
    docs.sort(key=_engagement_score, reverse=True)
    return await _hydrate_many(docs[:limit], user["user_id"])


@router.get("/reels/popular", response_model=List[Post])
async def popular_reels(limit: int = Query(8, ge=1, le=20), authorization: Optional[str] = Header(None)):
    """Top recent video reels by engagement (for discovery)."""
    user = await get_current_user(authorization)
    since = datetime.now(timezone.utc) - timedelta(days=30)
    docs = await db.posts.find(
        {"parent_id": None, "media": {"$elemMatch": {"type": "video"}}, "created_at": {"$gte": since}},
        {"_id": 0},
    ).sort("likes_count", -1).limit(120).to_list(120)
    skip = await _not_interested_ids(user["user_id"])
    out = [d for d in docs if d.get("id") not in skip and _has_playable_video(d)]
    out.sort(key=_engagement_score, reverse=True)
    return await _hydrate_many(out[:limit], user["user_id"])


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
    return await _hydrate_many(docs, user["user_id"])


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
    if poll.get("closed"):
        raise HTTPException(status_code=400, detail="Poll closed")
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
    if not await db.posts.find_one({"id": post_id}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=404, detail="Post not found")
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


@router.get("/posts/{post_id}/viewers")
async def post_viewers(post_id: str, authorization: Optional[str] = Header(None)):
    """List who viewed a post — visible only to the post's author (or a mod)."""
    user = await get_current_user(authorization)
    doc = await db.posts.find_one({"id": post_id}, {"_id": 0, "user_id": 1, "views_count": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Post not found")
    if doc["user_id"] != user["user_id"] and not (is_mod(user) or is_admin(user)):
        raise HTTPException(status_code=403, detail="Only the author can see who viewed this post")
    rows = await db.post_views.find(
        {"post_id": post_id}, {"_id": 0}
    ).sort("created_at", -1).limit(300).to_list(300)
    ordered, seen = [], set()
    for r in rows:
        vid = r.get("user_id")
        if not vid or vid == doc["user_id"] or vid in seen:
            continue
        seen.add(vid)
        ordered.append((vid, r.get("created_at")))
    ids = [v for v, _ in ordered]
    umap = {}
    if ids:
        urows = await db.users.find(
            {"user_id": {"$in": ids}},
            {"_id": 0, "user_id": 1, "name": 1, "username": 1, "picture": 1, "verified": 1},
        ).to_list(len(ids))
        umap = {u["user_id"]: u for u in urows}
    viewers = [{
        "user_id": vid,
        "name": (umap.get(vid) or {}).get("name", "User"),
        "username": (umap.get(vid) or {}).get("username"),
        "picture": (umap.get(vid) or {}).get("picture"),
        "verified": bool((umap.get(vid) or {}).get("verified", False)),
        "viewed_at": when,
    } for vid, when in ordered]
    return {"count": int(doc.get("views_count", 0) or 0), "unique": len(viewers), "viewers": viewers}


@router.get("/posts/{post_id}/analytics")
async def post_analytics(post_id: str, authorization: Optional[str] = Header(None)):
    """Detailed performance for a post — author (or a mod/admin) only."""
    user = await get_current_user(authorization)
    doc = await db.posts.find_one({"id": post_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Post not found")
    if doc["user_id"] != user["user_id"] and not (is_mod(user) or is_admin(user)):
        raise HTTPException(status_code=403, detail="Only the author can see analytics for this post")

    impressions = int(doc.get("views_count", 0) or 0)
    try:
        unique_viewers = await db.post_views.count_documents({"post_id": post_id})
    except Exception:
        unique_viewers = 0
    reactions = _reaction_list(doc.get("reactions"))
    reactions_total = sum(r["count"] for r in reactions)
    comments = int(doc.get("replies_count", 0) or 0)
    reposts = int(doc.get("reposts_count", 0) or 0)
    quotes = int(doc.get("quotes_count", 0) or 0)
    bookmarks = int(doc.get("bookmarks_count", 0) or 0)
    clicks = int(doc.get("ad_clicks", 0) or 0)
    interactions = reactions_total + comments + reposts + quotes + bookmarks
    engagement_rate = round(interactions / impressions, 4) if impressions > 0 else 0.0
    promoted = _is_promoted(doc)

    return {
        "post_id": post_id,
        "created_at": doc.get("created_at"),
        "impressions": impressions,
        "unique_viewers": unique_viewers,
        "clicks": clicks,
        "reactions_total": reactions_total,
        "reactions": reactions,
        "comments": comments,
        "reposts": reposts,
        "quotes": quotes,
        "bookmarks": bookmarks,
        "interactions": interactions,
        "engagement_rate": engagement_rate,  # interactions / impressions
        "promoted": promoted,
        "ad": {
            "impressions": int(doc.get("ad_impressions", 0) or 0),
            "clicks": clicks,
            "spent": round(float(doc.get("ad_spent", 0) or 0), 2),
            "budget": float(doc.get("ad_budget", 0) or 0) or None,
            "cpc": float(doc.get("ad_cpc", 0) or 0) or None,
        } if (promoted or doc.get("ad_spent") or doc.get("ad_clicks")) else None,
    }


@router.post("/posts/{post_id}/report")
async def report_post(
    post_id: str, body: ReportCreate, authorization: Optional[str] = Header(None)
):
    """Flag a post or reel for moderation (one report per user per post)."""
    user = await get_current_user(authorization)
    post = await db.posts.find_one({"id": post_id}, {"_id": 0, "id": 1, "user_id": 1, "min_sub_tier": 1})
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    # Subscriber-only posts: only subscribers (at tier), the author and admins can
    # report — same gate as commenting / reacting.
    _mtier = int(post.get("min_sub_tier") or 0)
    if _mtier > 0 and (await _viewer_sub_level(user["user_id"], post["user_id"])) < _mtier:
        raise HTTPException(status_code=403, detail={
            "code": "subscribers_only",
            "message": f"Subscribe at Tier {_mtier} or higher to report this post.",
        })
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


@router.post("/posts/{post_id}/not-interested")
async def not_interested(post_id: str, authorization: Optional[str] = Header(None)):
    """Hide this post for the viewer and feed fewer like it (records the signal
    so the home/explore feeds skip it)."""
    user = await get_current_user(authorization)
    post = await db.posts.find_one({"id": post_id}, {"_id": 0, "id": 1, "user_id": 1})
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    try:
        await db.post_not_interested.insert_one({
            "post_id": post_id,
            "user_id": user["user_id"],
            "author_id": post.get("user_id"),
            "created_at": datetime.now(timezone.utc),
        })
    except DuplicateKeyError:
        pass
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
            u = m.get("url") or ""
            if b.startswith("data:") or b.startswith("http") or u.startswith("http"):
                return True
    return False


@router.get("/feed/reels", response_model=List[Post])
async def reels_feed(
    focus: Optional[str] = Query(None),
    scope: str = Query("explore"),
    authorization: Optional[str] = Header(None),
):
    """Vertical video feed: every playable video post (watched or not),
    de-duplicated and personalized. A `focus` post is pinned first.

    `scope=following` limits the feed to reels from accounts you follow;
    `scope=explore` (default) is the full personalized feed.
    """
    user = await get_current_user(authorization)
    uid = user["user_id"]
    query: dict = {"parent_id": None,
                   "$or": [{"media": {"$elemMatch": {"type": "video"}}}, {"repost_is_video": True}]}
    if scope == "following":
        followees = await db.follows.find(
            {"follower_id": uid}, {"_id": 0, "followee_id": 1}
        ).to_list(2000)
        ids = [f["followee_id"] for f in followees]
        if not ids:
            return []
        query["user_id"] = {"$in": ids}
    cursor = (
        db.posts.find(query, {"_id": 0}).sort("created_at", -1).limit(250)
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
        elif d.get("repost_of"):
            # A repost of a reel: include it if the original video is playable.
            orig = await db.posts.find_one({"id": d["repost_of"]}, {"_id": 0})
            if orig and _has_playable_video(orig):
                playable.append(d)
    ranked = await _rank_docs(playable, uid, 60)
    if focus:
        ranked.sort(key=lambda d: 0 if d["id"] == focus else 1)
    return await _hydrate_many(ranked, uid)


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
    return await _hydrate_many(docs, me["user_id"])
