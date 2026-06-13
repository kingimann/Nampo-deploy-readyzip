"""Unit tests for the money-integrity tripwire (routes.money.scan_money_anomalies)
and the alert helper it shares with the admin money endpoints.

These exercise the anomaly logic against a tiny in-memory fake `db` (no Postgres
required) so the three anomaly classes — negative balances, velocity spikes and
unbacked credits — and the dedupe behaviour are all locked in.
"""
from datetime import datetime, timezone, timedelta

import pytest

from routes import money


# ── Minimal in-memory MongoDB-compatible stand-in ───────────────────────────
def _match(doc: dict, filt: dict) -> bool:
    for key, cond in filt.items():
        val = doc.get(key)
        if isinstance(cond, dict):
            for op, target in cond.items():
                if op == "$lt" and not (val is not None and val < target):
                    return False
                if op == "$gte" and not (val is not None and val >= target):
                    return False
                if op == "$ne" and val == target:
                    return False
        elif val != cond:
            return False
    return True


class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    async def to_list(self, n):
        return list(self._rows[:n])


class _Coll:
    def __init__(self):
        self.docs = []

    def find(self, filt=None, proj=None):
        filt = filt or {}
        return _Cursor([d.copy() for d in self.docs if _match(d, filt)])

    async def find_one(self, filt=None, proj=None):
        filt = filt or {}
        for d in self.docs:
            if _match(d, filt):
                return d.copy()
        return None

    async def insert_one(self, doc):
        self.docs.append(doc.copy())


class _DB:
    def __init__(self):
        self._colls = {}

    def __getattr__(self, name):
        # __getattr__ only fires for missing attrs; lazily make a collection.
        coll = self.__dict__.setdefault("_colls", {}).get(name)
        if coll is None:
            coll = _Coll()
            self._colls[name] = coll
        return coll


@pytest.fixture
def fake_db(monkeypatch):
    db = _DB()
    monkeypatch.setattr(money, "db", db)
    return db


@pytest.mark.asyncio
async def test_flags_negative_balance(fake_db):
    fake_db.users.docs = [
        {"user_id": "a", "wallet_balance": -5.0},
        {"user_id": "b", "wallet_balance": 10.0},
    ]
    res = await money.scan_money_anomalies()
    assert res["flagged"] == 1
    alerts = fake_db.money_alerts.docs
    assert [a["kind"] for a in alerts] == ["negative_balance"]
    assert alerts[0]["user_id"] == "a" and alerts[0]["balance"] == -5.0


@pytest.mark.asyncio
async def test_negative_balance_deduped_across_runs(fake_db):
    fake_db.users.docs = [{"user_id": "a", "wallet_balance": -5.0}]
    await money.scan_money_anomalies()
    await money.scan_money_anomalies()   # second run must not re-flag
    assert sum(a["kind"] == "negative_balance" for a in fake_db.money_alerts.docs) == 1


@pytest.mark.asyncio
async def test_flags_velocity_spike(fake_db):
    now = datetime.now(timezone.utc)
    # One sender over the hourly cap, split across both transfer rails.
    fake_db.money_transfers.docs = [
        {"from_user_id": "spammer", "created_at": now} for _ in range(money.SEND_MAX_PER_HOUR)
    ]
    fake_db.stripe_transfers.docs = [
        {"from_user_id": "spammer", "created_at": now},     # tips it over the cap
        {"from_user_id": "calm", "created_at": now},
    ]
    res = await money.scan_money_anomalies()
    spikes = [a for a in fake_db.money_alerts.docs if a["kind"] == "velocity_spike"]
    assert len(spikes) == 1
    assert spikes[0]["user_id"] == "spammer"
    assert spikes[0]["count"] == money.SEND_MAX_PER_HOUR + 1


@pytest.mark.asyncio
async def test_velocity_ignores_old_transfers(fake_db):
    old = datetime.now(timezone.utc) - timedelta(hours=2)
    fake_db.money_transfers.docs = [
        {"from_user_id": "spammer", "created_at": old} for _ in range(money.SEND_MAX_PER_HOUR + 5)
    ]
    res = await money.scan_money_anomalies()
    assert not any(a["kind"] == "velocity_spike" for a in fake_db.money_alerts.docs)


@pytest.mark.asyncio
async def test_flags_unbacked_credit_but_not_admin(fake_db):
    fake_db.wallet_topups.docs = [
        {"id": "t1", "user_id": "u", "amount": 50.0, "status": "completed",
         "session_id": None, "source": "checkout"},     # no Stripe event → flag
        {"id": "t2", "user_id": "v", "amount": 20.0, "status": "completed",
         "session_id": None, "source": "admin"},         # manual admin credit → ignore
    ]
    res = await money.scan_money_anomalies()
    unbacked = [a for a in fake_db.money_alerts.docs if a["kind"] == "unbacked_credit"]
    assert len(unbacked) == 1
    assert unbacked[0]["ref_id"] == "t1" and unbacked[0]["amount"] == 50.0


@pytest.mark.asyncio
async def test_record_money_alert_dedupe_and_discrete(fake_db):
    # Deduped: a second unresolved alert of the same (kind, user) is suppressed.
    assert await money.record_money_alert("negative_balance", user_id="a", balance=-1) is True
    assert await money.record_money_alert("negative_balance", user_id="a", balance=-2) is False
    # Discrete (admin action): every occurrence is recorded.
    assert await money.record_money_alert("admin_money_action", user_id="a", dedupe=False, action="set_wallet") is True
    assert await money.record_money_alert("admin_money_action", user_id="a", dedupe=False, action="set_wallet") is True
    kinds = [a["kind"] for a in fake_db.money_alerts.docs]
    assert kinds.count("negative_balance") == 1
    assert kinds.count("admin_money_action") == 2
