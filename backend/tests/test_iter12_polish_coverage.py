"""Iteration 12 — Polish coverage gap-filling tests.

These supplement test_iter11_local_auth_views_reels.py with the explicit
endpoints / cases called out in the iter-12 review request:

  * POST /api/auth/register  — spec-listed invalid usernames: "AB!", "ab", "a"*21,
                               and password length == 7 boundary.
  * GET  /api/auth/me        — bearer required + returns current user.
  * PATCH /api/auth/me       — name/bio/picture/home/work patches.
  * POST /api/auth/logout    — invalidates the bearer's session.
  * GET  /api/posts/user/{user_id}        — originals only (parent_id null).
  * POST /api/auth/session   — invalid session_id => 401 (backwards-compat).
"""
import os
import uuid
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
TEST_PREFIX = "TEST_iter12_"


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def mdb():
    c = MongoClient(MONGO_URL)
    yield c[DB_NAME]
    c.close()


def _new_email():
    return f"{TEST_PREFIX}{uuid.uuid4().hex[:8]}@example.com"


def _new_username():
    return f"u_{uuid.uuid4().hex[:10]}"


def _bearer(t):
    return {"Authorization": f"Bearer {t}"}


def _register(api):
    email = _new_email()
    username = _new_username()
    r = api.post(f"{BASE_URL}/api/auth/register", json={
        "email": email, "password": "supersecret123",
        "name": "Polly", "username": username,
    })
    assert r.status_code == 200, r.text
    d = r.json()
    return {
        "token": d["session_token"],
        "user_id": d["user"]["user_id"],
        "email": email,
        "username": username,
    }


@pytest.fixture(scope="module", autouse=True)
def cleanup(mdb):
    yield
    uids = [u["user_id"] for u in mdb.users.find(
        {"email": {"$regex": f"^{TEST_PREFIX}"}}, {"_id": 0, "user_id": 1}
    )]
    if uids:
        mdb.users.delete_many({"user_id": {"$in": uids}})
        mdb.user_sessions.delete_many({"user_id": {"$in": uids}})
        mdb.posts.delete_many({"user_id": {"$in": uids}})


# ---------------------------------------------------------------------------
# Register edge cases explicitly called out in the review request
# ---------------------------------------------------------------------------
class TestRegisterExplicitBadInputs:
    @pytest.mark.parametrize("bad_username", ["AB!", "ab", "a" * 21])
    def test_register_rejects_spec_bad_usernames(self, api, bad_username):
        r = api.post(f"{BASE_URL}/api/auth/register", json={
            "email": _new_email(), "password": "supersecret123",
            "name": "X", "username": bad_username,
        })
        assert r.status_code == 400, (
            f"Expected 400 for username={bad_username!r} but got {r.status_code}: {r.text}"
        )

    def test_register_password_7_chars_rejected(self, api):
        r = api.post(f"{BASE_URL}/api/auth/register", json={
            "email": _new_email(), "password": "1234567",  # 7 chars
            "name": "X", "username": _new_username(),
        })
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# GET / PATCH /api/auth/me
# ---------------------------------------------------------------------------
class TestAuthMe:
    @pytest.fixture(scope="class")
    def me(self, api):
        return _register(api)

    def test_me_requires_bearer(self, api):
        r = api.get(f"{BASE_URL}/api/auth/me")
        assert r.status_code == 401

    def test_me_returns_user(self, api, me):
        r = api.get(f"{BASE_URL}/api/auth/me", headers=_bearer(me["token"]))
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["user_id"] == me["user_id"]
        assert d["email"] == me["email"].lower()
        assert d["username"] == me["username"]

    def test_patch_me_updates_name_bio_picture(self, api, me):
        r = api.patch(f"{BASE_URL}/api/auth/me",
                      headers=_bearer(me["token"]),
                      json={"name": "Polly Updated",
                            "bio": "explorer of maps",
                            "picture": "data:image/png;base64,UPDATED"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["name"] == "Polly Updated"
        assert d["bio"] == "explorer of maps"
        assert d["picture"] == "data:image/png;base64,UPDATED"

        # Persisted: re-GET
        r2 = api.get(f"{BASE_URL}/api/auth/me", headers=_bearer(me["token"]))
        d2 = r2.json()
        assert d2["name"] == "Polly Updated"
        assert d2["bio"] == "explorer of maps"

    def test_patch_me_updates_home_and_work(self, api, me):
        r = api.patch(f"{BASE_URL}/api/auth/me",
                      headers=_bearer(me["token"]),
                      json={"home_name": "Home", "home_longitude": -73.9,
                            "home_latitude": 40.7,
                            "work_name": "Work", "work_longitude": -122.4,
                            "work_latitude": 37.7})
        assert r.status_code == 200
        d = r.json()
        assert d["home_name"] == "Home"
        assert d["home_longitude"] == -73.9
        assert d["home_latitude"] == 40.7
        assert d["work_name"] == "Work"


# ---------------------------------------------------------------------------
# /api/auth/logout
# ---------------------------------------------------------------------------
class TestLogout:
    def test_logout_invalidates_session(self, api):
        u = _register(api)
        # Token works first
        r = api.get(f"{BASE_URL}/api/auth/me", headers=_bearer(u["token"]))
        assert r.status_code == 200
        # Logout
        r2 = api.post(f"{BASE_URL}/api/auth/logout",
                      headers=_bearer(u["token"]))
        assert r2.status_code == 200
        assert r2.json() == {"ok": True}
        # Now the same token must be rejected
        r3 = api.get(f"{BASE_URL}/api/auth/me", headers=_bearer(u["token"]))
        assert r3.status_code == 401

    def test_logout_without_bearer_still_ok(self, api):
        # Endpoint is forgiving: no-bearer logout returns ok (server-side noop).
        r = api.post(f"{BASE_URL}/api/auth/logout")
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# GET /api/posts/user/{user_id} — originals only (parent_id is null)
# ---------------------------------------------------------------------------
class TestUserPostsOriginalsOnly:
    @pytest.fixture(scope="class")
    def scenario(self, api):
        a = _register(api)
        b = _register(api)
        # A creates one original
        p1 = api.post(f"{BASE_URL}/api/posts", headers=_bearer(a["token"]),
                      json={"text": "A original"}).json()
        # A creates a reply to A's own post (parent_id != null — excluded)
        api.post(f"{BASE_URL}/api/posts", headers=_bearer(a["token"]),
                 json={"text": "A reply", "parent_id": p1["id"]})
        # B reposts A's original (repost entry has parent_id == null but
        # belongs to B, not A — so should NOT appear in A's listing)
        api.post(f"{BASE_URL}/api/posts/{p1['id']}/repost",
                 headers=_bearer(b["token"]))
        return {"a": a, "b": b, "post_a": p1["id"]}

    def test_returns_only_a_originals(self, api, scenario):
        r = api.get(f"{BASE_URL}/api/posts/user/{scenario['a']['user_id']}",
                    headers=_bearer(scenario["a"]["token"]))
        assert r.status_code == 200, r.text
        items = r.json()
        ids = {p["id"] for p in items}
        assert scenario["post_a"] in ids
        for p in items:
            # All items must be top-level (parent_id is null)
            assert p.get("parent_id") in (None,)
            # All items must belong to A
            assert p["user_id"] == scenario["a"]["user_id"]

    def test_requires_bearer(self, api, scenario):
        r = api.get(f"{BASE_URL}/api/posts/user/{scenario['a']['user_id']}")
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# Backwards-compat: Emergent /api/auth/session still rejects bad session_ids.
# ---------------------------------------------------------------------------
class TestEmergentSessionBackcompat:
    def test_invalid_session_id_returns_401_or_502(self, api):
        # Live backend calls the real Emergent upstream. Without a real
        # session_id we should get 401 (invalid_session). Allow 502 if the
        # upstream is unreachable in the test env — both prove the route
        # does NOT crash, which is the regression we care about.
        r = api.post(f"{BASE_URL}/api/auth/session",
                     json={"session_id": "definitely-not-a-real-session-id"})
        assert r.status_code in (401, 502), (
            f"Got {r.status_code}: {r.text} — auth/session must NOT 500/crash"
        )
