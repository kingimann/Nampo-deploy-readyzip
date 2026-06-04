"""Backend tests for iteration 5:

* Race-tightening fixes:
  - POST /api/reviews uses single atomic update_one(..., upsert=True)
  - PATCH /api/guides slug auto-gen via _try_set_unique_slug (race-safe)
* NEW ETA-sharing surface:
  - POST /api/eta, /api/eta/{id}/update, /api/eta/{id}/stop
  - GET  /api/public/eta/{id}  (no auth; expiry flips active=false)
  - WS   /api/ws/eta/{id}  (initial state + broadcast on update/stop)

Auth is simulated by seeding a user + session row directly in Mongo,
mirroring the existing pattern in test_new_endpoints.py / test_recents_guides.py.
The Emergent OAuth provider is NOT touched here.
"""
import asyncio
import json
import os
import uuid
from datetime import datetime, timezone, timedelta

import pytest
import requests
import websockets
from pymongo import MongoClient


BASE_URL = os.environ.get(
    "EXPO_BACKEND_URL", "https://location-hub-312.preview.emergentagent.com"
).rstrip("/")
WS_URL = BASE_URL.replace("https://", "wss://").replace("http://", "ws://")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


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


def _seed(mdb, name="EtaTester"):
    suf = uuid.uuid4().hex[:8]
    uid = f"user_TEST_{suf}"
    email = f"TEST_eta_{suf}@example.com"
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
    mdb.guides.delete_many({"user_id": uid})
    mdb.reviews.delete_many({"user_id": uid})
    mdb.eta_shares.delete_many({"user_id": uid})


# ---------------------------------------------------------------------------
# Race-tightening: Reviews upsert
# ---------------------------------------------------------------------------
class TestReviewsRaceUpsert:
    def test_review_upsert_same_user_same_place_updates_in_place(self, api, mdb):
        u = _seed(mdb, "Alice-Rev")
        try:
            pk = f"TEST_pk_{uuid.uuid4().hex[:8]}"
            body = {
                "place_key": pk, "place_name": "Cafe X",
                "longitude": 10.0, "latitude": 20.0,
                "rating": 4, "text": "first",
            }
            r1 = api.post(f"{BASE_URL}/api/reviews", json=body, headers=u["h"])
            assert r1.status_code == 200, r1.text
            id1 = r1.json()["id"]
            created1 = r1.json()["created_at"]

            # 2nd POST: same user + same place_key => upsert in place
            body2 = {**body, "rating": 2, "text": "updated"}
            r2 = api.post(f"{BASE_URL}/api/reviews", json=body2, headers=u["h"])
            assert r2.status_code == 200, r2.text
            id2 = r2.json()["id"]

            # Same row -> id and created_at preserved; fields updated.
            assert id1 == id2, "upsert should NOT create a new row"
            assert r2.json()["rating"] == 2
            assert r2.json()["text"] == "updated"
            assert r2.json()["created_at"] == created1

            # DB has exactly one doc for (user_id, place_key).
            count = mdb.reviews.count_documents(
                {"user_id": u["user_id"], "place_key": pk}
            )
            assert count == 1
        finally:
            _cleanup(mdb, u["user_id"])

    def test_review_rating_out_of_range_400(self, api, mdb):
        u = _seed(mdb, "Bob-Rev")
        try:
            pk = f"TEST_pk_{uuid.uuid4().hex[:8]}"
            base = {
                "place_key": pk, "place_name": "X",
                "longitude": 0.0, "latitude": 0.0, "text": "",
            }
            r0 = api.post(f"{BASE_URL}/api/reviews",
                          json={**base, "rating": 0}, headers=u["h"])
            assert r0.status_code == 400
            r6 = api.post(f"{BASE_URL}/api/reviews",
                          json={**base, "rating": 6}, headers=u["h"])
            assert r6.status_code == 400
            r5 = api.post(f"{BASE_URL}/api/reviews",
                          json={**base, "rating": 5}, headers=u["h"])
            assert r5.status_code == 200
        finally:
            _cleanup(mdb, u["user_id"])

    def test_two_users_same_place_key_both_persist(self, api, mdb):
        a = _seed(mdb, "Alice-Rev2")
        b = _seed(mdb, "Bob-Rev2")
        try:
            pk = f"TEST_pk_{uuid.uuid4().hex[:8]}"
            body = {
                "place_key": pk, "place_name": "Shared Spot",
                "longitude": 1.0, "latitude": 2.0,
                "rating": 5, "text": "great",
            }
            ra = api.post(f"{BASE_URL}/api/reviews", json=body, headers=a["h"])
            rb = api.post(f"{BASE_URL}/api/reviews",
                          json={**body, "rating": 3, "text": "ok"},
                          headers=b["h"])
            assert ra.status_code == 200 and rb.status_code == 200
            assert ra.json()["id"] != rb.json()["id"]
            assert mdb.reviews.count_documents({"place_key": pk}) == 2

            # GET /api/reviews?place_key=... returns both, newest first.
            lst = api.get(f"{BASE_URL}/api/reviews",
                          params={"place_key": pk}, headers=a["h"])
            assert lst.status_code == 200
            ids = [r["id"] for r in lst.json()]
            assert set(ids) == {ra.json()["id"], rb.json()["id"]}
        finally:
            _cleanup(mdb, a["user_id"])
            _cleanup(mdb, b["user_id"])


# ---------------------------------------------------------------------------
# Race-tightening: Guide slug auto-gen
# ---------------------------------------------------------------------------
class TestGuideSlugRace:
    def _mk_guide(self, api, u, name):
        r = api.post(f"{BASE_URL}/api/guides",
                     json={"name": name}, headers=u["h"])
        assert r.status_code == 200, r.text
        return r.json()

    def test_first_publish_sets_slug_from_name(self, api, mdb):
        u = _seed(mdb, "Slug-Owner")
        try:
            uniq = uuid.uuid4().hex[:6]
            name = f"My Cool Trip {uniq}"
            g = self._mk_guide(api, u, name)
            r = api.patch(f"{BASE_URL}/api/guides/{g['id']}",
                          json={"is_public": True}, headers=u["h"])
            assert r.status_code == 200, r.text
            slug = r.json()["slug"]
            assert slug == f"my-cool-trip-{uniq}"
            assert r.json()["is_public"] is True
        finally:
            _cleanup(mdb, u["user_id"])

    def test_second_guide_same_name_gets_suffix_no_500(self, api, mdb):
        a = _seed(mdb, "Slug-A")
        b = _seed(mdb, "Slug-B")
        try:
            uniq = uuid.uuid4().hex[:6]
            name = f"Same Name {uniq}"
            ga = self._mk_guide(api, a, name)
            gb = self._mk_guide(api, b, name)
            ra = api.patch(f"{BASE_URL}/api/guides/{ga['id']}",
                           json={"is_public": True}, headers=a["h"])
            rb = api.patch(f"{BASE_URL}/api/guides/{gb['id']}",
                           json={"is_public": True}, headers=b["h"])
            assert ra.status_code == 200 and rb.status_code == 200, (
                ra.status_code, rb.status_code, ra.text, rb.text
            )
            sa = ra.json()["slug"]
            sb = rb.json()["slug"]
            base = f"same-name-{uniq}"
            assert sa == base
            assert sb == f"{base}-1"
        finally:
            _cleanup(mdb, a["user_id"])
            _cleanup(mdb, b["user_id"])

    def test_toggle_off_then_on_preserves_slug(self, api, mdb):
        u = _seed(mdb, "Slug-Toggle")
        try:
            uniq = uuid.uuid4().hex[:6]
            g = self._mk_guide(api, u, f"Toggle Me {uniq}")
            r1 = api.patch(f"{BASE_URL}/api/guides/{g['id']}",
                           json={"is_public": True}, headers=u["h"])
            slug1 = r1.json()["slug"]
            assert slug1

            r2 = api.patch(f"{BASE_URL}/api/guides/{g['id']}",
                           json={"is_public": False}, headers=u["h"])
            assert r2.status_code == 200
            # slug is preserved in DB even when private
            assert r2.json()["slug"] == slug1

            r3 = api.patch(f"{BASE_URL}/api/guides/{g['id']}",
                           json={"is_public": True}, headers=u["h"])
            assert r3.status_code == 200
            assert r3.json()["slug"] == slug1, (
                "slug must NOT be regenerated on re-publish"
            )
        finally:
            _cleanup(mdb, u["user_id"])

    def test_rapid_double_publish_both_succeed_slug_set(self, api, mdb):
        """Race regression: rapid PATCH is_public=true twice should not 500."""
        u = _seed(mdb, "Slug-Race")
        try:
            uniq = uuid.uuid4().hex[:6]
            g = self._mk_guide(api, u, f"Race Pub {uniq}")
            # Fire two PATCH calls sequentially as fast as possible.
            r1 = api.patch(f"{BASE_URL}/api/guides/{g['id']}",
                           json={"is_public": True}, headers=u["h"])
            r2 = api.patch(f"{BASE_URL}/api/guides/{g['id']}",
                           json={"is_public": True}, headers=u["h"])
            assert r1.status_code == 200, r1.text
            assert r2.status_code == 200, r2.text
            assert r1.json()["slug"] == f"race-pub-{uniq}"
            assert r2.json()["slug"] == f"race-pub-{uniq}"
        finally:
            _cleanup(mdb, u["user_id"])


# ---------------------------------------------------------------------------
# NEW: ETA HTTP endpoints
# ---------------------------------------------------------------------------
class TestEtaHttp:
    def _mk_share(self, api, u, **overrides):
        body = {
            "name": "Trip",
            "destination_name": "Office",
            "destination_longitude": 77.6,
            "destination_latitude": 12.97,
            "initial_longitude": 77.5,
            "initial_latitude": 12.93,
            "eta_minutes": 25,
            "ttl_minutes": 60,
        }
        body.update(overrides)
        r = api.post(f"{BASE_URL}/api/eta", json=body, headers=u["h"])
        assert r.status_code == 200, r.text
        return r.json()

    def test_create_eta_returns_share_id_and_active(self, api, mdb):
        u = _seed(mdb, "Eta-Creator")
        try:
            s = self._mk_share(api, u)
            assert s["active"] is True
            assert isinstance(s["share_id"], str) and len(s["share_id"]) == 10
            # share_id is hex
            int(s["share_id"], 16)
            assert s["user_id"] == u["user_id"]
            # expires_at within ttl window
            exp = datetime.fromisoformat(s["expires_at"].replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            assert (exp - now).total_seconds() > 60 * 50  # ~60 min ttl
            assert (exp - now).total_seconds() < 60 * 70
        finally:
            _cleanup(mdb, u["user_id"])

    def test_create_eta_clamps_ttl_min_and_max(self, api, mdb):
        u = _seed(mdb, "Eta-TTL")
        try:
            # ttl < 5 -> clamped to 5
            s_lo = self._mk_share(api, u, ttl_minutes=1)
            exp_lo = datetime.fromisoformat(
                s_lo["expires_at"].replace("Z", "+00:00")
            )
            secs = (exp_lo - datetime.now(timezone.utc)).total_seconds()
            assert 4 * 60 < secs < 6 * 60, f"ttl=1 clamped to 5: got {secs}"

            # ttl > 1440 -> clamped to 1440
            s_hi = self._mk_share(api, u, ttl_minutes=9999)
            exp_hi = datetime.fromisoformat(
                s_hi["expires_at"].replace("Z", "+00:00")
            )
            secs2 = (exp_hi - datetime.now(timezone.utc)).total_seconds()
            assert 1439 * 60 < secs2 < 1441 * 60
        finally:
            _cleanup(mdb, u["user_id"])

    def test_update_eta_owner_only_and_bumps_updated_at(self, api, mdb):
        owner = _seed(mdb, "Eta-Owner")
        other = _seed(mdb, "Eta-Intruder")
        try:
            s = self._mk_share(api, owner)
            sid = s["share_id"]
            updated0 = s["updated_at"]

            # 404 for unknown share_id
            r404 = api.post(
                f"{BASE_URL}/api/eta/nonexistent99/update",
                json={"current_longitude": 1, "current_latitude": 2},
                headers=owner["h"],
            )
            assert r404.status_code == 404

            # 403 for non-owner
            r403 = api.post(
                f"{BASE_URL}/api/eta/{sid}/update",
                json={"current_longitude": 1, "current_latitude": 2},
                headers=other["h"],
            )
            assert r403.status_code == 403

            # 200 for owner; updated fields applied & updated_at bumps
            import time
            time.sleep(0.05)
            r = api.post(
                f"{BASE_URL}/api/eta/{sid}/update",
                json={"current_longitude": 99.9, "current_latitude": -33.3,
                      "eta_minutes": 5},
                headers=owner["h"],
            )
            assert r.status_code == 200, r.text
            assert r.json()["current_longitude"] == 99.9
            assert r.json()["current_latitude"] == -33.3
            assert r.json()["eta_minutes"] == 5
            assert r.json()["updated_at"] > updated0
        finally:
            _cleanup(mdb, owner["user_id"])
            _cleanup(mdb, other["user_id"])

    def test_stop_eta_sets_active_false_owner_only(self, api, mdb):
        owner = _seed(mdb, "Eta-Stop")
        other = _seed(mdb, "Eta-Stop-Other")
        try:
            s = self._mk_share(api, owner)
            sid = s["share_id"]
            # unknown -> 404
            r0 = api.post(f"{BASE_URL}/api/eta/zzzzzzzzzz/stop",
                          headers=owner["h"])
            assert r0.status_code == 404
            # non-owner -> 404 (server returns 404 for both missing & not-owner on stop)
            r1 = api.post(f"{BASE_URL}/api/eta/{sid}/stop", headers=other["h"])
            assert r1.status_code == 404
            # owner -> 200, active False
            r2 = api.post(f"{BASE_URL}/api/eta/{sid}/stop", headers=owner["h"])
            assert r2.status_code == 200
            assert r2.json()["active"] is False
        finally:
            _cleanup(mdb, owner["user_id"])
            _cleanup(mdb, other["user_id"])

    def test_public_get_no_auth_and_expiry_flips_active(self, api, mdb):
        owner = _seed(mdb, "Eta-Pub")
        try:
            s = self._mk_share(api, owner)
            sid = s["share_id"]

            # Public GET — no Authorization header.
            r = requests.get(f"{BASE_URL}/api/public/eta/{sid}")
            assert r.status_code == 200, r.text
            assert r.json()["share_id"] == sid
            assert r.json()["active"] is True

            # Force expiry in DB and re-GET — should flip active=false.
            mdb.eta_shares.update_one(
                {"share_id": sid},
                {"$set": {"expires_at":
                          datetime.now(timezone.utc) - timedelta(minutes=1)}},
            )
            r2 = requests.get(f"{BASE_URL}/api/public/eta/{sid}")
            assert r2.status_code == 200
            assert r2.json()["active"] is False
            # And persisted as inactive
            doc = mdb.eta_shares.find_one({"share_id": sid})
            assert doc["active"] is False

            # Truly missing -> 404
            r3 = requests.get(f"{BASE_URL}/api/public/eta/zzzzzzzzzz")
            assert r3.status_code == 404
        finally:
            _cleanup(mdb, owner["user_id"])

    def test_eta_requires_auth(self, api, mdb):
        # Sanity: protected endpoints reject missing token.
        u = _seed(mdb, "Eta-Auth-Req")
        try:
            s = self._mk_share(api, u)
            sid = s["share_id"]
            for path, body in [
                ("/api/eta", {
                    "destination_longitude": 0, "destination_latitude": 0,
                    "initial_longitude": 0, "initial_latitude": 0,
                }),
                (f"/api/eta/{sid}/update",
                 {"current_longitude": 0, "current_latitude": 0}),
                (f"/api/eta/{sid}/stop", None),
            ]:
                r = requests.post(f"{BASE_URL}{path}", json=body)
                assert r.status_code == 401, (path, r.status_code)
        finally:
            _cleanup(mdb, u["user_id"])


# ---------------------------------------------------------------------------
# NEW: ETA WebSocket broadcast
# ---------------------------------------------------------------------------
class TestEtaWebSocket:
    @pytest.mark.asyncio
    async def test_ws_initial_state_and_broadcast_on_update(self, mdb):
        owner = _seed(mdb, "Eta-Ws-Owner")
        try:
            body = {
                "name": "WS Trip",
                "destination_longitude": 1.0, "destination_latitude": 2.0,
                "initial_longitude": 3.0, "initial_latitude": 4.0,
                "eta_minutes": 10, "ttl_minutes": 30,
            }
            r = requests.post(f"{BASE_URL}/api/eta", json=body,
                              headers=owner["h"])
            assert r.status_code == 200, r.text
            sid = r.json()["share_id"]

            ws_uri = f"{WS_URL}/api/ws/eta/{sid}"
            async with websockets.connect(ws_uri, open_timeout=10) as ws:
                # 1) initial state
                init_raw = await asyncio.wait_for(ws.recv(), timeout=10)
                init = json.loads(init_raw)
                assert init["type"] == "eta"
                assert init["share"]["share_id"] == sid
                assert init["share"]["current_longitude"] == 3.0

                # 2) trigger update over HTTP from "another client" (owner is fine)
                u = requests.post(
                    f"{BASE_URL}/api/eta/{sid}/update",
                    json={"current_longitude": 9.9, "current_latitude": 8.8,
                          "eta_minutes": 3},
                    headers=owner["h"],
                )
                assert u.status_code == 200

                # 3) WS should receive a broadcast
                msg_raw = await asyncio.wait_for(ws.recv(), timeout=10)
                msg = json.loads(msg_raw)
                assert msg["type"] == "eta"
                assert msg["share"]["share_id"] == sid
                assert msg["share"]["current_longitude"] == 9.9
                assert msg["share"]["eta_minutes"] == 3
        finally:
            _cleanup(mdb, owner["user_id"])

    @pytest.mark.asyncio
    async def test_ws_broadcasts_on_stop(self, mdb):
        owner = _seed(mdb, "Eta-Ws-Stop")
        try:
            body = {
                "destination_longitude": 0.0, "destination_latitude": 0.0,
                "initial_longitude": 0.0, "initial_latitude": 0.0,
            }
            r = requests.post(f"{BASE_URL}/api/eta", json=body,
                              headers=owner["h"])
            sid = r.json()["share_id"]

            ws_uri = f"{WS_URL}/api/ws/eta/{sid}"
            async with websockets.connect(ws_uri, open_timeout=10) as ws:
                await asyncio.wait_for(ws.recv(), timeout=10)  # initial
                requests.post(f"{BASE_URL}/api/eta/{sid}/stop",
                              headers=owner["h"])
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                assert msg["type"] == "eta"
                assert msg["share"]["active"] is False
        finally:
            _cleanup(mdb, owner["user_id"])

    @pytest.mark.asyncio
    async def test_ws_unknown_share_sends_error_and_closes(self, mdb):
        ws_uri = f"{WS_URL}/api/ws/eta/zzzzzzzzzz"
        async with websockets.connect(ws_uri, open_timeout=10) as ws:
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            msg = json.loads(raw)
            assert msg["type"] == "error"
            assert msg["detail"] == "not_found"


# ---------------------------------------------------------------------------
# Index sanity for the new collection
# ---------------------------------------------------------------------------
class TestEtaIndexes:
    def test_eta_shares_indexes(self, mdb):
        idx = mdb.eta_shares.index_information()
        # share_id unique
        share_id_idx = [v for k, v in idx.items() if v["key"] == [("share_id", 1)]]
        assert share_id_idx, "missing share_id index"
        assert share_id_idx[0].get("unique") is True

        # user_id present
        assert any(v["key"] == [("user_id", 1)] for v in idx.values()), idx

        # expires_at TTL
        ttl = [v for v in idx.values() if v["key"] == [("expires_at", 1)]]
        assert ttl, "missing expires_at index"
        assert ttl[0].get("expireAfterSeconds") == 0
