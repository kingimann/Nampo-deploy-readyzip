"""A credited wallet top-up should notify the user (in-app + push, and a
`wallet_topup` developer webhook via emit_notification's fan-out). These pin
that _apply_wallet_topup fires exactly one notification on a real credit and
none when there's nothing to credit — without a live database or Stripe.
"""
import pytest

from routes import money


class _Coll:
    async def insert_one(self, doc):
        return None

    async def find_one(self, *a, **k):
        return None


class _DB:
    def __getattr__(self, name):
        return _Coll()


@pytest.fixture
def captured_notifications(monkeypatch):
    calls = []

    async def fake_notify(to_id, actor_id, ntype, message):
        calls.append((to_id, actor_id, ntype, message))

    async def noop_credit(uid, amount):
        return None

    async def noop_event(*a, **k):
        return None

    monkeypatch.setattr(money, "_notify_money", fake_notify)
    monkeypatch.setattr(money, "_credit_wallet", noop_credit)
    monkeypatch.setattr(money, "record_money_event", noop_event)
    monkeypatch.setattr(money, "db", _DB())
    return calls


@pytest.mark.asyncio
async def test_topup_credit_notifies_user(captured_notifications):
    ok = await money._apply_wallet_topup("u1", 25.0, "stripe", None)
    assert ok is True
    assert captured_notifications == [
        ("u1", None, "wallet_topup", "$25.00 added to your wallet"),
    ]


@pytest.mark.asyncio
async def test_topup_zero_amount_does_not_notify(captured_notifications):
    ok = await money._apply_wallet_topup("u1", 0, "stripe", None)
    assert ok is False
    assert captured_notifications == []
