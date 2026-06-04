"""Backend tests for the new surface added in iteration 4:
  * Profile: PATCH /api/auth/me (trim/cap, ignore-empty)
  * GET /api/users/search (case-insensitive regex, excludes self)
  * GET /api/users/{id}/public (404, stats)
  * Public guides: PATCH /api/guides/{id} slug auto-gen + uniqueness,
    GET /api/public/guides/{slug} (no auth), clone (different user creates
    new places + new private guide)
  * Reviews: POST/GET/DELETE, 1..5 rating, upsert via unique idx
  * Messaging: conversations key idempotent, list w/ other_user,
    messages 404 for non-participant, text empty 400, place coord 400,
    last_message_at updates.

Auth is simulated by seeding a user + session row directly (Emergent
session-data is NOT touched here; it is MOCKED in
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
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def mdb():
    c = MongoClient(MONGO_URL)
    db = c[DB_NAME]
    yield db
    c.close()


def _seed(mdb, name="Tester"):
    suf = uuid.uuid4().hex[:8]
    uid = f"user_TEST_{suf}"
    email = f"TEST_ne_{suf}@example.com"
    tok = f"TESTTOK_{uuid.uuid4().hex}"
    mdb.users.insert_one({
        "user_id": uid, "email": email, "name": name,
        "picture": None, "bio": "",
        "created_at": datetime.now(timezone.utc),
    })
    mdb.user_sessions.insert_one({
        "session_token": tok, "user_id": uid,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=1),
        "created_at": datetime.now(timezone.utc),
    })
    return {"user_id": uid, "email": email, "token": tok,
            "h": {"Authorization": f"Bearer {tok}"}}


def _cleanup(mdb, uid):
    mdb.user_sessions.delete_many({"user_id": uid})
    mdb.users.delete_many({"user_id": uid})
    mdb.places.delete_many({"user_id": uid})
    mdb.recents.delete_many({"user_id": uid})
    mdb.guides.delete_many({"user_id": uid})
    mdb.reviews.delete_many({"user_id": uid})
    mdb.conversations.delete_many({"participant_ids": uid})


@pytest.fixture()
def alice(mdb):
    u = _seed(mdb, name="Alice Tester")
    yield u
    _cleanup(mdb, u["user_id"])


@pytest.fixture()
def bob(mdb):
    u = _seed(mdb, name="Bob Tester")
    yield u
    _cleanup(mdb, u["user_id"])


# ---------------------------------------------------------------------------
# Profile: PATCH /api/auth/me
# ---------------------------------------------------------------------------
class TestProfilePatch:
    def test_update_name_and_bio(self, api, alice):
        r = api.patch(f"{BASE_URL}/api/auth/me",
                      json={"name": "  Alice Updated  ", "bio": "  hi  "},
                      headers=alice["h"])
        assert r.status_code == 200, r.text
        b = r.json()
        assert b["name"] == "Alice Updated"  # trimmed
        assert b["bio"] == "hi"
        assert b["email"] == alice["email"]
        assert "_id" not in b

    def test_empty_name_is_ignored(self, api, alice):
        api.patch(f"{BASE_URL}/api/auth/me", json={"name": "First"},
                  headers=alice["h"])
        r = api.patch(f"{BASE_URL}/api/auth/me", json={"name": "   "},
                      headers=alice["h"])
        assert r.status_code == 200
        assert r.json()["name"] == "First"  # unchanged

    def test_name_capped_at_80(self, api, alice):
        long = "x" * 200
        r = api.patch(f"{BASE_URL}/api/auth/me", json={"name": long},
                      headers=alice["h"])
        assert r.status_code == 200
        assert len(r.json()["name"]) == 80

    def test_bio_capped_at_280(self, api, alice):
        long = "y" * 400
        r = api.patch(f"{BASE_URL}/api/auth/me", json={"bio": long},
                      headers=alice["h"])
        assert r.status_code == 200
        assert len(r.json()["bio"]) == 280

    def test_picture_updated(self, api, alice):
        r = api.patch(f"{BASE_URL}/api/auth/me",
                      json={"picture": "https://x/p.png"},
                      headers=alice["h"])
        assert r.status_code == 200
        assert r.json()["picture"] == "https://x/p.png"

    def test_unauthenticated(self, api):
        r = api.patch(f"{BASE_URL}/api/auth/me", json={"name": "x"})
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# User search & public profile
# ---------------------------------------------------------------------------
class TestUsersSearch:
    def test_search_excludes_self_and_finds_other(self, api, alice, bob):
        # alice searches for "bob"
        r = api.get(f"{BASE_URL}/api/users/search?q=Bob",
                    headers=alice["h"])
        assert r.status_code == 200, r.text
        ids = [u["user_id"] for u in r.json()]
        assert bob["user_id"] in ids
        assert alice["user_id"] not in ids
        # each has stats
        bob_entry = next(u for u in r.json() if u["user_id"] == bob["user_id"])
        assert set(bob_entry["stats"].keys()) >= {"places", "guides", "reviews"}

    def test_search_case_insensitive_email(self, api, alice, bob):
        # search by partial of bob's email (case different)
        frag = bob["email"].split("@")[0][:8].upper()
        r = api.get(f"{BASE_URL}/api/users/search?q={frag}",
                    headers=alice["h"])
        assert r.status_code == 200
        ids = [u["user_id"] for u in r.json()]
        assert bob["user_id"] in ids

    def test_search_requires_auth(self, api):
        r = api.get(f"{BASE_URL}/api/users/search?q=alice")
        assert r.status_code == 401

    def test_search_excludes_requester_self_match(self, api, alice):
        # alice searches her own name; she must be excluded.
        r = api.get(f"{BASE_URL}/api/users/search?q=Alice%20Tester",
                    headers=alice["h"])
        assert r.status_code == 200
        ids = [u["user_id"] for u in r.json()]
        assert alice["user_id"] not in ids


class TestPublicUserProfile:
    def test_404_for_unknown(self, api, alice):
        r = api.get(f"{BASE_URL}/api/users/user_does_not_exist/public",
                    headers=alice["h"])
        assert r.status_code == 404

    def test_returns_stats(self, api, alice, bob):
        # Seed: bob has 1 place, 1 guide, 1 review
        api.post(f"{BASE_URL}/api/places",
                 json={"title": "TEST_p", "longitude": 0, "latitude": 0},
                 headers=bob["h"])
        api.post(f"{BASE_URL}/api/guides", json={"name": "TEST_g"},
                 headers=bob["h"])
        api.post(f"{BASE_URL}/api/reviews",
                 json={"place_key": "k1", "place_name": "n",
                       "longitude": 0, "latitude": 0, "rating": 5},
                 headers=bob["h"])
        r = api.get(f"{BASE_URL}/api/users/{bob['user_id']}/public",
                    headers=alice["h"])
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["user_id"] == bob["user_id"]
        assert body["stats"]["places"] >= 1
        assert body["stats"]["guides"] >= 1
        assert body["stats"]["reviews"] >= 1
        assert "_id" not in body


# ---------------------------------------------------------------------------
# Public guides
# ---------------------------------------------------------------------------
class TestPublicGuides:
    def test_flip_public_auto_generates_slug(self, api, alice):
        h = alice["h"]
        gid = api.post(f"{BASE_URL}/api/guides",
                       json={"name": "My Cool Trip!"},
                       headers=h).json()["id"]
        # Initially private + no slug
        r1 = api.patch(f"{BASE_URL}/api/guides/{gid}",
                       json={"is_public": True}, headers=h)
        assert r1.status_code == 200, r1.text
        slug1 = r1.json()["slug"]
        assert slug1 == "my-cool-trip"
        assert r1.json()["is_public"] is True

        # Toggle to private then back to public — slug preserved
        api.patch(f"{BASE_URL}/api/guides/{gid}",
                  json={"is_public": False}, headers=h)
        r2 = api.patch(f"{BASE_URL}/api/guides/{gid}",
                       json={"is_public": True}, headers=h)
        assert r2.json()["slug"] == slug1

    def test_slug_collision_suffix(self, api, alice, bob):
        # alice publishes "Same Name"
        gid_a = api.post(f"{BASE_URL}/api/guides",
                        json={"name": "Same Name"},
                        headers=alice["h"]).json()["id"]
        ra = api.patch(f"{BASE_URL}/api/guides/{gid_a}",
                       json={"is_public": True}, headers=alice["h"])
        slug_a = ra.json()["slug"]
        # bob publishes "Same Name" too -> must get -1
        gid_b = api.post(f"{BASE_URL}/api/guides",
                        json={"name": "Same Name"},
                        headers=bob["h"]).json()["id"]
        rb = api.patch(f"{BASE_URL}/api/guides/{gid_b}",
                       json={"is_public": True}, headers=bob["h"])
        slug_b = rb.json()["slug"]
        assert slug_a != slug_b
        assert slug_b.startswith("same-name")

    def test_public_get_no_auth_with_places_in_order(self, api, alice):
        h = alice["h"]
        # 3 places, add in specific order
        p_ids = []
        for i, t in enumerate(["TEST_one", "TEST_two", "TEST_three"]):
            pid = api.post(f"{BASE_URL}/api/places",
                           json={"title": t, "longitude": i,
                                 "latitude": i}, headers=h).json()["id"]
            p_ids.append(pid)
        gid = api.post(f"{BASE_URL}/api/guides",
                       json={"name": "Ordered Guide"},
                       headers=h).json()["id"]
        for pid in p_ids:
            api.post(f"{BASE_URL}/api/guides/{gid}/places/{pid}", headers=h)
        api.patch(f"{BASE_URL}/api/guides/{gid}",
                  json={"is_public": True}, headers=h)
        slug = api.get(f"{BASE_URL}/api/guides", headers=h).json()
        slug = next(g["slug"] for g in slug if g["id"] == gid)

        # no auth headers
        r = requests.get(f"{BASE_URL}/api/public/guides/{slug}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["name"] == "Ordered Guide"
        assert [p["id"] for p in body["places"]] == p_ids
        assert body["owner"]["user_id"] == alice["user_id"]
        assert "stats" in body["owner"]
        assert "_id" not in body

    def test_public_404_private_or_missing(self, api, alice):
        # private guide -> 404 even if slug exists in some hypothetical case
        r = requests.get(f"{BASE_URL}/api/public/guides/does-not-exist-xyz")
        assert r.status_code == 404

    def test_clone_by_other_user(self, api, alice, bob, mdb):
        h_a = alice["h"]
        pid = api.post(f"{BASE_URL}/api/places",
                       json={"title": "TEST_orig", "longitude": 1,
                             "latitude": 2}, headers=h_a).json()["id"]
        gid = api.post(f"{BASE_URL}/api/guides",
                       json={"name": "Clone Source"}, headers=h_a).json()["id"]
        api.post(f"{BASE_URL}/api/guides/{gid}/places/{pid}", headers=h_a)
        api.patch(f"{BASE_URL}/api/guides/{gid}",
                  json={"is_public": True}, headers=h_a)
        slug = next(
            g["slug"] for g in api.get(f"{BASE_URL}/api/guides", headers=h_a).json()
            if g["id"] == gid
        )
        # Bob clones
        r = api.post(f"{BASE_URL}/api/public/guides/{slug}/clone",
                     headers=bob["h"])
        assert r.status_code == 200, r.text
        new_guide = r.json()
        assert new_guide["user_id"] == bob["user_id"]
        assert new_guide["name"] == "Clone Source (clone)"
        assert new_guide["is_public"] is False
        assert len(new_guide["place_ids"]) == 1
        new_pid = new_guide["place_ids"][0]
        assert new_pid != pid  # new UUID
        # Owned by bob
        bobs_place = api.get(f"{BASE_URL}/api/places/{new_pid}",
                             headers=bob["h"])
        assert bobs_place.status_code == 200
        assert bobs_place.json()["title"] == "TEST_orig"
        # Original alice place untouched
        a_orig = api.get(f"{BASE_URL}/api/places/{pid}", headers=h_a)
        assert a_orig.status_code == 200

    def test_clone_requires_auth(self, api):
        r = requests.post(f"{BASE_URL}/api/public/guides/anything/clone")
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# Reviews
# ---------------------------------------------------------------------------
class TestReviews:
    def test_create_and_list(self, api, alice, bob):
        key = f"TEST_pk_{uuid.uuid4().hex[:6]}"
        # alice + bob each review the same place
        r1 = api.post(f"{BASE_URL}/api/reviews",
                      json={"place_key": key, "place_name": "PN",
                            "longitude": 1.0, "latitude": 2.0,
                            "rating": 4, "text": "ok"},
                      headers=alice["h"])
        assert r1.status_code == 200, r1.text
        rb = api.post(f"{BASE_URL}/api/reviews",
                      json={"place_key": key, "place_name": "PN",
                            "longitude": 1.0, "latitude": 2.0,
                            "rating": 5},
                      headers=bob["h"])
        assert rb.status_code == 200
        lst = api.get(f"{BASE_URL}/api/reviews?place_key={key}",
                      headers=alice["h"])
        assert lst.status_code == 200
        ratings_by_uid = {r["user_id"]: r["rating"] for r in lst.json()}
        assert ratings_by_uid.get(alice["user_id"]) == 4
        assert ratings_by_uid.get(bob["user_id"]) == 5

    def test_invalid_rating_400(self, api, alice):
        for bad in [0, 6, -1, 99]:
            r = api.post(f"{BASE_URL}/api/reviews",
                         json={"place_key": "k", "place_name": "n",
                               "longitude": 0, "latitude": 0,
                               "rating": bad},
                         headers=alice["h"])
            assert r.status_code == 400, (bad, r.text)

    def test_upsert_same_user_same_place(self, api, alice, mdb):
        key = f"TEST_uniq_{uuid.uuid4().hex[:6]}"
        r1 = api.post(f"{BASE_URL}/api/reviews",
                      json={"place_key": key, "place_name": "n",
                            "longitude": 0, "latitude": 0, "rating": 3,
                            "text": "first"},
                      headers=alice["h"])
        rid = r1.json()["id"]
        # second post — should upsert, NOT duplicate
        r2 = api.post(f"{BASE_URL}/api/reviews",
                      json={"place_key": key, "place_name": "n",
                            "longitude": 0, "latitude": 0, "rating": 5,
                            "text": "updated"},
                      headers=alice["h"])
        assert r2.status_code == 200, r2.text
        assert r2.json()["id"] == rid  # same row
        assert r2.json()["rating"] == 5
        assert r2.json()["text"] == "updated"
        # only one row in Mongo
        count = mdb.reviews.count_documents(
            {"user_id": alice["user_id"], "place_key": key})
        assert count == 1

    def test_delete_own_and_404_other(self, api, alice, bob):
        key = f"TEST_del_{uuid.uuid4().hex[:6]}"
        rid = api.post(f"{BASE_URL}/api/reviews",
                      json={"place_key": key, "place_name": "n",
                            "longitude": 0, "latitude": 0, "rating": 3},
                      headers=alice["h"]).json()["id"]
        # bob cannot delete alice's review
        r1 = api.delete(f"{BASE_URL}/api/reviews/{rid}", headers=bob["h"])
        assert r1.status_code == 404
        # alice can
        r2 = api.delete(f"{BASE_URL}/api/reviews/{rid}", headers=alice["h"])
        assert r2.status_code == 200

    def test_reviews_require_auth(self, api):
        assert api.get(f"{BASE_URL}/api/reviews?place_key=x").status_code == 401
        assert api.post(f"{BASE_URL}/api/reviews",
                        json={"place_key": "x", "place_name": "n",
                              "longitude": 0, "latitude": 0,
                              "rating": 3}).status_code == 401


# ---------------------------------------------------------------------------
# Conversations & messages
# ---------------------------------------------------------------------------
class TestMessaging:
    def test_self_dm_creates_notes_to_self(self, api, alice):
        # Product now allows self-DM as "Notes to self" \u2014 returns 200 with
        # other_user pointing to self.
        r = api.post(f"{BASE_URL}/api/conversations",
                     json={"recipient_user_id": alice["user_id"]},
                     headers=alice["h"])
        assert r.status_code == 200, r.text
        assert r.json()["other_user"]["user_id"] == alice["user_id"]

    def test_unknown_recipient_404(self, api, alice):
        r = api.post(f"{BASE_URL}/api/conversations",
                     json={"recipient_user_id": "user_does_not_exist"},
                     headers=alice["h"])
        assert r.status_code == 404

    def test_create_idempotent(self, api, alice, bob):
        r1 = api.post(f"{BASE_URL}/api/conversations",
                      json={"recipient_user_id": bob["user_id"]},
                      headers=alice["h"])
        assert r1.status_code == 200, r1.text
        cid1 = r1.json()["id"]
        # Same caller -> same conv
        r2 = api.post(f"{BASE_URL}/api/conversations",
                      json={"recipient_user_id": bob["user_id"]},
                      headers=alice["h"])
        assert r2.json()["id"] == cid1
        # Other side opens -> same conv (deterministic key)
        r3 = api.post(f"{BASE_URL}/api/conversations",
                      json={"recipient_user_id": alice["user_id"]},
                      headers=bob["h"])
        assert r3.status_code == 200
        assert r3.json()["id"] == cid1
        # other_user is set
        assert r1.json()["other_user"]["user_id"] == bob["user_id"]
        assert r3.json()["other_user"]["user_id"] == alice["user_id"]

    def test_list_sorted_by_last_message_at(self, api, alice, bob, mdb):
        # Create 2 convs: alice<->bob and alice<->charlie
        charlie = _seed(mdb, name="Charlie")
        try:
            cid_b = api.post(f"{BASE_URL}/api/conversations",
                             json={"recipient_user_id": bob["user_id"]},
                             headers=alice["h"]).json()["id"]
            cid_c = api.post(f"{BASE_URL}/api/conversations",
                             json={"recipient_user_id": charlie["user_id"]},
                             headers=alice["h"]).json()["id"]
            # send msg in cid_c last -> it should be first
            api.post(f"{BASE_URL}/api/conversations/{cid_b}/messages",
                     json={"type": "text", "text": "hi b"},
                     headers=alice["h"])
            api.post(f"{BASE_URL}/api/conversations/{cid_c}/messages",
                     json={"type": "text", "text": "hi c"},
                     headers=alice["h"])
            r = api.get(f"{BASE_URL}/api/conversations", headers=alice["h"])
            assert r.status_code == 200
            ids_in_order = [c["id"] for c in r.json()]
            # cid_c should appear before cid_b
            assert ids_in_order.index(cid_c) < ids_in_order.index(cid_b)
            # last_message populated
            c_view = next(c for c in r.json() if c["id"] == cid_c)
            assert c_view["last_message"]["text"] == "hi c"
            assert c_view["other_user"]["user_id"] == charlie["user_id"]
        finally:
            _cleanup(mdb, charlie["user_id"])

    def test_messages_non_participant_404(self, api, alice, bob, mdb):
        cid = api.post(f"{BASE_URL}/api/conversations",
                       json={"recipient_user_id": bob["user_id"]},
                       headers=alice["h"]).json()["id"]
        intruder = _seed(mdb, name="Intruder")
        try:
            r = api.get(f"{BASE_URL}/api/conversations/{cid}/messages",
                        headers=intruder["h"])
            assert r.status_code == 404
            r2 = api.post(f"{BASE_URL}/api/conversations/{cid}/messages",
                          json={"type": "text", "text": "hey"},
                          headers=intruder["h"])
            assert r2.status_code == 404
        finally:
            _cleanup(mdb, intruder["user_id"])

    def test_messages_text_empty_400(self, api, alice, bob):
        cid = api.post(f"{BASE_URL}/api/conversations",
                       json={"recipient_user_id": bob["user_id"]},
                       headers=alice["h"]).json()["id"]
        for text in ["", "   "]:
            r = api.post(f"{BASE_URL}/api/conversations/{cid}/messages",
                         json={"type": "text", "text": text},
                         headers=alice["h"])
            assert r.status_code == 400, (text, r.text)

    def test_messages_place_missing_coords_400(self, api, alice, bob):
        cid = api.post(f"{BASE_URL}/api/conversations",
                       json={"recipient_user_id": bob["user_id"]},
                       headers=alice["h"]).json()["id"]
        r = api.post(f"{BASE_URL}/api/conversations/{cid}/messages",
                     json={"type": "place", "place_name": "X"},
                     headers=alice["h"])
        assert r.status_code == 400

    def test_messages_chronological_order_and_last_message_at(
            self, api, alice, bob):
        cid = api.post(f"{BASE_URL}/api/conversations",
                       json={"recipient_user_id": bob["user_id"]},
                       headers=alice["h"]).json()["id"]
        for t in ["one", "two", "three"]:
            r = api.post(f"{BASE_URL}/api/conversations/{cid}/messages",
                         json={"type": "text", "text": t},
                         headers=alice["h"])
            assert r.status_code == 200, r.text
        r = api.get(f"{BASE_URL}/api/conversations/{cid}/messages",
                    headers=bob["h"])
        assert r.status_code == 200
        assert [m["text"] for m in r.json()] == ["one", "two", "three"]
        # last_message_at populated on conversation
        conv = api.post(f"{BASE_URL}/api/conversations",
                        json={"recipient_user_id": alice["user_id"]},
                        headers=bob["h"]).json()
        assert conv["last_message"]["text"] == "three"

    def test_messaging_requires_auth(self, api):
        assert api.get(f"{BASE_URL}/api/conversations").status_code == 401
        assert api.post(
            f"{BASE_URL}/api/conversations",
            json={"recipient_user_id": "x"}).status_code == 401


# ---------------------------------------------------------------------------
# New indexes
# ---------------------------------------------------------------------------
class TestNewIndexes:
    def test_guides_slug_sparse_unique(self, mdb):
        idx = mdb.guides.index_information()
        slug_idx = next(
            (v for k, v in idx.items() if any(t[0] == "slug" for t in v["key"])),
            None,
        )
        assert slug_idx is not None
        assert slug_idx.get("unique") is True
        assert slug_idx.get("sparse") is True

    def test_reviews_unique_user_place(self, mdb):
        idx = mdb.reviews.index_information()
        # find compound (user_id, place_key)
        cmp_idx = next(
            (v for v in idx.values() if [k for k, _ in v["key"]]
             == ["user_id", "place_key"]),
            None,
        )
        assert cmp_idx is not None
        assert cmp_idx.get("unique") is True

    def test_reviews_place_key_index(self, mdb):
        idx = mdb.reviews.index_information()
        found = any(
            v["key"] == [("place_key", 1)] for v in idx.values()
        )
        assert found

    def test_conversations_key_unique(self, mdb):
        idx = mdb.conversations.index_information()
        ki = next(
            (v for v in idx.values() if v["key"] == [("key", 1)]), None
        )
        assert ki is not None
        assert ki.get("unique") is True

    def test_conversations_participant_ids_index(self, mdb):
        idx = mdb.conversations.index_information()
        assert any(
            v["key"] == [("participant_ids", 1)] for v in idx.values()
        )

    def test_messages_compound_index(self, mdb):
        idx = mdb.messages.index_information()
        assert any(
            [k for k, _ in v["key"]] == ["conversation_id", "created_at"]
            for v in idx.values()
        )
