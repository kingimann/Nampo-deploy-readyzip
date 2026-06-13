"""Balance-conservation tests for the money transfer flow (routes.money).

The highest-stakes subsystem: a send escrows amount+fee from the sender; accept
credits the recipient the amount (sender stays debited, fee is platform revenue);
decline/reverse refund amount+fee and un-book the fee. These pin that money is
conserved across each path — a regression here would create or destroy funds.

Runs in-process against FakeDB with the notification/velocity/fee side-helpers
stubbed; the wallet debit/credit, escrow, and fee booking run for real.
"""
import pytest

from routes import money
import routes.payments as payments
from tests._fakedb import FakeDB

FEE = 0.25


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def noop(*a, **k):
        return None

    async def fee():
        return FEE

    monkeypatch.setattr(money, "db", db)
    monkeypatch.setattr(money, "enforce_send_velocity", noop)
    monkeypatch.setattr(money, "_require_answer", noop)
    monkeypatch.setattr(money, "_fee_dollars", fee)
    monkeypatch.setattr(money, "_notify_money", noop)
    monkeypatch.setattr(money, "record_money_event", noop)
    monkeypatch.setattr(money, "_maybe_payout_nudge", noop)
    monkeypatch.setattr(payments, "payout_hold_until", lambda u: None)
    db.users.docs = [
        {"user_id": "sender", "name": "Sender", "wallet_balance": 100.0},
        {"user_id": "recipient", "name": "Recipient", "wallet_balance": 0.0},
    ]
    return db


async def _bal(db, uid):
    u = await db.users.find_one({"user_id": uid})
    return round(float(u["wallet_balance"]), 2)


@pytest.mark.asyncio
async def test_send_escrows_amount_plus_fee_from_sender(env):
    me = {"user_id": "sender", "name": "Sender"}
    out = await money.send_money(money.SendMoney(to_user_id="recipient", amount=10, answer="x"), me=me)
    assert out["status"] == "pending"
    # Sender debited amount+fee; recipient not credited until accept.
    assert await _bal(env, "sender") == round(100 - (10 + FEE), 2)
    assert await _bal(env, "recipient") == 0.0
    # Fee booked as platform revenue.
    assert await env.platform_revenue.count_documents({"source": "transfer_fee"}) == 1
    assert await env.money_transfers.count_documents({"status": "pending"}) == 1


@pytest.mark.asyncio
async def test_accept_credits_recipient_only_money_conserved(env):
    from datetime import datetime, timezone, timedelta
    past = datetime.now(timezone.utc) - timedelta(minutes=1)
    # Sender already escrowed 10+fee at send time (balance reflects that).
    env.users.docs = [
        {"user_id": "sender", "name": "Sender", "wallet_balance": round(100 - 10 - FEE, 2)},
        {"user_id": "recipient", "name": "Recipient", "wallet_balance": 0.0},
    ]
    env.money_transfers.docs = [{
        "id": "t1", "from_user_id": "sender", "to_user_id": "recipient",
        "amount": 10.0, "fee": FEE, "status": "pending", "claimable_at": past,
    }]
    out = await money.accept_transfer("t1", me={"user_id": "recipient", "name": "Recipient"})
    assert out["amount"] == 10.0
    # Recipient credited the amount; sender unchanged (was already debited).
    assert await _bal(env, "recipient") == 10.0
    assert await _bal(env, "sender") == round(100 - 10 - FEE, 2)
    # sender out 10+fee, recipient in 10, platform keeps fee → conserved.


@pytest.mark.asyncio
async def test_decline_refunds_amount_plus_fee_and_unbooks_fee(env):
    env.users.docs = [
        {"user_id": "sender", "name": "Sender", "wallet_balance": round(100 - 10 - FEE, 2)},
        {"user_id": "recipient", "name": "Recipient", "wallet_balance": 0.0},
    ]
    env.money_transfers.docs = [{
        "id": "t1", "from_user_id": "sender", "to_user_id": "recipient",
        "amount": 10.0, "fee": FEE, "status": "pending",
    }]
    env.platform_revenue.docs = [{"ref_id": "t1", "source": "transfer_fee", "amount": FEE}]
    await money.decline_transfer("t1", me={"user_id": "recipient"})
    # Sender made whole (amount+fee back); recipient never credited; fee un-booked.
    assert await _bal(env, "sender") == 100.0
    assert await _bal(env, "recipient") == 0.0
    assert await env.platform_revenue.count_documents({"ref_id": "t1"}) == 0


@pytest.mark.asyncio
async def test_reverse_refunds_sender(env):
    env.users.docs = [
        {"user_id": "sender", "name": "Sender", "wallet_balance": round(100 - 10 - FEE, 2)},
        {"user_id": "recipient", "name": "Recipient", "wallet_balance": 0.0},
    ]
    env.money_transfers.docs = [{
        "id": "t1", "from_user_id": "sender", "to_user_id": "recipient",
        "amount": 10.0, "fee": FEE, "status": "pending",
    }]
    env.platform_revenue.docs = [{"ref_id": "t1", "source": "transfer_fee", "amount": FEE}]
    await money.reverse_transfer("t1", me={"user_id": "sender"})
    assert await _bal(env, "sender") == 100.0
    assert await env.platform_revenue.count_documents({"ref_id": "t1"}) == 0


@pytest.mark.asyncio
async def test_send_to_self_rejected(env):
    with pytest.raises(Exception):
        await money.send_money(money.SendMoney(to_user_id="sender", amount=5, answer="x"),
                               me={"user_id": "sender"})


@pytest.mark.asyncio
async def test_send_insufficient_balance_makes_no_change(env):
    me = {"user_id": "sender", "name": "Sender"}
    with pytest.raises(Exception):
        await money.send_money(money.SendMoney(to_user_id="recipient", amount=1000, answer="x"), me=me)
    # Balance untouched on failure.
    assert await _bal(env, "sender") == 100.0
