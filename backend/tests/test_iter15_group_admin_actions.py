"""Iteration 15 — Group admin actions + private groups w/ join approval.

Covers:
  * Group.is_private field (POST/PATCH/GET return it)
  * Group hydration extras: my_role, membership_pending, pending_request_count
  * POST /api/groups/{id}/join semantics:
      - public → immediate member
      - private → creates pending join_request, owner gets notification
      - already member → no-op
      - duplicate pending → idempotent
  * POST /api/groups/{id}/members/{target_id}/promote (owner only)
  * POST /api/groups/{id}/members/{target_id}/demote (owner only)
  * DELETE /api/groups/{id}/members/{target_id} (kick — owner OR admin)
  * GET /api/groups/{id}/requests (owner/admin only)
  * POST /api/groups/{id}/requests/{target_id}/approve / reject
  * Regression: leave still works; owner-cannot-leave; leaving clears pending req
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
        "email": f"TEST_iter15_{label}_{suf}@example.com",
        "password": "TestPass1234",
        "name": f"Iter15 {label} {suf}",
        "username": f"t15{label}{suf}"[:20],
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
def alice(session):
    return _register(session, "alice")


@pytest.fixture(scope="module")
def bob(session):
    return _register(session, "bob")


@pytest.fixture(scope="module")
def carol(session):
    return _register(session, "carol")


@pytest.fixture(scope="module")
def outsider(session):
    return _register(session, "outsider")


def _create_group(session, owner, *, is_private: bool, name_suffix: str = "") -> dict:
    r = session.post(
        f"{API}/groups",
        json={
            "name": f"TEST iter15 {'priv' if is_private else 'pub'} {name_suffix} {uuid.uuid4().hex[:6]}",
            "description": "iter15 admin actions",
            "color": "#10b981",
            "is_private": is_private,
        },
        headers=owner["h"],
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module", autouse=True)
def _cleanup(mdb):
    yield
    test_users = list(
        mdb.users.find({"email": {"$regex": "^TEST_iter15_"}}, {"_id": 0, "user_id": 1})
    )
    uids = [u["user_id"] for u in test_users]
    if uids:
        mdb.user_sessions.delete_many({"user_id": {"$in": uids}})
        mdb.users.delete_many({"user_id": {"$in": uids}})
        mdb.posts.delete_many({"user_id": {"$in": uids}})
        mdb.notifications.delete_many({"$or": [
            {"user_id": {"$in": uids}}, {"actor_id": {"$in": uids}}
        ]})
        mdb.group_members.delete_many({"user_id": {"$in": uids}})
        mdb.group_join_requests.delete_many({"user_id": {"$in": uids}})
        owner_groups = list(
            mdb.groups.find({"owner_id": {"$in": uids}}, {"_id": 0, "id": 1})
        )
        gids = [g["id"] for g in owner_groups]
        if gids:
            mdb.group_members.delete_many({"group_id": {"$in": gids}})
            mdb.group_join_requests.delete_many({"group_id": {"$in": gids}})
            mdb.groups.delete_many({"id": {"$in": gids}})


# ---------------------------------------------------------------------------
# (1) is_private field round-trips
# ---------------------------------------------------------------------------
class TestIsPrivateField:
    def test_create_default_is_public(self, session, owner):
        r = session.post(
            f"{API}/groups",
            json={"name": f"TEST iter15 default {uuid.uuid4().hex[:6]}"},
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["is_private"] is False
        assert "my_role" in body and body["my_role"] == "owner"
        assert body.get("membership_pending") is False
        assert body.get("pending_request_count") == 0

    def test_create_explicit_private(self, session, owner):
        g = _create_group(session, owner, is_private=True)
        assert g["is_private"] is True
        # GET round-trip
        r = session.get(f"{API}/groups/{g['id']}", headers=owner["h"], timeout=30)
        assert r.status_code == 200
        assert r.json()["is_private"] is True

    def test_patch_toggles_is_private(self, session, owner):
        g = _create_group(session, owner, is_private=False)
        r = session.patch(
            f"{API}/groups/{g['id']}",
            json={"is_private": True}, headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json()["is_private"] is True
        # Toggle back
        r2 = session.patch(
            f"{API}/groups/{g['id']}",
            json={"is_private": False}, headers=owner["h"], timeout=30,
        )
        assert r2.json()["is_private"] is False

    def test_list_includes_is_private(self, session, owner):
        r = session.get(f"{API}/groups", headers=owner["h"], timeout=30)
        assert r.status_code == 200
        rows = r.json()
        assert all("is_private" in row for row in rows)
        assert all("my_role" in row for row in rows)


# ---------------------------------------------------------------------------
# (2) Hydration extras: my_role / membership_pending / pending_request_count
# ---------------------------------------------------------------------------
class TestHydrationExtras:
    def test_owner_sees_owner_role(self, session, owner):
        g = _create_group(session, owner, is_private=False)
        r = session.get(f"{API}/groups/{g['id']}", headers=owner["h"], timeout=30)
        body = r.json()
        assert body["my_role"] == "owner"
        assert body["pending_request_count"] == 0

    def test_non_member_outsider_has_default_role_and_no_pending(
        self, session, owner, outsider
    ):
        g = _create_group(session, owner, is_private=False)
        r = session.get(f"{API}/groups/{g['id']}", headers=outsider["h"], timeout=30)
        body = r.json()
        # Default role string from hydration is "member" for non-members
        assert body["my_role"] == "member"
        assert body["is_member"] is False
        assert body["membership_pending"] is False
        # pending_request_count only surfaces to owners/admins
        assert body["pending_request_count"] == 0


# ---------------------------------------------------------------------------
# (3) join semantics
# ---------------------------------------------------------------------------
class TestJoinSemantics:
    def test_public_join_immediate(self, session, owner, alice):
        g = _create_group(session, owner, is_private=False)
        r = session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["is_member"] is True
        assert body["my_role"] == "member"
        assert body["membership_pending"] is False
        assert body["member_count"] == 2

    def test_private_join_creates_pending_request(
        self, session, owner, alice, mdb
    ):
        g = _create_group(session, owner, is_private=True)
        before = mdb.group_join_requests.count_documents(
            {"group_id": g["id"], "user_id": alice["user_id"]}
        )
        assert before == 0
        r = session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["is_member"] is False
        assert body["membership_pending"] is True
        assert body["member_count"] == 1  # owner only — alice did NOT become member

        req = mdb.group_join_requests.find_one(
            {"group_id": g["id"], "user_id": alice["user_id"]}
        )
        assert req is not None
        assert req["status"] == "pending"

        # Owner gets a notification of type group_join_request
        notif = mdb.notifications.find_one({
            "user_id": owner["user_id"],
            "actor_id": alice["user_id"],
            "type": "group_join_request",
            "group_id": g["id"],
        })
        assert notif is not None

        # Owner sees pending_request_count = 1
        gr = session.get(f"{API}/groups/{g['id']}", headers=owner["h"], timeout=30)
        assert gr.json()["pending_request_count"] == 1

    def test_private_join_idempotent(self, session, owner, bob, mdb):
        g = _create_group(session, owner, is_private=True)
        r1 = session.post(f"{API}/groups/{g['id']}/join", headers=bob["h"], timeout=30)
        assert r1.status_code == 200
        r2 = session.post(f"{API}/groups/{g['id']}/join", headers=bob["h"], timeout=30)
        assert r2.status_code == 200
        assert r2.json()["membership_pending"] is True
        # Still exactly one pending row
        n = mdb.group_join_requests.count_documents(
            {"group_id": g["id"], "user_id": bob["user_id"], "status": "pending"}
        )
        assert n == 1

    def test_already_member_join_is_noop(self, session, owner, alice):
        g = _create_group(session, owner, is_private=False)
        # alice joins
        r1 = session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        assert r1.status_code == 200
        before_count = r1.json()["member_count"]
        # second call → still member, count unchanged
        r2 = session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        assert r2.status_code == 200
        body = r2.json()
        assert body["is_member"] is True
        assert body["member_count"] == before_count


# ---------------------------------------------------------------------------
# (4) Promote
# ---------------------------------------------------------------------------
class TestPromote:
    def test_owner_promotes_member_to_admin(self, session, owner, alice):
        g = _create_group(session, owner, is_private=False)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        r = session.post(
            f"{API}/groups/{g['id']}/members/{alice['user_id']}/promote",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        # Verify by alice's own GET — should see admin role
        gr = session.get(f"{API}/groups/{g['id']}", headers=alice["h"], timeout=30)
        assert gr.json()["my_role"] == "admin"

    def test_non_owner_promote_forbidden(self, session, owner, alice, bob):
        g = _create_group(session, owner, is_private=False)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        session.post(f"{API}/groups/{g['id']}/join", headers=bob["h"], timeout=30)
        # Promote alice to admin first
        session.post(
            f"{API}/groups/{g['id']}/members/{alice['user_id']}/promote",
            headers=owner["h"], timeout=30,
        )
        # alice (admin) tries to promote bob → 403
        r = session.post(
            f"{API}/groups/{g['id']}/members/{bob['user_id']}/promote",
            headers=alice["h"], timeout=30,
        )
        assert r.status_code == 403

    def test_promote_owner_returns_400(self, session, owner):
        g = _create_group(session, owner, is_private=False)
        r = session.post(
            f"{API}/groups/{g['id']}/members/{owner['user_id']}/promote",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 400

    def test_promote_non_member_returns_404(self, session, owner, outsider):
        g = _create_group(session, owner, is_private=False)
        r = session.post(
            f"{API}/groups/{g['id']}/members/{outsider['user_id']}/promote",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# (5) Demote
# ---------------------------------------------------------------------------
class TestDemote:
    def test_owner_demotes_admin_to_member(self, session, owner, alice):
        g = _create_group(session, owner, is_private=False)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        session.post(
            f"{API}/groups/{g['id']}/members/{alice['user_id']}/promote",
            headers=owner["h"], timeout=30,
        )
        r = session.post(
            f"{API}/groups/{g['id']}/members/{alice['user_id']}/demote",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        gr = session.get(f"{API}/groups/{g['id']}", headers=alice["h"], timeout=30)
        assert gr.json()["my_role"] == "member"

    def test_non_owner_demote_forbidden(self, session, owner, alice, bob):
        g = _create_group(session, owner, is_private=False)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        session.post(f"{API}/groups/{g['id']}/join", headers=bob["h"], timeout=30)
        r = session.post(
            f"{API}/groups/{g['id']}/members/{bob['user_id']}/demote",
            headers=alice["h"], timeout=30,
        )
        assert r.status_code == 403

    def test_demote_owner_returns_400(self, session, owner):
        g = _create_group(session, owner, is_private=False)
        r = session.post(
            f"{API}/groups/{g['id']}/members/{owner['user_id']}/demote",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 400
        assert "owner" in r.text.lower()

    def test_demote_non_member_returns_404(self, session, owner, outsider):
        g = _create_group(session, owner, is_private=False)
        r = session.post(
            f"{API}/groups/{g['id']}/members/{outsider['user_id']}/demote",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# (6) Kick
# ---------------------------------------------------------------------------
class TestKick:
    def test_owner_kicks_member(self, session, owner, alice):
        g = _create_group(session, owner, is_private=False)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        r = session.delete(
            f"{API}/groups/{g['id']}/members/{alice['user_id']}",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        # alice should now see herself as non-member
        gr = session.get(f"{API}/groups/{g['id']}", headers=alice["h"], timeout=30)
        assert gr.json()["is_member"] is False

    def test_admin_kicks_member(self, session, owner, alice, bob):
        g = _create_group(session, owner, is_private=False)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        session.post(f"{API}/groups/{g['id']}/join", headers=bob["h"], timeout=30)
        # promote alice to admin
        session.post(
            f"{API}/groups/{g['id']}/members/{alice['user_id']}/promote",
            headers=owner["h"], timeout=30,
        )
        # alice kicks bob
        r = session.delete(
            f"{API}/groups/{g['id']}/members/{bob['user_id']}",
            headers=alice["h"], timeout=30,
        )
        assert r.status_code == 200, r.text

    def test_admin_cannot_kick_another_admin(self, session, owner, alice, bob):
        g = _create_group(session, owner, is_private=False)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        session.post(f"{API}/groups/{g['id']}/join", headers=bob["h"], timeout=30)
        session.post(
            f"{API}/groups/{g['id']}/members/{alice['user_id']}/promote",
            headers=owner["h"], timeout=30,
        )
        session.post(
            f"{API}/groups/{g['id']}/members/{bob['user_id']}/promote",
            headers=owner["h"], timeout=30,
        )
        r = session.delete(
            f"{API}/groups/{g['id']}/members/{bob['user_id']}",
            headers=alice["h"], timeout=30,
        )
        assert r.status_code == 403

    def test_kick_owner_returns_400(self, session, owner, alice):
        g = _create_group(session, owner, is_private=False)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        session.post(
            f"{API}/groups/{g['id']}/members/{alice['user_id']}/promote",
            headers=owner["h"], timeout=30,
        )
        # Even owner trying to kick owner → 400
        r = session.delete(
            f"{API}/groups/{g['id']}/members/{owner['user_id']}",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 400

    def test_non_admin_kick_forbidden(self, session, owner, alice, bob):
        g = _create_group(session, owner, is_private=False)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        session.post(f"{API}/groups/{g['id']}/join", headers=bob["h"], timeout=30)
        # alice is a plain member trying to kick bob
        r = session.delete(
            f"{API}/groups/{g['id']}/members/{bob['user_id']}",
            headers=alice["h"], timeout=30,
        )
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# (7) List join requests
# ---------------------------------------------------------------------------
class TestListJoinRequests:
    def test_owner_lists_pending_requests(self, session, owner, alice, bob):
        g = _create_group(session, owner, is_private=True)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        session.post(f"{API}/groups/{g['id']}/join", headers=bob["h"], timeout=30)
        r = session.get(f"{API}/groups/{g['id']}/requests", headers=owner["h"], timeout=30)
        assert r.status_code == 200, r.text
        rows = r.json()
        assert isinstance(rows, list)
        uids = {row["user_id"] for row in rows}
        assert alice["user_id"] in uids
        assert bob["user_id"] in uids
        # each row must include name and user_id
        for row in rows:
            assert "user_id" in row
            assert "name" in row
            assert "created_at" in row

    def test_admin_can_list_requests(self, session, owner, alice, bob):
        g = _create_group(session, owner, is_private=True)
        # alice joins public group first (we need her to be a member to promote)
        # Make group public temporarily to add alice as member, then re-private.
        session.patch(f"{API}/groups/{g['id']}", json={"is_private": False},
                      headers=owner["h"], timeout=30)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        session.patch(f"{API}/groups/{g['id']}", json={"is_private": True},
                      headers=owner["h"], timeout=30)
        session.post(
            f"{API}/groups/{g['id']}/members/{alice['user_id']}/promote",
            headers=owner["h"], timeout=30,
        )
        # bob requests to join the now-private group
        session.post(f"{API}/groups/{g['id']}/join", headers=bob["h"], timeout=30)
        # alice (admin) lists requests
        r = session.get(f"{API}/groups/{g['id']}/requests", headers=alice["h"], timeout=30)
        assert r.status_code == 200, r.text
        uids = {row["user_id"] for row in r.json()}
        assert bob["user_id"] in uids

    def test_non_admin_list_requests_forbidden(self, session, owner, outsider):
        g = _create_group(session, owner, is_private=True)
        r = session.get(
            f"{API}/groups/{g['id']}/requests", headers=outsider["h"], timeout=30
        )
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# (8) Approve
# ---------------------------------------------------------------------------
class TestApprove:
    def test_owner_approves_request(self, session, owner, alice, mdb):
        g = _create_group(session, owner, is_private=True)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        r = session.post(
            f"{API}/groups/{g['id']}/requests/{alice['user_id']}/approve",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        # alice should now be a member
        gr = session.get(f"{API}/groups/{g['id']}", headers=alice["h"], timeout=30)
        assert gr.json()["is_member"] is True
        assert gr.json()["membership_pending"] is False
        # request marked approved
        req = mdb.group_join_requests.find_one(
            {"group_id": g["id"], "user_id": alice["user_id"]}
        )
        assert req["status"] == "approved"
        # alice gets notification
        notif = mdb.notifications.find_one({
            "user_id": alice["user_id"],
            "actor_id": owner["user_id"],
            "type": "group_request_approved",
            "group_id": g["id"],
        })
        assert notif is not None

    def test_approve_with_no_pending_returns_404(self, session, owner, outsider):
        g = _create_group(session, owner, is_private=True)
        r = session.post(
            f"{API}/groups/{g['id']}/requests/{outsider['user_id']}/approve",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 404

    def test_non_admin_approve_forbidden(self, session, owner, alice, outsider):
        g = _create_group(session, owner, is_private=True)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        r = session.post(
            f"{API}/groups/{g['id']}/requests/{alice['user_id']}/approve",
            headers=outsider["h"], timeout=30,
        )
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# (9) Reject
# ---------------------------------------------------------------------------
class TestReject:
    def test_owner_rejects_request(self, session, owner, alice, mdb):
        g = _create_group(session, owner, is_private=True)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        r = session.post(
            f"{API}/groups/{g['id']}/requests/{alice['user_id']}/reject",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 200, r.text
        req = mdb.group_join_requests.find_one(
            {"group_id": g["id"], "user_id": alice["user_id"]}
        )
        assert req["status"] == "rejected"
        # alice did NOT become member
        gr = session.get(f"{API}/groups/{g['id']}", headers=alice["h"], timeout=30)
        assert gr.json()["is_member"] is False
        assert gr.json()["membership_pending"] is False
        # alice got rejection notification
        notif = mdb.notifications.find_one({
            "user_id": alice["user_id"],
            "actor_id": owner["user_id"],
            "type": "group_request_rejected",
            "group_id": g["id"],
        })
        assert notif is not None

    def test_reject_no_pending_returns_404(self, session, owner, outsider):
        g = _create_group(session, owner, is_private=True)
        r = session.post(
            f"{API}/groups/{g['id']}/requests/{outsider['user_id']}/reject",
            headers=owner["h"], timeout=30,
        )
        assert r.status_code == 404

    def test_non_admin_reject_forbidden(self, session, owner, alice, outsider):
        g = _create_group(session, owner, is_private=True)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        r = session.post(
            f"{API}/groups/{g['id']}/requests/{alice['user_id']}/reject",
            headers=outsider["h"], timeout=30,
        )
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# (10) Regression
# ---------------------------------------------------------------------------
class TestRegression:
    def test_public_join_flow_still_works(self, session, owner, alice):
        g = _create_group(session, owner, is_private=False)
        r = session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        assert r.status_code == 200
        assert r.json()["is_member"] is True

    def test_owner_cannot_leave(self, session, owner):
        g = _create_group(session, owner, is_private=False)
        r = session.post(f"{API}/groups/{g['id']}/leave", headers=owner["h"], timeout=30)
        assert r.status_code == 400

    def test_leaving_clears_pending_request(self, session, owner, alice, mdb):
        # Private group → alice has a pending request
        g = _create_group(session, owner, is_private=True)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        # Owner approves so alice becomes a member with a row in requests as approved
        session.post(
            f"{API}/groups/{g['id']}/requests/{alice['user_id']}/approve",
            headers=owner["h"], timeout=30,
        )
        # Now flip group to private again and have alice re-request after leaving
        # First alice leaves
        r_leave = session.post(
            f"{API}/groups/{g['id']}/leave", headers=alice["h"], timeout=30
        )
        assert r_leave.status_code == 200
        # alice re-joins → new pending request
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        # Now leave again — should clear pending too
        session.post(f"{API}/groups/{g['id']}/leave", headers=alice["h"], timeout=30)
        # Confirm no pending requests remain for alice
        n = mdb.group_join_requests.count_documents(
            {"group_id": g["id"], "user_id": alice["user_id"], "status": "pending"}
        )
        assert n == 0

    def test_members_list_still_works(self, session, owner, alice):
        g = _create_group(session, owner, is_private=False)
        session.post(f"{API}/groups/{g['id']}/join", headers=alice["h"], timeout=30)
        r = session.get(
            f"{API}/groups/{g['id']}/members", headers=owner["h"], timeout=30
        )
        assert r.status_code == 200
        rows = r.json()
        uids = {row["user_id"] for row in rows}
        assert owner["user_id"] in uids
        assert alice["user_id"] in uids
        # owner role surfaced
        owner_row = next(row for row in rows if row["user_id"] == owner["user_id"])
        assert owner_row["role"] == "owner"
