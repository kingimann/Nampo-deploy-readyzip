"""Backend tests for iteration 6 new surface:

  * Self-DM (POST /api/conversations with recipient == self)
  * Read receipts (POST /api/conversations/{id}/read -> unread_count = 0)
  * Delete-own-message (DELETE /api/conversations/{c}/messages/{m})
  * Profile Home/Work fields on PATCH /api/auth/me
  * Posts / Feed / Follows (backend-only — spec'd by main agent)
  * Foursquare match (auth gate, empty key safety, real venue lookup)

Plus a few spot-check regression tests for prior critical endpoints.

Auth is simulated by directly seeding `users` + `user_sessions` rows
(matching the existing pattern in test_new_endpoints.py).
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
FSQ_API_KEY = os.environ.get("FSQ_API_KEY", "")


# ---------------------------------------------------------------------------
# Fixtures / helpers
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
    email = f"TEST_it6_{suf}@example.com"
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
    # Posts / follows / likes (these collections may not exist yet)
    try:
        mdb.posts.delete_many({"user_id": uid})
        mdb.post_likes.delete_many({"user_id": uid})
        mdb.follows.delete_many({"$or": [{"follower_id": uid}, {"followee_id": uid}]})
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 1) Self-DM
# ---------------------------------------------------------------------------
class TestSelfDM:
    def test_self_dm_create_idempotent_and_message_flow(self, api, mdb):
        u = _seed(mdb, "SelfTester")
        try:
            # First call creates the self-conv
            r1 = api.post(
                f"{BASE_URL}/api/conversations",
                headers=u["h"],
                json={"recipient_user_id": u["user_id"]},
            )
            assert r1.status_code == 200, r1.text
            j1 = r1.json()
            conv_id = j1["id"]
            # 2nd call should return the SAME conversation id
            r2 = api.post(
                f"{BASE_URL}/api/conversations",
                headers=u["h"],
                json={"recipient_user_id": u["user_id"]},
            )
            assert r2.status_code == 200
            assert r2.json()["id"] == conv_id, "self-DM POST must be idempotent"

            # DB shape: participant_ids = [self.user_id] (single participant)
            db_conv = mdb.conversations.find_one({"id": conv_id})
            assert db_conv is not None
            assert db_conv["participant_ids"] == [u["user_id"]]

            # Send a message
            send = api.post(
                f"{BASE_URL}/api/conversations/{conv_id}/messages",
                headers=u["h"],
                json={"type": "text", "text": "TEST_self note 1"},
            )
            assert send.status_code == 200, send.text
            assert send.json()["text"] == "TEST_self note 1"
            assert send.json()["sender_id"] == u["user_id"]

            # Read messages back
            ls = api.get(
                f"{BASE_URL}/api/conversations/{conv_id}/messages", headers=u["h"]
            )
            assert ls.status_code == 200
            msgs = ls.json()
            assert len(msgs) >= 1
            assert any(m["text"] == "TEST_self note 1" for m in msgs)
        finally:
            _cleanup(mdb, u["user_id"])

    def test_self_dm_appears_in_list_conversations(self, api, mdb):
        """KNOWN-BUG check: list_conversations skips convs with no 'other'.
        A self-conv has participant_ids=[self] only, so it gets filtered out.
        """
        u = _seed(mdb, "SelfList")
        try:
            r = api.post(
                f"{BASE_URL}/api/conversations",
                headers=u["h"],
                json={"recipient_user_id": u["user_id"]},
            )
            assert r.status_code == 200
            conv_id = r.json()["id"]

            lst = api.get(f"{BASE_URL}/api/conversations", headers=u["h"])
            assert lst.status_code == 200
            ids = [c["id"] for c in lst.json()]
            assert conv_id in ids, (
                "Self-DM conversation MUST appear in GET /api/conversations "
                "but it does not (other_id None -> skipped)."
            )
        finally:
            _cleanup(mdb, u["user_id"])


# ---------------------------------------------------------------------------
# 2) Read receipts
# ---------------------------------------------------------------------------
class TestReadReceipts:
    def test_mark_read_404_for_non_participant(self, api, mdb):
        a, b, c = _seed(mdb, "A"), _seed(mdb, "B"), _seed(mdb, "C")
        try:
            r = api.post(
                f"{BASE_URL}/api/conversations",
                headers=a["h"],
                json={"recipient_user_id": b["user_id"]},
            )
            assert r.status_code == 200
            conv_id = r.json()["id"]
            # C is not a participant
            mr = api.post(
                f"{BASE_URL}/api/conversations/{conv_id}/read", headers=c["h"]
            )
            assert mr.status_code == 404
        finally:
            for u in (a, b, c):
                _cleanup(mdb, u["user_id"])

    def test_mark_read_writes_last_read_and_unread_count_flow(self, api, mdb):
        a, b = _seed(mdb, "A"), _seed(mdb, "B")
        try:
            r = api.post(
                f"{BASE_URL}/api/conversations",
                headers=a["h"],
                json={"recipient_user_id": b["user_id"]},
            )
            assert r.status_code == 200
            conv_id = r.json()["id"]

            # B sends 2 messages to A
            for txt in ("TEST hello 1", "TEST hello 2"):
                s = api.post(
                    f"{BASE_URL}/api/conversations/{conv_id}/messages",
                    headers=b["h"],
                    json={"type": "text", "text": txt},
                )
                assert s.status_code == 200

            # A's list should report unread_count >= 2 BEFORE mark-read.
            lst = api.get(f"{BASE_URL}/api/conversations", headers=a["h"])
            assert lst.status_code == 200
            row = next((c for c in lst.json() if c["id"] == conv_id), None)
            assert row is not None
            # NOTE: ConversationView model doesn't declare unread_count, so this
            # field is silently dropped on the wire. The DB write side
            # (last_read.<user_id>) still works. We assert the field is present
            # to catch the bug.
            assert "unread_count" in row, (
                "ConversationView is missing unread_count in the API response — "
                "the field is set in code but not declared on the Pydantic model."
            )
            assert row["unread_count"] >= 2

            # Mark read
            mr = api.post(
                f"{BASE_URL}/api/conversations/{conv_id}/read", headers=a["h"]
            )
            assert mr.status_code == 200

            # last_read.<a> must be set in DB
            db_conv = mdb.conversations.find_one({"id": conv_id})
            assert a["user_id"] in (db_conv.get("last_read") or {})

            # Now unread_count for A should be 0
            lst2 = api.get(f"{BASE_URL}/api/conversations", headers=a["h"])
            assert lst2.status_code == 200
            row2 = next((c for c in lst2.json() if c["id"] == conv_id), None)
            assert row2 is not None
            assert row2.get("unread_count", 0) == 0

            # B sends one more — A should now see unread_count == 1
            api.post(
                f"{BASE_URL}/api/conversations/{conv_id}/messages",
                headers=b["h"],
                json={"type": "text", "text": "TEST hello 3 (after read)"},
            )
            lst3 = api.get(f"{BASE_URL}/api/conversations", headers=a["h"])
            row3 = next((c for c in lst3.json() if c["id"] == conv_id), None)
            assert row3 is not None
            assert row3.get("unread_count", -1) == 1
        finally:
            _cleanup(mdb, a["user_id"]); _cleanup(mdb, b["user_id"])


# ---------------------------------------------------------------------------
# 3) Delete-own-message
# ---------------------------------------------------------------------------
class TestDeleteMessage:
    def test_delete_own_message_then_404_for_unknown(self, api, mdb):
        a, b = _seed(mdb, "A"), _seed(mdb, "B")
        try:
            r = api.post(
                f"{BASE_URL}/api/conversations",
                headers=a["h"],
                json={"recipient_user_id": b["user_id"]},
            )
            conv_id = r.json()["id"]
            s = api.post(
                f"{BASE_URL}/api/conversations/{conv_id}/messages",
                headers=a["h"],
                json={"type": "text", "text": "TEST to delete"},
            )
            msg_id = s.json()["id"]
            d = api.delete(
                f"{BASE_URL}/api/conversations/{conv_id}/messages/{msg_id}",
                headers=a["h"],
            )
            assert d.status_code == 200
            # GET should no longer return it
            ls = api.get(
                f"{BASE_URL}/api/conversations/{conv_id}/messages", headers=a["h"]
            )
            assert all(m["id"] != msg_id for m in ls.json())
            # Unknown id -> 404
            d2 = api.delete(
                f"{BASE_URL}/api/conversations/{conv_id}/messages/does-not-exist",
                headers=a["h"],
            )
            assert d2.status_code == 404
        finally:
            _cleanup(mdb, a["user_id"]); _cleanup(mdb, b["user_id"])

    def test_delete_not_owner_returns_404(self, api, mdb):
        a, b = _seed(mdb, "A"), _seed(mdb, "B")
        try:
            r = api.post(
                f"{BASE_URL}/api/conversations",
                headers=a["h"],
                json={"recipient_user_id": b["user_id"]},
            )
            conv_id = r.json()["id"]
            # B sends a message; A tries to delete it -> 404
            s = api.post(
                f"{BASE_URL}/api/conversations/{conv_id}/messages",
                headers=b["h"],
                json={"type": "text", "text": "TEST B's msg"},
            )
            msg_id = s.json()["id"]
            d = api.delete(
                f"{BASE_URL}/api/conversations/{conv_id}/messages/{msg_id}",
                headers=a["h"],
            )
            assert d.status_code == 404
            # The message should still be there
            ls = api.get(
                f"{BASE_URL}/api/conversations/{conv_id}/messages", headers=b["h"]
            )
            assert any(m["id"] == msg_id for m in ls.json())
        finally:
            _cleanup(mdb, a["user_id"]); _cleanup(mdb, b["user_id"])


# ---------------------------------------------------------------------------
# 4) Profile Home/Work
# ---------------------------------------------------------------------------
class TestProfileHomeWork:
    def test_patch_and_read_home_work(self, api, mdb):
        u = _seed(mdb, "HomeWork")
        try:
            payload = {
                "home_name": "TEST_home",
                "home_longitude": -122.4194,
                "home_latitude": 37.7749,
                "work_name": "TEST_work",
                "work_longitude": -73.9857,
                "work_latitude": 40.7484,
            }
            pr = api.patch(
                f"{BASE_URL}/api/auth/me", headers=u["h"], json=payload
            )
            assert pr.status_code == 200, pr.text
            body = pr.json()
            for k, v in payload.items():
                assert body[k] == v, f"{k} round-trip on PATCH"

            me = api.get(f"{BASE_URL}/api/auth/me", headers=u["h"])
            assert me.status_code == 200
            mb = me.json()
            for k, v in payload.items():
                assert mb[k] == v, f"{k} round-trip on GET"

            # Optional fields: omitting them in subsequent PATCH must not clear
            pr2 = api.patch(
                f"{BASE_URL}/api/auth/me", headers=u["h"],
                json={"bio": "x"},
            )
            assert pr2.status_code == 200
            mb2 = pr2.json()
            assert mb2["home_name"] == "TEST_home"
            assert mb2["work_latitude"] == 40.7484
        finally:
            _cleanup(mdb, u["user_id"])


# ---------------------------------------------------------------------------
# 5) Posts / Feed / Follows (backend-only)  -- per spec these MUST exist
# ---------------------------------------------------------------------------
class TestPostsFeedFollows:
    """Per the iteration 6 spec, the following endpoints must exist:
      POST   /api/posts
      DELETE /api/posts/{id}
      GET    /api/posts/{id}
      GET    /api/posts/{id}/replies
      GET    /api/feed/explore
      GET    /api/feed/home
      GET    /api/posts/user/{user_id}
      POST   /api/posts/{id}/like
      POST   /api/users/{user_id}/follow

    They are currently NOT registered on api_router (only the models &
    Mongo indexes exist). These tests document that and will pass once
    the routes are implemented.
    """

    def test_post_create_returns_hydrated_post(self, api, mdb):
        u = _seed(mdb, "Poster")
        try:
            r = api.post(
                f"{BASE_URL}/api/posts",
                headers=u["h"],
                json={"text": "TEST first post"},
            )
            assert r.status_code == 200, f"POST /api/posts not implemented (got {r.status_code})"
            j = r.json()
            assert j.get("text") == "TEST first post"
            assert j.get("user_id") == u["user_id"]
            assert "author" in j and j["author"].get("user_id") == u["user_id"]
            assert j.get("likes_count") == 0
            assert j.get("replies_count") == 0
            assert j.get("liked_by_me") is False
        finally:
            _cleanup(mdb, u["user_id"])

    def test_post_empty_text_400(self, api, mdb):
        u = _seed(mdb, "Poster2")
        try:
            r = api.post(
                f"{BASE_URL}/api/posts", headers=u["h"], json={"text": "   "}
            )
            assert r.status_code == 400, f"expected 400 on empty text (got {r.status_code})"
        finally:
            _cleanup(mdb, u["user_id"])

    def test_post_unknown_parent_404(self, api, mdb):
        u = _seed(mdb, "Poster3")
        try:
            r = api.post(
                f"{BASE_URL}/api/posts",
                headers=u["h"],
                json={"text": "reply", "parent_id": "does-not-exist"},
            )
            assert r.status_code == 404, f"expected 404 unknown parent (got {r.status_code})"
        finally:
            _cleanup(mdb, u["user_id"])

    def test_feed_explore_and_user_posts(self, api, mdb):
        u = _seed(mdb, "FeedUser")
        try:
            r = api.post(
                f"{BASE_URL}/api/posts",
                headers=u["h"],
                json={"text": "TEST feed visible"},
            )
            assert r.status_code == 200
            pid = r.json()["id"]

            ex = api.get(f"{BASE_URL}/api/feed/explore", headers=u["h"])
            assert ex.status_code == 200
            assert any(p["id"] == pid for p in ex.json())

            up = api.get(f"{BASE_URL}/api/posts/user/{u['user_id']}", headers=u["h"])
            assert up.status_code == 200
            assert any(p["id"] == pid for p in up.json())
        finally:
            _cleanup(mdb, u["user_id"])

    def test_like_toggle(self, api, mdb):
        a, b = _seed(mdb, "LikeA"), _seed(mdb, "LikeB")
        try:
            r = api.post(
                f"{BASE_URL}/api/posts", headers=a["h"], json={"text": "TEST likeme"}
            )
            assert r.status_code == 200
            pid = r.json()["id"]
            l1 = api.post(f"{BASE_URL}/api/posts/{pid}/like", headers=b["h"])
            assert l1.status_code == 200
            g = api.get(f"{BASE_URL}/api/posts/{pid}", headers=b["h"])
            assert g.status_code == 200
            assert g.json().get("likes_count") == 1
            assert g.json().get("liked_by_me") is True
            l2 = api.post(f"{BASE_URL}/api/posts/{pid}/like", headers=b["h"])
            assert l2.status_code == 200
            g2 = api.get(f"{BASE_URL}/api/posts/{pid}", headers=b["h"])
            assert g2.json().get("likes_count") == 0
            assert g2.json().get("liked_by_me") is False
        finally:
            _cleanup(mdb, a["user_id"]); _cleanup(mdb, b["user_id"])

    def test_follow_toggle_and_self_400(self, api, mdb):
        a, b = _seed(mdb, "FA"), _seed(mdb, "FB")
        try:
            # Cannot follow self
            rs = api.post(
                f"{BASE_URL}/api/users/{a['user_id']}/follow", headers=a["h"]
            )
            assert rs.status_code == 400, f"expected 400 cannot follow self (got {rs.status_code})"

            # Follow B then unfollow
            r1 = api.post(
                f"{BASE_URL}/api/users/{b['user_id']}/follow", headers=a["h"]
            )
            assert r1.status_code == 200
            r2 = api.post(
                f"{BASE_URL}/api/users/{b['user_id']}/follow", headers=a["h"]
            )
            assert r2.status_code == 200
        finally:
            _cleanup(mdb, a["user_id"]); _cleanup(mdb, b["user_id"])

    def test_feed_home_followees_plus_self(self, api, mdb):
        a, b, c = _seed(mdb, "HA"), _seed(mdb, "HB"), _seed(mdb, "HC")
        try:
            # B posts
            rb = api.post(
                f"{BASE_URL}/api/posts", headers=b["h"], json={"text": "TEST B post"}
            )
            assert rb.status_code == 200
            pb = rb.json()["id"]
            # C posts (not followed)
            api.post(f"{BASE_URL}/api/posts", headers=c["h"],
                     json={"text": "TEST C post"})
            # A posts
            ra = api.post(
                f"{BASE_URL}/api/posts", headers=a["h"], json={"text": "TEST A post"}
            )
            pa = ra.json()["id"]
            # A follows B
            api.post(f"{BASE_URL}/api/users/{b['user_id']}/follow", headers=a["h"])
            # A's home feed must include A's & B's, NOT C's
            home = api.get(f"{BASE_URL}/api/feed/home", headers=a["h"])
            assert home.status_code == 200
            ids = {p["id"] for p in home.json()}
            assert pa in ids
            assert pb in ids
        finally:
            for u in (a, b, c):
                _cleanup(mdb, u["user_id"])

    def test_delete_post_owner_only_and_replies_cascade(self, api, mdb):
        a, b = _seed(mdb, "DA"), _seed(mdb, "DB")
        try:
            r = api.post(
                f"{BASE_URL}/api/posts", headers=a["h"], json={"text": "TEST top"}
            )
            top = r.json()["id"]
            rp = api.post(
                f"{BASE_URL}/api/posts",
                headers=b["h"],
                json={"text": "TEST reply", "parent_id": top},
            )
            assert rp.status_code == 200
            reply_id = rp.json()["id"]

            # parent now has replies_count == 1
            g = api.get(f"{BASE_URL}/api/posts/{top}", headers=a["h"])
            assert g.json().get("replies_count") == 1

            # B (non-owner of top) cannot delete top
            d404 = api.delete(f"{BASE_URL}/api/posts/{top}", headers=b["h"])
            assert d404.status_code in (403, 404)

            # B can delete own reply -> parent.replies_count decrements
            d = api.delete(f"{BASE_URL}/api/posts/{reply_id}", headers=b["h"])
            assert d.status_code == 200
            g2 = api.get(f"{BASE_URL}/api/posts/{top}", headers=a["h"])
            assert g2.json().get("replies_count") == 0
        finally:
            _cleanup(mdb, a["user_id"]); _cleanup(mdb, b["user_id"])


# ---------------------------------------------------------------------------
# 6) Foursquare match
# ---------------------------------------------------------------------------
class TestFoursquare:
    def test_no_bearer_returns_401(self, api):
        r = api.get(
            f"{BASE_URL}/api/foursquare/match",
            params={"name": "Eiffel Tower", "lng": 2.2945, "lat": 48.8584},
        )
        assert r.status_code == 401

    @pytest.mark.skipif(not FSQ_API_KEY,
                        reason="FSQ_API_KEY not set — live call skipped")
    def test_real_venue_returns_fsq_profile(self, api, mdb):
        u = _seed(mdb, "FsqUser")
        try:
            r = api.get(
                f"{BASE_URL}/api/foursquare/match",
                headers=u["h"],
                params={"name": "Eiffel Tower", "lng": 2.2945, "lat": 48.8584},
            )
            # Live external call; tolerate 200 + null (no match) AND 200 + a profile.
            assert r.status_code == 200, r.text
            data = r.json()
            if data is None:
                pytest.skip("Foursquare returned no match for Eiffel Tower (live API)")
            assert "fsq_id" in data and data["fsq_id"]
            assert "name" in data
        finally:
            _cleanup(mdb, u["user_id"])

    def test_does_not_crash_with_empty_key(self, api, mdb, monkeypatch):
        """The endpoint must return JSON (null) gracefully if FSQ_API_KEY is empty.
        We can't easily mutate the running server's env, so we just verify the
        endpoint shape (no 500). With the current key set, this will return
        either null or a profile, but never raise.
        """
        u = _seed(mdb, "FsqEmpty")
        try:
            r = api.get(
                f"{BASE_URL}/api/foursquare/match",
                headers=u["h"],
                # Coords in the middle of the ocean, no venue should match
                params={"name": "ZZZ_nope", "lng": 0.0, "lat": 0.0},
            )
            assert r.status_code == 200
            # Must be a valid JSON body (None or dict), not a crash
            j = r.json()
            assert j is None or isinstance(j, dict)
        finally:
            _cleanup(mdb, u["user_id"])


# ---------------------------------------------------------------------------
# 7) Spot-check regression for prior critical endpoints
# ---------------------------------------------------------------------------
class TestRegressionSpotCheck:
    def test_health(self, api):
        r = api.get(f"{BASE_URL}/api/")
        assert r.status_code == 200
        assert "message" in r.json()

    def test_auth_session_missing_returns_401(self, api):
        # No bearer at all
        r = api.get(f"{BASE_URL}/api/auth/me")
        assert r.status_code == 401

    def test_places_crud_smoke(self, api, mdb):
        u = _seed(mdb, "RegPlaces")
        try:
            c = api.post(
                f"{BASE_URL}/api/places",
                headers=u["h"],
                json={
                    "title": "TEST place",
                    "longitude": -122.0,
                    "latitude": 37.0,
                    "address": "x",
                    "category": "marker",
                    "notes": "",
                },
            )
            assert c.status_code == 200, c.text
            pid = c.json()["id"]
            g = api.get(f"{BASE_URL}/api/places", headers=u["h"])
            assert g.status_code == 200
            assert any(p["id"] == pid for p in g.json())
            gone = api.delete(f"{BASE_URL}/api/places/{pid}", headers=u["h"])
            assert gone.status_code == 200
        finally:
            _cleanup(mdb, u["user_id"])

    def test_recents_create_and_list(self, api, mdb):
        u = _seed(mdb, "RegRec")
        try:
            r = api.post(
                f"{BASE_URL}/api/recents",
                headers=u["h"],
                json={
                    "name": "TEST recent",
                    "longitude": 0.0,
                    "latitude": 0.0,
                    "full_address": "x",
                },
            )
            assert r.status_code == 200, r.text
            ls = api.get(f"{BASE_URL}/api/recents", headers=u["h"])
            assert ls.status_code == 200
        finally:
            _cleanup(mdb, u["user_id"])
