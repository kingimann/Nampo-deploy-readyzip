"""Contract guard: routes that were typed to stop the app key-probing must keep
their declared success schema.

Mirrors test_openapi_money_contract for the non-money routes typed in the
2026-06 OpenAPI pass (circles, games, forms, promoted/ads, hazards, factchecks,
roadside, media/resolve-video, pub/sites, scam-check). If a refactor drops a
`response_model=` here, the 200/201 regresses to an empty/loose schema and SDK
codegen silently breaks — this fails first.

Pure in-process test: introspects the generated OpenAPI; no server or DB.
"""
import server

# (path under /api/v1, method) for every route typed in this pass.
TYPED_ROUTES = [
    ("/circles", "get"), ("/circles", "post"), ("/circles/{circle_id}", "patch"),
    ("/games", "get"), ("/games", "post"), ("/games/{game_id}", "get"),
    ("/forms", "post"), ("/forms/{form_id}", "get"), ("/forms/{form_id}", "post"),
    ("/admin/ad-revenue", "get"),
    ("/promoted/links", "post"), ("/promoted/reels", "post"),
    ("/admin/bot/run", "post"), ("/promoted/account", "get"),
    ("/media/resolve-video", "post"),
    ("/pub/sites", "post"),
    ("/admin/roadside/verifications", "get"),
    ("/roadside/active", "get"), ("/roadside/helping", "get"),
    ("/roadside/check", "post"), ("/roadside/check-photo", "post"),
    ("/hazards", "post"), ("/hazards/{hid}/confirm", "post"), ("/hazards/{hid}/dismiss", "post"),
    ("/posts/{post_id}/factchecks", "post"),
    ("/conversations/{conv_id}/messages/{msg_id}/scam-check", "post"),
]

_SPEC = server.app.openapi()
_PATHS = _SPEC["paths"]


def _success_schema(path, method):
    op = _PATHS["/api/v1" + path][method]
    resps = op.get("responses", {})
    ok = next((resps[c] for c in ("200", "201", "202") if c in resps), None)
    assert ok is not None, f"{method.upper()} {path} declares no 2xx response"
    return ok.get("content", {}).get("application/json", {}).get("schema")


def _is_typed(schema):
    if not schema:
        return False
    if schema.get("$ref") or schema.get("items") or schema.get("allOf") or schema.get("anyOf"):
        return True
    # A bare {"type": "object"} with no properties is the empty/loose shape.
    if schema.get("type") == "object" and not schema.get("properties"):
        return False
    return bool(schema.get("type"))


def test_every_typed_route_keeps_a_success_schema():
    untyped = []
    for path, method in TYPED_ROUTES:
        if not _is_typed(_success_schema(path, method)):
            untyped.append(f"{method.upper()} {path}")
    assert not untyped, f"these lost their response_model (200 regressed to empty): {untyped}"
