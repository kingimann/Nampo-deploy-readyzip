"""Behavioural tests for place reviews (routes.reviews).

Pins: rating is bounded 1..5 and coordinates to valid ranges at the model
boundary (422 otherwise); a review is one-per-user-per-place
(re-posting updates in place via upsert, never duplicates); list is filtered by
place_key; delete is owner-scoped (404 otherwise).
"""
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

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


def test_rating_must_be_in_range():
    # Bounds are enforced at the model boundary (HTTP 422), not in the handler.
    for bad in (0, 6, -1):
        with pytest.raises(ValidationError):
            _body(rating=bad)


def test_coordinates_must_be_in_range():
    with pytest.raises(ValidationError):
        ReviewCreate(place_key="p", place_name="x", longitude=200.0, latitude=2.0, rating=5)
    with pytest.raises(ValidationError):
        ReviewCreate(place_key="p", place_name="x", longitude=2.0, latitude=-91.0, rating=5)


@pytest.mark.asyncio
async def test_summary_aggregates_ratings(env):
    await reviews.create_review(_body(rating=5, place="pk1"))
    # A second user's review of the same place (inserted directly).
    await env.reviews.insert_one(
        {"id": "r2", "user_id": "u2", "place_key": "pk1", "rating": 3, "created_at": None})
    out = await reviews.review_summary(place_key="pk1")
    assert out.count == 2
    assert out.average == 4.0
    assert out.distribution == {"1": 0, "2": 0, "3": 1, "4": 0, "5": 1}


@pytest.mark.asyncio
async def test_nearby_ranks_by_rating_within_radius(env):
    # Two places near (lng=0, lat=0); one far away.
    env.reviews.docs = [
        {"id": "a1", "user_id": "u1", "place_key": "near-hi", "place_name": "Hi",
         "longitude": 0.001, "latitude": 0.001, "rating": 5, "created_at": None},
        {"id": "a2", "user_id": "u2", "place_key": "near-hi", "place_name": "Hi",
         "longitude": 0.001, "latitude": 0.001, "rating": 4, "created_at": None},
        {"id": "b1", "user_id": "u1", "place_key": "near-lo", "place_name": "Lo",
         "longitude": 0.002, "latitude": 0.002, "rating": 2, "created_at": None},
        {"id": "c1", "user_id": "u1", "place_key": "far", "place_name": "Far",
         "longitude": 50.0, "latitude": 50.0, "rating": 5, "created_at": None},
    ]
    out = await reviews.reviews_nearby(lat=0.0, lng=0.0, radius_km=5.0, limit=50)
    keys = [p.place_key for p in out]
    assert "far" not in keys              # outside the radius
    assert keys == ["near-hi", "near-lo"]  # higher average first
    assert out[0].count == 2 and out[0].average == 4.5


@pytest.mark.asyncio
async def test_summary_empty_place(env):
    out = await reviews.review_summary(place_key="nope")
    assert out.count == 0 and out.average == 0.0
    assert out.distribution == {"1": 0, "2": 0, "3": 0, "4": 0, "5": 0}


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
