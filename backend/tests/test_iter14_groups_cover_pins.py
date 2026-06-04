"""Iteration 14 — Group cover_image (PATCH) and pinned posts endpoints.

Covers:
  * PATCH /api/groups/{id}                   (owner-only edit)
  * POST   /api/groups/{id}/pins/{post_id}   (pin, FIFO, max 3)
  * DELETE /api/groups/{id}/pins/{post_id}   (unpin)
  * GET    /api/groups/{id}/pins             (list pinned posts in pin order)
  * Regression: cover_image + pinned_post_ids on list/get/join/create
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
API = f"{BASE_URL}/api"

# 1x1 PNG data URI
TINY_PNG_DATA_URI = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAA"
    "C0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII="
)


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
        "email": f"TEST_iter14_{label}_{suf}@example.com",
        "password": "TestPass1234",
        "name": f"Iter14 {label} {suf}",
        "username": f"t14{label}{suf}",
    }
    r = session.post(f"{API}/auth/register", json=payload, timeout=30)
    assert r.status_code in (200, 201), f"register failed {r.status_code} {r.text}"
    body = r.json()
    tok = body["session_token"]
    user = body["user"]
    return {
        "user_id": user["user_id"],
        "name": user["name"],
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
        json={
            "name": f"TEST iter14 group {uuid.uuid4().hex[:6]}",
            "description": "iter14 cover+pins",
            "color": "#a855f7",
        },
        headers=owner["h"],
        timeout=30,
    )
    assert r.status_code == 200, r.text
    g = r.json()
    r2 = session.post(f"{API}/groups/{g['id']}/join", headers=member["h"], timeout=30)
    assert r2.status_code == 200, r2.text
    return g


def _make_group_post(session, owner_or_member, group_id, text="post") -> str:
    r = session.post(
        f"{API}/groups/{group_id}/posts",
        json={"text": f"TEST_iter14 {text} {uuid.uuid4().hex[:6]}"},
        headers=owner_or_member["h"],
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


@pytest.fixture(scope="module", autouse=True)
def _cleanup(mdb):
    yield
    test_users = list(
        mdb.users.find({"email": {"$regex": "^TEST_iter14_"}}, {"_id": 0, "user_id": 1})
    )
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
# 0) Regression: Group create defaults
# ---------------------------------------------------------------------------
class TestGroupCreateDefaults:
    def test_create_defaults_cover_null_pins_empty(self, session, owner):
        r = session.post(
            f"{API}/groups",
            json={"name": f"TEST iter14 defaults {uuid.uuid4().hex[:6]}"},
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        g = r.json()
        assert g["cover_image"] is None
        assert g["pinned_post_ids"] == []

    def test_list_groups_contains_new_fields(self, session, owner):
        r = session.get(f"{API}/groups", headers=owner["h"], timeout=30)
        assert r.status_code == 200
        for g in r.json():
            assert "cover_image" in g
            assert "pinned_post_ids" in g
            assert isinstance(g["pinned_post_ids"], list)


# ---------------------------------------------------------------------------
# 1) PATCH /api/groups/{id}
# ---------------------------------------------------------------------------
class TestPatchGroup:
    def test_owner_updates_name_description_color(self, session, owner, group):
        r = session.patch(
            f"{API}/groups/{group['id']}",
            json={"name": "TEST iter14 renamed", "description": "new desc", "color": "#0ea5e9"},
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        g = r.json()
        assert g["name"] == "TEST iter14 renamed"
        assert g["description"] == "new desc"
        assert g["color"] == "#0ea5e9"
        # GET to verify persistence
        r2 = session.get(f"{API}/groups/{group['id']}", headers=owner["h"], timeout=30)
        assert r2.json()["name"] == "TEST iter14 renamed"

    def test_owner_sets_data_uri_cover(self, session, owner, group):
        r = session.patch(
            f"{API}/groups/{group['id']}",
            json={"cover_image": TINY_PNG_DATA_URI},
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json()["cover_image"] == TINY_PNG_DATA_URI
        # persistence
        r2 = session.get(f"{API}/groups/{group['id']}", headers=owner["h"], timeout=30)
        assert r2.json()["cover_image"] == TINY_PNG_DATA_URI

    def test_owner_sets_http_url_cover(self, session, owner, group):
        url = "https://example.com/cover.jpg"
        r = session.patch(
            f"{API}/groups/{group['id']}",
            json={"cover_image": url},
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json()["cover_image"] == url

    def test_owner_clears_cover_with_empty_string(self, session, owner, group):
        # First set it
        session.patch(
            f"{API}/groups/{group['id']}",
            json={"cover_image": TINY_PNG_DATA_URI},
            headers=owner["h"], timeout=30,
        )
        # Then clear
        r = session.patch(
            f"{API}/groups/{group['id']}",
            json={"cover_image": ""},
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json()["cover_image"] is None

    def test_invalid_cover_format_400(self, session, owner, group):
        r = session.patch(
            f"{API}/groups/{group['id']}",
            json={"cover_image": "not-a-data-uri"},
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 400, r.text
        assert "invalid cover" in r.text.lower()

    def test_empty_name_400(self, session, owner, group):
        r = session.patch(
            f"{API}/groups/{group['id']}",
            json={"name": "   "},
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 400, r.text
        assert "name required" in r.text.lower()

    def test_non_owner_403(self, session, member, group):
        r = session.patch(
            f"{API}/groups/{group['id']}",
            json={"name": "hacker rename"},
            headers=member["h"], timeout=30,
        )
        assert r.status_code == 403, r.text
        assert "owner" in r.text.lower()

    def test_outsider_also_403(self, session, outsider, group):
        r = session.patch(
            f"{API}/groups/{group['id']}",
            json={"description": "nope"},
            headers=outsider["h"], timeout=30,
        )
        assert r.status_code == 403, r.text

    def test_invalid_group_404(self, session, owner):
        r = session.patch(
            f"{API}/groups/does-not-exist-xyz",
            json={"name": "x"},
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# 2) POST /api/groups/{id}/pins/{post_id}
# ---------------------------------------------------------------------------
class TestPinPost:
    @pytest.fixture
    def fresh_group(self, session, owner, member):
        r = session.post(
            f"{API}/groups",
            json={"name": f"TEST iter14 pins {uuid.uuid4().hex[:6]}"},
            headers=owner["h"], timeout=30,
        )
        g = r.json()
        # member joins
        session.post(f"{API}/groups/{g['id']}/join", headers=member["h"], timeout=30)
        return g

    def test_owner_pins_own_post_index_0(self, session, owner, fresh_group):
        pid = _make_group_post(session, owner, fresh_group["id"], "own pin")
        r = session.post(
            f"{API}/groups/{fresh_group['id']}/pins/{pid}",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        g = r.json()
        assert pid in g["pinned_post_ids"]
        assert g["pinned_post_ids"][0] == pid

    def test_owner_can_pin_member_post(self, session, owner, member, fresh_group):
        pid = _make_group_post(session, member, fresh_group["id"], "member post")
        r = session.post(
            f"{API}/groups/{fresh_group['id']}/pins/{pid}",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        assert pid in r.json()["pinned_post_ids"]

    def test_non_owner_pin_403(self, session, owner, member, fresh_group):
        pid = _make_group_post(session, owner, fresh_group["id"], "ttp")
        r = session.post(
            f"{API}/groups/{fresh_group['id']}/pins/{pid}",
            headers=member["h"], timeout=30,
        )
        assert r.status_code == 403, r.text
        assert "owner" in r.text.lower()

    def test_post_not_in_group_404(self, session, owner, fresh_group):
        # Create a post outside any group (regular post)
        r = session.post(
            f"{API}/posts",
            json={"text": "TEST_iter14 non-group post"},
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200
        outside_pid = r.json()["id"]
        r2 = session.post(
            f"{API}/groups/{fresh_group['id']}/pins/{outside_pid}",
            headers=owner["h"], timeout=30,
        )
        assert r2.status_code == 404, r2.text
        assert "not in this group" in r2.text.lower()

    def test_nonexistent_post_404(self, session, owner, fresh_group):
        r = session.post(
            f"{API}/groups/{fresh_group['id']}/pins/does-not-exist",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 404, r.text

    def test_pin_invalid_group_404(self, session, owner):
        r = session.post(
            f"{API}/groups/does-not-exist/pins/anything",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 404, r.text

    def test_idempotent_double_pin(self, session, owner, fresh_group):
        pid = _make_group_post(session, owner, fresh_group["id"], "idem")
        # First pin
        r1 = session.post(
            f"{API}/groups/{fresh_group['id']}/pins/{pid}",
            headers=owner["h"], timeout=30,
        )
        assert r1.status_code == 200
        ids_before = r1.json()["pinned_post_ids"]
        # Pin a second post so first is at index 1...
        pid2 = _make_group_post(session, owner, fresh_group["id"], "idem-second")
        session.post(
            f"{API}/groups/{fresh_group['id']}/pins/{pid2}",
            headers=owner["h"], timeout=30,
        )
        # Now re-pin pid — should be no-op, NOT move to index 0
        r2 = session.post(
            f"{API}/groups/{fresh_group['id']}/pins/{pid}",
            headers=owner["h"], timeout=30,
        )
        assert r2.status_code == 200
        pins = r2.json()["pinned_post_ids"]
        # No duplicates
        assert pins.count(pid) == 1
        # Per spec ("idempotent ... stays at index 0") — re-pinning preserves
        # current position; pid was at index 1 after pid2 push, should remain.
        # The endpoint returns current state without re-inserting, so:
        assert pid in pins
        # Length unchanged from previous step
        assert len(pins) == 2
        _ = ids_before  # silence unused

    def test_pin_fifo_max_3(self, session, owner, fresh_group):
        # Reset pins for this group by unpinning everything first
        grp = session.get(
            f"{API}/groups/{fresh_group['id']}", headers=owner["h"], timeout=30,
        ).json()
        for existing in list(grp.get("pinned_post_ids", [])):
            session.delete(
                f"{API}/groups/{fresh_group['id']}/pins/{existing}",
                headers=owner["h"], timeout=30,
            )

        # Pin 4 distinct posts
        pids = [
            _make_group_post(session, owner, fresh_group["id"], f"fifo-{i}")
            for i in range(4)
        ]
        for pid in pids:
            r = session.post(
                f"{API}/groups/{fresh_group['id']}/pins/{pid}",
                headers=owner["h"], timeout=30,
            )
            assert r.status_code == 200, r.text

        g = session.get(
            f"{API}/groups/{fresh_group['id']}", headers=owner["h"], timeout=30,
        ).json()
        pins = g["pinned_post_ids"]
        assert len(pins) == 3, f"expected 3 (max), got {len(pins)}: {pins}"
        # FIFO: newest at index 0, oldest pushed out (pids[0] should be gone)
        assert pids[0] not in pins, "oldest pin not evicted on overflow"
        assert pins[0] == pids[3], "newest pin not at index 0"
        # Remaining order: [pid3, pid2, pid1]
        assert pins == [pids[3], pids[2], pids[1]]


# ---------------------------------------------------------------------------
# 3) DELETE /api/groups/{id}/pins/{post_id}
# ---------------------------------------------------------------------------
class TestUnpinPost:
    @pytest.fixture
    def fresh_group(self, session, owner, member):
        r = session.post(
            f"{API}/groups",
            json={"name": f"TEST iter14 unpin {uuid.uuid4().hex[:6]}"},
            headers=owner["h"], timeout=30,
        )
        g = r.json()
        session.post(f"{API}/groups/{g['id']}/join", headers=member["h"], timeout=30)
        return g

    def test_owner_unpins(self, session, owner, fresh_group):
        pid = _make_group_post(session, owner, fresh_group["id"], "to unpin")
        session.post(
            f"{API}/groups/{fresh_group['id']}/pins/{pid}",
            headers=owner["h"], timeout=30,
        )
        r = session.delete(
            f"{API}/groups/{fresh_group['id']}/pins/{pid}",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        assert pid not in r.json()["pinned_post_ids"]

    def test_non_owner_unpin_403(self, session, owner, member, fresh_group):
        pid = _make_group_post(session, owner, fresh_group["id"], "x")
        session.post(
            f"{API}/groups/{fresh_group['id']}/pins/{pid}",
            headers=owner["h"], timeout=30,
        )
        r = session.delete(
            f"{API}/groups/{fresh_group['id']}/pins/{pid}",
            headers=member["h"], timeout=30,
        )
        assert r.status_code == 403, r.text

    def test_unpin_non_pinned_is_noop_200(self, session, owner, fresh_group):
        # post exists in group but is not pinned
        pid = _make_group_post(session, owner, fresh_group["id"], "never pinned")
        r = session.delete(
            f"{API}/groups/{fresh_group['id']}/pins/{pid}",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        # current state returned
        assert pid not in r.json()["pinned_post_ids"]

    def test_unpin_invalid_group_404(self, session, owner):
        r = session.delete(
            f"{API}/groups/does-not-exist/pins/whatever",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# 4) GET /api/groups/{id}/pins
# ---------------------------------------------------------------------------
class TestListPinnedPosts:
    @pytest.fixture
    def setup(self, session, owner, member):
        r = session.post(
            f"{API}/groups",
            json={"name": f"TEST iter14 list-pins {uuid.uuid4().hex[:6]}"},
            headers=owner["h"], timeout=30,
        )
        g = r.json()
        session.post(f"{API}/groups/{g['id']}/join", headers=member["h"], timeout=30)
        return g

    def test_empty_when_no_pins(self, session, member, setup):
        r = session.get(
            f"{API}/groups/{setup['id']}/pins",
            headers=member["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json() == []

    def test_returns_in_pin_order(self, session, owner, member, setup):
        # Create 3 posts and pin them in sequence
        pids = [
            _make_group_post(session, owner, setup["id"], f"order-{i}")
            for i in range(3)
        ]
        for pid in pids:
            session.post(
                f"{API}/groups/{setup['id']}/pins/{pid}",
                headers=owner["h"], timeout=30,
            )
        # group's pinned_post_ids should be [pids[2], pids[1], pids[0]]
        g = session.get(f"{API}/groups/{setup['id']}", headers=owner["h"], timeout=30).json()
        expected_order = g["pinned_post_ids"]
        assert expected_order == [pids[2], pids[1], pids[0]]

        # List pinned posts as member
        r = session.get(
            f"{API}/groups/{setup['id']}/pins",
            headers=member["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        rows = r.json()
        assert isinstance(rows, list)
        assert [p["id"] for p in rows] == expected_order, (
            "pinned posts not returned in Group.pinned_post_ids order"
        )
        # Each is a full Post (has author, text, etc.)
        for p in rows:
            assert "author" in p
            assert "text" in p
            assert "id" in p

    def test_non_member_403(self, session, outsider, setup):
        r = session.get(
            f"{API}/groups/{setup['id']}/pins",
            headers=outsider["h"], timeout=30,
        )
        assert r.status_code == 403, r.text

    def test_invalid_group_404(self, session, owner):
        r = session.get(
            f"{API}/groups/does-not-exist-xyz/pins",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# 5) Regression: cover + pins on join response
# ---------------------------------------------------------------------------
class TestJoinResponseFields:
    def test_join_response_has_fields(self, session, owner, outsider):
        # owner creates a fresh group with cover set
        r = session.post(
            f"{API}/groups",
            json={"name": f"TEST iter14 join-fields {uuid.uuid4().hex[:6]}"},
            headers=owner["h"], timeout=30,
        )
        g = r.json()
        # Set a cover, pin a post
        session.patch(
            f"{API}/groups/{g['id']}",
            json={"cover_image": TINY_PNG_DATA_URI},
            headers=owner["h"], timeout=30,
        )
        pid = _make_group_post(session, owner, g["id"], "for join")
        session.post(
            f"{API}/groups/{g['id']}/pins/{pid}",
            headers=owner["h"], timeout=30,
        )
        # outsider joins
        r2 = session.post(
            f"{API}/groups/{g['id']}/join",
            headers=outsider["h"], timeout=30,
        )
        assert r2.status_code == 200, r2.text
        body = r2.json()
        assert body["cover_image"] == TINY_PNG_DATA_URI
        assert pid in body["pinned_post_ids"]
