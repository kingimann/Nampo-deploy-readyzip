"""Backend tests for new Apple-Maps-style endpoints:
  * GET /api/places/{id} (own vs other-user 404)
  * /api/recents CRUD: list (max 20, recent-first), POST dedupe + 20-cap,
    DELETE one (404 for non-owner), DELETE all
  * /api/guides CRUD: list, create (empty place_ids), delete (404 for non-owner)
  * /api/guides/{guide_id}/places/{place_id} add (idempotent via $addToSet),
    404 for missing/unowned guide or place, remove via $pull
  * DELETE /api/places/{id} cascades into guides.place_ids ($pull)
  * MongoDB indexes recents.user_id and guides.user_id

Auth is simulated by directly seeding a user + session row in Mongo,
matching the pattern used in test_map_app_backend.py. The Emergent OAuth
session-data endpoint is NOT touched here (it is MOCKED in
test_auth_session_mocked.py).
"""
import os
import uuid
from datetime import datetime, timezone, timedelta

import pytest
import requests
from pymongo import MongoClient


BASE_URL = os.environ.get(
    "EXPO_BACKEND_URL",
    "https://location-hub-312.preview.emergentagent.com",
).rstrip("/")

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def mongo_db():
    c = MongoClient(MONGO_URL)
    db = c[DB_NAME]
    yield db
    c.close()


@pytest.fixture()
def seeded_user(mongo_db):
    """Seed user + session, cleanup recents/guides/places afterwards."""
    suffix = uuid.uuid4().hex[:8]
    user_id = f"user_TEST_{suffix}"
    email = f"TEST_rg_{suffix}@example.com"
    token = f"TESTTOK_{uuid.uuid4().hex}"
    mongo_db.users.insert_one({
        "user_id": user_id,
        "email": email,
        "name": "RG Tester",
        "picture": None,
        "created_at": datetime.now(timezone.utc),
    })
    mongo_db.user_sessions.insert_one({
        "session_token": token,
        "user_id": user_id,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=1),
        "created_at": datetime.now(timezone.utc),
    })
    yield {"user_id": user_id, "email": email, "token": token,
           "h": {"Authorization": f"Bearer {token}"}}
    mongo_db.user_sessions.delete_many({"user_id": user_id})
    mongo_db.users.delete_one({"user_id": user_id})
    mongo_db.places.delete_many({"user_id": user_id})
    mongo_db.recents.delete_many({"user_id": user_id})
    mongo_db.guides.delete_many({"user_id": user_id})


# ---------------------------------------------------------------------------
# GET /api/places/{id}
# ---------------------------------------------------------------------------
class TestGetPlaceById:
    def test_get_own_place(self, api_client, seeded_user):
        h = seeded_user["h"]
        payload = {"title": "TEST_GP", "longitude": 1.0, "latitude": 2.0,
                   "address": "Somewhere", "category": "marker"}
        r = api_client.post(f"{BASE_URL}/api/places", json=payload, headers=h)
        assert r.status_code == 200, r.text
        pid = r.json()["id"]

        r2 = api_client.get(f"{BASE_URL}/api/places/{pid}", headers=h)
        assert r2.status_code == 200, r2.text
        body = r2.json()
        assert body["id"] == pid
        assert body["title"] == "TEST_GP"
        assert body["user_id"] == seeded_user["user_id"]
        assert "_id" not in body

    def test_get_other_users_place_returns_404(
        self, api_client, mongo_db, seeded_user
    ):
        other_id = str(uuid.uuid4())
        mongo_db.places.insert_one({
            "id": other_id, "user_id": "user_TEST_other_gp",
            "title": "TEST_other", "notes": "", "longitude": 0.0,
            "latitude": 0.0, "address": "", "category": "marker",
            "created_at": datetime.now(timezone.utc),
        })
        try:
            r = api_client.get(
                f"{BASE_URL}/api/places/{other_id}", headers=seeded_user["h"]
            )
            assert r.status_code == 404, r.text
        finally:
            mongo_db.places.delete_one({"id": other_id})

    def test_get_unknown_place_returns_404(self, api_client, seeded_user):
        r = api_client.get(
            f"{BASE_URL}/api/places/{uuid.uuid4()}", headers=seeded_user["h"]
        )
        assert r.status_code == 404

    def test_get_place_without_token_401(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/places/{uuid.uuid4()}")
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# /api/recents
# ---------------------------------------------------------------------------
class TestRecents:
    def test_empty_list(self, api_client, seeded_user):
        r = api_client.get(f"{BASE_URL}/api/recents", headers=seeded_user["h"])
        assert r.status_code == 200
        assert r.json() == []

    def test_create_and_list_recent_most_recent_first(
        self, api_client, seeded_user
    ):
        h = seeded_user["h"]
        for i, name in enumerate(["TEST_A", "TEST_B", "TEST_C"]):
            r = api_client.post(
                f"{BASE_URL}/api/recents",
                json={"name": name, "full_address": f"addr-{i}",
                      "longitude": 10.0 + i, "latitude": 20.0 + i},
                headers=h,
            )
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["name"] == name
            assert body["user_id"] == seeded_user["user_id"]
            assert "_id" not in body
        r = api_client.get(f"{BASE_URL}/api/recents", headers=h)
        assert r.status_code == 200
        names = [x["name"] for x in r.json()]
        assert names[:3] == ["TEST_C", "TEST_B", "TEST_A"], names

    def test_dedupe_by_name_and_rounded_coords(
        self, api_client, mongo_db, seeded_user
    ):
        h = seeded_user["h"]
        payload = {"name": "TEST_DUP", "full_address": "x",
                   "longitude": 10.12345, "latitude": 20.98765}
        r1 = api_client.post(f"{BASE_URL}/api/recents", json=payload, headers=h)
        assert r1.status_code == 200
        # Within 1e-4 of original coords → must dedupe (delete prior, insert new)
        payload2 = dict(payload, longitude=10.12346, latitude=20.98764)
        r2 = api_client.post(f"{BASE_URL}/api/recents", json=payload2, headers=h)
        assert r2.status_code == 200
        assert r2.json()["id"] != r1.json()["id"]

        cnt = mongo_db.recents.count_documents({
            "user_id": seeded_user["user_id"], "name": "TEST_DUP"
        })
        assert cnt == 1, f"Expected dedupe, got {cnt} rows"

    def test_cap_at_20(self, api_client, mongo_db, seeded_user):
        h = seeded_user["h"]
        for i in range(25):
            r = api_client.post(
                f"{BASE_URL}/api/recents",
                json={"name": f"TEST_CAP_{i}", "full_address": "",
                      "longitude": float(i), "latitude": float(i)},
                headers=h,
            )
            assert r.status_code == 200
        total = mongo_db.recents.count_documents({
            "user_id": seeded_user["user_id"]
        })
        assert total == 20, f"Expected cap of 20, got {total}"
        r = api_client.get(f"{BASE_URL}/api/recents", headers=h)
        assert r.status_code == 200
        assert len(r.json()) == 20
        # Most recent first → TEST_CAP_24 at top
        assert r.json()[0]["name"] == "TEST_CAP_24"
        # Oldest 5 (0..4) dropped
        listed = {x["name"] for x in r.json()}
        for i in range(5):
            assert f"TEST_CAP_{i}" not in listed

    def test_delete_recent(self, api_client, seeded_user):
        h = seeded_user["h"]
        r = api_client.post(
            f"{BASE_URL}/api/recents",
            json={"name": "TEST_DEL", "longitude": 1.1, "latitude": 2.2},
            headers=h,
        )
        rid = r.json()["id"]
        r2 = api_client.delete(f"{BASE_URL}/api/recents/{rid}", headers=h)
        assert r2.status_code == 200
        assert r2.json() == {"ok": True}
        r3 = api_client.delete(f"{BASE_URL}/api/recents/{rid}", headers=h)
        assert r3.status_code == 404

    def test_delete_other_users_recent_returns_404(
        self, api_client, mongo_db, seeded_user
    ):
        other_id = str(uuid.uuid4())
        mongo_db.recents.insert_one({
            "id": other_id, "user_id": "user_TEST_other_rec",
            "name": "TEST_other", "full_address": "",
            "longitude": 0.0, "latitude": 0.0,
            "created_at": datetime.now(timezone.utc),
        })
        try:
            r = api_client.delete(
                f"{BASE_URL}/api/recents/{other_id}", headers=seeded_user["h"]
            )
            assert r.status_code == 404
            # Other user's row must still exist
            assert mongo_db.recents.find_one({"id": other_id}) is not None
        finally:
            mongo_db.recents.delete_one({"id": other_id})

    def test_clear_all_recents(self, api_client, mongo_db, seeded_user):
        h = seeded_user["h"]
        for i in range(3):
            api_client.post(
                f"{BASE_URL}/api/recents",
                json={"name": f"TEST_CLR_{i}", "longitude": float(i),
                      "latitude": float(i)},
                headers=h,
            )
        r = api_client.delete(f"{BASE_URL}/api/recents", headers=h)
        assert r.status_code == 200
        assert r.json() == {"ok": True}
        assert mongo_db.recents.count_documents({
            "user_id": seeded_user["user_id"]
        }) == 0

    def test_recents_endpoints_require_auth(self, api_client):
        assert api_client.get(f"{BASE_URL}/api/recents").status_code == 401
        assert api_client.post(
            f"{BASE_URL}/api/recents",
            json={"name": "x", "longitude": 0, "latitude": 0},
        ).status_code == 401
        assert api_client.delete(f"{BASE_URL}/api/recents").status_code == 401
        assert api_client.delete(
            f"{BASE_URL}/api/recents/{uuid.uuid4()}"
        ).status_code == 401


# ---------------------------------------------------------------------------
# /api/guides
# ---------------------------------------------------------------------------
class TestGuides:
    def test_create_and_list_guides(self, api_client, seeded_user):
        h = seeded_user["h"]
        r = api_client.get(f"{BASE_URL}/api/guides", headers=h)
        assert r.status_code == 200
        assert r.json() == []

        r2 = api_client.post(
            f"{BASE_URL}/api/guides",
            json={"name": "TEST_Trips", "color": "#FF0000", "icon": "star"},
            headers=h,
        )
        assert r2.status_code == 200, r2.text
        g = r2.json()
        assert g["name"] == "TEST_Trips"
        assert g["color"] == "#FF0000"
        assert g["icon"] == "star"
        assert g["place_ids"] == []
        assert g["user_id"] == seeded_user["user_id"]
        assert "_id" not in g

        # Defaults applied when color/icon omitted
        r3 = api_client.post(
            f"{BASE_URL}/api/guides", json={"name": "TEST_Defaults"},
            headers=h,
        )
        assert r3.status_code == 200
        g3 = r3.json()
        assert g3["color"] == "#3B82F6"
        assert g3["icon"] == "bookmark"
        assert g3["place_ids"] == []

        r4 = api_client.get(f"{BASE_URL}/api/guides", headers=h)
        names = [x["name"] for x in r4.json()]
        assert "TEST_Trips" in names and "TEST_Defaults" in names

    def test_delete_guide(self, api_client, seeded_user):
        h = seeded_user["h"]
        gid = api_client.post(
            f"{BASE_URL}/api/guides", json={"name": "TEST_DelG"}, headers=h
        ).json()["id"]
        r = api_client.delete(f"{BASE_URL}/api/guides/{gid}", headers=h)
        assert r.status_code == 200
        r2 = api_client.delete(f"{BASE_URL}/api/guides/{gid}", headers=h)
        assert r2.status_code == 404

    def test_delete_other_users_guide_404(
        self, api_client, mongo_db, seeded_user
    ):
        other_id = str(uuid.uuid4())
        mongo_db.guides.insert_one({
            "id": other_id, "user_id": "user_TEST_other_g",
            "name": "TEST_other", "color": "#000", "icon": "x",
            "place_ids": [], "created_at": datetime.now(timezone.utc),
        })
        try:
            r = api_client.delete(
                f"{BASE_URL}/api/guides/{other_id}", headers=seeded_user["h"]
            )
            assert r.status_code == 404
            assert mongo_db.guides.find_one({"id": other_id}) is not None
        finally:
            mongo_db.guides.delete_one({"id": other_id})

    def test_add_place_to_guide_idempotent(self, api_client, seeded_user):
        h = seeded_user["h"]
        gid = api_client.post(
            f"{BASE_URL}/api/guides", json={"name": "TEST_AddG"}, headers=h
        ).json()["id"]
        pid = api_client.post(
            f"{BASE_URL}/api/places",
            json={"title": "TEST_P_for_guide", "longitude": 1.0,
                  "latitude": 2.0},
            headers=h,
        ).json()["id"]

        r = api_client.post(
            f"{BASE_URL}/api/guides/{gid}/places/{pid}", headers=h
        )
        assert r.status_code == 200, r.text
        assert pid in r.json()["place_ids"]

        # Idempotency: adding the same place again -> still single entry
        r2 = api_client.post(
            f"{BASE_URL}/api/guides/{gid}/places/{pid}", headers=h
        )
        assert r2.status_code == 200
        assert r2.json()["place_ids"].count(pid) == 1

    def test_add_place_to_guide_404_missing_guide(
        self, api_client, seeded_user
    ):
        h = seeded_user["h"]
        pid = api_client.post(
            f"{BASE_URL}/api/places",
            json={"title": "TEST_P_only", "longitude": 0.0, "latitude": 0.0},
            headers=h,
        ).json()["id"]
        r = api_client.post(
            f"{BASE_URL}/api/guides/{uuid.uuid4()}/places/{pid}", headers=h
        )
        assert r.status_code == 404

    def test_add_place_to_guide_404_missing_place(
        self, api_client, seeded_user
    ):
        h = seeded_user["h"]
        gid = api_client.post(
            f"{BASE_URL}/api/guides", json={"name": "TEST_AddG2"}, headers=h
        ).json()["id"]
        r = api_client.post(
            f"{BASE_URL}/api/guides/{gid}/places/{uuid.uuid4()}", headers=h
        )
        assert r.status_code == 404

    def test_add_other_users_place_to_own_guide_404(
        self, api_client, mongo_db, seeded_user
    ):
        h = seeded_user["h"]
        gid = api_client.post(
            f"{BASE_URL}/api/guides", json={"name": "TEST_AddG3"}, headers=h
        ).json()["id"]
        other_pid = str(uuid.uuid4())
        mongo_db.places.insert_one({
            "id": other_pid, "user_id": "user_TEST_otherp",
            "title": "TEST_other", "notes": "", "longitude": 0.0,
            "latitude": 0.0, "address": "", "category": "marker",
            "created_at": datetime.now(timezone.utc),
        })
        try:
            r = api_client.post(
                f"{BASE_URL}/api/guides/{gid}/places/{other_pid}", headers=h
            )
            assert r.status_code == 404
        finally:
            mongo_db.places.delete_one({"id": other_pid})

    def test_remove_place_from_guide(self, api_client, seeded_user):
        h = seeded_user["h"]
        gid = api_client.post(
            f"{BASE_URL}/api/guides", json={"name": "TEST_RmG"}, headers=h
        ).json()["id"]
        pid = api_client.post(
            f"{BASE_URL}/api/places",
            json={"title": "TEST_RmP", "longitude": 5.0, "latitude": 6.0},
            headers=h,
        ).json()["id"]
        api_client.post(
            f"{BASE_URL}/api/guides/{gid}/places/{pid}", headers=h
        )
        r = api_client.delete(
            f"{BASE_URL}/api/guides/{gid}/places/{pid}", headers=h
        )
        assert r.status_code == 200
        assert pid not in r.json()["place_ids"]
        # Removing again is still 200 (pull is no-op on missing element,
        # guide still exists)
        r2 = api_client.delete(
            f"{BASE_URL}/api/guides/{gid}/places/{pid}", headers=h
        )
        assert r2.status_code == 200

    def test_remove_place_from_missing_guide_404(
        self, api_client, seeded_user
    ):
        r = api_client.delete(
            f"{BASE_URL}/api/guides/{uuid.uuid4()}/places/{uuid.uuid4()}",
            headers=seeded_user["h"],
        )
        assert r.status_code == 404

    def test_guides_require_auth(self, api_client):
        assert api_client.get(f"{BASE_URL}/api/guides").status_code == 401
        assert api_client.post(
            f"{BASE_URL}/api/guides", json={"name": "x"}
        ).status_code == 401


# ---------------------------------------------------------------------------
# Place delete cascades into guides.place_ids
# ---------------------------------------------------------------------------
class TestPlaceDeleteCascade:
    def test_deleting_place_pulls_id_from_all_guides(
        self, api_client, mongo_db, seeded_user
    ):
        h = seeded_user["h"]
        pid = api_client.post(
            f"{BASE_URL}/api/places",
            json={"title": "TEST_CascadeP", "longitude": 1.0, "latitude": 2.0},
            headers=h,
        ).json()["id"]
        g1 = api_client.post(
            f"{BASE_URL}/api/guides", json={"name": "TEST_Casc1"}, headers=h
        ).json()
        g2 = api_client.post(
            f"{BASE_URL}/api/guides", json={"name": "TEST_Casc2"}, headers=h
        ).json()
        for g in (g1, g2):
            r = api_client.post(
                f"{BASE_URL}/api/guides/{g['id']}/places/{pid}", headers=h
            )
            assert r.status_code == 200
            assert pid in r.json()["place_ids"]

        r = api_client.delete(f"{BASE_URL}/api/places/{pid}", headers=h)
        assert r.status_code == 200

        for g in (g1, g2):
            doc = mongo_db.guides.find_one({"id": g["id"]}, {"_id": 0})
            assert pid not in doc["place_ids"], (
                f"place id leaked in guide {g['id']}: {doc['place_ids']}"
            )


# ---------------------------------------------------------------------------
# New MongoDB indexes
# ---------------------------------------------------------------------------
class TestNewIndexes:
    def test_recents_user_id_index(self, mongo_db):
        idx = mongo_db.recents.index_information()
        assert "user_id_1" in idx, idx

    def test_guides_user_id_index(self, mongo_db):
        idx = mongo_db.guides.index_information()
        assert "user_id_1" in idx, idx
