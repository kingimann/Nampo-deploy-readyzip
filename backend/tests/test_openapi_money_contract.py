"""Contract guard: every money endpoint must declare a 200 response schema.

This locks in the §1 work from the API-improvement guide — once an endpoint is
typed with `response_model=`, a future refactor that drops it (regressing the
OpenAPI spec back to an empty 200, which breaks SDK codegen) fails here.

Pure unit test: it builds an app from the money routers and introspects the
generated OpenAPI — no running server or database required.
"""
import pytest
from fastapi import FastAPI

from routes import payments, money, stripe_connect

# (path, method) for every money endpoint that returns a typed body.
MONEY_ROUTES = [
    ("/stripe/account", "post"),
    ("/stripe/balance", "get"),
    ("/stripe/transfer", "post"),
    ("/stripe/payout", "post"),
    ("/stripe/transactions", "get"),
    ("/payments/config", "get"),
    ("/capabilities", "get"),
    ("/payments/payouts/setup", "post"),
    ("/payments/payouts/status", "get"),
    ("/payments/checkout", "post"),
    ("/payments/pay-intent", "post"),
    ("/payments/pay-intent/confirm", "post"),
    ("/payments/payouts/cashout", "post"),
    ("/wallet/balance", "get"),
    ("/wallet/currency", "post"),
    ("/wallet/topup", "post"),
    ("/wallet/topup/sync", "post"),
    ("/wallet/topup/intent", "post"),
    ("/wallet/topup/confirm", "post"),
    ("/wallet/topup/confirm-intent", "post"),
    ("/wallet/topup/{tid}/cancel", "post"),
    ("/wallet/activity", "get"),
    ("/wallet/topups", "get"),
    ("/payments/pay-wallet", "post"),
]


@pytest.fixture(scope="module")
def spec():
    app = FastAPI()
    for r in (payments.router, money.router, stripe_connect.router):
        app.include_router(r)
    return app.openapi()


@pytest.mark.parametrize("path,method", MONEY_ROUTES)
def test_money_endpoint_declares_200_schema(spec, path, method):
    op = spec["paths"].get(path, {}).get(method)
    assert op is not None, f"{method.upper()} {path} is not registered"
    resp = op["responses"].get("200")
    assert resp is not None, f"{method.upper()} {path} has no 200 response"
    content = resp.get("content", {}).get("application/json", {})
    assert content.get("schema"), f"{method.upper()} {path} has no 200 JSON schema (response_model missing?)"
