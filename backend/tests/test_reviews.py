"""Behavioural tests for place reviews (routes.reviews).

Pins: rating is bounded 1..5 (400 otherwise); a review is one-per-user-per-place
(re-posting updates in place via upsert, never duplicates); list is filtered by
place_key; delete is owner-scoped (404 otherwise).
"""
import pytest
from fastapi import HTTPException

from routes import reviews
from models import ReviewCreate
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "me", "name": "Me"}

    monkeypatch.setattr(reviews, "db", db)
    monkeypatch.setattr(reviews, "get_current_user", fake_user)
    return db


def _body(rating=5, text="great", place="pk1"):
    return ReviewCreate(place_key=place, place_name="Cafe", longitude=1.0, latitude=2.0,
                        rating=rating, text=text)


@pytest.mark.asyncio
async def test_rating_must_be_in_range(env):
    with pytest.raises(HTTPException) as ei:
        await reviews.create_review(_body(rating=6))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_create_then_update_in_place(env):
    out1 = await reviews.create_review(_body(rating=4, text="ok"))
    out2 = await reviews.create_review(_body(rating=2, text="changed my mind"))
    # Same (user, place) → updated, not duplicated.
    assert out1.id == out2.id
    assert out2.rating == 2 and out2.text == "changed my mind"
    assert await env.reviews.count_documents({"user_id": "me", "place_key": "pk1"}) == 1


@pytest.mark.asyncio
async def test_list_filters_by_place(env):
    await reviews.create_review(_body(place="pk1"))
    await reviews.create_review(_body(place="pk2"))
    out = await reviews.list_reviews_for_place(place_key="pk1")
    assert len(out) == 1 and out[0].place_key == "pk1"


@pytest.mark.asyncio
async def test_delete_owner_scoped(env):
    env.reviews.docs = [{"id": "r1", "user_id": "other", "place_key": "pk1",
                         "rating": 5, "created_at": None}]
    with pytest.raises(HTTPException) as ei:
        await reviews.delete_review("r1")
    assert ei.value.status_code == 404
