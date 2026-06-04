"""Iteration 13 — Groups endpoints unified with main posts collection.

Verifies the change that group posts are now stored in `db.posts` with a
`group_id` stamp instead of a separate `db.group_posts`.

Coverage:
  * POST /api/groups/{group_id}/posts — member, non-member, invalid group,
    owner, with media/poll/parent_id/quote_of
  * GET  /api/groups/{group_id}/posts — list returns only group's top-level
    posts (no replies), non-member 403, invalid 404
  * GET  /api/groups/{group_id}/members (NEW) — list, non-member 403, owner role
  * Feed isolation regression — group posts MUST NOT appear in /feed/explore
    or /feed/home, but DO appear in /posts/user/{user_id}
  * Standard ops on group posts — like/unlike works (no membership check),
    reply via /api/posts works and has NO group_id
"""
import os
import uuid
from typing import Optional

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

API = f"{BASE_URL}/api"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def mdb():
    c = MongoClient(MONGO_URL)
    db = c[DB_NAME]
    yield db
    c.close()


def _register(session, label: str) -> dict:
    suf = uuid.uuid4().hex[:8]
    payload = {
        "email": f"TEST_iter13_{label}_{suf}@example.com",
        "password": "TestPass1234",
        "name": f"Iter13 {label} {suf}",
        "username": f"t13{label}{suf}",
    }
    r = session.post(f"{API}/auth/register", json=payload, timeout=30)
    assert r.status_code in (200, 201), f"register failed {r.status_code} {r.text}"
    body = r.json()
    tok = body["session_token"]
    user = body["user"]
    return {
        "user_id": user["user_id"],
        "name": user["name"],
        "email": user["email"],
        "token": tok,
        "h": {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
    }


@pytest.fixture(scope="module")
def owner(session):
    return _register(session, "owner")


@pytest.fixture(scope="module")
def member(session):
    return _register(session, "member")


@pytest.fixture(scope="module")
def outsider(session):
    return _register(session, "outsider")


@pytest.fixture(scope="module")
def group(session, owner, member):
    r = session.post(
        f"{API}/groups",
        json={"name": f"TEST iter13 group {uuid.uuid4().hex[:6]}",
              "description": "iter13 test group", "color": "#22c55e"},
        headers=owner["h"], timeout=30,
    )
    assert r.status_code == 200, r.text
    g = r.json()
    # member joins
    r2 = session.post(f"{API}/groups/{g['id']}/join", headers=member["h"], timeout=30)
    assert r2.status_code == 200, r2.text
    yield g


@pytest.fixture(scope="module", autouse=True)
def _cleanup(mdb, request):
    yield
    # Tear down: delete users/sessions/posts/groups/notifications/etc created
    # under iter13 prefix.
    test_users = list(mdb.users.find(
        {"email": {"$regex": "^TEST_iter13_"}}, {"_id": 0, "user_id": 1}
    ))
    uids = [u["user_id"] for u in test_users]
    if uids:
        mdb.user_sessions.delete_many({"user_id": {"$in": uids}})
        mdb.users.delete_many({"user_id": {"$in": uids}})
        mdb.posts.delete_many({"user_id": {"$in": uids}})
        mdb.post_likes.delete_many({"user_id": {"$in": uids}})
        mdb.post_bookmarks.delete_many({"user_id": {"$in": uids}})
        mdb.notifications.delete_many({"$or": [
            {"user_id": {"$in": uids}}, {"actor_id": {"$in": uids}}
        ]})
        mdb.group_members.delete_many({"user_id": {"$in": uids}})
        mdb.groups.delete_many({"owner_id": {"$in": uids}})


# ---------------------------------------------------------------------------
# 1) POST /api/groups/{group_id}/posts
# ---------------------------------------------------------------------------
class TestCreateGroupPost:
    def test_owner_can_post_text(self, session, owner, group, mdb):
        r = session.post(
            f"{API}/groups/{group['id']}/posts",
            json={"text": "TEST_iter13 owner top-level post"},
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        post = r.json()
        assert post["text"] == "TEST_iter13 owner top-level post"
        assert post["user_id"] == owner["user_id"]
        # Verify group_id stamped in raw doc
        raw = mdb.posts.find_one({"id": post["id"]}, {"_id": 0})
        assert raw is not None
        assert raw.get("group_id") == group["id"]

    def test_member_can_post_text(self, session, member, group):
        r = session.post(
            f"{API}/groups/{group['id']}/posts",
            json={"text": "TEST_iter13 member post"},
            headers=member["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json()["text"] == "TEST_iter13 member post"

    def test_non_member_403(self, session, outsider, group):
        r = session.post(
            f"{API}/groups/{group['id']}/posts",
            json={"text": "should fail"},
            headers=outsider["h"], timeout=30,
        )
        assert r.status_code == 403, r.text
        assert "member" in r.text.lower()

    def test_invalid_group_404(self, session, owner):
        r = session.post(
            f"{API}/groups/does-not-exist-xyz/posts",
            json={"text": "nope"},
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 404, r.text

    def test_post_with_media(self, session, owner, group, mdb):
        media = [{
            "type": "image",
            # tiny base64 (1x1 png) ish — just a small string, server only checks length
            "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
            "width": 1, "height": 1,
        }]
        r = session.post(
            f"{API}/groups/{group['id']}/posts",
            json={"text": "TEST_iter13 media", "media": media},
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        post = r.json()
        assert len(post.get("media") or []) == 1
        raw = mdb.posts.find_one({"id": post["id"]}, {"_id": 0})
        assert raw.get("group_id") == group["id"]

    def test_post_with_poll(self, session, owner, group, mdb):
        r = session.post(
            f"{API}/groups/{group['id']}/posts",
            json={
                "text": "TEST_iter13 poll q?",
                "poll": {"options": ["a", "b", "c"], "duration_hours": 24},
            },
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        post = r.json()
        assert post.get("poll") is not None
        assert len(post["poll"]["options"]) == 3
        raw = mdb.posts.find_one({"id": post["id"]}, {"_id": 0})
        assert raw.get("group_id") == group["id"]

    def test_post_as_reply_parent_id(self, session, owner, group, mdb):
        # First make a parent inside the group
        r1 = session.post(
            f"{API}/groups/{group['id']}/posts",
            json={"text": "TEST_iter13 parent for reply"},
            headers=owner["h"], timeout=30,
        )
        assert r1.status_code == 200
        parent_id = r1.json()["id"]
        # Reply via the group-post endpoint (with parent_id in body)
        r2 = session.post(
            f"{API}/groups/{group['id']}/posts",
            json={"text": "TEST_iter13 reply via group endpoint",
                  "parent_id": parent_id},
            headers=owner["h"], timeout=30,
        )
        assert r2.status_code == 200, r2.text
        reply = r2.json()
        assert reply["parent_id"] == parent_id
        # Also stamped with group_id
        raw = mdb.posts.find_one({"id": reply["id"]}, {"_id": 0})
        assert raw.get("group_id") == group["id"]

    def test_post_with_quote_of(self, session, owner, group, mdb):
        # Quote a post that exists (any existing one). Use a fresh one.
        r1 = session.post(
            f"{API}/groups/{group['id']}/posts",
            json={"text": "TEST_iter13 quote target"},
            headers=owner["h"], timeout=30,
        )
        target_id = r1.json()["id"]
        r2 = session.post(
            f"{API}/groups/{group['id']}/posts",
            json={"text": "TEST_iter13 quoting", "quote_of": target_id},
            headers=owner["h"], timeout=30,
        )
        assert r2.status_code == 200, r2.text
        post = r2.json()
        assert post.get("quote_of") == target_id
        raw = mdb.posts.find_one({"id": post["id"]}, {"_id": 0})
        assert raw.get("group_id") == group["id"]


# ---------------------------------------------------------------------------
# 2) GET /api/groups/{group_id}/posts
# ---------------------------------------------------------------------------
class TestListGroupPosts:
    def test_member_can_list(self, session, member, group):
        r = session.get(
            f"{API}/groups/{group['id']}/posts",
            headers=member["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(data, list)
        assert len(data) >= 1

    def test_replies_excluded(self, session, owner, group):
        r = session.get(
            f"{API}/groups/{group['id']}/posts",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        for p in r.json():
            assert p.get("parent_id") in (None, ""), (
                f"reply leaked into group list: {p['id']}"
            )

    def test_sorted_desc_by_created_at(self, session, owner, group):
        r = session.get(
            f"{API}/groups/{group['id']}/posts",
            headers=owner["h"], timeout=30,
        )
        data = r.json()
        ts = [p["created_at"] for p in data]
        assert ts == sorted(ts, reverse=True), "posts not sorted desc"

    def test_non_member_403(self, session, outsider, group):
        r = session.get(
            f"{API}/groups/{group['id']}/posts",
            headers=outsider["h"], timeout=30,
        )
        assert r.status_code == 403, r.text

    def test_invalid_group_404(self, session, owner):
        r = session.get(
            f"{API}/groups/does-not-exist-xyz/posts",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# 3) GET /api/groups/{group_id}/members  (NEW)
# ---------------------------------------------------------------------------
class TestListGroupMembers:
    def test_member_lists_members(self, session, owner, member, group):
        r = session.get(
            f"{API}/groups/{group['id']}/members",
            headers=member["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        rows = r.json()
        assert isinstance(rows, list)
        assert len(rows) >= 2
        by_uid = {row["user_id"]: row for row in rows}
        assert owner["user_id"] in by_uid
        assert member["user_id"] in by_uid
        # Required keys present
        for row in rows:
            for k in ("user_id", "name", "username", "picture",
                      "role", "joined_at"):
                assert k in row, f"missing key {k} in member row"

    def test_owner_role_correct(self, session, member, owner, group):
        r = session.get(
            f"{API}/groups/{group['id']}/members",
            headers=member["h"], timeout=30,
        )
        rows = r.json()
        by_uid = {row["user_id"]: row for row in rows}
        assert by_uid[owner["user_id"]]["role"] == "owner"
        assert by_uid[member["user_id"]]["role"] == "member"

    def test_non_member_403(self, session, outsider, group):
        r = session.get(
            f"{API}/groups/{group['id']}/members",
            headers=outsider["h"], timeout=30,
        )
        assert r.status_code == 403, r.text


# ---------------------------------------------------------------------------
# 4) Feed isolation regression
# ---------------------------------------------------------------------------
class TestFeedIsolation:
    """Group posts must NOT appear in explore/home feeds but SHOULD show in
    user-profile feed."""

    def test_group_post_not_in_explore(self, session, owner, group):
        marker = f"TEST_iter13_isolation_explore_{uuid.uuid4().hex[:6]}"
        r = session.post(
            f"{API}/groups/{group['id']}/posts",
            json={"text": marker},
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200
        gp_id = r.json()["id"]
        # /feed/explore
        r2 = session.get(f"{API}/feed/explore", headers=owner["h"], timeout=30)
        assert r2.status_code == 200
        ids = [p["id"] for p in r2.json()]
        assert gp_id not in ids, "group post leaked into /feed/explore"
        texts = [p.get("text", "") for p in r2.json()]
        assert marker not in texts

    def test_group_post_not_in_home(self, session, owner, group):
        marker = f"TEST_iter13_isolation_home_{uuid.uuid4().hex[:6]}"
        r = session.post(
            f"{API}/groups/{group['id']}/posts",
            json={"text": marker},
            headers=owner["h"], timeout=30,
        )
        gp_id = r.json()["id"]
        r2 = session.get(f"{API}/feed/home", headers=owner["h"], timeout=30)
        assert r2.status_code == 200
        ids = [p["id"] for p in r2.json()]
        assert gp_id not in ids, "group post leaked into /feed/home"

    def test_group_post_in_user_profile_feed(self, session, owner, group):
        marker = f"TEST_iter13_profile_{uuid.uuid4().hex[:6]}"
        r = session.post(
            f"{API}/groups/{group['id']}/posts",
            json={"text": marker},
            headers=owner["h"], timeout=30,
        )
        gp_id = r.json()["id"]
        r2 = session.get(
            f"{API}/posts/user/{owner['user_id']}",
            headers=owner["h"], timeout=30,
        )
        assert r2.status_code == 200
        ids = [p["id"] for p in r2.json()]
        assert gp_id in ids, (
            "group post missing from /posts/user/{user_id} profile feed"
        )


# ---------------------------------------------------------------------------
# 5) Standard post operations on group posts
# ---------------------------------------------------------------------------
class TestStandardOpsOnGroupPosts:
    @pytest.fixture
    def gpost(self, session, owner, group):
        r = session.post(
            f"{API}/groups/{group['id']}/posts",
            json={"text": f"TEST_iter13 standard ops {uuid.uuid4().hex[:6]}"},
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200
        return r.json()

    def test_like_unlike_works_even_for_non_member(
        self, session, outsider, gpost
    ):
        # Outsider (NOT a group member) can still like — by design, no
        # membership check at /posts/{id}/like layer.
        r = session.post(
            f"{API}/posts/{gpost['id']}/like",
            headers=outsider["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        liked = r.json()
        assert liked["likes_count"] == 1
        # unlike
        r2 = session.post(
            f"{API}/posts/{gpost['id']}/like",
            headers=outsider["h"], timeout=30,
        )
        assert r2.status_code == 200
        assert r2.json()["likes_count"] == 0

    def test_reply_via_main_posts_has_no_group_id(
        self, session, owner, gpost, mdb
    ):
        # Reply through the main /api/posts endpoint with parent_id.
        # Per design, replies through /api/posts do NOT get group_id stamped.
        r = session.post(
            f"{API}/posts",
            json={"text": "TEST_iter13 reply via main endpoint",
                  "parent_id": gpost["id"]},
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        reply = r.json()
        assert reply["parent_id"] == gpost["id"]
        raw = mdb.posts.find_one({"id": reply["id"]}, {"_id": 0})
        # Critical assertion from the review request
        assert "group_id" not in raw or raw.get("group_id") is None, (
            f"reply via /api/posts unexpectedly got group_id="
            f"{raw.get('group_id')}"
        )
