"""Public transit — nearby stops + next departures via TransitLand.

Proxies the TransitLand v2 REST API so the API key stays server-side. Set
TRANSITLAND_API_KEY in the environment (free key at https://www.transit.land/).
"""
import asyncio
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Header, Query

from core import TRANSITLAND_API_KEY, TRANSITLAND_BASE, get_current_user

router = APIRouter()

# GTFS route_type → friendly label/icon hint.
_ROUTE_TYPES = {
    0: "tram", 1: "subway", 2: "rail", 3: "bus", 4: "ferry",
    5: "cable", 6: "aerial", 7: "funicular", 11: "trolleybus", 12: "monorail",
}


def _route_kind(rt) -> str:
    try:
        base = int(rt) % 100  # extended GTFS types share their hundreds digit
    except (TypeError, ValueError):
        return "transit"
    if 0 <= base <= 12 and base in _ROUTE_TYPES:
        return _ROUTE_TYPES[base]
    if 100 <= int(rt) < 200:
        return "rail"
    if 200 <= int(rt) < 300:
        return "bus"
    if 400 <= int(rt) < 500:
        return "subway"
    if 700 <= int(rt) < 800:
        return "bus"
    if 900 <= int(rt) < 1000:
        return "tram"
    if 1000 <= int(rt) < 1100:
        return "ferry"
    return "transit"


def _best_iso(dep: dict) -> Optional[str]:
    """Pull the best available UTC ISO timestamp from a departure record."""
    d = dep.get("departure") or {}
    for key in ("estimated_utc", "scheduled_utc"):
        v = d.get(key)
        if v:
            return v
    for key in ("estimated", "scheduled"):
        v = dep.get(key)
        if v:
            return v
    return None


def _minutes_until(iso: Optional[str]) -> Optional[int]:
    if not iso:
        return None
    try:
        s = iso.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        delta = (dt - datetime.now(timezone.utc)).total_seconds()
        return int(round(delta / 60.0))
    except (ValueError, TypeError):
        return None


def _delay_seconds(dep: dict) -> Optional[int]:
    """Real-time delay vs schedule, in seconds (+late / -early). None if no RT."""
    d = dep.get("departure") or {}
    for key in ("estimated_delay", "delay"):
        v = d.get(key)
        if isinstance(v, (int, float)):
            return int(v)
    # Fall back to estimated_utc - scheduled_utc when both timestamps exist.
    est, sched = d.get("estimated_utc"), d.get("scheduled_utc")
    if est and sched:
        try:
            de = datetime.fromisoformat(est.replace("Z", "+00:00"))
            ds = datetime.fromisoformat(sched.replace("Z", "+00:00"))
            return int(round((de - ds).total_seconds()))
        except (ValueError, TypeError):
            return None
    return None


async def _departures_for_stop(client: httpx.AsyncClient, onestop_id: str) -> list:
    try:
        resp = await client.get(
            f"{TRANSITLAND_BASE}/stops/{onestop_id}/departures",
            params={"apikey": TRANSITLAND_API_KEY, "limit": 4, "next": 5400},
        )
        if resp.status_code != 200:
            return []
        data = resp.json() or {}
    except (httpx.HTTPError, ValueError):
        return []

    out = []
    for stop in (data.get("stops") or []):
        stop_name = stop.get("stop_name") or stop.get("name") or ""
        for dep in (stop.get("departures") or []):
            trip = dep.get("trip") or {}
            route = trip.get("route") or {}
            short = route.get("route_short_name") or ""
            long = route.get("route_long_name") or ""
            iso = _best_iso(dep)
            mins = _minutes_until(iso)
            if mins is not None and mins < -1:
                continue  # already departed
            d = dep.get("departure") or {}
            out.append({
                "stop_name": stop_name,
                "route": short or long or "—",
                "route_long": long,
                "kind": _route_kind(route.get("route_type")),
                "headsign": trip.get("trip_headsign") or dep.get("trip_headsign") or long,
                "time_label": (dep.get("departure_time") or "")[:5],
                "minutes": mins,
                "realtime": bool(d.get("estimated") or d.get("estimated_utc")),
                "delay": _delay_seconds(dep),
                "iso": iso,
            })
    return out


@router.get("/transit/nearby")
async def transit_nearby(
    lat: float = Query(...),
    lon: float = Query(...),
    radius: int = Query(800, ge=100, le=2000),
    authorization: Optional[str] = Header(None),
):
    await get_current_user(authorization)
    if not TRANSITLAND_API_KEY:
        return {"configured": False, "departures": [], "stops": []}

    async with httpx.AsyncClient(timeout=12.0) as client:
        try:
            resp = await client.get(
                f"{TRANSITLAND_BASE}/stops",
                params={
                    "apikey": TRANSITLAND_API_KEY,
                    "lat": lat,
                    "lon": lon,
                    "radius": radius,
                    "limit": 12,
                },
            )
        except httpx.HTTPError:
            return {"configured": True, "departures": [], "stops": [], "error": "upstream"}
        if resp.status_code != 200:
            return {"configured": True, "departures": [], "stops": [], "error": "upstream"}

        stops_raw = (resp.json() or {}).get("stops") or []
        # Nearest first (TransitLand returns a distance when lat/lon given).
        stops_raw.sort(key=lambda s: s.get("distance", 1e9) if isinstance(s.get("distance"), (int, float)) else 1e9)
        stop_list = [
            {
                "name": s.get("stop_name") or s.get("name") or "Stop",
                "onestop_id": s.get("onestop_id"),
                "distance": s.get("distance"),
            }
            for s in stops_raw if s.get("onestop_id")
        ]

        # Fetch departures for the closest few stops concurrently.
        ids = [s["onestop_id"] for s in stop_list[:6]]
        results = await asyncio.gather(*[_departures_for_stop(client, i) for i in ids])

    departures: list = []
    for r in results:
        departures.extend(r)
    # Sort: ones with a known minutes value first (soonest), then the rest.
    departures.sort(key=lambda d: d["minutes"] if d.get("minutes") is not None else 9999)
    departures = departures[:25]

    return {
        "configured": True,
        "stops": stop_list[:6],
        "departures": departures,
    }
