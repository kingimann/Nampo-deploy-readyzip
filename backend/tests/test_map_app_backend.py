"""Backend tests for Mapbox Map App (Emergent Google OAuth).

Covers:
  * Public health endpoint
  * Invalid session_id rejection on POST /api/auth/session
  * 401 on protected endpoints without Bearer token
  * 401 on protected endpoints with invalid Bearer token
  * CORS configuration (`*` origins)
  * MongoDB indexes were created on startup
  * Full auth + Places CRUD path with MOCKED Emergent session-data endpoint
    (direct DB seeding of session + user to simulate post-OAuth state)
  * Second /api/auth/session for the same email upserts instead of duplicating
    (direct DB-level check)
"""
import os
import uuid
from datetime import datetime, timezone, timedelta

import pytest
import requests
from pymongo import MongoClient


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BASE_URL = os.environ.get(
    "EXPO_BACKEND_URL",
    "https://location-hub-312.preview.emergentagent.com",
).rstrip("/")

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def mongo_db():
    client = MongoClient(MONGO_URL)
    db = client[DB_NAME]
    yield db
    client.close()


@pytest.fixture()
def seeded_session(mongo_db):
    """Seed a fake user + session row directly in Mongo to mimic post-OAuth state.

    This avoids needing the real Emergent session_id while still validating
    the `get_current_user` middleware path on all protected routes.
    """
    suffix = uuid.uuid4().hex[:8]
    user_id = f"user_TEST_{suffix}"
    email = f"TEST_{suffix}@example.com"
    session_token = f"TESTTOKEN_{uuid.uuid4().hex}"

    mongo_db.users.insert_one(
        {
            "user_id": user_id,
            "email": email,
            "name": "Test User",
            "picture": None,
            "created_at": datetime.now(timezone.utc),
        }
    )
    mongo_db.user_sessions.insert_one(
        {
            "session_token": session_token,
            "user_id": user_id,
            "expires_at": datetime.now(timezone.utc) + timedelta(days=1),
            "created_at": datetime.now(timezone.utc),
        }
    )

    yield {"user_id": user_id, "email": email, "session_token": session_token}

    # Cleanup
    mongo_db.user_sessions.delete_many({"user_id": user_id})
    mongo_db.users.delete_one({"user_id": user_id})
    mongo_db.places.delete_many({"user_id": user_id})


# ---------------------------------------------------------------------------
# 1. Health check
# ---------------------------------------------------------------------------
class TestHealth:
    def test_root_returns_message(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/")
        assert r.status_code == 200, r.text
        assert r.json() == {"message": "Map App API"}


# ---------------------------------------------------------------------------
# 2. Auth session – invalid session_id
# ---------------------------------------------------------------------------
class TestAuthSessionInvalid:
    def test_invalid_session_id_returns_401(self, api_client):
        bogus = f"invalid-session-{uuid.uuid4().hex}"
        r = api_client.post(
            f"{BASE_URL}/api/auth/session", json={"session_id": bogus}
        )
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text}"
        body = r.json()
        assert "detail" in body
        assert "invalid" in body["detail"].lower() or "session" in body["detail"].lower()

    def test_missing_session_id_body_returns_422(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/session", json={})
        # Pydantic validation should reject (422). Anything < 500 acceptable.
        assert r.status_code in (400, 422), r.text


# ---------------------------------------------------------------------------
# 3. Protected endpoints without Bearer
# ---------------------------------------------------------------------------
class TestUnauthenticated:
    def test_me_without_token_401(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/auth/me")
        assert r.status_code == 401, r.text

    def test_list_places_without_token_401(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/places")
        assert r.status_code == 401, r.text

    def test_create_place_without_token_401(self, api_client):
        r = api_client.post(
            f"{BASE_URL}/api/places",
            json={
                "title": "Nope",
                "longitude": 12.34,
                "latitude": 56.78,
            },
        )
        assert r.status_code == 401, r.text

    def test_delete_place_without_token_401(self, api_client):
        r = api_client.delete(f"{BASE_URL}/api/places/{uuid.uuid4()}")
        assert r.status_code == 401, r.text

    def test_invalid_bearer_token_401(self, api_client):
        r = api_client.get(
            f"{BASE_URL}/api/auth/me",
            headers={"Authorization": "Bearer not-a-real-token-xyz"},
        )
        assert r.status_code == 401, r.text

    def test_malformed_authorization_header_401(self, api_client):
        r = api_client.get(
            f"{BASE_URL}/api/auth/me",
            headers={"Authorization": "Basic foo"},
        )
        assert r.status_code == 401, r.text


# ---------------------------------------------------------------------------
# 4. CORS
# ---------------------------------------------------------------------------
class TestCORS:
    def test_cors_allows_any_origin(self, api_client):
        origin = "https://random-origin.example.com"
        r = api_client.get(
            f"{BASE_URL}/api/", headers={"Origin": origin}
        )
        assert r.status_code == 200
        # starlette CORS echoes the origin (or "*") in the header.
        aco = r.headers.get("access-control-allow-origin")
        assert aco in (origin, "*"), f"Unexpected ACAO: {aco!r}"

    def test_cors_preflight(self, api_client):
        r = api_client.options(
            f"{BASE_URL}/api/places",
            headers={
                "Origin": "https://example.com",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Authorization,Content-Type",
            },
        )
        assert r.status_code in (200, 204), r.text
        assert r.headers.get("access-control-allow-origin") in (
            "https://example.com",
            "*",
        )


# ---------------------------------------------------------------------------
# 5. MongoDB indexes created on startup
# ---------------------------------------------------------------------------
class TestMongoIndexes:
    def test_users_email_unique_index(self, mongo_db):
        idx = mongo_db.users.index_information()
        assert "email_1" in idx, idx
        assert idx["email_1"].get("unique") is True

    def test_users_user_id_unique_index(self, mongo_db):
        idx = mongo_db.users.index_information()
        assert "user_id_1" in idx, idx
        assert idx["user_id_1"].get("unique") is True

    def test_user_sessions_session_token_unique(self, mongo_db):
        idx = mongo_db.user_sessions.index_information()
        assert "session_token_1" in idx, idx
        assert idx["session_token_1"].get("unique") is True

    def test_user_sessions_ttl_index(self, mongo_db):
        idx = mongo_db.user_sessions.index_information()
        assert "expires_at_1" in idx, idx
        assert idx["expires_at_1"].get("expireAfterSeconds") == 0

    def test_places_user_id_index(self, mongo_db):
        idx = mongo_db.places.index_information()
        assert "user_id_1" in idx, idx


# ---------------------------------------------------------------------------
# 6. Authenticated flows using a seeded session (post-OAuth simulation)
# ---------------------------------------------------------------------------
class TestAuthenticatedFlows:
    def test_me_with_valid_seeded_token(self, api_client, seeded_session):
        r = api_client.get(
            f"{BASE_URL}/api/auth/me",
            headers={"Authorization": f"Bearer {seeded_session['session_token']}"},
        )
        assert r.status_code == 200, r.text
        u = r.json()
        assert u["user_id"] == seeded_session["user_id"]
        assert u["email"] == seeded_session["email"]
        assert u["name"] == "Test User"

    def test_places_crud_with_seeded_token(self, api_client, seeded_session):
        h = {"Authorization": f"Bearer {seeded_session['session_token']}"}

        # initially empty
        r = api_client.get(f"{BASE_URL}/api/places", headers=h)
        assert r.status_code == 200
        assert r.json() == []

        # create
        payload = {
            "title": "TEST_Eiffel",
            "notes": "Trip",
            "longitude": 2.2945,
            "latitude": 48.8584,
            "address": "Paris, France",
            "category": "favorite",
        }
        r = api_client.post(f"{BASE_URL}/api/places", json=payload, headers=h)
        assert r.status_code == 200, r.text
        place = r.json()
        assert place["title"] == "TEST_Eiffel"
        assert place["category"] == "favorite"
        assert place["user_id"] == seeded_session["user_id"]
        assert "_id" not in place
        place_id = place["id"]
        assert place_id

        # list returns it
        r = api_client.get(f"{BASE_URL}/api/places", headers=h)
        assert r.status_code == 200
        ids = [p["id"] for p in r.json()]
        assert place_id in ids
        for p in r.json():
            assert "_id" not in p  # mongo _id must be excluded

        # delete
        r = api_client.delete(f"{BASE_URL}/api/places/{place_id}", headers=h)
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": True}

        # second delete -> 404
        r = api_client.delete(f"{BASE_URL}/api/places/{place_id}", headers=h)
        assert r.status_code == 404, r.text

    def test_user_cannot_delete_other_users_place(
        self, api_client, mongo_db, seeded_session
    ):
        # Insert a place owned by some other user directly
        other_place_id = str(uuid.uuid4())
        mongo_db.places.insert_one(
            {
                "id": other_place_id,
                "user_id": "user_TEST_other",
                "title": "TEST_other",
                "notes": "",
                "longitude": 0.0,
                "latitude": 0.0,
                "address": "",
                "category": "marker",
                "created_at": datetime.now(timezone.utc),
            }
        )
        try:
            r = api_client.delete(
                f"{BASE_URL}/api/places/{other_place_id}",
                headers={
                    "Authorization": f"Bearer {seeded_session['session_token']}"
                },
            )
            assert r.status_code == 404, r.text  # scoped by user_id
        finally:
            mongo_db.places.delete_one({"id": other_place_id})

    def test_logout_invalidates_session(self, api_client, mongo_db, seeded_session):
        token = seeded_session["session_token"]
        h = {"Authorization": f"Bearer {token}"}

        r = api_client.post(f"{BASE_URL}/api/auth/logout", headers=h)
        assert r.status_code == 200

        # Session row should be gone
        assert mongo_db.user_sessions.find_one({"session_token": token}) is None

        # Subsequent /me should now 401
        r = api_client.get(f"{BASE_URL}/api/auth/me", headers=h)
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# 7. Expired session is rejected
# ---------------------------------------------------------------------------
class TestExpiredSession:
    def test_expired_session_returns_401(self, api_client, mongo_db):
        suffix = uuid.uuid4().hex[:8]
        user_id = f"user_TEST_exp_{suffix}"
        email = f"TEST_exp_{suffix}@example.com"
        token = f"TESTEXPIRED_{uuid.uuid4().hex}"
        mongo_db.users.insert_one(
            {
                "user_id": user_id,
                "email": email,
                "name": "Expired",
                "picture": None,
                "created_at": datetime.now(timezone.utc),
            }
        )
        mongo_db.user_sessions.insert_one(
            {
                "session_token": token,
                "user_id": user_id,
                "expires_at": datetime.now(timezone.utc) - timedelta(days=1),
                "created_at": datetime.now(timezone.utc) - timedelta(days=8),
            }
        )
        try:
            r = api_client.get(
                f"{BASE_URL}/api/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert r.status_code == 401, r.text
            # Server should also delete the expired session row.
            assert mongo_db.user_sessions.find_one({"session_token": token}) is None
        finally:
            mongo_db.user_sessions.delete_many({"user_id": user_id})
            mongo_db.users.delete_one({"user_id": user_id})


# ---------------------------------------------------------------------------
# 8. Upsert behavior on /api/auth/session (DB-level)
# ---------------------------------------------------------------------------
class TestUserUpsertDBLevel:
    """We can't hit the real Emergent endpoint with a fake session_id, but we
    can verify the unique-email index prevents duplicate users (which is the
    actual contract `create_session` relies on for upsert semantics)."""

    def test_duplicate_email_insert_rejected_by_unique_index(self, mongo_db):
        email = f"TEST_dup_{uuid.uuid4().hex[:8]}@example.com"
        u1 = {
            "user_id": f"user_TEST_{uuid.uuid4().hex[:8]}",
            "email": email,
            "name": "A",
            "picture": None,
            "created_at": datetime.now(timezone.utc),
        }
        mongo_db.users.insert_one(u1)
        try:
            from pymongo.errors import DuplicateKeyError

            with pytest.raises(DuplicateKeyError):
                mongo_db.users.insert_one(
                    {
                        "user_id": f"user_TEST_{uuid.uuid4().hex[:8]}",
                        "email": email,  # same email
                        "name": "B",
                        "picture": None,
                        "created_at": datetime.now(timezone.utc),
                    }
                )
        finally:
            mongo_db.users.delete_many({"email": email})
