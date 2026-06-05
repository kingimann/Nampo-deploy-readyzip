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

# Account-funded billing: advertisers load a prepaid ad balance; each
# interaction debits it. Loading funds keeps campaigns running; at $0 they
# pause (instead of a per-post budget expiring).
AD_RATE_VIEW = 0.01      # per counted impression/view
AD_RATE_COMMENT = 0.05   # per comment on a promoted post
AD_DEFAULT_CPC = 0.10    # per click when the campaign sets no CPC


async def _credit(to_user_id: str, amount: float, kind: str, from_name: str):
    await db.earnings.insert_one({
        "id": str(uuid.uuid4()), "user_id": to_user_id, "amount": round(amount, 2),
        "kind": kind, "from_user_id": "", "from_name": from_name,
        "created_at": datetime.now(timezone.utc),
    })


async def _ad_balance(user_id: str):
    """Advertiser's prepaid ad balance, or None if they've never funded an ad
    account (legacy/unmetered campaigns keep their old behaviour)."""
    u = await db.users.find_one({"user_id": user_id}, {"_id": 0, "ad_balance": 1})
    if not u or u.get("ad_balance") is None:
        return None
    return float(u.get("ad_balance") or 0)


async def bill_ad_interaction(post: dict, viewer_id: str, kind: str, host_user_id: Optional[str] = None) -> float:
    """Debit the advertiser's prepaid ad balance for a billable interaction
    (view | click | comment) and credit the host where it happened. No-op for
    self-interactions or campaigns with no funded balance. Returns the charge."""
    advertiser = post.get("user_id")
    if not advertiser or advertiser == viewer_id:
        return 0.0
    bal = await _ad_balance(advertiser)
    if bal is None or bal <= 0:
        return 0.0
    if kind == "click":
        rate, field = (float(post.get("ad_cpc", 0) or 0) or AD_DEFAULT_CPC), "ad_clicks"
    elif kind == "comment":
        rate, field = AD_RATE_COMMENT, "ad_comments"
    else:
        rate, field = AD_RATE_VIEW, "ad_impressions"
    charge = round(min(rate, bal), 2)
    if charge <= 0:
        return 0.0
    await db.users.update_one({"user_id": advertiser}, {"$inc": {"ad_balance": -charge}})
    await db.posts.update_one({"id": post["id"]}, {"$inc": {field: 1, "ad_spent": charge}})
    if host_user_id and host_user_id != viewer_id and host_user_id != advertiser:
        await _credit(host_user_id, round(charge * HOST_REVENUE_SHARE, 2), "ad_revenue", "Ad revenue")
    return charge


async def _apply_ad_topup(user_id: str, amount: float, source: str):
    """Credit an advertiser's prepaid ad balance and log the top-up."""
    amount = round(float(amount or 0), 2)
    await db.users.update_one({"user_id": user_id}, {"$inc": {"ad_balance": amount}})
    await db.ad_topups.insert_one({
        "id": str(uuid.uuid4()), "user_id": user_id, "amount": amount,
        "source": source, "created_at": datetime.now(timezone.utc),
    })


class AdEvent(BaseModel):
    type: str                    # "impression" | "click"
    host_user_id: Optional[str] = None   # whose surface the ad was shown on


@router.get("/ads/next")
async def next_ad(
    placement: str = Query("feed"),
    slot: Optional[int] = Query(None),   # rotate inventory across slots in one scroll
    authorization: Optional[str] = Header(None),
):
    """Return one active sponsored post for an ad slot (or {ad: null})."""
    me = await get_current_user(authorization)
    now = datetime.now(timezone.utc)
    q = {"promoted_until": {"$gt": now}, "user_id": {"$ne": me["user_id"]}}
    rows = await db.posts.find(q, {"_id": 0}).sort("promoted_until", -1).limit(40).to_list(40)
    # No requirements or minimums to be served: any active promoted post shows,
    # regardless of ad balance or budget. Balances/budgets only meter billing —
    # they never gate whether an ad appears.
    # Drop ads this viewer has hidden or reported.
    hidden = {h.get("post_id") for h in await db.ad_hides.find({"viewer_id": me["user_id"]}, {"_id": 0, "post_id": 1}).to_list(500)}
    rows = [r for r in rows if r["id"] not in hidden]
    from routes.posts import _hydrate_post
    if rows:
        # Rotate by slot so consecutive ad slots show different inventory;
        # random when no slot is given.
        post = rows[slot % len(rows)] if slot is not None else random.choice(rows)
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
    kind = "click" if body.type == "click" else "impression"
    # Dedupe billable interactions per viewer per ad (24h).
    if await _seen_recently(post_id, viewer, kind, 24):
        return {"ok": True, "duplicate": True}
    host = body.host_user_id
    is_real = host and host != viewer and host != post.get("user_id")

    # Funded accounts: debit the prepaid ad balance per view/click.
    if (await _ad_balance(post.get("user_id"))) is not None:
        charge = await bill_ad_interaction(post, viewer, "click" if kind == "click" else "view", host_user_id=host)
        return {"ok": True, "charged": charge}

    # ── Legacy per-post budget / flat payout path ──
    if kind == "click":
        budget = float(post.get("ad_budget", 0) or 0)
        if budget > 0:
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


# ── Admin test bot: simulate engagement on a sponsored post ──────────────────
class BotRun(BaseModel):
    post_id: str
    views: int = 0
    clicks: int = 0
    likes: int = 0
    comments: int = 0
    earner_id: Optional[str] = None   # who receives the host ad-revenue (default: caller)


@router.get("/admin/bot/posts")
async def bot_posts(authorization: Optional[str] = Header(None)):
    """List sponsored posts the admin can bot-test (admin only)."""
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    now = datetime.now(timezone.utc)
    rows = await db.posts.find(
        {"promoted_until": {"$gt": now}}, {"_id": 0}
    ).sort("promoted_until", -1).limit(100).to_list(100)
    owner_ids = {r.get("user_id") for r in rows if r.get("user_id")}
    names: dict = {}
    if owner_ids:
        urows = await db.users.find(
            {"user_id": {"$in": list(owner_ids)}}, {"_id": 0, "user_id": 1, "name": 1}
        ).to_list(len(owner_ids))
        names = {u["user_id"]: u.get("name", "User") for u in urows}
    posts = [{
        "post_id": r["id"],
        "text": (r.get("text") or "")[:120],
        "owner_name": names.get(r.get("user_id"), "User"),
        "views": int(r.get("views_count", 0) or 0),
        "likes": int(r.get("likes_count", 0) or 0),
        "comments": int(r.get("replies_count", 0) or 0),
        "impressions": int(r.get("ad_impressions", 0) or 0),
        "clicks": int(r.get("ad_clicks", 0) or 0),
        "spent": round(float(r.get("ad_spent", 0) or 0), 2),
    } for r in rows]
    return {"posts": posts}


@router.post("/admin/bot/run")
async def bot_run(body: BotRun, authorization: Optional[str] = Header(None)):
    """Simulate views/clicks/likes/comments on a sponsored post to test wallet
    and analytics. Counters only — no real like/comment records are created.
    Admin only. Credits the earner (default: caller) with host ad-revenue so
    you can verify earnings appear in the wallet."""
    me = await get_current_user(authorization)
    if not is_admin(me):
        raise HTTPException(status_code=403, detail="Admins only")
    post = await db.posts.find_one({"id": body.post_id}, {"_id": 0})
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    clamp = lambda n: max(0, min(100000, int(n or 0)))
    views, clicks, likes, comments = clamp(body.views), clamp(body.clicks), clamp(body.likes), clamp(body.comments)

    # Bump engagement + ad-analytics counters (counters only — no real docs).
    inc: dict = {}
    if views:
        inc["views_count"] = views
        inc["ad_impressions"] = views
    if likes:
        inc["likes_count"] = likes
    if comments:
        inc["replies_count"] = comments
        inc["ad_comments"] = comments
    if clicks:
        inc["ad_clicks"] = clicks

    # Advertiser spend (so the campaign's spend/analytics move like real traffic).
    cpc = float(post.get("ad_cpc", 0) or 0) or AD_DEFAULT_CPC
    spend = round(views * AD_RATE_VIEW + clicks * cpc + comments * AD_RATE_COMMENT, 2)
    if spend:
        inc["ad_spent"] = spend
    if inc:
        await db.posts.update_one({"id": body.post_id}, {"$inc": inc})

    # Debit the advertiser's prepaid balance (if funded) so balance drain is testable.
    advertiser = post.get("user_id")
    adv_bal = await _ad_balance(advertiser)
    debited = 0.0
    if adv_bal is not None and spend > 0:
        debited = round(min(spend, adv_bal), 2)
        if debited > 0:
            await db.users.update_one({"user_id": advertiser}, {"$inc": {"ad_balance": -debited}})

    # Credit the host/earner with ad revenue so the wallet shows real earnings.
    earner = body.earner_id or me["user_id"]
    earned = round(spend * HOST_REVENUE_SHARE, 2)
    if earned > 0:
        await _credit(earner, earned, "ad_revenue", "View bot (test)")

    fresh = await db.posts.find_one(
        {"id": body.post_id},
        {"_id": 0, "views_count": 1, "likes_count": 1, "replies_count": 1,
         "ad_impressions": 1, "ad_clicks": 1, "ad_comments": 1, "ad_spent": 1},
    ) or {}
    return {
        "ok": True,
        "earned": earned,
        "earner_id": earner,
        "spend": spend,
        "debited_from_advertiser": debited,
        "totals": {
            "views": int(fresh.get("views_count", 0) or 0),
            "likes": int(fresh.get("likes_count", 0) or 0),
            "comments": int(fresh.get("replies_count", 0) or 0),
            "impressions": int(fresh.get("ad_impressions", 0) or 0),
            "clicks": int(fresh.get("ad_clicks", 0) or 0),
            "spent": round(float(fresh.get("ad_spent", 0) or 0), 2),
        },
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


class AdTopup(BaseModel):
    amount: float


@router.get("/ads/account")
async def ad_account(authorization: Optional[str] = Header(None)):
    """Advertiser's prepaid ad-account: current balance, spend and rates."""
    me = await get_current_user(authorization)
    u = await db.users.find_one({"user_id": me["user_id"]}, {"_id": 0, "ad_balance": 1})
    bal = (u or {}).get("ad_balance")
    funded = bal is not None
    bal_f = round(float(bal or 0), 2)
    now = datetime.now(timezone.utc)
    rows = await db.posts.find(
        {"user_id": me["user_id"], "promoted_until": {"$exists": True}},
        {"_id": 0, "ad_spent": 1, "promoted_until": 1},
    ).to_list(500)
    from core import _norm_dt
    active = 0
    for r in rows:
        until = r.get("promoted_until")
        try:
            if until and _norm_dt(until) > now:
                active += 1
        except Exception:
            pass
    spent = round(sum(float(r.get("ad_spent", 0) or 0) for r in rows), 2)
    topups = await db.ad_topups.find(
        {"user_id": me["user_id"]}, {"_id": 0}
    ).sort("created_at", -1).limit(10).to_list(10)
    try:
        from routes.payments import stripe_enabled
        pay_on = stripe_enabled()
    except Exception:
        pay_on = False
    return {
        "balance": bal_f,
        "funded": funded,
        "paused": False,  # ads never pause — funding is optional, no minimum
        "active_campaigns": active,
        "lifetime_spend": spent,
        "stripe_enabled": pay_on,
        "rates": {"view": AD_RATE_VIEW, "click": AD_DEFAULT_CPC, "comment": AD_RATE_COMMENT},
        "recent_topups": [
            {"amount": round(float(t.get("amount", 0) or 0), 2),
             "source": t.get("source", "test"), "created_at": t.get("created_at")}
            for t in topups
        ],
    }


@router.post("/ads/account/topup")
async def ad_topup(body: AdTopup, authorization: Optional[str] = Header(None)):
    """Load funds into the prepaid ad account. Routes through Stripe Checkout
    when real payments are on; otherwise credits immediately (test mode)."""
    me = await get_current_user(authorization)
    amount = round(float(body.amount or 0), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than 0")
    if amount > 10000:
        raise HTTPException(status_code=400, detail="Maximum top-up is $10,000")
    try:
        from routes.payments import stripe_enabled, WEB_APP_URL
        pay_on = stripe_enabled()
    except Exception:
        pay_on, WEB_APP_URL = False, ""
    if pay_on:
        import stripe  # type: ignore
        session = stripe.checkout.Session.create(
            mode="payment",
            line_items=[{
                "price_data": {
                    "currency": "usd",
                    "product_data": {"name": "Ad account top-up"},
                    "unit_amount": int(round(amount * 100)),
                },
                "quantity": 1,
            }],
            success_url=f"{WEB_APP_URL}/advertise?topup=success",
            cancel_url=f"{WEB_APP_URL}/advertise?topup=cancel",
            metadata={"kind": "ad_topup", "buyer_id": me["user_id"], "amount": str(amount)},
        )
        return {"url": session["url"], "id": session["id"], "stripe": True}
    await _apply_ad_topup(me["user_id"], amount, "test")
    bal = await _ad_balance(me["user_id"])
    return {"ok": True, "credited": amount, "balance": round(float(bal or 0), 2), "stripe": False}


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
