"""Behavioural tests for marketplace offers / negotiation (routes.marketplace).

Buyer makes an offer; seller accepts / declines / counters; buyer accepts the
counter or withdraws. Pins the guards (own-listing, sold, validation,
ownership), the re-offer-updates-not-duplicates rule, single-winner state
transitions, and that accepting one offer declines the listing's others.
"""
import pytest

from routes import marketplace
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    monkeypatch.setattr(marketplace, "db", db)
    # _notify_offer swallows errors, but stub emit anyway to keep it quiet/fast.

    async def me_factory(uid):
        async def _get(_a):
            return {"user_id": uid, "name": uid.title()}
        return _get
    db.listings.docs = [{"id": "l1", "user_id": "seller", "title": "Bike", "status": "active"}]
    return db, monkeypatch


def _as(monkeypatch, uid):
    async def _get(_a):
        return {"user_id": uid, "name": uid.title()}
    monkeypatch.setattr(marketplace, "get_current_user", _get)


@pytest.mark.asyncio
async def test_make_offer_and_seller_sees_it(env):
    db, mp = env
    _as(mp, "buyer")
    out = await marketplace.make_offer("l1", marketplace.OfferBody(amount=40, message="cash today"))
    assert out["status"] == "pending" and out["amount"] == 40.0 and out["role"] == "buyer"
    # Seller sees it on the listing.
    _as(mp, "seller")
    lst = await marketplace.listing_offers("l1")
    assert len(lst["offers"]) == 1 and lst["offers"][0]["role"] == "seller"


@pytest.mark.asyncio
async def test_cannot_offer_on_own_listing(env):
    db, mp = env
    _as(mp, "seller")
    with pytest.raises(Exception) as ei:
        await marketplace.make_offer("l1", marketplace.OfferBody(amount=40))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_cannot_offer_on_sold_listing(env):
    db, mp = env
    db.listings.docs[0]["status"] = "sold"
    _as(mp, "buyer")
    with pytest.raises(Exception) as ei:
        await marketplace.make_offer("l1", marketplace.OfferBody(amount=40))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_invalid_amount_rejected(env):
    db, mp = env
    _as(mp, "buyer")
    with pytest.raises(Exception) as ei:
        await marketplace.make_offer("l1", marketplace.OfferBody(amount=0))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_reoffer_updates_not_duplicates(env):
    db, mp = env
    _as(mp, "buyer")
    await marketplace.make_offer("l1", marketplace.OfferBody(amount=40))
    out = await marketplace.make_offer("l1", marketplace.OfferBody(amount=45))
    assert out["amount"] == 45.0
    assert await db.marketplace_offers.count_documents({"listing_id": "l1", "buyer_id": "buyer"}) == 1


@pytest.mark.asyncio
async def test_accept_declines_other_open_offers(env):
    db, mp = env
    _as(mp, "buyer")
    o1 = await marketplace.make_offer("l1", marketplace.OfferBody(amount=40))
    _as(mp, "buyer2")
    o2 = await marketplace.make_offer("l1", marketplace.OfferBody(amount=42))
    _as(mp, "seller")
    await marketplace.accept_offer(o1["id"])
    rows = {r["id"]: r["status"] for r in db.marketplace_offers.docs}
    assert rows[o1["id"]] == "accepted"
    assert rows[o2["id"]] == "declined"


@pytest.mark.asyncio
async def test_only_seller_can_accept(env):
    db, mp = env
    _as(mp, "buyer")
    o = await marketplace.make_offer("l1", marketplace.OfferBody(amount=40))
    # Buyer can't accept their own offer.
    with pytest.raises(Exception) as ei:
        await marketplace.accept_offer(o["id"])
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_counter_then_buyer_accepts(env):
    db, mp = env
    _as(mp, "buyer")
    o = await marketplace.make_offer("l1", marketplace.OfferBody(amount=40))
    _as(mp, "seller")
    c = await marketplace.counter_offer(o["id"], marketplace.CounterBody(amount=48))
    assert c["status"] == "countered" and c["counter_amount"] == 48.0
    _as(mp, "buyer")
    acc = await marketplace.accept_counter(o["id"])
    assert acc["status"] == "accepted" and acc["amount"] == 48.0


@pytest.mark.asyncio
async def test_withdraw(env):
    db, mp = env
    _as(mp, "buyer")
    o = await marketplace.make_offer("l1", marketplace.OfferBody(amount=40))
    out = await marketplace.withdraw_offer(o["id"])
    assert out["status"] == "withdrawn"


@pytest.mark.asyncio
async def test_my_offers_split_made_received(env):
    db, mp = env
    _as(mp, "buyer")
    await marketplace.make_offer("l1", marketplace.OfferBody(amount=40))
    mine = await marketplace.my_offers()
    assert len(mine["made"]) == 1 and len(mine["received"]) == 0
    _as(mp, "seller")
    theirs = await marketplace.my_offers()
    assert len(theirs["received"]) == 1 and len(theirs["made"]) == 0
