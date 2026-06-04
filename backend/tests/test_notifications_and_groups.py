"""Iteration 8 backend tests:

Covers:
  * NEW: /api/notifications/* (list, unread count, mark one, mark all, delete)
  * NEW: /api/conversations/groups (group creation + group_invite notifications)
  * NEW: PATCH /api/conversations/{id} (rename / add / remove members; owner-only)
  * NEW: POST /api/conversations/{id}/leave (member leave, owner transfer, owner alone deletes)
  * NEW: DELETE /api/conversations/{id} (soft delete DM, leave for group)
  * Notifications side-effects of like / repost / reply (and no self-notify)
  * Resurfacing of soft-deleted DM when the other party sends a new message
  * Old messages hidden from a user who soft-deleted, until a new one arrives

Auth: seed Emergent Google OAuth users + sessions directly in Mongo.
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


def _seed_user(mdb, name="Tester"):
    suf = uuid.uuid4().hex[:8]
    uid = f"user_TEST_{suf}"
    tok = f"TESTTOK_{uuid.uuid4().hex}"
    mdb.users.insert_one({
        "user_id": uid,
        "email": f"TEST_iter8_{suf}@example.com",
        "name": name,
        "picture": None, "bio": "",
        "created_at": datetime.now(timezone.utc),
    })
    mdb.user_sessions.insert_one({
        "session_token": tok, "user_id": uid,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=1),
        "created_at": datetime.now(timezone.utc),
    })
    return {"user_id": uid, "token": tok, "name": name,
            "h": {"Authorization": f"Bearer {tok}"}}


def _cleanup(mdb, uid):
    mdb.user_sessions.delete_many({"user_id": uid})
    mdb.users.delete_many({"user_id": uid})
    for coll in ("posts", "post_likes", "notifications", "messages"):
        try:
            mdb[coll].delete_many({"user_id": uid})
        except Exception:
            pass
    mdb.notifications.delete_many({"actor_id": uid})
    mdb.messages.delete_many({"sender_id": uid})
    mdb.conversations.delete_many({"participant_ids": uid})


@pytest.fixture(scope="module")
def alice(mdb):
    u = _seed_user(mdb, "Alice ITER8")
    yield u
    _cleanup(mdb, u["user_id"])


@pytest.fixture(scope="module")
def bob(mdb):
    u = _seed_user(mdb, "Bob ITER8")
    yield u
    _cleanup(mdb, u["user_id"])


@pytest.fixture(scope="module")
def carol(mdb):
    u = _seed_user(mdb, "Carol ITER8")
    yield u
    _cleanup(mdb, u["user_id"])


# ---------------------------------------------------------------------------
# Sanity
# ---------------------------------------------------------------------------
class TestHealth:
    def test_root(self, api):
        r = api.get(f"{BASE_URL}/api/")
        assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# Notifications via post interactions
# ---------------------------------------------------------------------------
class TestNotificationsFromPosts:
    def test_like_notification_and_no_self_notify(self, api, alice, bob, mdb):
        # Clear any existing notifications for Alice
        mdb.notifications.delete_many({"user_id": alice["user_id"]})

        # Alice posts
        p = api.post(f"{BASE_URL}/api/posts",
                     json={"text": "Notif like test"},
                     headers=alice["h"])
        assert p.status_code == 200, p.text
        pid = p.json()["id"]

        # Alice self-likes -> NO notification
        sl = api.post(f"{BASE_URL}/api/posts/{pid}/like", headers=alice["h"])
        assert sl.status_code == 200
        n_self = api.get(f"{BASE_URL}/api/notifications", headers=alice["h"]).json()
        assert all(n.get("post_id") != pid or n.get("type") != "like" for n in n_self), \
            "Self-like must NOT create a like notification"
        # Toggle off
        api.post(f"{BASE_URL}/api/posts/{pid}/like", headers=alice["h"])

        # Bob likes -> Alice gets a like notification
        bl = api.post(f"{BASE_URL}/api/posts/{pid}/like", headers=bob["h"])
        assert bl.status_code == 200, bl.text
        notifs = api.get(f"{BASE_URL}/api/notifications", headers=alice["h"]).json()
        like_notifs = [n for n in notifs if n.get("type") == "like" and n.get("post_id") == pid]
        assert len(like_notifs) == 1, like_notifs
        ln = like_notifs[0]
        assert ln["actor_id"] == bob["user_id"]
        assert ln["actor_name"] == "Bob ITER8"
        assert ln["read"] is False

    def test_repost_notification_and_no_self_notify(self, api, alice, bob, mdb):
        mdb.notifications.delete_many({"user_id": alice["user_id"], "type": "repost"})
        p = api.post(f"{BASE_URL}/api/posts",
                     json={"text": "Notif repost test"},
                     headers=alice["h"])
        pid = p.json()["id"]
        # Self-repost: must not create
        api.post(f"{BASE_URL}/api/posts/{pid}/repost", headers=alice["h"])
        n_self = api.get(f"{BASE_URL}/api/notifications", headers=alice["h"]).json()
        assert all(not (n.get("type") == "repost" and n.get("post_id") == pid) for n in n_self), \
            "Self-repost must NOT create a notification"
        # Toggle off
        api.post(f"{BASE_URL}/api/posts/{pid}/repost", headers=alice["h"])

        # Bob reposts -> Alice gets repost notif
        rb = api.post(f"{BASE_URL}/api/posts/{pid}/repost", headers=bob["h"])
        assert rb.status_code == 200, rb.text
        notifs = api.get(f"{BASE_URL}/api/notifications", headers=alice["h"]).json()
        repost_notifs = [n for n in notifs if n.get("type") == "repost" and n.get("post_id") == pid]
        assert len(repost_notifs) == 1
        assert repost_notifs[0]["actor_id"] == bob["user_id"]

    def test_reply_notification_and_no_self_notify(self, api, alice, bob, mdb):
        mdb.notifications.delete_many({"user_id": alice["user_id"], "type": "reply"})
        p = api.post(f"{BASE_URL}/api/posts",
                     json={"text": "Notif reply test"},
                     headers=alice["h"])
        pid = p.json()["id"]
        # Self-reply
        api.post(f"{BASE_URL}/api/posts",
                 json={"text": "self reply", "parent_id": pid},
                 headers=alice["h"])
        n_self = api.get(f"{BASE_URL}/api/notifications", headers=alice["h"]).json()
        assert all(not (n.get("type") == "reply" and n.get("post_id") == pid) for n in n_self), \
            "Self-reply must NOT create a notification"

        # Bob replies -> Alice gets a reply notif
        br = api.post(f"{BASE_URL}/api/posts",
                      json={"text": "hi Alice", "parent_id": pid},
                      headers=bob["h"])
        assert br.status_code == 200, br.text
        notifs = api.get(f"{BASE_URL}/api/notifications", headers=alice["h"]).json()
        reply_notifs = [n for n in notifs if n.get("type") == "reply" and n.get("post_id") == pid]
        assert len(reply_notifs) == 1
        assert reply_notifs[0]["actor_id"] == bob["user_id"]
        assert "hi Alice" in (reply_notifs[0].get("message") or "")


# ---------------------------------------------------------------------------
# Notification listing / counts / read / delete
# ---------------------------------------------------------------------------
class TestNotificationCRUD:
    def test_list_sorted_newest_first(self, api, alice):
        notifs = api.get(f"{BASE_URL}/api/notifications", headers=alice["h"]).json()
        assert isinstance(notifs, list)
        assert len(notifs) >= 1, "expected some notifs after previous tests"
        # Newest first
        timestamps = [n["created_at"] for n in notifs]
        assert timestamps == sorted(timestamps, reverse=True)
        # actor_name hydrated
        for n in notifs:
            if n.get("actor_id"):
                assert n.get("actor_name") is not None

    def test_unread_count(self, api, alice):
        r = api.get(f"{BASE_URL}/api/notifications/unread", headers=alice["h"])
        assert r.status_code == 200, r.text
        body = r.json()
        assert "count" in body and isinstance(body["count"], int) and body["count"] >= 1

    def test_mark_one_read(self, api, alice):
        notifs = api.get(f"{BASE_URL}/api/notifications", headers=alice["h"]).json()
        unread = next((n for n in notifs if not n["read"]), None)
        assert unread is not None
        r = api.post(f"{BASE_URL}/api/notifications/{unread['id']}/read", headers=alice["h"])
        assert r.status_code == 200, r.text
        # GET again -> that one should be read
        notifs2 = api.get(f"{BASE_URL}/api/notifications", headers=alice["h"]).json()
        target = next(n for n in notifs2 if n["id"] == unread["id"])
        assert target["read"] is True

    def test_mark_one_read_404_for_unknown(self, api, alice):
        r = api.post(f"{BASE_URL}/api/notifications/{uuid.uuid4()}/read", headers=alice["h"])
        assert r.status_code == 404

    def test_mark_all_read(self, api, alice):
        r = api.post(f"{BASE_URL}/api/notifications/read-all", headers=alice["h"])
        assert r.status_code == 200
        u = api.get(f"{BASE_URL}/api/notifications/unread", headers=alice["h"]).json()
        assert u["count"] == 0

    def test_delete_notification(self, api, alice):
        notifs = api.get(f"{BASE_URL}/api/notifications", headers=alice["h"]).json()
        assert notifs, "need at least one notif to delete"
        nid = notifs[0]["id"]
        d = api.delete(f"{BASE_URL}/api/notifications/{nid}", headers=alice["h"])
        assert d.status_code == 200, d.text
        notifs2 = api.get(f"{BASE_URL}/api/notifications", headers=alice["h"]).json()
        assert all(n["id"] != nid for n in notifs2)

    def test_delete_404_when_not_yours(self, api, alice, bob, mdb):
        # Create a notif for Bob directly
        nid = str(uuid.uuid4())
        mdb.notifications.insert_one({
            "id": nid, "user_id": bob["user_id"], "type": "like",
            "actor_id": alice["user_id"], "post_id": None,
            "conversation_id": None, "group_id": None,
            "message": "", "read": False,
            "created_at": datetime.now(timezone.utc),
        })
        # Alice tries to delete Bob's notif
        r = api.delete(f"{BASE_URL}/api/notifications/{nid}", headers=alice["h"])
        assert r.status_code == 404

    def test_auth_required(self, api):
        for path, method in [
            ("/api/notifications", "GET"),
            ("/api/notifications/unread", "GET"),
            ("/api/notifications/x/read", "POST"),
            ("/api/notifications/read-all", "POST"),
            ("/api/notifications/x", "DELETE"),
        ]:
            r = requests.request(method, f"{BASE_URL}{path}")
            assert r.status_code == 401, f"{method} {path} -> {r.status_code}"


# ---------------------------------------------------------------------------
# Group conversations
# ---------------------------------------------------------------------------
class TestGroupChats:
    @pytest.fixture(scope="class")
    def group(self, api, alice, bob, carol, mdb):
        # Clear existing notifs for accurate assertion
        mdb.notifications.delete_many({"user_id": {"$in": [bob["user_id"], carol["user_id"]]}, "type": "group_invite"})
        r = api.post(
            f"{BASE_URL}/api/conversations/groups",
            json={"name": "Atlas Roadtrip", "member_ids": [bob["user_id"], carol["user_id"]]},
            headers=alice["h"],
        )
        assert r.status_code == 200, r.text
        conv = r.json()
        yield conv
        # cleanup
        try:
            mdb.conversations.delete_one({"id": conv["id"]})
            mdb.messages.delete_many({"conversation_id": conv["id"]})
            mdb.notifications.delete_many({"conversation_id": conv["id"]})
        except Exception:
            pass

    def test_group_creation_shape(self, group, alice):
        assert group["kind"] == "group"
        assert group["name"] == "Atlas Roadtrip"
        assert group["owner_id"] == alice["user_id"]
        assert len(group["members"]) >= 2

    def test_group_invite_notifs_sent(self, api, group, bob, carol, alice):
        bnotifs = api.get(f"{BASE_URL}/api/notifications", headers=bob["h"]).json()
        cnotifs = api.get(f"{BASE_URL}/api/notifications", headers=carol["h"]).json()
        bn = [n for n in bnotifs if n.get("type") == "group_invite" and n.get("conversation_id") == group["id"]]
        cn = [n for n in cnotifs if n.get("type") == "group_invite" and n.get("conversation_id") == group["id"]]
        assert len(bn) == 1 and bn[0]["actor_id"] == alice["user_id"]
        assert len(cn) == 1 and cn[0]["actor_id"] == alice["user_id"]
        # Alice does NOT get one for her own group creation
        an = api.get(f"{BASE_URL}/api/notifications", headers=alice["h"]).json()
        assert not any(n.get("type") == "group_invite" and n.get("conversation_id") == group["id"] for n in an)

    def test_group_listed_for_all_members(self, api, group, alice, bob, carol):
        for u in (alice, bob, carol):
            r = api.get(f"{BASE_URL}/api/conversations", headers=u["h"])
            assert r.status_code == 200, r.text
            ids = [c["id"] for c in r.json() if c.get("kind") == "group"]
            assert group["id"] in ids, f"group missing from {u['name']}'s list"

    def test_group_message_notifications(self, api, group, alice, bob, carol, mdb):
        # clear group_message notifs for cleanliness
        mdb.notifications.delete_many({"conversation_id": group["id"], "type": "group_message"})
        r = api.post(
            f"{BASE_URL}/api/conversations/{group['id']}/messages",
            json={"type": "text", "text": "hello team"},
            headers=alice["h"],
        )
        assert r.status_code == 200, r.text
        # Bob & Carol get group_message; Alice does NOT
        for u, expected in [(bob, 1), (carol, 1), (alice, 0)]:
            notifs = api.get(f"{BASE_URL}/api/notifications", headers=u["h"]).json()
            gm = [n for n in notifs if n.get("type") == "group_message" and n.get("conversation_id") == group["id"]]
            assert len(gm) == expected, f"{u['name']} got {len(gm)} group_message notifs (expected {expected})"

    def test_patch_owner_can_rename_and_add(self, api, group, alice, bob, carol, mdb):
        # seed a new user to add
        dave = _seed_user(mdb, "Dave ITER8")
        try:
            r = api.patch(
                f"{BASE_URL}/api/conversations/{group['id']}",
                json={"name": "Atlas Trip 2026", "add_member_ids": [dave["user_id"]]},
                headers=alice["h"],
            )
            assert r.status_code == 200, r.text
            data = r.json()
            assert data["name"] == "Atlas Trip 2026"
            member_ids = [m["user_id"] for m in data["members"]]
            assert dave["user_id"] in member_ids
            # Dave got group_invite
            dn = api.get(f"{BASE_URL}/api/notifications", headers=dave["h"]).json()
            assert any(n.get("type") == "group_invite" and n.get("conversation_id") == group["id"] for n in dn)
            # Remove dave from the group so cleanup doesn't blow away the shared fixture conv
            api.patch(
                f"{BASE_URL}/api/conversations/{group['id']}",
                json={"remove_member_ids": [dave["user_id"]]},
                headers=alice["h"],
            )
        finally:
            _cleanup(mdb, dave["user_id"])

    def test_patch_non_owner_cannot_modify_members(self, api, group, bob, carol):
        r = api.patch(
            f"{BASE_URL}/api/conversations/{group['id']}",
            json={"add_member_ids": [carol["user_id"]]},  # bob isn't owner
            headers=bob["h"],
        )
        assert r.status_code == 403, r.text

        r2 = api.patch(
            f"{BASE_URL}/api/conversations/{group['id']}",
            json={"remove_member_ids": [carol["user_id"]]},
            headers=bob["h"],
        )
        assert r2.status_code == 403, r2.text

    def test_owner_can_remove_member(self, api, group, alice, carol):
        r = api.patch(
            f"{BASE_URL}/api/conversations/{group['id']}",
            json={"remove_member_ids": [carol["user_id"]]},
            headers=alice["h"],
        )
        assert r.status_code == 200, r.text
        member_ids = [m["user_id"] for m in r.json()["members"]]
        assert carol["user_id"] not in member_ids

    def test_owner_cannot_remove_self_via_remove_member_ids(self, api, group, alice):
        r = api.patch(
            f"{BASE_URL}/api/conversations/{group['id']}",
            json={"remove_member_ids": [alice["user_id"]]},
            headers=alice["h"],
        )
        assert r.status_code == 200, r.text
        member_ids = [m["user_id"] for m in r.json()["members"]]
        assert alice["user_id"] in member_ids, "Owner should not be removable via remove_member_ids"


class TestGroupLeaveAndOwnerTransfer:
    def test_member_can_leave(self, api, alice, bob, mdb):
        # Fresh group: alice owner, bob+a new charlie member
        charlie = _seed_user(mdb, "Charlie ITER8")
        try:
            r = api.post(
                f"{BASE_URL}/api/conversations/groups",
                json={"name": "LeaveTest", "member_ids": [bob["user_id"], charlie["user_id"]]},
                headers=alice["h"],
            )
            assert r.status_code == 200, r.text
            gid = r.json()["id"]
            # bob leaves
            lr = api.post(f"{BASE_URL}/api/conversations/{gid}/leave", headers=bob["h"])
            assert lr.status_code == 200, lr.text
            # Bob's list should NOT include this group anymore
            bobs = api.get(f"{BASE_URL}/api/conversations", headers=bob["h"]).json()
            assert all(c["id"] != gid for c in bobs)
            # Alice's still has bob removed
            alices = api.get(f"{BASE_URL}/api/conversations", headers=alice["h"]).json()
            grp = next(c for c in alices if c["id"] == gid)
            ids = [m["user_id"] for m in grp["members"]]
            assert bob["user_id"] not in ids
            assert alice["user_id"] in ids
            assert charlie["user_id"] in ids
        finally:
            mdb.conversations.delete_many({"id": gid})
            mdb.messages.delete_many({"conversation_id": gid})
            mdb.notifications.delete_many({"conversation_id": gid})
            _cleanup(mdb, charlie["user_id"])

    def test_owner_leave_transfers_ownership(self, api, alice, bob, mdb):
        r = api.post(
            f"{BASE_URL}/api/conversations/groups",
            json={"name": "OwnerXfer", "member_ids": [bob["user_id"]]},
            headers=alice["h"],
        )
        gid = r.json()["id"]
        try:
            lr = api.post(f"{BASE_URL}/api/conversations/{gid}/leave", headers=alice["h"])
            assert lr.status_code == 200, lr.text
            # Bob should now be the owner
            bobs = api.get(f"{BASE_URL}/api/conversations", headers=bob["h"]).json()
            grp = next(c for c in bobs if c["id"] == gid)
            assert grp["owner_id"] == bob["user_id"]
            assert alice["user_id"] not in [m["user_id"] for m in grp["members"]]
        finally:
            mdb.conversations.delete_many({"id": gid})
            mdb.messages.delete_many({"conversation_id": gid})

    def test_solo_owner_leave_deletes_conversation(self, api, alice, mdb):
        # Need >=2 members to create per route guard, so add bob then remove him
        bob_ish = _seed_user(mdb, "BobIsh ITER8")
        try:
            r = api.post(
                f"{BASE_URL}/api/conversations/groups",
                json={"name": "SoloOwner", "member_ids": [bob_ish["user_id"]]},
                headers=alice["h"],
            )
            gid = r.json()["id"]
            # bob_ish leaves first
            api.post(f"{BASE_URL}/api/conversations/{gid}/leave", headers=bob_ish["h"])
            # Now owner alice leaves alone -> conv deleted
            lr = api.post(f"{BASE_URL}/api/conversations/{gid}/leave", headers=alice["h"])
            assert lr.status_code == 200, lr.text
            # conv gone from db
            assert mdb.conversations.find_one({"id": gid}) is None
        finally:
            _cleanup(mdb, bob_ish["user_id"])


# ---------------------------------------------------------------------------
# Soft-delete DM
# ---------------------------------------------------------------------------
class TestSoftDeleteDM:
    @pytest.fixture(scope="class")
    def dm(self, api, alice, bob, mdb):
        r = api.post(
            f"{BASE_URL}/api/conversations",
            json={"recipient_user_id": bob["user_id"]},
            headers=alice["h"],
        )
        assert r.status_code == 200, r.text
        conv = r.json()
        # Alice sends a message
        api.post(f"{BASE_URL}/api/conversations/{conv['id']}/messages",
                 json={"type": "text", "text": "hi bob"},
                 headers=alice["h"])
        yield conv
        mdb.conversations.delete_one({"id": conv["id"]})
        mdb.messages.delete_many({"conversation_id": conv["id"]})

    def test_soft_delete_hides_for_alice_only(self, api, dm, alice, bob):
        d = api.delete(f"{BASE_URL}/api/conversations/{dm['id']}", headers=alice["h"])
        assert d.status_code == 200, d.text
        # Alice doesn't see it
        alice_list = api.get(f"{BASE_URL}/api/conversations", headers=alice["h"]).json()
        assert all(c["id"] != dm["id"] for c in alice_list)
        # Bob still sees it
        bob_list = api.get(f"{BASE_URL}/api/conversations", headers=bob["h"]).json()
        assert any(c["id"] == dm["id"] for c in bob_list)

    def test_messages_hidden_before_resurface(self, api, dm, alice):
        # Old messages exist but cleared_at hides them for Alice
        msgs = api.get(f"{BASE_URL}/api/conversations/{dm['id']}/messages", headers=alice["h"]).json()
        assert msgs == [] or all(m.get("text") != "hi bob" for m in msgs), \
            f"old messages should be hidden after soft-delete, got: {msgs}"

    def test_bob_message_resurfaces_for_alice(self, api, dm, alice, bob):
        # Bob sends a new message
        r = api.post(f"{BASE_URL}/api/conversations/{dm['id']}/messages",
                     json={"type": "text", "text": "hey alice"},
                     headers=bob["h"])
        assert r.status_code == 200, r.text
        # Alice's list now contains the conv again
        alice_list = api.get(f"{BASE_URL}/api/conversations", headers=alice["h"]).json()
        assert any(c["id"] == dm["id"] for c in alice_list), "Conv should resurface after new message"
        # Alice should now see the new message (and not the old hi bob)
        msgs = api.get(f"{BASE_URL}/api/conversations/{dm['id']}/messages", headers=alice["h"]).json()
        texts = [m["text"] for m in msgs]
        assert "hey alice" in texts
        assert "hi bob" not in texts, "old pre-cleared messages should remain hidden"

    def test_delete_group_via_delete_endpoint_behaves_like_leave(self, api, alice, bob, mdb):
        r = api.post(
            f"{BASE_URL}/api/conversations/groups",
            json={"name": "DeleteAsLeave", "member_ids": [bob["user_id"]]},
            headers=alice["h"],
        )
        gid = r.json()["id"]
        try:
            d = api.delete(f"{BASE_URL}/api/conversations/{gid}", headers=bob["h"])
            assert d.status_code == 200, d.text
            # Bob no longer a member
            bobs = api.get(f"{BASE_URL}/api/conversations", headers=bob["h"]).json()
            assert all(c["id"] != gid for c in bobs)
            # Alice (owner) still has it
            alices = api.get(f"{BASE_URL}/api/conversations", headers=alice["h"]).json()
            grp = next((c for c in alices if c["id"] == gid), None)
            assert grp is not None
            assert bob["user_id"] not in [m["user_id"] for m in grp["members"]]
        finally:
            mdb.conversations.delete_many({"id": gid})
            mdb.messages.delete_many({"conversation_id": gid})


# ---------------------------------------------------------------------------
# Regression spot-checks
# ---------------------------------------------------------------------------
class TestRegressionDM:
    def test_dm_idempotent(self, api, alice, bob):
        a = api.post(f"{BASE_URL}/api/conversations",
                     json={"recipient_user_id": bob["user_id"]},
                     headers=alice["h"])
        assert a.status_code == 200
        b = api.post(f"{BASE_URL}/api/conversations",
                     json={"recipient_user_id": bob["user_id"]},
                     headers=alice["h"])
        assert b.status_code == 200
        assert a.json()["id"] == b.json()["id"]

    def test_self_dm_works(self, api, alice):
        r = api.post(f"{BASE_URL}/api/conversations",
                     json={"recipient_user_id": alice["user_id"]},
                     headers=alice["h"])
        assert r.status_code == 200, r.text
        assert r.json()["other_user"]["name"] == "Notes to self"

    def test_dm_send_and_mark_read(self, api, alice, bob):
        # Get/create DM
        cr = api.post(f"{BASE_URL}/api/conversations",
                      json={"recipient_user_id": bob["user_id"]},
                      headers=alice["h"]).json()
        m = api.post(f"{BASE_URL}/api/conversations/{cr['id']}/messages",
                     json={"type": "text", "text": "regression"},
                     headers=alice["h"])
        assert m.status_code == 200, m.text
        mr = api.post(f"{BASE_URL}/api/conversations/{cr['id']}/read", headers=bob["h"])
        assert mr.status_code == 200, mr.text


class TestRegressionRepost:
    def test_repost_toggle_still_green(self, api, alice, bob):
        cr = api.post(f"{BASE_URL}/api/posts",
                      json={"text": "regression repost"},
                      headers=alice["h"])
        assert cr.status_code == 200
        pid = cr.json()["id"]
        on = api.post(f"{BASE_URL}/api/posts/{pid}/repost", headers=bob["h"])
        assert on.status_code == 200
        assert on.json()["reposts_count"] == 1
        off = api.post(f"{BASE_URL}/api/posts/{pid}/repost", headers=bob["h"])
        assert off.status_code == 200
        assert off.json()["reposts_count"] == 0
