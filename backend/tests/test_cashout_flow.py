"""Behavioural tests for instant cash-out (routes.payments.cashout_to_card) — the
money-OUT path, with Stripe mocked.

Pins: a successful cash-out debits the wallet by the gross amount, the user
receives gross-fee on their card, the flat fee is booked as platform revenue,
and a payout record is written; below-minimum / no-debit-card / insufficient
balance are rejected; and a Stripe failure refunds the wallet (no funds lost).
"""
import pytest

from routes import payments
from tests._fakedb import FakeDB

MIN = payments.MIN_CASHOUT     # 20.0
FEE = payments.CASHOUT_FEE     # 2.00


class _FakeStripe:
    """Minimal stripe stand-in. `account` is the retrieved connected account;
    `fail_payout` makes Payout.create raise (to exercise the refund path)."""
    def __init__(self, account, fail_payout=False):
        self._account = account
        self._fail = fail_payout
        self.transfers = []
        self.payouts = []
        outer = self

        class Account:
            @staticmethod
            def retrieve(acct_id=None, **k):
                return outer._account

        class Transfer:
            @staticmethod
            def create(**k):
                outer.transfers.append(k)
                return {"id": "tr_1"}

        class Payout:
            @staticmethod
            def create(**k):
                if outer._fail:
                    raise RuntimeError("card declined")
                outer.payouts.append(k)
                return {"id": "po_1"}

        self.Account, self.Transfer, self.Payout = Account, Transfer, Payout


def _account(card=True, payouts_enabled=True, currency="usd"):
    data = [{"object": "card", "brand": "visa", "last4": "4242"}] if card else []
    return {
        "payouts_enabled": payouts_enabled,
        "external_accounts": {"data": data},
        "default_currency": currency,
    }


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def off():
        return False

    monkeypatch.setattr(payments, "db", db)
    monkeypatch.setattr(payments, "stripe_enabled", lambda: True)
    monkeypatch.setattr(payments, "test_payments_on", off)
    monkeypatch.setattr(payments, "payout_hold_until", lambda u: None)
    return db


def _user(balance=50.0):
    return {"user_id": "u1", "stripe_account_id": "acct_1",
            "wallet_balance": balance, "id_verified": True}


async def _bal(db):
    u = await db.users.find_one({"user_id": "u1"})
    return round(float(u["wallet_balance"]), 2)


@pytest.mark.asyncio
async def test_successful_cashout_debits_gross_books_fee(env, monkeypatch):
    monkeypatch.setattr(payments, "stripe", _FakeStripe(_account()))
    env.users.docs = [_user(balance=50.0)]
    out = await payments.cashout_to_card(payments.CashoutBody(amount=20.0), _auth_user=_user(50.0))
    # User receives gross - fee on their card; platform keeps the flat fee.
    assert out["amount"] == round(20.0 - FEE, 2)
    assert await _bal(env) == round(50.0 - 20.0, 2)          # wallet debited the gross
    assert await env.payouts.count_documents({"method": "instant_card"}) == 1
    assert await env.platform_revenue.count_documents({"source": "cashout_fee"}) == 1


@pytest.mark.asyncio
async def test_below_minimum_rejected(env, monkeypatch):
    monkeypatch.setattr(payments, "stripe", _FakeStripe(_account()))
    env.users.docs = [_user(50.0)]
    with pytest.raises(Exception) as ei:
        await payments.cashout_to_card(payments.CashoutBody(amount=MIN - 1), _auth_user=_user(50.0))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_no_debit_card_rejected(env, monkeypatch):
    monkeypatch.setattr(payments, "stripe", _FakeStripe(_account(card=False)))
    env.users.docs = [_user(50.0)]
    with pytest.raises(Exception) as ei:
        await payments.cashout_to_card(payments.CashoutBody(amount=20.0), _auth_user=_user(50.0))
    assert ei.value.status_code == 400
    assert await _bal(env) == 50.0   # nothing debited


@pytest.mark.asyncio
async def test_stripe_failure_refunds_wallet(env, monkeypatch):
    monkeypatch.setattr(payments, "stripe", _FakeStripe(_account(), fail_payout=True))
    env.users.docs = [_user(50.0)]
    with pytest.raises(Exception) as ei:
        await payments.cashout_to_card(payments.CashoutBody(amount=20.0), _auth_user=_user(50.0))
    assert ei.value.status_code == 400
    # The wallet must be made whole after a failed payout.
    assert await _bal(env) == 50.0
    assert await env.payouts.count_documents({}) == 0


@pytest.mark.asyncio
async def test_insufficient_balance_rejected(env, monkeypatch):
    monkeypatch.setattr(payments, "stripe", _FakeStripe(_account()))
    env.users.docs = [_user(10.0)]   # below the 20 they try to cash out
    with pytest.raises(Exception) as ei:
        await payments.cashout_to_card(payments.CashoutBody(amount=20.0), _auth_user=_user(10.0))
    assert ei.value.status_code == 400
    assert await _bal(env) == 10.0
