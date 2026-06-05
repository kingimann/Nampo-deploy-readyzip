"""Sponsored ads served into slots across the app (profiles, communities,
marketplace, …) plus creator ad-revenue.

Ad inventory = promoted posts (see /posts/{id}/promote). When an ad is shown on
someone's profile and viewers click it, the host (profile owner) earns a share.
Profile owners also earn from profile views once they cross a threshold.
"""
import random
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel

from datetime import timedelta

from core import db, get_current_user, is_admin

router = APIRouter()

# Revenue-share rates (test economy; tune freely).
AD_CLICK_PAYOUT = 0.02            # flat host payout per click on non-budget ads
HOST_REVENUE_SHARE = 0.5         # host's cut of a budget campaign's CPC (rest = platform)
PROFILE_VIEWS_PER_PAYOUT = 100   # every N profile views …
PROFILE_VIEW_PAYOUT = 0.10       # … the owner earns this


async def _credit(to_user_id: str, amount: float, kind: str, from_name: str):
    await db.earnings.insert_one({
        "id": str(uuid.uuid4()), "user_id": to_user_id, "amount": round(amount, 2),
        "kind": kind, "from_user_id": "", "from_name": from_name,
        "created_at": datetime.now(timezone.utc),
    })


class AdEvent(BaseModel):
    type: str                    # "impression" | "click"
    host_user_id: Optional[str] = None   # whose surface the ad was shown on


@router.get("/ads/next")
async def next_ad(
    placement: str = Query("feed"),
    exclude: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    """Return one active sponsored post for an ad slot (or {ad: null})."""
    me = await get_current_user(authorization)
    now = datetime.now(timezone.utc)
    q = {"promoted_until": {"$gt": now}, "user_id": {"$ne": me["user_id"]}}
    if exclude:
        q["id"] = {"$ne": exclude}
    rows = await db.posts.find(q, {"_id": 0}).sort("promoted_until", -1).limit(40).to_list(40)
    # Budget campaigns stop serving once the budget is spent.
    rows = [r for r in rows if not (r.get("ad_budget") and float(r.get("ad_spent", 0) or 0) >= float(r["ad_budget"]))]
    # Drop ads this viewer has hidden or reported.
    hidden = {h.get("post_id") for h in await db.ad_hides.find({"viewer_id": me["user_id"]}, {"_id": 0, "post_id": 1}).to_list(500)}
    rows = [r for r in rows if r["id"] not in hidden]
    from routes.posts import _hydrate_post
    if rows:
        post = random.choice(rows)
        full = await _hydrate_post(post, me["user_id"])
        return {"house": False, "post": full.model_dump(),
                "reason": "It's a promoted post matched to this spot."}
    # ── House ad: never leave a slot empty — surface the viewer's own post ──
    mine = await db.posts.find(
        {"user_id": me["user_id"], "parent_id": None}, {"_id": 0}
    ).sort("created_at", -1).limit(1).to_list(1)
    if mine:
        full = await _hydrate_post(mine[0], me["user_id"])
        return {"house": True, "post": full.model_dump()}
    return {"house": True, "post": None, "cta": "advertise"}


async def _seen_recently(post_id: str, viewer_id: str, kind: str, hours: int) -> bool:
    """Fraud guard: has this viewer already triggered `kind` for this ad recently?
    Logs the event when it's new. Returns True if it's a duplicate."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    dup = await db.ad_events.find_one(
        {"post_id": post_id, "viewer_id": viewer_id, "kind": kind, "created_at": {"$gte": since}},
        {"_id": 0, "id": 1},
    )
    if dup:
        return True
    await db.ad_events.insert_one({
        "id": str(uuid.uuid4()), "post_id": post_id, "viewer_id": viewer_id,
        "kind": kind, "created_at": datetime.now(timezone.utc),
    })
    return False


@router.post("/ads/{post_id}/event")
async def ad_event(post_id: str, body: AdEvent, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    post = await db.posts.find_one({"id": post_id}, {"_id": 0})
    if not post:
        return {"ok": True}
    viewer = me["user_id"]
    # Never count the advertiser interacting with their own ad.
    if viewer == post.get("user_id"):
        return {"ok": True, "self": True}
    if body.type == "click":
        # Dedupe billable clicks per viewer per ad (24h).
        if await _seen_recently(post_id, viewer, "click", 24):
            return {"ok": True, "duplicate": True}
        host = body.host_user_id
        is_real = host and host != viewer and host != post.get("user_id")
        budget = float(post.get("ad_budget", 0) or 0)
        if budget > 0:
            # Pay-per-click campaign: charge the advertiser's budget at CPC,
            # split between the host (where it was clicked) and the platform.
            spent = float(post.get("ad_spent", 0) or 0)
            if spent >= budget:
                return {"ok": True, "served": False}
            cpc = float(post.get("ad_cpc", 0.10) or 0.10)
            charge = min(cpc, budget - spent)
            await db.posts.update_one({"id": post_id}, {"$inc": {"ad_clicks": 1, "ad_spent": charge}})
            if is_real and charge > 0:
                await _credit(host, round(charge * HOST_REVENUE_SHARE, 2), "ad_revenue", "Ad revenue")
        else:
            await db.posts.update_one({"id": post_id}, {"$inc": {"ad_clicks": 1}})
            if is_real:
                await _credit(host, AD_CLICK_PAYOUT, "ad_revenue", "Ad revenue")
    else:
        # Dedupe impressions per viewer per ad per day (analytics hygiene).
        if await _seen_recently(post_id, viewer, "impression", 24):
            return {"ok": True, "duplicate": True}
        await db.posts.update_one({"id": post_id}, {"$inc": {"ad_impressions": 1}})
    return {"ok": True}


@router.post("/ads/{post_id}/hide")
async def hide_ad(post_id: str, authorization: Optional[str] = Header(None)):
    """Stop showing this ad to the current viewer."""
    me = await get_current_user(authorization)
    exists = await db.ad_hides.find_one({"viewer_id": me["user_id"], "post_id": post_id}, {"_id": 0, "id": 1})
    if not exists:
        await db.ad_hides.insert_one({
            "id": str(uuid.uuid4()), "viewer_id": me["user_id"], "post_id": post_id,
            "created_at": datetime.now(timezone.utc),
        })
    return {"hidden": True}


@router.post("/ads/{post_id}/report")
async def report_ad(post_id: str, authorization: Optional[str] = Header(None)):
    """Report an ad (and hide it from this viewer)."""
    me = await get_current_user(authorization)
    await db.ad_reports.insert_one({
        "id": str(uuid.uuid4()), "reporter_id": me["user_id"], "post_id": post_id,
        "created_at": datetime.now(timezone.utc),
    })
    await db.ad_hides.insert_one({
        "id": str(uuid.uuid4()), "viewer_id": me["user_id"], "post_id": post_id,
        "created_at": datetime.now(timezone.utc),
    })
    return {"reported": True}


@router.get("/admin/ad-revenue")
async def admin_ad_revenue(authorization: Optional[str] = Header(None)):
    """Platform-wide ad revenue dashboard (admin only)."""
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    posts = await db.posts.find(
        {"promoted_until": {"$exists": True}},
        {"_id": 0, "id": 1, "ad_spent": 1, "ad_impressions": 1, "ad_clicks": 1, "user_id": 1},
    ).to_list(2000)
    total_spend = round(sum(float(p.get("ad_spent", 0) or 0) for p in posts), 2)
    total_impr = sum(int(p.get("ad_impressions", 0) or 0) for p in posts)
    total_clicks = sum(int(p.get("ad_clicks", 0) or 0) for p in posts)

    # What the platform paid out to hosts as ad/view revenue.
    earn = await db.earnings.find(
        {"kind": {"$in": ["ad_revenue", "views"]}}, {"_id": 0, "user_id": 1, "amount": 1}
    ).to_list(5000)
    paid_to_hosts = round(sum(float(e.get("amount", 0) or 0) for e in earn), 2)

    # Top earners (hosts) and top advertisers (by spend).
    by_host: dict = {}
    for e in earn:
        by_host[e["user_id"]] = by_host.get(e["user_id"], 0) + float(e.get("amount", 0) or 0)
    by_adv: dict = {}
    for p in posts:
        sp = float(p.get("ad_spent", 0) or 0)
        if sp > 0:
            by_adv[p["user_id"]] = by_adv.get(p["user_id"], 0) + sp

    async def _names(ids):
        rows = await db.users.find({"user_id": {"$in": list(ids)}}, {"_id": 0, "user_id": 1, "name": 1}).to_list(len(ids) or 1)
        return {r["user_id"]: r.get("name", "User") for r in rows}

    top_host_ids = sorted(by_host, key=by_host.get, reverse=True)[:10]
    top_adv_ids = sorted(by_adv, key=by_adv.get, reverse=True)[:10]
    names = await _names(set(top_host_ids) | set(top_adv_ids))

    return {
        "total_ad_spend": total_spend,
        "paid_to_hosts": paid_to_hosts,
        "platform_cut": round(total_spend - paid_to_hosts, 2),
        "total_impressions": total_impr,
        "total_clicks": total_clicks,
        "ctr": round((total_clicks / total_impr * 100), 1) if total_impr else 0.0,
        "active_campaigns": await db.posts.count_documents({"promoted_until": {"$gt": datetime.now(timezone.utc)}}),
        "top_earners": [{"name": names.get(uid, "User"), "amount": round(by_host[uid], 2)} for uid in top_host_ids],
        "top_advertisers": [{"name": names.get(uid, "User"), "amount": round(by_adv[uid], 2)} for uid in top_adv_ids],
    }


@router.get("/ads/campaigns")
async def my_campaigns(authorization: Optional[str] = Header(None)):
    """Analytics for the current user's promoted posts."""
    me = await get_current_user(authorization)
    now = datetime.now(timezone.utc)
    rows = await db.posts.find(
        {"user_id": me["user_id"], "promoted_until": {"$exists": True}}, {"_id": 0}
    ).sort("promoted_until", -1).limit(50).to_list(50)
    out = []
    for r in rows:
        imp = int(r.get("ad_impressions", 0) or 0)
        clk = int(r.get("ad_clicks", 0) or 0)
        budget = float(r.get("ad_budget", 0) or 0)
        spent = float(r.get("ad_spent", 0) or 0)
        until = r.get("ad" if False else "promoted_until")
        active = False
        try:
            from core import _norm_dt
            active = bool(until and _norm_dt(until) > now and (not budget or spent < budget))
        except Exception:
            pass
        out.append({
            "post_id": r["id"], "text": (r.get("text") or "")[:120],
            "impressions": imp, "clicks": clk,
            "ctr": round((clk / imp * 100), 1) if imp else 0.0,
            "budget": round(budget, 2), "spent": round(spent, 2),
            "cpc": round(float(r.get("ad_cpc", 0) or 0), 2),
            "promoted_until": until, "active": active,
        })
    return {"campaigns": out}


@router.post("/users/{user_id}/view")
async def record_profile_view(user_id: str, authorization: Optional[str] = Header(None)):
    """Count a profile view and reward the owner once they cross a threshold."""
    me = await get_current_user(authorization)
    if user_id == me["user_id"]:
        return {"ok": True}
    target = await db.users.find_one({"user_id": user_id}, {"_id": 0, "profile_views": 1})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    new_count = int(target.get("profile_views", 0) or 0) + 1
    await db.users.update_one({"user_id": user_id}, {"$inc": {"profile_views": 1}})
    if new_count % PROFILE_VIEWS_PER_PAYOUT == 0:
        await _credit(user_id, PROFILE_VIEW_PAYOUT, "views", "Profile views")
    return {"ok": True, "views": new_count}
