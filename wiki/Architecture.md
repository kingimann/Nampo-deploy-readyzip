# Architecture

```
┌──────────────────────────┐     REST /api/v1/* (+ /api/* legacy)  +  WS /api/ws/eta/*   ┌──────────────────────────┐
│   Expo / React Native    │ ───────────────────────────────────────────────────────▶  │      FastAPI backend     │
│   (frontend/)            │      Authorization: Bearer <session token | API key>      │      (backend/)          │
│                          │ ◀───────────────────────────────────────────────────────  │                          │
│  - expo-router screens   │                                                            │  - routes/* (APIRouter)  │
│  - MapboxWebView (GL JS) │                                                            │  - PostgreSQL (asyncpg)  │
└──────────┬───────────────┘                                                            └─────────────┬────────────┘
           │ direct client→Mapbox (geocode, search, directions)                                       │
           ▼                                                                                           ▼
   ┌─────────────────┐                                  Stripe · Cloudinary · Foursquare · TransitLand · Twilio
   │  Mapbox APIs    │                                  SMTP · LiveKit · Expo Push · Anthropic/Ollama · Render API
   └─────────────────┘
```

## Request flow
- The client calls the backend at **`EXPO_PUBLIC_BACKEND_URL` + `/api`**. Auth is a Bearer **session token** (or developer **API key**) stored in `expo-secure-store`.
- **Native:** uses the full `EXPO_PUBLIC_BACKEND_URL`. **Web:** uses it when set, otherwise falls back to same-origin so the Metro dev proxy (`metro.config.js`) forwards `/api/*` and `/health` to the backend on port `8080` in local dev.
- The stable, versioned base is **`/api/v1`**; **`/api`** is a legacy alias. CORS is open so browser/mobile/third-party apps can call directly.
- Live ETA sharing rides a WebSocket at **`/api/ws/eta/{share_id}`**.

## Where work happens
- **Mapbox** (geocoding, category search, turn-by-turn) runs **client-side** with `EXPO_PUBLIC_MAPBOX_TOKEN`.
- **Foursquare, TransitLand, Stripe webhooks, AI vision, Render API** run **server-side**.

## Backend data layer
- **PostgreSQL** via async **asyncpg**, accessed through a thin **MongoDB-style wrapper** (`backend/db.py`). Each "collection" is a table with a single JSONB `doc` column, so route code reads like Motor/PyMongo (`db.users.find_one(...)`, `update_one`, `$set`, `$inc`).
- The DB is configured **only** via `DATABASE_URL`.

## Backend modules (`backend/routes/`)
`auth`, `users`, `posts`, `stories`, `messaging`, `calls`, `push`, `notifications`, `places`, `guides`, `reviews`, `foursquare`, `transit`, `eta`, `marketplace`, `communities`, `groups`, `roadside`, `support`, `forms`, `embed`, `webhooks`, `oauth`, `ads`, `adnetwork`, `payments`, `money`, `payouts`, `integrations`, `render_admin`, `meta`.

Services (`backend/services/`): `claude_ai`, `ollama`, `claude_bot`, `email`, `sms`, `push`, `encryption`, `link_preview`.

## Frontend structure (`frontend/`)
- `app/` — expo-router routes (file-based). `app/(tabs)/` is the main tab set.
- `app/_layout.tsx` — root: auth gate, providers, the `MobileFrame` (phone-width web frame), the bottom `LiquidTabBar`, the left sidebar, and gates.
- `app/+html.tsx` — web HTML shell (PWA manifest link, app-feel CSS, launch splash).
- `src/api/client.ts` — typed API client. `src/api/mapbox.ts` — maps.
- `src/components/` — shared UI (PostCard, MapboxWebView, MobileFrame, FadeIn/PressableScale/BouncyPressable/Skeleton, EdgeSwipe, …).
