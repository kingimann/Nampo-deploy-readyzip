"""Publisher ad network — let developers embed Nami ads on their own websites
and earn a revenue share.

A developer registers a *site* (gets a public `site_key`), drops in a snippet,
and we serve link ads into an iframe. Impressions/clicks bill the advertiser's
prepaid ad balance and credit the publisher (site owner). Public endpoints under
`/pub/*` take no auth — the `site_key` identifies the publisher.
"""
import html
import json
import random
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from pydantic import BaseModel

from core import db, get_current_user, require_account_age, MONETIZE_MIN_AGE_DAYS
from routes.ads import bill_link_ad, _seen_recently

router = APIRouter()


def _public_base(request: Request) -> str:
    """Absolute public origin, honoring the TLS-terminating proxy (Render) so we
    never emit an http:// URL that browsers block as mixed content on https."""
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme or "https"
    proto = proto.split(",")[0].strip()
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}"


def _hex(s: Optional[str]) -> Optional[str]:
    """Accept a 3- or 6-digit hex colour (with or without '#'); else None."""
    s = (s or "").strip().lstrip("#")
    if re.fullmatch(r"[0-9a-fA-F]{3}", s) or re.fullmatch(r"[0-9a-fA-F]{6}", s):
        return "#" + s
    return None


def _ad_config(theme: str, accent: Optional[str], radius: Optional[str], label: Optional[str]) -> dict:
    """Resolve the look of an embedded ad unit, with safe defaults. Dark mode
    swaps the palette; the accent colours the domain/CTA line."""
    dark = (theme or "").strip().lower() == "dark"
    try:
        rad = max(0, min(24, int(radius)))
    except (TypeError, ValueError):
        rad = 12
    return {
        "bg": "#111b21" if dark else "#ffffff",
        "text": "#e9edef" if dark else "#0b0b0c",
        "muted": "#8696a0" if dark else "#5b6770",
        "border": "#2a3942" if dark else "#e3e6e8",
        "accent": _hex(accent) or "#1f8f6b",
        "radius": rad,
        "label": (label or "Sponsored").strip()[:24] or "Sponsored",
    }


# ── Publisher site management (authenticated) ────────────────────────────────
class SiteCreate(BaseModel):
    name: str
    domain: Optional[str] = ""


@router.post("/pub/sites")
async def create_site(body: SiteCreate, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    require_account_age(me, "monetize a site", MONETIZE_MIN_AGE_DAYS)
    name = (body.name or "").strip()[:120]
    if not name:
        raise HTTPException(status_code=400, detail="Site name is required")
    doc = {
        "id": str(uuid.uuid4()),
        "owner_id": me["user_id"],
        "name": name,
        "domain": (body.domain or "").strip()[:200],
        "site_key": "pub_" + uuid.uuid4().hex,
        "impressions": 0, "clicks": 0, "earned": 0.0,
        "created_at": datetime.now(timezone.utc),
    }
    await db.ad_sites.insert_one(doc.copy())
    return _site_view(doc)


def _site_view(s: dict) -> dict:
    imp = int(s.get("impressions", 0) or 0)
    clk = int(s.get("clicks", 0) or 0)
    return {
        "id": s["id"], "name": s.get("name"), "domain": s.get("domain"),
        "site_key": s.get("site_key"),
        "impressions": imp, "clicks": clk,
        "ctr": round((clk / imp * 100), 1) if imp else 0.0,
        "earned": round(float(s.get("earned", 0) or 0), 2),
        "created_at": s.get("created_at"),
    }


@router.get("/pub/sites")
async def list_sites(authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    rows = await db.ad_sites.find({"owner_id": me["user_id"]}, {"_id": 0}).sort("created_at", -1).limit(50).to_list(50)
    return {"sites": [_site_view(s) for s in rows]}


@router.delete("/pub/sites/{site_id}")
async def delete_site(site_id: str, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    res = await db.ad_sites.delete_one({"id": site_id, "owner_id": me["user_id"]})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Site not found")
    return {"ok": True}


# ── Public ad serving (no auth — site_key identifies the publisher) ───────────
async def _pick_link_ad(exclude_owner: str):
    now = datetime.now(timezone.utc)
    rows = await db.link_ads.find(
        {"promoted_until": {"$gt": now}, "owner_id": {"$ne": exclude_owner}}, {"_id": 0}
    ).sort("promoted_until", -1).limit(40).to_list(40)
    return random.choice(rows) if rows else None


@router.get("/pub/ad")
async def serve_ad(request: Request, site: str = Query(...)):
    """Return one ad for a publisher slot (JSON). Records a billed impression."""
    s = await db.ad_sites.find_one({"site_key": site}, {"_id": 0})
    if not s:
        raise HTTPException(status_code=404, detail="Unknown site")
    ad = await _pick_link_ad(s["owner_id"])
    if not ad:
        return {"ok": True, "ad": None}
    # Bill the impression; `credited` is what the publisher actually earned
    # (0 for invalid traffic / unestablished publisher / over the daily cap).
    credited = await bill_link_ad(ad, None, "impression", host_user_id=s["owner_id"])
    await db.ad_sites.update_one(
        {"id": s["id"]}, {"$inc": {"impressions": 1, "earned": credited}}
    )
    base = _public_base(request)
    domain = ad.get("url", "")
    try:
        from urllib.parse import urlparse
        domain = urlparse(ad["url"]).hostname or ad["url"]
        domain = domain.replace("www.", "")
    except Exception:
        pass
    return {"ok": True, "ad": {
        "id": ad["id"], "headline": ad.get("headline"), "description": ad.get("description"),
        "image": ad.get("image"), "domain": domain,
        "click": f"{base}/api/pub/click?site={site}&ad={ad['id']}",
    }}


@router.get("/pub/click")
async def click_ad(site: str = Query(...), ad: str = Query(...)):
    """Record a billed click and redirect the visitor to the advertiser's site."""
    s = await db.ad_sites.find_one({"site_key": site}, {"_id": 0})
    doc = await db.link_ads.find_one({"id": ad}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Ad not found")
    if s:
        credited = await bill_link_ad(doc, None, "click", host_user_id=s["owner_id"])
        await db.ad_sites.update_one(
            {"id": s["id"]}, {"$inc": {"clicks": 1, "earned": credited}}
        )
    return RedirectResponse(url=doc.get("url", "/"), status_code=302)


_AD_UNIT_HTML = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--bg:#fff;--text:#0b0b0c;--muted:#5b6770;--border:#e3e6e8;--acc:#1f8f6b;--rad:12px}
  html,body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg)}
  a.card{display:flex;gap:10px;align-items:center;text-decoration:none;color:var(--text);
    border:1px solid var(--border);border-radius:var(--rad);padding:10px;background:var(--bg)}
  .card img{width:54px;height:54px;border-radius:calc(var(--rad) - 4px);object-fit:cover;flex:0 0 auto}
  .h{font-weight:700;font-size:14px;line-height:1.2}
  .d{font-size:12px;color:var(--muted);margin-top:2px}
  .m{font-size:11px;color:var(--acc);margin-top:4px;font-weight:600}
  .lbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin:0 0 4px 2px}
  .empty{font-size:12px;color:var(--muted);padding:10px}
</style></head><body>
<div class="lbl" id="lbl">Sponsored</div>
<div id="root"><div class="empty">Loading ad…</div></div>
<script>
(function(){
  var SITE="__SITE__", BASE="__BASE__", CFG=__CONFIG__;
  var rs=document.documentElement.style;
  rs.setProperty('--bg',CFG.bg);rs.setProperty('--text',CFG.text);rs.setProperty('--muted',CFG.muted);
  rs.setProperty('--border',CFG.border);rs.setProperty('--acc',CFG.accent);rs.setProperty('--rad',CFG.radius+'px');
  document.getElementById('lbl').textContent=CFG.label;
  function esc(s){return String(s==null?"":s).replace(/[&<>"'`]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;","`":"&#96;"}[c];});}
  function safeUrl(u){u=String(u==null?"":u).trim();return /^https?:\\/\\//i.test(u)?u:"#";}
  fetch(BASE+"/api/pub/ad?site="+encodeURIComponent(SITE)).then(function(r){return r.json()}).then(function(j){
    var root=document.getElementById("root");
    if(!j||!j.ad){root.innerHTML='<div class="empty">No ad available.</div>';return;}
    var a=j.ad;
    var img=safeUrl(a.image)!=="#"?('<img src="'+esc(safeUrl(a.image))+'" alt="">'):'';
    var desc=a.description?('<div class="d">'+esc(a.description)+'</div>'):'';
    root.innerHTML='<a class="card" href="'+esc(safeUrl(a.click))+'" target="_blank" rel="noopener nofollow">'+img+
      '<div><div class="h">'+esc(a.headline)+'</div>'+desc+'<div class="m">'+esc(a.domain)+' ›</div></div></a>';
  }).catch(function(){document.getElementById("root").innerHTML='<div class="empty">No ad available.</div>';});
})();
</script></body></html>"""


@router.get("/pub/unit", response_class=HTMLResponse)
async def ad_unit(
    request: Request,
    site: str = Query(...),
    theme: str = Query("light"),
    accent: Optional[str] = Query(None),
    radius: Optional[str] = Query(None),
    label: Optional[str] = Query(None),
):
    """Self-contained HTML ad unit — embed it in an <iframe>. Look is customizable
    via theme (light/dark), accent, radius and label query params."""
    base = _public_base(request)
    cfg = _ad_config(theme, accent, radius, label)
    cfg_js = json.dumps(cfg).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    page = (
        _AD_UNIT_HTML
        .replace("__SITE__", html.escape(site))
        .replace("__BASE__", base)
        .replace("__CONFIG__", cfg_js)
    )
    return HTMLResponse(content=page, headers={"X-Frame-Options": "ALLOWALL"})


@router.get("/pub/embed.js")
async def embed_js(request: Request, site: str = Query(...)):
    """Loader snippet:
    <script src=".../pub/embed.js?site=KEY" data-width data-height
            data-theme data-accent data-radius data-label></script>"""
    base = _public_base(request)
    js = """(function(){
  var s=document.currentScript;
  var site="__SITE__";
  function attr(n){return s&&s.getAttribute(n);}
  var w=attr("data-width")||"320";
  var h=attr("data-height")||"104";
  var qs="site="+encodeURIComponent(site);
  ["theme","accent","radius","label"].forEach(function(k){
    var v=attr("data-"+k); if(v) qs+="&"+k+"="+encodeURIComponent(v);
  });
  var f=document.createElement("iframe");
  f.src="__BASE__/api/pub/unit?"+qs;
  f.width=w;f.height=h;f.scrolling="no";f.style.border="0";f.style.overflow="hidden";
  if(s&&s.parentNode)s.parentNode.insertBefore(f,s);
})();""".replace("__SITE__", site).replace("__BASE__", base)
    return Response(content=js, media_type="application/javascript")
