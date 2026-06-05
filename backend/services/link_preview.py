"""OpenGraph link preview fetcher with SSRF protection + cache."""
from __future__ import annotations

import ipaddress
import re
import socket
from datetime import datetime, timezone, timedelta
from html.parser import HTMLParser
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx

from core import db

CACHE_TTL = timedelta(days=7)
MAX_BYTES = 256 * 1024  # only sniff first 256KB
TIMEOUT = 5.0

_URL_RE = re.compile(r"https?://[^\s]+", re.I)


def first_url(text: str) -> Optional[str]:
    m = _URL_RE.search(text or "")
    return m.group(0) if m else None


class _OG(HTMLParser):
    def __init__(self):
        super().__init__()
        self.props: dict = {}
        self.title = None
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta":
            prop = (a.get("property") or a.get("name") or "").lower()
            content = a.get("content")
            if prop and content:
                self.props[prop] = content
        if tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title and not self.title:
            self.title = data.strip() or None


def _is_safe_host(host: str) -> bool:
    """Block IPs in private/reserved ranges to prevent SSRF."""
    try:
        # resolve all addresses
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for fam, _, _, _, sockaddr in infos:
        ip = ipaddress.ip_address(sockaddr[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False
    return True


async def fetch_link_preview(url: str) -> Optional[dict]:
    """Return cached/freshly-fetched OG metadata for the URL, or None."""
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    if not _is_safe_host(parsed.hostname):
        return None

    cached = await db.link_previews.find_one({"url": url}, {"_id": 0})
    if cached:
        # Honor cache TTL
        fetched = cached.get("fetched_at")
        if isinstance(fetched, datetime):
            if (datetime.now(timezone.utc) - fetched.replace(
                tzinfo=fetched.tzinfo or timezone.utc
            )) < CACHE_TTL:
                return {k: cached.get(k) for k in
                        ("url", "title", "description", "image", "site_name")}

    try:
        async with httpx.AsyncClient(
            timeout=TIMEOUT,
            follow_redirects=True,
            max_redirects=5,
            headers={"User-Agent": "NamiBot/1.0 (link preview)"},
        ) as client:
            async with client.stream("GET", url) as resp:
                if resp.status_code >= 400:
                    return None
                ctype = (resp.headers.get("content-type") or "").lower()
                if "html" not in ctype:
                    return None
                chunks = []
                total = 0
                async for chunk in resp.aiter_bytes(chunk_size=8192):
                    chunks.append(chunk)
                    total += len(chunk)
                    if total >= MAX_BYTES:
                        break
                body = b"".join(chunks).decode("utf-8", errors="replace")
    except Exception:
        return None

    p = _OG()
    try:
        p.feed(body)
    except Exception:
        pass

    def og(*keys):
        for k in keys:
            v = p.props.get(k)
            if v:
                return v
        return None

    image = og("og:image", "twitter:image")
    if image:
        image = urljoin(url, image)

    preview = {
        "url": url,
        "title": og("og:title", "twitter:title") or p.title,
        "description": og("og:description", "twitter:description", "description"),
        "image": image,
        "site_name": og("og:site_name"),
    }
    if not preview["title"] and not preview["description"] and not preview["image"]:
        return None

    await db.link_previews.update_one(
        {"url": url},
        {"$set": {**preview, "fetched_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return preview
