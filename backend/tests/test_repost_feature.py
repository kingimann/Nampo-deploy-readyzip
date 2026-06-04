"""Backend tests for the Newsfeed REPOST feature (X/Twitter style).

Endpoints covered:
  * POST /api/posts/{post_id}/repost (toggle on/off, idempotent per (user, original_post))
  * Repost-of-repost should resolve to the ORIGINAL post
  * GET /api/feed/explore hydrates `reposted_post`
  * Regression spot-checks: POST /api/posts, POST /api/posts/{id}/like,
    GET /api/posts/{id}/replies, GET /api/posts/user/{user_id}.

Auth is simulated by directly seeding `users` + `user_sessions` (Emergent
Google OAuth — there is no password login). Uses motor/pymongo directly.
"""
import os
import uuid
from datetime import datetime, timezone, timedelta

import pytest
import requests
from pymongo import MongoClient


BASE_URL = (
    os.environ.get("EXPO_BACKEND_URL")
    or os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or "https://location-hub-312.preview.emergentagent.com"
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
    email = f"TEST_repost_{suf}@example.com"
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
    try:
        mdb.posts.delete_many({"user_id": uid})
    except Exception:
        pass
    try:
        mdb.post_likes.delete_many({"user_id": uid})
    except Exception:
        pass
    try:
        mdb.follows.delete_many({"$or": [{"follower_id": uid}, {"followee_id": uid}]})
    except Exception:
        pass


@pytest.fixture(scope="module")
def alice(mdb):
    u = _seed(mdb, "Alice TEST")
    yield u
    _cleanup(mdb, u["user_id"])


@pytest.fixture(scope="module")
def bob(mdb):
    u = _seed(mdb, "Bob TEST")
    yield u
    _cleanup(mdb, u["user_id"])


# ---------------------------------------------------------------------------
# Health (sanity)
# ---------------------------------------------------------------------------
class TestHealth:
    def test_root(self, api):
        r = api.get(f"{BASE_URL}/api/")
        assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# Repost flow
# ---------------------------------------------------------------------------
class TestRepost:
    def test_auth_required(self, api):
        r = requests.post(f"{BASE_URL}/api/posts/some_id/repost")
        assert r.status_code == 401, r.text

    def test_repost_404_for_unknown_post(self, api, alice):
        r = api.post(
            f"{BASE_URL}/api/posts/{uuid.uuid4()}/repost",
            headers=alice["h"],
        )
        assert r.status_code == 404, r.text

    def test_full_repost_toggle_cycle(self, api, alice, bob):
        """Alice posts -> Bob reposts -> verify -> Bob un-reposts -> verify."""
        # Alice creates a post
        cr = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "Alice's first map post"},
            headers=alice["h"],
        )
        assert cr.status_code == 200, cr.text
        post = cr.json()
        assert post["text"] == "Alice's first map post"
        assert post.get("reposts_count", 0) == 0
        assert post.get("reposted_by_me", False) is False
        post_id = post["id"]

        # Bob reposts Alice's post
        rr = api.post(
            f"{BASE_URL}/api/posts/{post_id}/repost",
            headers=bob["h"],
        )
        assert rr.status_code == 200, rr.text
        body = rr.json()
        # Response returns the ORIGINAL post (hydrated) — not the repost entry
        assert body["id"] == post_id, "Repost endpoint must return the original post id"
        assert body["user_id"] == alice["user_id"], "Returned post must belong to Alice"
        assert body["reposts_count"] == 1, body
        assert body["reposted_by_me"] is True, body
        assert body.get("repost_of") in (None,), "Original post itself shouldn't have repost_of"

        # Confirm a new repost row was inserted (text="", repost_of=post_id, user=Bob)
        repost_row = api.get(
            f"{BASE_URL}/api/feed/explore",
            headers=bob["h"],
        )
        assert repost_row.status_code == 200, repost_row.text
        feed = repost_row.json()
        bob_repost = next(
            (p for p in feed if p["user_id"] == bob["user_id"] and p.get("repost_of") == post_id),
            None,
        )
        assert bob_repost is not None, "Bob's repost entry should appear in explore feed"
        assert bob_repost["text"] == "", "Repost entry text should be empty"
        # The hydrated reposted_post must be populated with the original content
        rp = bob_repost.get("reposted_post")
        assert rp is not None, "reposted_post must be hydrated on the repost entry"
        assert rp["id"] == post_id
        assert rp["text"] == "Alice's first map post"
        assert rp["user_id"] == alice["user_id"]

        # Alice viewing her own post — should reflect reposts_count=1, reposted_by_me=False
        ga = api.get(f"{BASE_URL}/api/posts/{post_id}", headers=alice["h"])
        assert ga.status_code == 200, ga.text
        alice_view = ga.json()
        assert alice_view["reposts_count"] == 1
        assert alice_view["reposted_by_me"] is False

        # Bob toggles repost OFF
        off = api.post(
            f"{BASE_URL}/api/posts/{post_id}/repost",
            headers=bob["h"],
        )
        assert off.status_code == 200, off.text
        offb = off.json()
        assert offb["id"] == post_id
        assert offb["reposts_count"] == 0, offb
        assert offb["reposted_by_me"] is False, offb

        # And Bob's repost row should be gone from the explore feed
        feed2 = api.get(f"{BASE_URL}/api/feed/explore", headers=bob["h"]).json()
        bob_repost_after = next(
            (p for p in feed2 if p["user_id"] == bob["user_id"] and p.get("repost_of") == post_id),
            None,
        )
        assert bob_repost_after is None, "Bob's repost entry should have been deleted"

    def test_repost_of_repost_resolves_to_original(self, api, alice, bob, mdb):
        """If Bob reposts Alice's post, then Alice tries to repost Bob's repost-entry,
        the server should resolve to the ORIGINAL post and toggle Alice's repost of it."""
        # Alice creates a post
        cr = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "Original by Alice"},
            headers=alice["h"],
        )
        assert cr.status_code == 200, cr.text
        orig_id = cr.json()["id"]

        # Bob reposts -> creates a repost row
        rb = api.post(f"{BASE_URL}/api/posts/{orig_id}/repost", headers=bob["h"])
        assert rb.status_code == 200, rb.text
        assert rb.json()["reposts_count"] == 1

        # Find Bob's repost row id directly via Mongo
        bobs_repost = mdb.posts.find_one(
            {"user_id": bob["user_id"], "repost_of": orig_id},
            {"_id": 0, "id": 1},
        )
        assert bobs_repost is not None, "Bob's repost row must exist in db.posts"
        bob_repost_id = bobs_repost["id"]

        # Alice now reposts Bob's repost — should resolve to orig and increment by 1
        ra = api.post(
            f"{BASE_URL}/api/posts/{bob_repost_id}/repost",
            headers=alice["h"],
        )
        assert ra.status_code == 200, ra.text
        rab = ra.json()
        assert rab["id"] == orig_id, "Repost-of-repost must resolve to original"
        assert rab["user_id"] == alice["user_id"]
        assert rab["reposts_count"] == 2, rab
        assert rab["reposted_by_me"] is True

        # Toggling again via the repost id should DECREMENT (idempotent on (user, original))
        ra2 = api.post(
            f"{BASE_URL}/api/posts/{bob_repost_id}/repost",
            headers=alice["h"],
        )
        assert ra2.status_code == 200, ra2.text
        rab2 = ra2.json()
        assert rab2["id"] == orig_id
        assert rab2["reposts_count"] == 1, rab2
        assert rab2["reposted_by_me"] is False

        # Cleanup: bob un-reposts to bring count back to 0
        api.post(f"{BASE_URL}/api/posts/{orig_id}/repost", headers=bob["h"])

    def test_explore_feed_hydrates_reposted_post(self, api, alice, bob):
        """End-to-end check: a fresh repost shows up in /feed/explore with reposted_post hydrated."""
        # Fresh original
        cr = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "Hydrate me"},
            headers=alice["h"],
        )
        assert cr.status_code == 200
        orig_id = cr.json()["id"]

        # Bob reposts
        rb = api.post(f"{BASE_URL}/api/posts/{orig_id}/repost", headers=bob["h"])
        assert rb.status_code == 200

        # Bob's explore should contain the repost entry with hydrated reposted_post
        fe = api.get(f"{BASE_URL}/api/feed/explore", headers=bob["h"])
        assert fe.status_code == 200, fe.text
        feed = fe.json()
        entry = next(
            (p for p in feed if p["user_id"] == bob["user_id"] and p.get("repost_of") == orig_id),
            None,
        )
        assert entry is not None, "Repost entry missing from explore feed"
        # Empty text on repost row
        assert entry["text"] == ""
        # Hydrated reposted_post
        rp = entry.get("reposted_post")
        assert rp is not None, "reposted_post should be hydrated in /feed/explore"
        assert rp["id"] == orig_id
        assert rp["text"] == "Hydrate me"
        assert rp["user_id"] == alice["user_id"]
        # Should also expose author on the hydrated original
        assert rp.get("author", {}).get("user_id") == alice["user_id"]

        # Cleanup
        api.post(f"{BASE_URL}/api/posts/{orig_id}/repost", headers=bob["h"])


# ---------------------------------------------------------------------------
# Regression: like still works after repost feature was added
# ---------------------------------------------------------------------------
class TestLikeRegression:
    def test_like_toggle(self, api, alice, bob):
        cr = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "Like me"},
            headers=alice["h"],
        )
        assert cr.status_code == 200, cr.text
        pid = cr.json()["id"]

        # Bob likes
        on = api.post(f"{BASE_URL}/api/posts/{pid}/like", headers=bob["h"])
        assert on.status_code == 200, on.text
        b1 = on.json()
        assert b1["likes_count"] == 1
        assert b1["liked_by_me"] is True

        # Bob unlikes
        off = api.post(f"{BASE_URL}/api/posts/{pid}/like", headers=bob["h"])
        assert off.status_code == 200, off.text
        b2 = off.json()
        assert b2["likes_count"] == 0
        assert b2["liked_by_me"] is False


# ---------------------------------------------------------------------------
# Regression: replies + user posts unaffected
# ---------------------------------------------------------------------------
class TestRepliesAndUserPosts:
    def test_reply_flow_and_listings(self, api, alice, bob):
        # Alice posts top-level
        top = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "Parent post"},
            headers=alice["h"],
        )
        assert top.status_code == 200
        pid = top.json()["id"]

        # Bob replies
        rep = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "A reply", "parent_id": pid},
            headers=bob["h"],
        )
        assert rep.status_code == 200, rep.text
        rep_body = rep.json()
        assert rep_body["parent_id"] == pid
        assert rep_body["text"] == "A reply"

        # /posts/{id}/replies
        rl = api.get(f"{BASE_URL}/api/posts/{pid}/replies", headers=alice["h"])
        assert rl.status_code == 200, rl.text
        replies = rl.json()
        assert any(r["id"] == rep_body["id"] and r["text"] == "A reply" for r in replies)

        # Parent's replies_count should be 1
        gp = api.get(f"{BASE_URL}/api/posts/{pid}", headers=alice["h"])
        assert gp.status_code == 200
        assert gp.json()["replies_count"] == 1

        # /posts/user/{user_id} returns only top-level for Alice (the parent)
        up = api.get(
            f"{BASE_URL}/api/posts/user/{alice['user_id']}",
            headers=bob["h"],
        )
        assert up.status_code == 200, up.text
        alices = up.json()
        # The parent post must be present; the reply must NOT be (it belongs to bob anyway,
        # but also parent_id != None should be filtered out)
        assert any(p["id"] == pid for p in alices)
        assert not any(p.get("parent_id") for p in alices), "user_posts should be top-level only"
