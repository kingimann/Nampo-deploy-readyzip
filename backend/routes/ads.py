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

from core import db, get_current_user

router = APIRouter()

# Revenue-share rates (test economy; tune freely).
AD_CLICK_PAYOUT = 0.02            # host earns per ad click on their profile
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
    rows = await db.posts.find(q, {"_id": 0}).sort("promoted_until", -1).limit(20).to_list(20)
    if not rows:
        return {"ad": None}
    post = random.choice(rows)
    author = await db.users.find_one({"user_id": post["user_id"]}, {"_id": 0, "name": 1, "picture": 1})
    media = post.get("media") or []
    img = next((m.get("url") or m.get("base64") for m in media if m.get("type") == "image"), None)
    return {"ad": {
        "post_id": post["id"],
        "text": (post.get("text") or "")[:200],
        "image": img,
        "author_name": (author or {}).get("name", "Sponsored"),
        "author_picture": (author or {}).get("picture"),
    }}


@router.post("/ads/{post_id}/event")
async def ad_event(post_id: str, body: AdEvent, authorization: Optional[str] = Header(None)):
    me = await get_current_user(authorization)
    post = await db.posts.find_one({"id": post_id}, {"_id": 0, "id": 1, "user_id": 1})
    if not post:
        return {"ok": True}
    if body.type == "click":
        await db.posts.update_one({"id": post_id}, {"$inc": {"ad_clicks": 1}})
        host = body.host_user_id
        # Pay the host for a genuine click (not self, not the advertiser).
        if host and host != me["user_id"] and host != post.get("user_id"):
            await _credit(host, AD_CLICK_PAYOUT, "ad_revenue", "Ad revenue")
    else:
        await db.posts.update_one({"id": post_id}, {"$inc": {"ad_impressions": 1}})
    return {"ok": True}


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
