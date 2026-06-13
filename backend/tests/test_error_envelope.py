"""Contract guard for the unified error envelope (API hygiene §2b).

The backend funnels every non-2xx through `_err_body`, which returns one shape:
    {"error": {"code", "message", …}, "detail": {…same…}}
and the OpenAPI spec documents it as `ErrorEnvelope` (the `default` response on
every operation) so generated SDKs can branch on the stable `code`.

These pin both halves — the live response shape AND the documented schema — so a
future refactor can't silently drop either. Pure in-process test: it imports the
app and uses TestClient; the 404/405 paths never touch the database.
"""
from starlette.testclient import TestClient

import server

client = TestClient(server.app, raise_server_exceptions=False)


def _assert_envelope(body):
    assert isinstance(body, dict), body
    assert "error" in body and "detail" in body, body
    for key in ("error", "detail"):
        part = body[key]
        assert isinstance(part, dict), (key, part)
        assert isinstance(part.get("code"), str) and part["code"], (key, part)
        assert isinstance(part.get("message"), str) and part["message"], (key, part)
    # `detail` duplicates `error` for backwards compatibility.
    assert body["error"] == body["detail"], body


def test_404_uses_the_error_envelope():
    resp = client.get("/api/v1/definitely-not-a-real-route")
    assert resp.status_code == 404
    body = resp.json()
    _assert_envelope(body)
    assert body["error"]["code"] == "not_found"


def test_405_uses_the_error_envelope():
    # `/health` is GET-only; a POST should 405 through the same envelope.
    resp = client.post("/health")
    assert resp.status_code == 405
    _assert_envelope(resp.json())


def test_openapi_documents_the_error_envelope_on_every_operation():
    spec = server.app.openapi()
    schemas = spec["components"]["schemas"]
    assert "ErrorEnvelope" in schemas and "ErrorBody" in schemas
    assert schemas["ErrorBody"]["required"] == ["code", "message"]

    missing = []
    for path, ops in spec["paths"].items():
        for method, op in ops.items():
            if method.lower() not in ("get", "post", "put", "patch", "delete"):
                continue
            ref = (
                op.get("responses", {})
                .get("default", {})
                .get("content", {})
                .get("application/json", {})
                .get("schema", {})
                .get("$ref", "")
            )
            if not ref.endswith("/ErrorEnvelope"):
                missing.append(f"{method.upper()} {path}")
    assert not missing, f"{len(missing)} operations missing the default ErrorEnvelope: {missing[:5]}"
