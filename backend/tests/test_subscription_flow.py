"""Behavioural tests for creator subscriptions (routes.users.subscribe_user).

The test-mode/wallet path moves money: the subscriber's wallet is charged the
tier price and the creator is credited the same (so a sub can't mint free
withdrawable earnings). Pins: self-sub / invalid-tier / Stripe-on / insufficient
balance are rejected; a successful sub conserves money and records the sub; a
repeat sub is idempotent (no double charge); unsubscribe cancels.
"""
import pytest

from routes import users
from routes import money
import routes.payments as payments
from tests._fakedb import FakeDB

PRICE = 2.99   # tier "basic"


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def me(_a):
        return {"user_id": "fan", "name": "Fan"}

    async def not_live():
        return False

    monkeypatch.setattr(users, "db", db)
    monkeypatch.setattr(money, "db", db)            # _debit/_credit_wallet use money.db
    monkeypatch.setattr(users, "get_current_user", me)
    monkeypatch.setattr(payments, "payments_live", not_live)
    monkeypatch.setattr(users, "emit_notification", None)   # skip notification fan-out
    db.users.docs = [
        {"user_id": "fan", "name": "Fan", "wallet_balance": 10.0},
        {"user_id": "creator", "name": "Creator", "wallet_balance": 0.0},
    ]
    return db


async def _bal(db, uid):
    u = await db.users.find_one({"user_id": uid})
    return round(float(u["wallet_balance"]), 2)


@pytest.mark.asyncio
async def test_cannot_subscribe_to_self(env):
    with pytest.raises(Exception) as ei:
        await users.subscribe_user("fan", users.SubscribeBody(tier="basic"))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_invalid_tier_rejected(env):
    with pytest.raises(Exception) as ei:
        await users.subscribe_user("creator", users.SubscribeBody(tier="bogus"))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_stripe_on_routes_to_checkout(env, monkeypatch):
    async def live():
        return True
    monkeypatch.setattr(payments, "payments_live", live)
    with pytest.raises(Exception) as ei:
        await users.subscribe_user("creator", users.SubscribeBody(tier="basic"))
    assert ei.value.status_code == 409


@pytest.mark.asyncio
async def test_successful_subscription_conserves_money(env):
    out = await users.subscribe_user("creator", users.SubscribeBody(tier="basic"))
    assert out["subscribed"] is True
    assert await _bal(env, "fan") == round(10.0 - PRICE, 2)
    assert await _bal(env, "creator") == PRICE
    sub = await env.subscriptions.find_one({"subscriber_id": "fan", "creator_id": "creator"})
    assert sub["status"] == "active" and sub["tier"] == "basic"


@pytest.mark.asyncio
async def test_insufficient_balance_rejected(env):
    env.users.docs[0]["wallet_balance"] = 1.0   # < 2.99
    with pytest.raises(Exception) as ei:
        await users.subscribe_user("creator", users.SubscribeBody(tier="basic"))
    assert ei.value.status_code == 400
    assert await _bal(env, "fan") == 1.0
    assert await env.subscriptions.count_documents({}) == 0


@pytest.mark.asyncio
async def test_repeat_subscription_is_idempotent(env):
    await users.subscribe_user("creator", users.SubscribeBody(tier="basic"))
    await users.subscribe_user("creator", users.SubscribeBody(tier="basic"))
    # Charged once, one active subscription.
    assert await _bal(env, "fan") == round(10.0 - PRICE, 2)
    assert await env.subscriptions.count_documents({"status": "active"}) == 1


@pytest.mark.asyncio
async def test_unsubscribe_cancels(env):
    await users.subscribe_user("creator", users.SubscribeBody(tier="basic"))
    await users.unsubscribe_user("creator")
    assert await env.subscriptions.count_documents({"status": "active"}) == 0
