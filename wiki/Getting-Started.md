# Getting Started

The backend and frontend run as two separate processes.

## Prerequisites
- **Node.js 20+** and **npm** (or Yarn 1.x — the repo pins `yarn@1.22.22`)
- **Python 3.11**
- A **PostgreSQL** database (local or managed)
- The **Expo CLI** (run via `npx expo`)
- A **Mapbox access token** (free tier) for maps/geocoding/directions
- Optional keys (each feature degrades gracefully when absent): Foursquare, Stripe, Cloudinary, Twilio, SMTP, LiveKit, TransitLand, Anthropic, Render. See **[[Configuration]]**.

## 1. Backend (FastAPI)

```bash
cd backend
pip install -r requirements.txt              # a virtualenv is recommended

export DATABASE_URL="postgresql://user:password@localhost:5432/nampo"
# Optional, e.g.:
# export MESSAGE_ENC_KEY="$(python -c 'from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())')"

uvicorn server:app --reload --port 8080      # auto-reload on :8080
```

Health checks:
- `GET /health` → `{"status":"ok"}`
- `GET /` → `{"status":"ok","app":"Nami App API"}`
- `GET /api/v1/info` → machine-readable API overview & capabilities

## 2. Frontend (Expo)

```bash
cd frontend

cat > .env <<'EOF'
EXPO_PUBLIC_BACKEND_URL=http://localhost:8080
EXPO_PUBLIC_MAPBOX_TOKEN=pk.your_mapbox_public_token
EOF

npm install
npx expo start --clear     # --clear is important (Reanimated/worklets babel plugin)
```

Press `w` for web, `i`/`a` for simulators, or scan the QR in **Expo Go**.

> On **web**, the Metro dev server proxies `/api/*` and `/health` to `http://localhost:8080`, so you don't need `EXPO_PUBLIC_BACKEND_URL`. On **native devices**, set it to a URL the device can reach (LAN IP or a tunnel), not `localhost`.

## Create your first account

From the sign-up screen, or directly against the API:

```bash
curl -X POST http://localhost:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"supersecret","name":"You","username":"you"}'
```

A successful response returns a `session_token` and your user object. To make yourself an **admin**, set `ADMIN_EMAILS` to your email (see **[[Configuration]]**).

## Useful scripts
`frontend/package.json`: `npm run android`, `npm run ios`, `npm run web`, `npm run lint`.

## Notes for native builds
Some features need a real EAS build (not Expo Go): **voice/video calls** (WebRTC) and anything using **Reanimated worklets**. See **[[Deployment]]** and run `npx expo start --clear` after pulling Babel-config changes.
