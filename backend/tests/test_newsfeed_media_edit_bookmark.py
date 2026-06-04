"""Backend tests for Newsfeed: media on posts, edit (PATCH), bookmarks.

Auth: seed users + sessions directly in Mongo (Emergent Google OAuth,
no password). Bearer <session_token>.

Endpoints covered:
  * POST /api/posts with media (image, video), text-only fallback, empty rejection
  * PATCH /api/posts/{id} (owner edit, edited_at, 404 for non-owner, 400 empty)
  * POST /api/posts/{id}/bookmark toggle + GET /api/bookmarks listing
  * Regressions: like / repost (text=="", repost_of set) / reply (notification)
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


# Tiny 1x1 JPEG-ish base64 (valid data-URI prefix; backend doesn't decode it)
TINY_IMG = (
    "data:image/jpeg;base64,"
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB"
)
TINY_VID = "data:video/mp4;base64," + ("A" * 64)


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
    email = f"TEST_news_{suf}@example.com"
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


def _cleanup(mdb, uid):
    mdb.user_sessions.delete_many({"user_id": uid})
    mdb.users.delete_many({"user_id": uid})
    for coll in ("posts", "post_likes", "post_bookmarks", "notifications"):
        try:
            mdb[coll].delete_many({"user_id": uid})
        except Exception:
            pass
    try:
        mdb.notifications.delete_many({"actor_id": uid})
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
# Health
# ---------------------------------------------------------------------------
class TestHealth:
    def test_root(self, api):
        r = api.get(f"{BASE_URL}/api/")
        assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# Media on POST /api/posts
# ---------------------------------------------------------------------------
class TestPostMedia:
    def test_create_with_media_only_empty_text_ok(self, api, alice):
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "", "media": [{"type": "image", "base64": TINY_IMG}]},
            headers=alice["h"],
        )
        assert r.status_code == 200, r.text
        post = r.json()
        assert post["text"] == ""
        assert isinstance(post.get("media"), list)
        assert len(post["media"]) == 1
        assert post["media"][0]["type"] == "image"
        assert post["media"][0]["base64"] == TINY_IMG
        # New fields
        assert "bookmarks_count" in post and post["bookmarks_count"] == 0
        assert "bookmarked_by_me" in post and post["bookmarked_by_me"] is False
        assert "edited_at" in post and post["edited_at"] in (None,)

    def test_create_text_only_still_works(self, api, alice):
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "text-only regression"},
            headers=alice["h"],
        )
        assert r.status_code == 200, r.text
        post = r.json()
        assert post["text"] == "text-only regression"
        assert post["media"] == []
        assert post["bookmarks_count"] == 0

    def test_create_empty_text_and_no_media_rejected(self, api, alice):
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": ""},
            headers=alice["h"],
        )
        assert r.status_code == 400, r.text

        r2 = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "", "media": []},
            headers=alice["h"],
        )
        assert r2.status_code == 400, r2.text

    def test_create_media_capped_at_4(self, api, alice):
        m = [{"type": "image", "base64": TINY_IMG} for _ in range(6)]
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "many media", "media": m},
            headers=alice["h"],
        )
        assert r.status_code == 200, r.text
        post = r.json()
        assert len(post["media"]) == 4, f"expected slice to 4, got {len(post['media'])}"

    def test_oversize_media_413(self, api, alice):
        # > 8MB encoded
        big = "data:image/jpeg;base64," + ("A" * (8 * 1024 * 1024 + 100))
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "big", "media": [{"type": "image", "base64": big}]},
            headers=alice["h"],
        )
        assert r.status_code == 413, r.text

    def test_video_media_read_back(self, api, alice):
        r = api.post(
            f"{BASE_URL}/api/posts",
            json={
                "text": "vid",
                "media": [{"type": "video", "base64": TINY_VID}],
            },
            headers=alice["h"],
        )
        assert r.status_code == 200, r.text
        pid = r.json()["id"]
        # Read back via GET
        g = api.get(f"{BASE_URL}/api/posts/{pid}", headers=alice["h"])
        assert g.status_code == 200
        post = g.json()
        assert len(post["media"]) == 1
        assert post["media"][0]["type"] == "video"
        assert post["media"][0]["base64"] == TINY_VID


# ---------------------------------------------------------------------------
# PATCH /api/posts/{id}
# ---------------------------------------------------------------------------
class TestEditPost:
    def test_edit_text_sets_edited_at(self, api, alice):
        cr = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "original text"},
            headers=alice["h"],
        )
        assert cr.status_code == 200
        post = cr.json()
        assert post["edited_at"] is None
        pid = post["id"]

        pr = api.patch(
            f"{BASE_URL}/api/posts/{pid}",
            json={"text": "edited text"},
            headers=alice["h"],
        )
        assert pr.status_code == 200, pr.text
        body = pr.json()
        assert body["text"] == "edited text"
        assert body["edited_at"] is not None, "edited_at must be set after PATCH"

        # Re-GET confirms persistence
        g = api.get(f"{BASE_URL}/api/posts/{pid}", headers=alice["h"])
        assert g.status_code == 200
        assert g.json()["text"] == "edited text"
        assert g.json()["edited_at"] is not None

    def test_edit_media_replaces(self, api, alice):
        cr = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "with media",
                  "media": [{"type": "image", "base64": TINY_IMG}]},
            headers=alice["h"],
        )
        assert cr.status_code == 200
        pid = cr.json()["id"]

        # Replace with two media
        pr = api.patch(
            f"{BASE_URL}/api/posts/{pid}",
            json={"media": [
                {"type": "image", "base64": TINY_IMG},
                {"type": "video", "base64": TINY_VID},
            ]},
            headers=alice["h"],
        )
        assert pr.status_code == 200, pr.text
        body = pr.json()
        assert len(body["media"]) == 2
        types = [m["type"] for m in body["media"]]
        assert "image" in types and "video" in types

    def test_edit_non_owner_404(self, api, alice, bob):
        cr = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "alice owns"},
            headers=alice["h"],
        )
        assert cr.status_code == 200
        pid = cr.json()["id"]

        pr = api.patch(
            f"{BASE_URL}/api/posts/{pid}",
            json={"text": "bob tries"},
            headers=bob["h"],
        )
        assert pr.status_code == 404, pr.text

    def test_edit_to_empty_400(self, api, alice):
        cr = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "will go empty"},
            headers=alice["h"],
        )
        assert cr.status_code == 200
        pid = cr.json()["id"]
        pr = api.patch(
            f"{BASE_URL}/api/posts/{pid}",
            json={"text": "", "media": []},
            headers=alice["h"],
        )
        assert pr.status_code == 400, pr.text

    def test_edit_auth_required(self, api):
        pr = requests.patch(
            f"{BASE_URL}/api/posts/{uuid.uuid4()}",
            json={"text": "x"},
        )
        assert pr.status_code == 401, pr.text


# ---------------------------------------------------------------------------
# Bookmarks
# ---------------------------------------------------------------------------
class TestBookmarks:
    def test_bookmark_toggle_and_listing(self, api, alice, bob):
        # Alice creates a post
        cr = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "bookmark me"},
            headers=alice["h"],
        )
        assert cr.status_code == 200
        post = cr.json()
        pid = post["id"]
        assert post["bookmarks_count"] == 0
        assert post["bookmarked_by_me"] is False

        # Bob bookmarks
        on = api.post(
            f"{BASE_URL}/api/posts/{pid}/bookmark",
            headers=bob["h"],
        )
        assert on.status_code == 200, on.text
        body = on.json()
        assert body["bookmarked_by_me"] is True
        assert body["bookmarks_count"] == 1

        # GET /api/bookmarks lists it
        lst = api.get(f"{BASE_URL}/api/bookmarks", headers=bob["h"])
        assert lst.status_code == 200, lst.text
        items = lst.json()
        assert any(p["id"] == pid for p in items), "bookmarked post must be listed"
        # Verify it shows bookmarked_by_me=True from Bob's perspective
        item = next(p for p in items if p["id"] == pid)
        assert item["bookmarked_by_me"] is True
        assert item["bookmarks_count"] == 1

        # Toggle off
        off = api.post(
            f"{BASE_URL}/api/posts/{pid}/bookmark",
            headers=bob["h"],
        )
        assert off.status_code == 200, off.text
        body2 = off.json()
        assert body2["bookmarked_by_me"] is False
        assert body2["bookmarks_count"] == 0

        # GET /api/bookmarks no longer lists it
        lst2 = api.get(f"{BASE_URL}/api/bookmarks", headers=bob["h"])
        assert lst2.status_code == 200
        assert not any(p["id"] == pid for p in lst2.json())

    def test_bookmark_newest_first(self, api, alice, bob):
        # Create two posts, bookmark in order
        p1 = api.post(f"{BASE_URL}/api/posts", json={"text": "p1"},
                      headers=alice["h"]).json()
        p2 = api.post(f"{BASE_URL}/api/posts", json={"text": "p2"},
                      headers=alice["h"]).json()

        api.post(f"{BASE_URL}/api/posts/{p1['id']}/bookmark", headers=bob["h"])
        # Ensure ordering differentiation
        import time
        time.sleep(0.05)
        api.post(f"{BASE_URL}/api/posts/{p2['id']}/bookmark", headers=bob["h"])

        lst = api.get(f"{BASE_URL}/api/bookmarks", headers=bob["h"])
        assert lst.status_code == 200, lst.text
        items = lst.json()
        # The two bookmarked posts must appear, newest (p2) before older (p1)
        ids = [p["id"] for p in items if p["id"] in (p1["id"], p2["id"])]
        assert ids[:2] == [p2["id"], p1["id"]], f"expected newest-first, got {ids}"

        # Cleanup
        api.post(f"{BASE_URL}/api/posts/{p1['id']}/bookmark", headers=bob["h"])
        api.post(f"{BASE_URL}/api/posts/{p2['id']}/bookmark", headers=bob["h"])

    def test_bookmark_auth_required(self, api):
        r = requests.post(f"{BASE_URL}/api/posts/anything/bookmark")
        assert r.status_code == 401, r.text

    def test_bookmark_unknown_post_404(self, api, alice):
        r = api.post(
            f"{BASE_URL}/api/posts/{uuid.uuid4()}/bookmark",
            headers=alice["h"],
        )
        assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# Regressions
# ---------------------------------------------------------------------------
class TestRegressions:
    def test_like_still_works(self, api, alice, bob):
        cr = api.post(f"{BASE_URL}/api/posts", json={"text": "like me"},
                      headers=alice["h"])
        assert cr.status_code == 200
        pid = cr.json()["id"]

        on = api.post(f"{BASE_URL}/api/posts/{pid}/like", headers=bob["h"])
        assert on.status_code == 200
        assert on.json()["likes_count"] == 1
        assert on.json()["liked_by_me"] is True

        off = api.post(f"{BASE_URL}/api/posts/{pid}/like", headers=bob["h"])
        assert off.status_code == 200
        assert off.json()["likes_count"] == 0
        assert off.json()["liked_by_me"] is False

    def test_repost_still_works(self, api, alice, bob, mdb):
        cr = api.post(f"{BASE_URL}/api/posts", json={"text": "repost me"},
                      headers=alice["h"])
        assert cr.status_code == 200
        pid = cr.json()["id"]

        rr = api.post(f"{BASE_URL}/api/posts/{pid}/repost", headers=bob["h"])
        assert rr.status_code == 200
        assert rr.json()["reposts_count"] == 1
        assert rr.json()["reposted_by_me"] is True

        # The repost entry must have text="" and repost_of=pid
        repost_row = mdb.posts.find_one(
            {"user_id": bob["user_id"], "repost_of": pid}, {"_id": 0}
        )
        assert repost_row is not None
        assert repost_row["text"] == ""
        assert repost_row["repost_of"] == pid

        # Toggle off
        off = api.post(f"{BASE_URL}/api/posts/{pid}/repost", headers=bob["h"])
        assert off.status_code == 200
        assert off.json()["reposts_count"] == 0

    def test_reply_emits_notification(self, api, alice, bob, mdb):
        cr = api.post(f"{BASE_URL}/api/posts", json={"text": "parent post"},
                      headers=alice["h"])
        assert cr.status_code == 200
        pid = cr.json()["id"]

        rep = api.post(
            f"{BASE_URL}/api/posts",
            json={"text": "a reply", "parent_id": pid},
            headers=bob["h"],
        )
        assert rep.status_code == 200, rep.text
        assert rep.json()["parent_id"] == pid

        # Parent replies_count should have incremented
        g = api.get(f"{BASE_URL}/api/posts/{pid}", headers=alice["h"])
        assert g.status_code == 200
        assert g.json()["replies_count"] >= 1

        # Notification should exist for Alice from Bob, ntype=reply
        notif = mdb.notifications.find_one(
            {
                "user_id": alice["user_id"],
                "actor_id": bob["user_id"],
                "type": "reply",
                "post_id": pid,
            },
            {"_id": 0},
        )
        assert notif is not None, "reply notification must be emitted to parent author"

    def test_delete_still_works(self, api, alice):
        cr = api.post(f"{BASE_URL}/api/posts", json={"text": "delete me"},
                      headers=alice["h"])
        assert cr.status_code == 200
        pid = cr.json()["id"]
        d = api.delete(f"{BASE_URL}/api/posts/{pid}", headers=alice["h"])
        assert d.status_code == 200, d.text
        g = api.get(f"{BASE_URL}/api/posts/{pid}", headers=alice["h"])
        assert g.status_code == 404
