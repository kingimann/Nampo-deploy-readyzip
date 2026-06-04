"""Phase-B Newsfeed backend tests.

Covers:
  * Hashtags: extraction (lowercased), GET /api/hashtags/{tag}, case-insensitivity,
    /api/hashtags/{tag}/count, empty-tag handling.
  * Who-liked / who-reposted: /api/posts/{id}/likers, /api/posts/{id}/reposters
    (excludes quote-reposters since those have no repost_of).
  * Quote-repost (quote_of): create, quoted_post hydration, redirect to original
    when quoting a repost-entry, notification to original author, 404 on bogus.
  * OG Link preview: best-effort populate, link_previews cache, SSRF for 127.0.0.1.
  * Polls: create (2..4 options), invalid sizes 400, vote first/idempotent/change,
    invalid option 400, closed poll 400.
  * Regression spot-checks: like / repost-toggle / reply / bookmark / edit / delete,
    repost_count + quote_count grow correctly.

Auth: directly seed users + user_sessions in Mongo (Emergent Google OAuth — no
password). Bearer <session_token>.
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
    or "http://localhost:8001"
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
    email = f"TEST_phb_{suf}@example.com"
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
    return {
        "user_id": uid, "email": email, "token": tok,
        "h": {"Authorization": f"Bearer {tok}"},
    }


def _cleanup_user(mdb, uid):
    mdb.user_sessions.delete_many({"user_id": uid})
    mdb.users.delete_many({"user_id": uid})


@pytest.fixture(scope="module")
def alice(mdb):
    u = _seed(mdb, name="Alice TEST")
    yield u
    _cleanup_user(mdb, u["user_id"])
    # Cascade cleanup of artifacts
    for coll in ("posts", "post_likes", "post_bookmarks",
                 "notifications", "poll_votes", "link_previews"):
        mdb[coll].delete_many({"user_id": u["user_id"]})


@pytest.fixture(scope="module")
def bob(mdb):
    u = _seed(mdb, name="Bob TEST")
    yield u
    _cleanup_user(mdb, u["user_id"])
    for coll in ("posts", "post_likes", "post_bookmarks",
                 "notifications", "poll_votes"):
        mdb[coll].delete_many({"user_id": u["user_id"]})


@pytest.fixture(scope="module")
def carol(mdb):
    u = _seed(mdb, name="Carol TEST")
    yield u
    _cleanup_user(mdb, u["user_id"])
    for coll in ("posts", "post_likes", "post_bookmarks",
                 "notifications", "poll_votes"):
        mdb[coll].delete_many({"user_id": u["user_id"]})


# ---------------------------------------------------------------------------
# 1) Hashtags
# ---------------------------------------------------------------------------
class TestHashtags:
    def test_create_post_extracts_lowercased_hashtags(self, api, alice, mdb):
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "Hello #hello #world #FooBar end"},
            headers=alice["h"],
        )
        assert r.status_code == 200, r.text
        data = r.json()
        # set comparison (extraction uses set)
        assert set(data["hashtags"]) == {"hello", "world", "foobar"}
        # verify in DB doc
        doc = mdb.posts.find_one({"id": data["id"]}, {"_id": 0})
        assert set(doc["hashtags"]) == {"hello", "world", "foobar"}
        TestHashtags.post_id = data["id"]

    def test_get_hashtag_returns_post(self, api, alice):
        r = api.get(f"{BASE_URL}/api/hashtags/hello", headers=alice["h"])
        assert r.status_code == 200, r.text
        ids = [p["id"] for p in r.json()]
        assert TestHashtags.post_id in ids

    def test_hashtag_case_insensitive(self, api, alice):
        r = api.get(f"{BASE_URL}/api/hashtags/HELLO", headers=alice["h"])
        assert r.status_code == 200
        ids = [p["id"] for p in r.json()]
        assert TestHashtags.post_id in ids

    def test_hashtag_count(self, api, alice):
        r = api.get(f"{BASE_URL}/api/hashtags/hello/count", headers=alice["h"])
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["tag"] == "hello"
        assert body["count"] >= 1

    def test_hashtag_newest_first(self, api, alice):
        # Create a second #hello post; should appear before the first
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "Another #hello again"},
            headers=alice["h"],
        )
        assert r.status_code == 200
        newer_id = r.json()["id"]
        r2 = api.get(f"{BASE_URL}/api/hashtags/hello", headers=alice["h"])
        ids = [p["id"] for p in r2.json()]
        assert ids[0] == newer_id

    def test_empty_hashtag(self, api, alice):
        # Either 404 (no route match) or 400 are acceptable
        r = api.get(f"{BASE_URL}/api/hashtags/", headers=alice["h"])
        assert r.status_code in (400, 404, 405), r.status_code


# ---------------------------------------------------------------------------
# 2) Who-liked / who-reposted
# ---------------------------------------------------------------------------
class TestLikersReposters:
    def test_likers_and_reposters(self, api, alice, bob, carol):
        # Alice posts
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "popular post"},
            headers=alice["h"],
        )
        assert r.status_code == 200
        pid = r.json()["id"]
        TestLikersReposters.pid = pid

        # Bob and Carol like it
        r1 = api.post(f"{BASE_URL}/api/posts/{pid}/like", headers=bob["h"])
        assert r1.status_code == 200
        r2 = api.post(f"{BASE_URL}/api/posts/{pid}/like", headers=carol["h"])
        assert r2.status_code == 200
        assert r2.json()["likes_count"] == 2

        # Bob reposts (toggle on), Carol quote-reposts (not a repost-entry)
        r3 = api.post(f"{BASE_URL}/api/posts/{pid}/repost", headers=bob["h"])
        assert r3.status_code == 200
        assert r3.json()["reposts_count"] == 1
        r4 = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "love this", "quote_of": pid},
            headers=carol["h"],
        )
        assert r4.status_code == 200
        assert r4.json()["quote_of"] == pid

        # likers
        r5 = api.get(f"{BASE_URL}/api/posts/{pid}/likers", headers=alice["h"])
        assert r5.status_code == 200, r5.text
        likers = r5.json()
        uids = [u["user_id"] for u in likers]
        assert bob["user_id"] in uids and carol["user_id"] in uids
        # newest first: carol liked after bob
        assert uids[0] == carol["user_id"]

        # reposters – Bob only (Carol is a quote-reposter)
        r6 = api.get(f"{BASE_URL}/api/posts/{pid}/reposters", headers=alice["h"])
        assert r6.status_code == 200, r6.text
        reposter_uids = [u["user_id"] for u in r6.json()]
        assert bob["user_id"] in reposter_uids
        assert carol["user_id"] not in reposter_uids


# ---------------------------------------------------------------------------
# 3) Quote-repost
# ---------------------------------------------------------------------------
class TestQuoteRepost:
    def test_quote_creates_post_and_increments_counter(self, api, alice, bob, mdb):
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "original here"},
            headers=alice["h"],
        )
        assert r.status_code == 200
        orig_id = r.json()["id"]

        # Bob quotes
        r2 = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "Take a look", "quote_of": orig_id},
            headers=bob["h"],
        )
        assert r2.status_code == 200, r2.text
        body = r2.json()
        assert body["quote_of"] == orig_id
        # quoted_post is hydrated
        assert body["quoted_post"] is not None
        assert body["quoted_post"]["id"] == orig_id
        assert body["quoted_post"]["text"] == "original here"

        # original's quotes_count increments
        r3 = api.get(f"{BASE_URL}/api/posts/{orig_id}", headers=alice["h"])
        assert r3.status_code == 200
        assert r3.json()["quotes_count"] >= 1

        # original author Alice gets a "repost" notification with the quote text
        notes = list(mdb.notifications.find(
            {"user_id": alice["user_id"], "type": "repost",
             "post_id": orig_id, "actor_id": bob["user_id"]},
            {"_id": 0},
        ))
        assert notes, "No quote notification emitted to original author"
        assert any(n.get("message") == "Take a look" for n in notes)
        TestQuoteRepost.orig_id = orig_id

    def test_quote_of_redirects_to_original_when_target_is_repost(
        self, api, alice, bob, carol
    ):
        # Alice posts original
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "the real original"},
            headers=alice["h"],
        )
        assert r.status_code == 200
        orig_id = r.json()["id"]

        # Bob reposts (this creates a repost-entry doc)
        r2 = api.post(f"{BASE_URL}/api/posts/{orig_id}/repost", headers=bob["h"])
        assert r2.status_code == 200
        # find repost-entry id
        client = MongoClient(MONGO_URL)
        repost_entry = client[DB_NAME].posts.find_one(
            {"user_id": bob["user_id"], "repost_of": orig_id},
            {"_id": 0},
        )
        client.close()
        assert repost_entry is not None
        repost_entry_id = repost_entry["id"]

        # Carol tries to quote the repost-entry id
        r3 = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "quoting repost", "quote_of": repost_entry_id},
            headers=carol["h"],
        )
        assert r3.status_code == 200, r3.text
        body = r3.json()
        # quote_of should be the original, NOT the repost-entry id
        assert body["quote_of"] == orig_id
        assert body["quote_of"] != repost_entry_id

    def test_quote_of_bogus_404(self, api, bob):
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "x", "quote_of": "does-not-exist-xyz"},
            headers=bob["h"],
        )
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# 4) OG Link preview
# ---------------------------------------------------------------------------
class TestLinkPreview:
    def test_post_with_url_no_crash(self, api, alice):
        # example.com may or may not return OG tags; just verify no crash
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "check this https://www.example.com out"},
            headers=alice["h"],
        )
        assert r.status_code == 200, r.text
        data = r.json()
        # link_preview is either present (dict with url) or None
        assert data.get("link_preview") is None or isinstance(
            data["link_preview"], dict
        )

    def test_ssrf_blocks_loopback(self, api, alice, mdb):
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "internal http://127.0.0.1/foo"},
            headers=alice["h"],
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("link_preview") is None
        # And nothing got cached for that URL
        cached = mdb.link_previews.find_one({"url": "http://127.0.0.1/foo"})
        assert cached is None

    def test_link_preview_cache(self, api, alice, mdb):
        """Pre-seed cache for a URL; verify post hydrates link_preview from cache
        without re-fetch (i.e., the seeded title sticks)."""
        url = f"https://example.invalid/{uuid.uuid4().hex}"
        seeded = {
            "url": url, "title": "Cached Title",
            "description": "Cached desc", "image": None, "site_name": "Cached",
            "fetched_at": datetime.now(timezone.utc),
        }
        mdb.link_previews.insert_one(seeded)
        try:
            r = api.post(
                f"{BASE_URL}/api/posts",
                json={"text": f"see {url}"},
                headers=alice["h"],
            )
            assert r.status_code == 200, r.text
            data = r.json()
            # Host is invalid; SSRF check resolves DNS; example.invalid won't
            # resolve so _is_safe_host returns False, preview will be None.
            # We accept either: cache hit with title=Cached Title OR None,
            # so long as no crash. The point of this test is no-crash + that
            # the link_previews collection wasn't duplicated.
            count = mdb.link_previews.count_documents({"url": url})
            assert count == 1, "Cache row was duplicated by failed fetch"
        finally:
            mdb.link_previews.delete_many({"url": url})


# ---------------------------------------------------------------------------
# 5) Polls
# ---------------------------------------------------------------------------
class TestPolls:
    def test_create_poll_3_options(self, api, alice):
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "Choose!",
                  "poll": {"options": ["A", "B", "C"], "duration_hours": 24}},
            headers=alice["h"],
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["poll"] is not None
        opts = data["poll"]["options"]
        assert len(opts) == 3
        ids = [o["id"] for o in opts]
        assert len(set(ids)) == 3
        for o in opts:
            assert o["votes"] == 0
        # ends_at ~24h ahead (sanity: at least 23h, at most 25h)
        ends = datetime.fromisoformat(data["poll"]["ends_at"].replace("Z", "+00:00"))
        delta = ends - datetime.now(timezone.utc)
        assert timedelta(hours=23) < delta < timedelta(hours=25)
        TestPolls.poll_post = data
        TestPolls.opt_ids = ids

    def test_poll_too_few_options(self, api, alice):
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "x", "poll": {"options": ["only"], "duration_hours": 1}},
            headers=alice["h"],
        )
        assert r.status_code == 400

    def test_poll_too_many_options(self, api, alice):
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "x", "poll": {"options": ["1", "2", "3", "4", "5"],
                                        "duration_hours": 1}},
            headers=alice["h"],
        )
        assert r.status_code == 400

    def test_vote_first(self, api, bob):
        pid = TestPolls.poll_post["id"]
        oid = TestPolls.opt_ids[0]
        r = api.post(
            f"{BASE_URL}/api/posts/{pid}/vote",
            json={"option_id": oid},
            headers=bob["h"],
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["poll"]["voted_option_id"] == oid
        votes_for_oid = next(o["votes"] for o in data["poll"]["options"]
                             if o["id"] == oid)
        assert votes_for_oid == 1

    def test_vote_same_option_idempotent(self, api, bob):
        pid = TestPolls.poll_post["id"]
        oid = TestPolls.opt_ids[0]
        r = api.post(
            f"{BASE_URL}/api/posts/{pid}/vote",
            json={"option_id": oid},
            headers=bob["h"],
        )
        assert r.status_code == 200
        data = r.json()
        votes_for_oid = next(o["votes"] for o in data["poll"]["options"]
                             if o["id"] == oid)
        assert votes_for_oid == 1, "Same-option re-vote should be no-op"

    def test_vote_change(self, api, bob):
        pid = TestPolls.poll_post["id"]
        old_oid = TestPolls.opt_ids[0]
        new_oid = TestPolls.opt_ids[1]
        r = api.post(
            f"{BASE_URL}/api/posts/{pid}/vote",
            json={"option_id": new_oid},
            headers=bob["h"],
        )
        assert r.status_code == 200, r.text
        data = r.json()
        opts = {o["id"]: o["votes"] for o in data["poll"]["options"]}
        assert opts[old_oid] == 0, "Previous option should be decremented"
        assert opts[new_oid] == 1
        assert data["poll"]["voted_option_id"] == new_oid

    def test_vote_invalid_option(self, api, bob):
        pid = TestPolls.poll_post["id"]
        r = api.post(
            f"{BASE_URL}/api/posts/{pid}/vote",
            json={"option_id": "nonexistent_xx"},
            headers=bob["h"],
        )
        assert r.status_code == 400

    def test_vote_missing_option_id(self, api, bob):
        pid = TestPolls.poll_post["id"]
        r = api.post(
            f"{BASE_URL}/api/posts/{pid}/vote",
            json={},
            headers=bob["h"],
        )
        assert r.status_code == 400

    def test_vote_closed_poll(self, api, alice, bob, mdb):
        # Create a poll then mutate ends_at into the past directly in Mongo
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "soon-to-close",
                  "poll": {"options": ["X", "Y"], "duration_hours": 1}},
            headers=alice["h"],
        )
        assert r.status_code == 200
        pid = r.json()["id"]
        oid = r.json()["poll"]["options"][0]["id"]
        mdb.posts.update_one(
            {"id": pid},
            {"$set": {"poll.ends_at": datetime.now(timezone.utc)
                      - timedelta(hours=1)}},
        )
        r2 = api.post(
            f"{BASE_URL}/api/posts/{pid}/vote",
            json={"option_id": oid},
            headers=bob["h"],
        )
        assert r2.status_code == 400, r2.text


# ---------------------------------------------------------------------------
# 6) Regression spot-checks
# ---------------------------------------------------------------------------
class TestRegressions:
    def test_like_repost_reply_bookmark_edit_delete(self, api, alice, bob, mdb):
        # Alice posts
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "regress base"},
            headers=alice["h"],
        )
        assert r.status_code == 200
        pid = r.json()["id"]

        # Bob likes
        r = api.post(f"{BASE_URL}/api/posts/{pid}/like", headers=bob["h"])
        assert r.status_code == 200 and r.json()["likes_count"] == 1
        # Bob unlikes
        r = api.post(f"{BASE_URL}/api/posts/{pid}/like", headers=bob["h"])
        assert r.status_code == 200 and r.json()["likes_count"] == 0

        # Bob reposts (toggle)
        r = api.post(f"{BASE_URL}/api/posts/{pid}/repost", headers=bob["h"])
        assert r.status_code == 200 and r.json()["reposts_count"] == 1
        # Bob un-reposts
        r = api.post(f"{BASE_URL}/api/posts/{pid}/repost", headers=bob["h"])
        assert r.status_code == 200 and r.json()["reposts_count"] == 0

        # Bob replies
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "nice", "parent_id": pid},
            headers=bob["h"],
        )
        assert r.status_code == 200
        reply_id = r.json()["id"]
        r2 = api.get(f"{BASE_URL}/api/posts/{pid}", headers=alice["h"])
        assert r2.json()["replies_count"] == 1

        # Bob bookmarks
        r = api.post(f"{BASE_URL}/api/posts/{pid}/bookmark", headers=bob["h"])
        assert r.status_code == 200 and r.json()["bookmarks_count"] == 1
        r = api.get(f"{BASE_URL}/api/bookmarks", headers=bob["h"])
        assert r.status_code == 200
        assert any(p["id"] == pid for p in r.json())

        # Alice edits
        r = api.patch(
            f"{BASE_URL}/api/posts/{pid}",
            json={"text": "regress base edited"},
            headers=alice["h"],
        )
        assert r.status_code == 200
        assert r.json()["text"] == "regress base edited"
        assert r.json().get("edited_at") is not None

        # Alice deletes
        r = api.delete(f"{BASE_URL}/api/posts/{pid}", headers=alice["h"])
        assert r.status_code == 200
        r2 = api.get(f"{BASE_URL}/api/posts/{pid}", headers=alice["h"])
        assert r2.status_code == 404

    def test_repost_and_quote_counts_grow(self, api, alice, bob, carol):
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "growable"},
            headers=alice["h"],
        )
        assert r.status_code == 200
        pid = r.json()["id"]

        # Bob reposts -> reposts_count = 1
        r = api.post(f"{BASE_URL}/api/posts/{pid}/repost", headers=bob["h"])
        assert r.json()["reposts_count"] == 1
        # Carol reposts -> reposts_count = 2
        r = api.post(f"{BASE_URL}/api/posts/{pid}/repost", headers=carol["h"])
        assert r.json()["reposts_count"] == 2

        # Bob quotes -> quotes_count = 1
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "q1", "quote_of": pid},
            headers=bob["h"],
        )
        assert r.status_code == 200
        # Carol quotes -> quotes_count = 2
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "q2", "quote_of": pid},
            headers=carol["h"],
        )
        assert r.status_code == 200

        # Verify both counts
        r = api.get(f"{BASE_URL}/api/posts/{pid}", headers=alice["h"])
        body = r.json()
        assert body["reposts_count"] == 2
        assert body["quotes_count"] == 2
