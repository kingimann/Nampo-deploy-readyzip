"""Public, embeddable content — let developers embed Nami posts and profiles on
any website or app: JSON read endpoints, themeable iframe "cards", a drop-in
<script> loader, and an oEmbed endpoint (so CMSs like WordPress auto-embed a
pasted Nami link).

No auth — these expose ONLY already-public content. We never serve:
  • subscriber-gated posts (min_sub_tier > 0), or
  • content from banned / currently-suspended users.
A light per-IP rate limit discourages scraping.
"""
import html
import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse

from core import db

router = APIRouter()

WEB_APP_URL = (os.environ.get("WEB_APP_URL", "https://nampo-web.onrender.com") or "").rstrip("/")

# Lightweight per-IP rate limit for the JSON/oEmbed endpoints (in-memory, single
# instance; resets on restart).
_RATE: dict = {}
RATE_MAX = 120
RATE_WINDOW = 60.0


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return (request.client.host if request.client else "") or "?"


def _rate_ok(ip: str) -> bool:
    now = time.time()
    hits = [t for t in _RATE.get(ip, []) if now - t < RATE_WINDOW]
    if len(hits) >= RATE_MAX:
        _RATE[ip] = hits
        return False
    hits.append(now)
    _RATE[ip] = hits
    return True


def _public_base(request: Request) -> str:
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme or "https"
    proto = proto.split(",")[0].strip()
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}"


def _hex(s: Optional[str]) -> Optional[str]:
    s = (s or "").strip().lstrip("#")
    if re.fullmatch(r"[0-9a-fA-F]{3}", s) or re.fullmatch(r"[0-9a-fA-F]{6}", s):
        return "#" + s
    return None


def _embed_cfg(theme: str, accent: Optional[str], radius: Optional[str]) -> dict:
    dark = (theme or "").strip().lower() == "dark"
    try:
        rad = max(0, min(28, int(radius)))
    except (TypeError, ValueError):
        rad = 14
    return {
        "bg": "#111b21" if dark else "#ffffff",
        "text": "#e9edef" if dark else "#0b0b0c",
        "muted": "#8696a0" if dark else "#5b6770",
        "border": "#2a3942" if dark else "#e8ebed",
        "accent": _hex(accent) or "#00A884",
        "radius": rad,
    }


def _author_ok(u: Optional[dict]) -> bool:
    """A user whose content may be shown publicly: exists, not banned, not
    currently suspended."""
    if not u:
        return False
    if u.get("banned"):
        return False
    su = u.get("suspended_until")
    if su:
        try:
            if isinstance(su, str):
                su = datetime.fromisoformat(su.replace("Z", "+00:00"))
            if su.tzinfo is None:
                su = su.replace(tzinfo=timezone.utc)
            if su > datetime.now(timezone.utc):
                return False
        except Exception:
            pass
    return True


def _kfmt(n) -> str:
    try:
        n = int(n or 0)
    except (TypeError, ValueError):
        return "0"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M".replace(".0M", "M")
    if n >= 1_000:
        return f"{n / 1000:.1f}k".replace(".0k", "k")
    return str(n)


def _media_view(m: dict) -> dict:
    return {
        "type": m.get("type") or "image",
        "url": m.get("url") or m.get("base64"),
        "thumbnail": m.get("thumbnail"),
        "width": m.get("width"), "height": m.get("height"),
    }


def _author_view(u: dict) -> dict:
    return {
        "user_id": u.get("user_id"),
        "name": u.get("name") or "Nami user",
        "username": u.get("username"),
        "picture": u.get("picture"),
        "verified": bool(u.get("verified", False)),
        "url": f"{WEB_APP_URL}/user/{u.get('username') or u.get('user_id')}",
    }


async def _load_public_post(post_id: str):
    """Return (post_doc, author_doc) if the post is publicly embeddable, else None."""
    doc = await db.posts.find_one({"id": post_id}, {"_id": 0})
    if not doc:
        return None
    if int(doc.get("min_sub_tier") or 0) > 0:   # subscriber-only — never expose
        return None
    author = await db.users.find_one({"user_id": doc.get("user_id")}, {"_id": 0})
    if not _author_ok(author):
        return None
    return doc, author


async def _load_public_listing(listing_id: str):
    """Return (listing_doc, seller_doc) if publicly embeddable, else None.
    Only `active` listings (not sold/flagged) by non-banned sellers are shown."""
    doc = await db.listings.find_one({"id": listing_id}, {"_id": 0})
    if not doc or doc.get("status") != "active":
        return None
    seller = await db.users.find_one({"user_id": doc.get("user_id")}, {"_id": 0})
    if not _author_ok(seller):
        return None
    return doc, seller


def _listing_photos(doc: dict) -> list:
    photos = doc.get("photos") or ([doc["photo_base64"]] if doc.get("photo_base64") else [])
    return [p for p in photos if p]


_CUR_SYMBOL = {"USD": "$", "CAD": "$", "AUD": "$", "NZD": "$", "EUR": "€", "GBP": "£", "JPY": "¥", "INR": "₹"}


def _price_str(doc: dict) -> str:
    cur = (doc.get("currency") or "USD").upper()
    try:
        p = float(doc.get("price") or 0)
    except (TypeError, ValueError):
        p = 0.0
    amt = f"{p:,.0f}" if p == int(p) else f"{p:,.2f}"
    sym = _CUR_SYMBOL.get(cur)
    return f"{sym}{amt}" if sym else f"{amt} {cur}"


def _listing_json(doc: dict, seller: dict) -> dict:
    return {
        "id": doc["id"],
        "title": doc.get("title") or "",
        "price": float(doc.get("price") or 0),
        "currency": doc.get("currency") or "USD",
        "price_display": _price_str(doc),
        "condition": doc.get("condition") or "used",
        "category": doc.get("category"),
        "description": doc.get("description") or "",
        "locality": doc.get("locality") or "",
        "delivery": doc.get("delivery") or "pickup",
        "negotiable": bool(doc.get("negotiable")),
        "photos": _listing_photos(doc),
        "seller": _author_view(seller),
        "created_at": doc.get("created_at"),
        "url": f"{WEB_APP_URL}/listing/{doc['id']}",
    }


async def _load_public_guide(slug: str):
    """Return (guide_doc, owner_doc) for a public guide, else None."""
    guide = await db.guides.find_one({"slug": slug, "is_public": True}, {"_id": 0})
    if not guide:
        return None
    owner = await db.users.find_one({"user_id": guide.get("user_id")}, {"_id": 0})
    if not _author_ok(owner):
        return None
    return guide, owner


async def _guide_places(guide: dict, limit: int = 50) -> list:
    pids = guide.get("place_ids") or []
    if not pids:
        return []
    docs = await db.places.find({"id": {"$in": pids}}, {"_id": 0}).to_list(200)
    order = {pid: i for i, pid in enumerate(pids)}
    docs.sort(key=lambda p: order.get(p["id"], 0))
    return docs[:limit]


def _guide_json(guide: dict, owner: dict, places: list) -> dict:
    return {
        "id": guide["id"], "slug": guide.get("slug"),
        "name": guide.get("name") or "Guide",
        "color": guide.get("color") or "#3B82F6",
        "icon": guide.get("icon") or "bookmark",
        "owner": _author_view(owner),
        "place_count": len(guide.get("place_ids") or []),
        "places": [{
            "id": p.get("id"), "title": p.get("title"), "address": p.get("address"),
            "category": p.get("category"),
            "longitude": p.get("longitude"), "latitude": p.get("latitude"),
        } for p in places],
        "created_at": guide.get("created_at"),
        "url": f"{WEB_APP_URL}/g/{guide.get('slug')}",
    }


async def _load_public_community(name: str):
    doc = await db.communities.find_one({"name": (name or "").lstrip("/").lower()}, {"_id": 0})
    return doc or None


async def _community_member_count(cid: str) -> int:
    try:
        return await db.community_members.count_documents({"community_id": cid})
    except Exception:
        return 0


def _community_json(doc: dict, members: int) -> dict:
    return {
        "id": doc["id"], "name": doc.get("name"),
        "title": doc.get("title") or doc.get("name"),
        "description": doc.get("description") or "",
        "color": doc.get("color") or "#3B82F6",
        "icon": doc.get("icon") or "people",
        "member_count": members,
        "url": f"{WEB_APP_URL}/c/{doc.get('name')}",
    }


async def _load_public_user(username: str):
    uname = (username or "").lstrip("@").strip()
    if not uname:
        return None
    u = await db.users.find_one({"username": uname}, {"_id": 0})
    if not u:
        u = await db.users.find_one(
            {"username": {"$regex": f"^{re.escape(uname)}$", "$options": "i"}}, {"_id": 0}
        )
    return u if _author_ok(u) else None


def _post_json(doc: dict, author: dict) -> dict:
    media = [_media_view(m) for m in (doc.get("media") or []) if (m.get("url") or m.get("base64"))]
    return {
        "id": doc["id"],
        "text": doc.get("text") or "",
        "author": _author_view(author),
        "media": media,
        "created_at": doc.get("created_at"),
        "counts": {
            "likes": int(doc.get("likes_count", 0) or 0),
            "replies": int(doc.get("replies_count", 0) or 0),
            "reposts": int(doc.get("reposts_count", 0) or 0),
            "views": int(doc.get("views_count", 0) or 0),
        },
        "url": f"{WEB_APP_URL}/post/{doc['id']}",
    }


def _profile_json(u: dict) -> dict:
    return {
        **_author_view(u),
        "bio": u.get("bio") or "",
        "subscriber_count": int(u.get("subscriber_count", 0) or 0),
    }


# ── JSON read endpoints ───────────────────────────────────────────────────────
@router.get("/pub/post/{post_id}")
async def public_post(request: Request, post_id: str):
    if not _rate_ok(_client_ip(request)):
        raise HTTPException(status_code=429, detail="Slow down — too many requests.")
    r = await _load_public_post(post_id)
    if not r:
        raise HTTPException(status_code=404, detail="Post not available")
    return _post_json(*r)


@router.get("/pub/profile/{username}")
async def public_profile(request: Request, username: str):
    if not _rate_ok(_client_ip(request)):
        raise HTTPException(status_code=429, detail="Slow down — too many requests.")
    u = await _load_public_user(username)
    if not u:
        raise HTTPException(status_code=404, detail="Profile not available")
    return _profile_json(u)


@router.get("/pub/listing/{listing_id}")
async def public_listing(request: Request, listing_id: str):
    if not _rate_ok(_client_ip(request)):
        raise HTTPException(status_code=429, detail="Slow down — too many requests.")
    r = await _load_public_listing(listing_id)
    if not r:
        raise HTTPException(status_code=404, detail="Listing not available")
    return _listing_json(*r)


@router.get("/pub/guide/{slug}")
async def public_guide(request: Request, slug: str):
    if not _rate_ok(_client_ip(request)):
        raise HTTPException(status_code=429, detail="Slow down — too many requests.")
    r = await _load_public_guide(slug)
    if not r:
        raise HTTPException(status_code=404, detail="Guide not available")
    guide, owner = r
    places = await _guide_places(guide)
    return _guide_json(guide, owner, places)


@router.get("/pub/community/{name}")
async def public_community(request: Request, name: str):
    if not _rate_ok(_client_ip(request)):
        raise HTTPException(status_code=429, detail="Slow down — too many requests.")
    doc = await _load_public_community(name)
    if not doc:
        raise HTTPException(status_code=404, detail="Community not available")
    return _community_json(doc, await _community_member_count(doc["id"]))


@router.get("/pub/profile/{username}/posts")
async def public_profile_posts(request: Request, username: str,
                               limit: int = Query(10), cursor: Optional[str] = Query(None)):
    """A user's public posts, newest first — build a Nami feed widget on your site.
    Cursor pagination: pass the returned `next_cursor` to get the next page (null =
    end). Only public timeline posts are returned (no replies, reposts, groups,
    communities, or subscriber-only posts)."""
    if not _rate_ok(_client_ip(request)):
        raise HTTPException(status_code=429, detail="Slow down — too many requests.")
    u = await _load_public_user(username)
    if not u:
        raise HTTPException(status_code=404, detail="Profile not available")
    lim = max(1, min(int(limit or 10), 30))
    q = {
        "user_id": u["user_id"], "parent_id": None,
        "repost_of": {"$in": [None, ""]},
        "group_id": {"$in": [None, ""]}, "community_id": {"$in": [None, ""]},
    }
    if cursor:
        try:
            cdt = datetime.fromisoformat(cursor.replace("Z", "+00:00"))
            q["created_at"] = {"$lt": cdt}
        except Exception:
            pass
    rows = await db.posts.find(q, {"_id": 0}).sort("created_at", -1).limit(lim + 1).to_list(lim + 1)
    has_more = len(rows) > lim
    page = rows[:lim]
    items = [_post_json(d, u) for d in page if int(d.get("min_sub_tier") or 0) == 0]
    next_cursor = None
    if has_more and page:
        nc = page[-1].get("created_at")
        next_cursor = nc.isoformat() if hasattr(nc, "isoformat") else str(nc)
    return {"posts": items, "next_cursor": next_cursor}


# ── Themeable iframe cards (server-rendered) ──────────────────────────────────
_CARD_CSS = """
  :root{--bg:#fff;--text:#0b0b0c;--muted:#5b6770;--border:#e8ebed;--acc:#00A884;--rad:14px}
  html,body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:transparent}
  a.card{display:block;text-decoration:none;color:var(--text);background:var(--bg);
    border:1px solid var(--border);border-radius:var(--rad);padding:14px;max-width:550px}
  .top{display:flex;align-items:center;gap:10px}
  .av{width:42px;height:42px;border-radius:50%;object-fit:cover;background:var(--border);flex:0 0 auto}
  .nm{font-weight:700;font-size:14px;display:flex;align-items:center;gap:4px}
  .un{color:var(--muted);font-size:12.5px}
  .ck{color:var(--acc);font-size:13px}
  .tx{font-size:14.5px;line-height:1.45;margin:10px 0 0;white-space:pre-wrap;word-wrap:break-word}
  .bio{font-size:13.5px;color:var(--muted);margin:8px 0 0}
  .price{font-size:20px;font-weight:800;margin:10px 0 2px;color:var(--text)}
  .ltitle{font-size:14.5px;font-weight:700;margin:0}
  .sub{font-size:12.5px;color:var(--muted);margin-top:3px}
  .gname{font-size:17px;font-weight:800}
  .gplace{font-size:13.5px;margin:5px 0;color:var(--text)}
  .cav{width:48px;height:48px;border-radius:14px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:20px;flex:0 0 auto}
  .media{margin-top:10px;border-radius:calc(var(--rad) - 4px);overflow:hidden;border:1px solid var(--border)}
  .media img{display:block;width:100%;max-height:330px;object-fit:cover}
  .meta{display:flex;gap:16px;margin-top:10px;color:var(--muted);font-size:12.5px}
  .brand{display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding-top:10px;border-top:1px solid var(--border)}
  .brand .n{font-weight:800;color:var(--acc);font-size:13px}
  .brand .cta{font-size:12px;color:var(--muted)}
"""


def _card_html(inner: str, cfg: dict) -> str:
    cfg_js = json.dumps(cfg).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<style>{_CARD_CSS}</style></head><body>{inner}"
        "<script>(function(){var C=" + cfg_js + ";var s=document.documentElement.style;"
        "s.setProperty('--bg',C.bg);s.setProperty('--text',C.text);s.setProperty('--muted',C.muted);"
        "s.setProperty('--border',C.border);s.setProperty('--acc',C.accent);s.setProperty('--rad',C.radius+'px');})();</script>"
        "</body></html>"
    )


def _unavailable(msg: str) -> HTMLResponse:
    page = _card_html(f'<div style="font-family:sans-serif;color:#8696a0;font-size:13px;padding:14px">{html.escape(msg)}</div>', _embed_cfg("light", None, None))
    return HTMLResponse(content=page, status_code=404, headers={"X-Frame-Options": "ALLOWALL"})


@router.get("/pub/post-card", response_class=HTMLResponse)
async def post_card(request: Request, post: str = Query(...), theme: str = Query("light"),
                    accent: Optional[str] = Query(None), radius: Optional[str] = Query(None)):
    r = await _load_public_post(post)
    if not r:
        return _unavailable("This post is unavailable.")
    doc, author = r
    cfg = _embed_cfg(theme, accent, radius)
    e = html.escape
    av = e(author.get("picture") or "")
    name = e(author.get("name") or "Nami user")
    uname = author.get("username")
    ck = ' <span class="ck">✔</span>' if author.get("verified") else ""
    handle = f'<div class="un">@{e(uname)}</div>' if uname else ""
    text = e(doc.get("text") or "")
    media_html = ""
    for m in (doc.get("media") or []):
        src = m.get("url") or m.get("base64")
        if src and (m.get("type") or "image") == "image":
            media_html = f'<div class="media"><img src="{e(src)}" alt=""></div>'
            break
        if src and m.get("type") == "video" and m.get("thumbnail"):
            media_html = f'<div class="media"><img src="{e(m["thumbnail"])}" alt=""></div>'
            break
    c = doc
    meta = (f'<div class="meta"><span>❤ {_kfmt(c.get("likes_count"))}</span>'
            f'<span>💬 {_kfmt(c.get("replies_count"))}</span>'
            f'<span>🔁 {_kfmt(c.get("reposts_count"))}</span></div>')
    link = f"{WEB_APP_URL}/post/{e(doc['id'])}"
    text_html = f'<div class="tx">{text}</div>' if text else ""
    inner = (
        f'<a class="card" href="{link}" target="_blank" rel="noopener">'
        f'<div class="top"><img class="av" src="{av}" alt="">'
        f'<div><div class="nm">{name}{ck}</div>{handle}</div></div>'
        f'{text_html}{media_html}{meta}'
        '<div class="brand"><span class="n">Nami</span><span class="cta">View post ›</span></div>'
        "</a>"
    )
    return HTMLResponse(content=_card_html(inner, cfg), headers={"X-Frame-Options": "ALLOWALL"})


@router.get("/pub/profile-card", response_class=HTMLResponse)
async def profile_card(request: Request, profile: str = Query(...), theme: str = Query("light"),
                       accent: Optional[str] = Query(None), radius: Optional[str] = Query(None)):
    u = await _load_public_user(profile)
    if not u:
        return _unavailable("This profile is unavailable.")
    cfg = _embed_cfg(theme, accent, radius)
    e = html.escape
    av = e(u.get("picture") or "")
    name = e(u.get("name") or "Nami user")
    uname = u.get("username")
    ck = ' <span class="ck">✔</span>' if u.get("verified") else ""
    handle = f'<div class="un">@{e(uname)}</div>' if uname else ""
    bio = f'<div class="bio">{e(u.get("bio"))}</div>' if u.get("bio") else ""
    link = f"{WEB_APP_URL}/user/{e(uname or u.get('user_id'))}"
    inner = (
        f'<a class="card" href="{link}" target="_blank" rel="noopener">'
        f'<div class="top"><img class="av" src="{av}" alt="">'
        f'<div><div class="nm">{name}{ck}</div>{handle}</div></div>'
        f'{bio}'
        '<div class="brand"><span class="n">Nami</span><span class="cta">View profile ›</span></div>'
        "</a>"
    )
    return HTMLResponse(content=_card_html(inner, cfg), headers={"X-Frame-Options": "ALLOWALL"})


@router.get("/pub/listing-card", response_class=HTMLResponse)
async def listing_card(request: Request, listing: str = Query(...), theme: str = Query("light"),
                       accent: Optional[str] = Query(None), radius: Optional[str] = Query(None)):
    r = await _load_public_listing(listing)
    if not r:
        return _unavailable("This listing is unavailable.")
    doc, seller = r
    cfg = _embed_cfg(theme, accent, radius)
    e = html.escape
    photos = _listing_photos(doc)
    img = f'<div class="media"><img src="{e(photos[0])}" alt=""></div>' if photos else ""
    cond = e((doc.get("condition") or "").replace("_", " "))
    loc = e(doc.get("locality") or "")
    sub = " · ".join([s for s in (cond, loc) if s])
    sub_html = f'<div class="sub">{sub}</div>' if sub else ""
    title = e(doc.get("title") or "Listing")
    link = f"{WEB_APP_URL}/listing/{e(doc['id'])}"
    inner = (
        f'<a class="card" href="{link}" target="_blank" rel="noopener">'
        f'{img}'
        f'<div class="price">{e(_price_str(doc))}</div>'
        f'<div class="ltitle">{title}</div>'
        f'{sub_html}'
        '<div class="brand"><span class="n">Nami Marketplace</span><span class="cta">View listing ›</span></div>'
        "</a>"
    )
    return HTMLResponse(content=_card_html(inner, cfg), headers={"X-Frame-Options": "ALLOWALL"})


@router.get("/pub/guide-card", response_class=HTMLResponse)
async def guide_card(request: Request, guide: str = Query(...), theme: str = Query("light"),
                     accent: Optional[str] = Query(None), radius: Optional[str] = Query(None)):
    r = await _load_public_guide(guide)
    if not r:
        return _unavailable("This guide is unavailable.")
    g, owner = r
    places = await _guide_places(g, limit=5)
    cfg = _embed_cfg(theme, accent, radius)
    e = html.escape
    name = e(g.get("name") or "Guide")
    count = len(g.get("place_ids") or [])
    plural = "" if count == 1 else "s"
    owner_name = e(owner.get("name") or "")
    place_lines = "".join(f'<div class="gplace">📍 {e(p.get("title") or "Place")}</div>' for p in places)
    more = f'<div class="sub">+{count - 5} more</div>' if count > 5 else ""
    link = f"{WEB_APP_URL}/g/{e(g.get('slug') or '')}"
    inner = (
        f'<a class="card" href="{link}" target="_blank" rel="noopener">'
        f'<div class="gname">{name}</div>'
        f'<div class="sub">{count} place{plural}{(" · by " + owner_name) if owner_name else ""}</div>'
        f'<div style="margin-top:10px">{place_lines}{more}</div>'
        '<div class="brand"><span class="n">Nami Guides</span><span class="cta">Open guide ›</span></div>'
        "</a>"
    )
    return HTMLResponse(content=_card_html(inner, cfg), headers={"X-Frame-Options": "ALLOWALL"})


@router.get("/pub/community-card", response_class=HTMLResponse)
async def community_card(request: Request, community: str = Query(...), theme: str = Query("light"),
                        accent: Optional[str] = Query(None), radius: Optional[str] = Query(None)):
    doc = await _load_public_community(community)
    if not doc:
        return _unavailable("This community is unavailable.")
    members = await _community_member_count(doc["id"])
    cfg = _embed_cfg(theme, accent, radius)
    e = html.escape
    title = doc.get("title") or doc.get("name") or "Community"
    color = _hex(doc.get("color")) or "#3B82F6"
    initial = e((title[:1] or "C").upper())
    plural = "" if members == 1 else "s"
    desc = f'<div class="bio">{e(doc.get("description"))}</div>' if doc.get("description") else ""
    link = f"{WEB_APP_URL}/c/{e(doc.get('name') or '')}"
    inner = (
        f'<a class="card" href="{link}" target="_blank" rel="noopener">'
        f'<div class="top"><div class="cav" style="background:{color}">{initial}</div>'
        f'<div><div class="nm">{e(title)}</div>'
        f'<div class="un">c/{e(doc.get("name") or "")} · {members} member{plural}</div></div></div>'
        f'{desc}'
        '<div class="brand"><span class="n">Nami Communities</span><span class="cta">Open community ›</span></div>'
        "</a>"
    )
    return HTMLResponse(content=_card_html(inner, cfg), headers={"X-Frame-Options": "ALLOWALL"})


# ── Drop-in <script> loader ───────────────────────────────────────────────────
_EMBED_JS = """(function(){
  var s=document.currentScript;
  function a(n){return s&&s.getAttribute(n);}
  var post=a("data-post"), profile=a("data-profile"), listing=a("data-listing"), guide=a("data-guide"), community=a("data-community");
  if(!post&&!profile&&!listing&&!guide&&!community)return;
  var path = post?("post-card?post="+encodeURIComponent(post))
    : listing?("listing-card?listing="+encodeURIComponent(listing))
    : guide?("guide-card?guide="+encodeURIComponent(guide))
    : community?("community-card?community="+encodeURIComponent(community))
    : ("profile-card?profile="+encodeURIComponent(profile));
  ["theme","accent","radius"].forEach(function(k){var v=a("data-"+k);if(v)path+="&"+k+"="+encodeURIComponent(v);});
  var f=document.createElement("iframe");
  f.src="__BASE__/api/pub/"+path;
  f.width=a("data-width")||"100%";f.height=a("data-height")||(profile?"150":listing?"420":guide?"340":community?"180":"460");
  f.scrolling="no";f.style.border="0";f.style.maxWidth="550px";f.style.width="100%";
  if(s&&s.parentNode)s.parentNode.insertBefore(f,s);
})();"""


@router.get("/pub/content-embed.js")
async def content_embed_js(request: Request):
    js = _EMBED_JS.replace("__BASE__", _public_base(request))
    return HTMLResponse(content=js, media_type="application/javascript")


# ── oEmbed (https://oembed.com) ───────────────────────────────────────────────
def _extract_post_id(url: str) -> Optional[str]:
    m = re.search(r"/(?:post|p)/([A-Za-z0-9\-]{6,})", url or "")
    return m.group(1) if m else None


def _extract_listing_id(url: str) -> Optional[str]:
    m = re.search(r"/(?:listing|l)/([A-Za-z0-9\-]{6,})", url or "")
    return m.group(1) if m else None


def _extract_guide_slug(url: str) -> Optional[str]:
    m = re.search(r"/(?:guide|g)/([A-Za-z0-9_\-]{2,})", url or "")
    return m.group(1) if m else None


def _extract_community(url: str) -> Optional[str]:
    m = re.search(r"/(?:community|c)/([A-Za-z0-9_\-]{2,})", url or "")
    return m.group(1) if m else None


def _extract_username(url: str) -> Optional[str]:
    m = re.search(r"/(?:user|u|profile|@)/?([A-Za-z0-9_.\-]{2,})", url or "")
    return m.group(1) if m else None


@router.get("/pub/oembed")
async def oembed(request: Request, url: str = Query(...), format: str = Query("json"),
                 maxwidth: Optional[int] = Query(None), maxheight: Optional[int] = Query(None)):
    """oEmbed provider endpoint. Paste a Nami post/profile URL into any oEmbed-aware
    site (WordPress, Discourse, etc.) and it renders an embed card."""
    if not _rate_ok(_client_ip(request)):
        raise HTTPException(status_code=429, detail="Slow down — too many requests.")
    if format not in ("json", ""):
        return JSONResponse(status_code=501, content={"error": "Only json format is supported"})
    base = _public_base(request)
    width = min(int(maxwidth or 550), 550)

    pid = _extract_post_id(url)
    if pid:
        r = await _load_public_post(pid)
        if not r:
            raise HTTPException(status_code=404, detail="Post not available")
        doc, author = r
        height = min(int(maxheight or 460), 460)
        src = f"{base}/api/pub/post-card?post={pid}"
        thumb = next((m.get("url") or m.get("thumbnail") for m in (doc.get("media") or [])
                      if (m.get("url") or m.get("thumbnail"))), author.get("picture"))
        title = (doc.get("text") or "Post on Nami")[:120]
        return _oembed_payload(title, author, src, width, height, thumb)

    lid = _extract_listing_id(url)
    if lid:
        r = await _load_public_listing(lid)
        if not r:
            raise HTTPException(status_code=404, detail="Listing not available")
        doc, seller = r
        height = min(int(maxheight or 420), 460)
        src = f"{base}/api/pub/listing-card?listing={lid}"
        thumb = next(iter(_listing_photos(doc)), seller.get("picture"))
        return _oembed_payload(f"{doc.get('title')} — {_price_str(doc)}", seller, src, width, height, thumb)

    gslug = _extract_guide_slug(url)
    if gslug:
        r = await _load_public_guide(gslug)
        if not r:
            raise HTTPException(status_code=404, detail="Guide not available")
        g, owner = r
        height = min(int(maxheight or 340), 420)
        src = f"{base}/api/pub/guide-card?guide={gslug}"
        return _oembed_payload(f"{g.get('name')} — a Nami guide", owner, src, width, height, owner.get("picture"))

    cname = _extract_community(url)
    if cname:
        doc = await _load_public_community(cname)
        if not doc:
            raise HTTPException(status_code=404, detail="Community not available")
        height = min(int(maxheight or 180), 240)
        src = f"{base}/api/pub/community-card?community={cname}"
        iframe = (f'<iframe src="{html.escape(src)}" width="{width}" height="{height}" '
                  'frameborder="0" scrolling="no" style="border:0;max-width:550px;width:100%" '
                  'allowtransparency="true"></iframe>')
        return {
            "version": "1.0", "type": "rich", "provider_name": "Nami", "provider_url": WEB_APP_URL,
            "title": f"c/{doc.get('name')} on Nami",
            "author_name": doc.get("title") or doc.get("name"),
            "author_url": f"{WEB_APP_URL}/c/{doc.get('name')}",
            "html": iframe, "width": width, "height": height, "cache_age": 3600,
        }

    uname = _extract_username(url)
    if uname:
        u = await _load_public_user(uname)
        if not u:
            raise HTTPException(status_code=404, detail="Profile not available")
        height = min(int(maxheight or 150), 200)
        src = f"{base}/api/pub/profile-card?profile={uname}"
        return _oembed_payload(f"{u.get('name')} on Nami", u, src, width, height, u.get("picture"))

    raise HTTPException(status_code=404, detail="Not a recognized Nami URL")


def _oembed_payload(title: str, author: dict, src: str, width: int, height: int, thumb) -> dict:
    iframe = (f'<iframe src="{html.escape(src)}" width="{width}" height="{height}" '
              'frameborder="0" scrolling="no" style="border:0;max-width:550px;width:100%" '
              'allowtransparency="true"></iframe>')
    payload = {
        "version": "1.0",
        "type": "rich",
        "provider_name": "Nami",
        "provider_url": WEB_APP_URL,
        "title": title,
        "author_name": author.get("name"),
        "author_url": f"{WEB_APP_URL}/user/{author.get('username') or author.get('user_id')}",
        "html": iframe,
        "width": width,
        "height": height,
        "cache_age": 3600,
    }
    if thumb:
        payload["thumbnail_url"] = thumb
    return payload
