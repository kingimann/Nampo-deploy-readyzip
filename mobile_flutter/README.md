# mobile_flutter/

Home for an optional **Flutter** mobile client that talks to the same OkaySpace
backend as the existing React/Expo app. The React web app is unaffected — this
is additive.

## What's here

- **`packages/okayspace_api/`** — a Dart client for the FastAPI backend, mirroring
  `frontend/src/api/client.ts` (same `/api` base, Bearer session token, error
  envelope, idempotency). See its [README](packages/okayspace_api/README.md).

## Suggested next steps (when you're ready)

1. `flutter create app` here, depend on `okayspace_api` via a path dependency.
2. Wire `SecureTokenStore` (flutter_secure_storage) and build the login + feed
   screens first as a proof-of-concept against the live API.
3. Add native SDKs as you port features: Stripe, Mapbox, LiveKit, FCM/APNs push.
4. Port `frontend/src/utils/e2e.ts` (NaCl box) with `pinenacl`/`cryptography`
   only when you need to interoperate with end-to-end-encrypted web chats.

The backend already serves an OpenAPI schema at `<baseUrl>/api/openapi.json`, so
you can also code-generate a client if you prefer (see the package README).
