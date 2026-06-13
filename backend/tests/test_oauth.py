"""Behavioural tests for the OAuth app + connection endpoints (routes.oauth).

Pins: creating an app needs a name + an https redirect URI (400) and returns a
client id/secret; app listing is owner-scoped and never leaks the secret; public
app-info 404s on an unknown id and omits the secret; a user's connections are
grouped per client with the app name; revoking a connection drops all that app's
tokens + codes for the user.
"""
import pytest
from fastapi import HTTPException

from routes import oauth
from tests._fakedb import FakeDB


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()

    async def fake_user(_authorization):
        return {"user_id": "me"}

    monkeypatch.setattr(oauth, "db", db)
    monkeypatch.setattr(oauth, "get_current_user", fake_user)
    return db


@pytest.mark.asyncio
async def test_create_requires_name_and_https_uri(env):
    with pytest.raises(HTTPException) as ei:
        await oauth.create_app(oauth.AppCreate(name="", redirect_uris=["https://x.com/cb"]))
    assert ei.value.status_code == 400
    with pytest.raises(HTTPException) as ei2:
        await oauth.create_app(oauth.AppCreate(name="App", redirect_uris=["ftp://nope"]))
    assert ei2.value.status_code == 400


@pytest.mark.asyncio
async def test_create_returns_credentials(env):
    out = await oauth.create_app(oauth.AppCreate(name="My App", redirect_uris=["https://x.com/cb"]))
    assert out["client_id"].startswith("okayspace_cid_")
    assert out["client_secret"].startswith("okayspace_csec_")
    assert await env.oauth_apps.count_documents({"owner_id": "me"}) == 1


@pytest.mark.asyncio
async def test_list_is_owner_scoped_and_hides_secret(env):
    await oauth.create_app(oauth.AppCreate(name="Mine", redirect_uris=["https://x.com/cb"]))
    env.oauth_apps.docs.append({"client_id": "other_cid", "owner_id": "other", "name": "Theirs",
                                "redirect_uris": [], "client_secret": "secret"})
    out = await oauth.list_apps()
    assert len(out["apps"]) == 1
    assert "client_secret" not in out["apps"][0]


@pytest.mark.asyncio
async def test_app_info_public_omits_secret_and_404s(env):
    env.oauth_apps.docs = [{"client_id": "cid1", "name": "Pub", "redirect_uris": ["https://x/cb"],
                            "client_secret": "shh"}]
    info = await oauth.app_info("cid1")
    assert info["name"] == "Pub" and "client_secret" not in info
    with pytest.raises(HTTPException) as ei:
        await oauth.app_info("missing")
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_connections_grouped_with_app_name(env):
    env.oauth_apps.docs = [{"client_id": "cidA", "name": "Analytics"}]
    env.oauth_tokens.docs = [
        {"user_id": "me", "client_id": "cidA", "scope": "profile", "created_at": 2},
        {"user_id": "me", "client_id": "cidA", "scope": "profile", "created_at": 1},
    ]
    out = await oauth.my_connections()
    assert len(out["connections"]) == 1
    conn = out["connections"][0]
    assert conn["client_id"] == "cidA" and conn["name"] == "Analytics" and conn["tokens"] == 2


@pytest.mark.asyncio
async def test_revoke_connection_drops_tokens_and_codes(env):
    env.oauth_tokens.docs = [{"user_id": "me", "client_id": "cidA", "access_token": "t1"}]
    env.oauth_codes.docs = [{"user_id": "me", "client_id": "cidA", "code": "c1"}]
    await oauth.revoke_connection("cidA")
    assert await env.oauth_tokens.count_documents({"user_id": "me", "client_id": "cidA"}) == 0
    assert await env.oauth_codes.count_documents({"user_id": "me", "client_id": "cidA"}) == 0
