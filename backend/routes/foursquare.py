"""Foursquare Places business profile match."""
from typing import Optional

import httpx
from fastapi import APIRouter, Header, Query

from core import FSQ_API_KEY, FSQ_BASE, get_current_user
from models import FsqProfile

router = APIRouter()


@router.get("/foursquare/match", response_model=Optional[FsqProfile])
async def foursquare_match(
    name: str = Query(...),
    lng: float = Query(...),
    lat: float = Query(...),
    authorization: Optional[str] = Header(None),
):
    await get_current_user(authorization)
    if not FSQ_API_KEY:
        return None
    headers = {
        "Authorization": f"Bearer {FSQ_API_KEY}",
        "X-Places-Api-Version": "2025-06-17",
        "Accept": "application/json",
    }
    params = {
        "query": name,
        "ll": f"{lat},{lng}",
        "radius": "200",
        "limit": "1",
        "fields": (
            "fsq_place_id,name,location,categories,rating,price,tel,website,"
            "hours,distance,photos"
        ),
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as http_client:
            resp = await http_client.get(
                f"{FSQ_BASE}/search", headers=headers, params=params
            )
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    results = (resp.json() or {}).get("results", [])
    if not results:
        return None
    r = results[0]
    loc = r.get("location") or {}
    cats = r.get("categories") or []
    photo_url: Optional[str] = None
    if r.get("photos"):
        p = r["photos"][0]
        photo_url = f"{p.get('prefix','')}original{p.get('suffix','')}"
    hours = r.get("hours") or {}
    return FsqProfile(
        fsq_id=r.get("fsq_place_id", ""),
        name=r.get("name", name),
        address=loc.get("address") or loc.get("formatted_address"),
        locality=loc.get("locality"),
        category=(cats[0].get("name") if cats else None),
        rating=r.get("rating"),
        price=r.get("price"),
        phone=r.get("tel"),
        website=r.get("website"),
        hours_display=hours.get("display"),
        open_now=hours.get("open_now"),
        photo=photo_url,
        distance=r.get("distance"),
    )
