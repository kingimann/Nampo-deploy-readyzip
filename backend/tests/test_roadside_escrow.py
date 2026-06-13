"""Balance-conservation tests for roadside wallet escrow (routes.roadside).

A wallet request holds base+tax+fuel from the requester. On completion the
helper is paid base+fuel and the platform keeps the tax. On cancel: a full
refund while open / accepted-not-en-route; once the helper is en route the
requester forfeits half the base to the helper and the rest (incl. tax) is
refunded. These pin that the held escrow is always fully and correctly
disbursed.
"""
from datetime import datetime, timezone

import pytest

from routes import roadside
from routes import money
from tests._fakedb import FakeDB

BASE = 80.0
TAX = 8.0
TOTAL = BASE + TAX   # no fuel


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "requester"}

    async def fake_hydrate(doc, viewer_id):
        return doc

    async def fake_notify(**kwargs):
        return None

    monkeypatch.setattr(roadside, "db", db)
    # The wallet helpers (_credit_wallet / _record_platform_fee) live in
    # routes.money and use that module's db, so point it at the same fake.
    monkeypatch.setattr(money, "db", db)
    monkeypatch.setattr(roadside, "get_current_user", fake_user)
    monkeypatch.setattr(roadside, "_hydrate", fake_hydrate)
    monkeypatch.setattr(roadside, "emit_notification", fake_notify)
    return db


def _seed(db, *, status="accepted", en_route=False, requester_bal=0.0, helper_bal=0.0):
    db.users.docs = [
        {"user_id": "requester", "wallet_balance": requester_bal},
        {"user_id": "helper", "wallet_balance": helper_bal},
    ]
    db.roadside_requests.docs = [{
        "id": "r1", "requester_id": "requester", "helper_id": "helper",
        "service": "tow", "status": status, "en_route": en_route,
        "price": BASE, "tax": TAX, "fuel_cost": 0.0, "total": TOTAL,
        "payment_method": "wallet", "held": True, "settled": False, "refunded": False,
        "created_at": datetime.now(timezone.utc),
    }]


async def _bal(db, uid):
    u = await db.users.find_one({"user_id": uid})
    return round(float(u["wallet_balance"]), 2)


@pytest.mark.asyncio
async def test_settle_pays_helper_and_books_tax(env):
    _seed(env, status="accepted")
    doc = env.roadside_requests.docs[0].copy()
    await roadside._settle(doc)
    # Helper receives base+fuel; platform keeps the tax; requester already paid.
    assert await _bal(env, "helper") == BASE
    assert await env.platform_revenue.count_documents({"source": "roadside_tax"}) == 1
    assert (await env.roadside_requests.find_one({"id": "r1"}))["status"] == "completed"


@pytest.mark.asyncio
async def test_cancel_while_accepted_not_enroute_full_refund(env):
    _seed(env, status="accepted", en_route=False, requester_bal=0.0)
    await roadside.cancel("r1")
    # Full escrow refunded; helper gets nothing.
    assert await _bal(env, "requester") == TOTAL
    assert await _bal(env, "helper") == 0.0
    assert (await env.roadside_requests.find_one({"id": "r1"}))["refunded"] is True


@pytest.mark.asyncio
async def test_cancel_en_route_forfeits_half_base(env):
    _seed(env, status="accepted", en_route=True, requester_bal=0.0)
    await roadside.cancel("r1")
    # Requester refunded total - base/2; helper gets base/2. Sum == total (conserved).
    assert await _bal(env, "requester") == round(TOTAL - BASE / 2, 2)
    assert await _bal(env, "helper") == round(BASE / 2, 2)
    assert (await _bal(env, "requester") + await _bal(env, "helper")) == TOTAL


@pytest.mark.asyncio
async def test_only_requester_can_cancel(env, monkeypatch):
    _seed(env, status="accepted")

    async def as_helper(_a):
        return {"user_id": "helper"}
    monkeypatch.setattr(roadside, "get_current_user", as_helper)
    with pytest.raises(Exception) as ei:
        await roadside.cancel("r1")
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_cannot_cancel_closed_request(env):
    _seed(env, status="completed")
    with pytest.raises(Exception) as ei:
        await roadside.cancel("r1")
    assert ei.value.status_code == 400
