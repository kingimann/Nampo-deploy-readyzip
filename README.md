# Nampo

**Nami App** is a social + maps app for mobile (and the web) that blends a Twitter/Instagram-style social network with a full-featured, Google-Maps-style navigation experience. Users get a **news feed** with photos and videos, **reels**, ephemeral **stories**, **direct and group messaging** (voice notes, custom emojis, shared live locations), an interactive **Mapbox map** with **turn-by-turn navigation**, saved **places** and shareable **guides**, rich **profiles** with follows/friends and **verified badges**, a location-aware **marketplace**, **Reddit-style community forums**, chat **groups**, and **creator monetization** (tips & subscriptions) — all on a single FastAPI backend.

The repo is a monorepo: a **React Native + Expo** client (`frontend/`) talking over REST and WebSockets to a **FastAPI** server (`backend/`).

> Note on naming: the repository is `nampo-deploy-readyzip` and deploy docs historically said "Nampo"; the app is branded **Nami App** (Expo manifest name, login screen, API root `{"app": "Nami App API"}`). They refer to the same app.

---

## Key features

### Social / Feed
- News feed with text, photos, and videos (home/following feed and an explore feed)
- Likes **and dislikes** (mutually exclusive; counts sync to the server after each toggle), replies/threads, bookmarks, reposts, and quote-reposts
- **Pin** your own posts to the top of your profile
- **Threaded comments**: reply to a comment (nested under it), with "replying to @user" labels and tappable `@mentions`; the post owner can **pin a comment**
- **Inline media & embeds**: paste a YouTube/Twitch/Vimeo link and it plays inline; paste a direct image / imgur / giphy link and it shows inline (in posts *and* comments). GIF picker available in comments too.
- Polls (timed, single-choice) attached to posts
- Hashtags (browse posts by tag, with counts) and rich link previews
- X-style impression / view-count tracking on posts; likers and reposters lists
- **Content reporting** (flag a post/reel for moderation, one report per user)
- **Promote / advertise** a post: boosts ranking and shows a "Sponsored" badge, via a prototype checkout (durations + a test-mode card form)

### Reels & Stories
- Reels: a vertical, full-screen video feed (`/feed/reels`)
- Stories: 24-hour ephemeral image/video stories with a story tray, view counts, viewer lists, and story replies

### Messaging
- One-to-one (DM) and group conversations
- Message types: text, shared **place/location**, media (images/video), **voice notes** (with a live recording timer), **GIFs**, **shared posts**, **contacts**, and **file/document attachments** (native via the document picker, plus the web file input)
- **❤️ reactions** (double-tap a bubble or use the long-press menu) and **replies** (quoted preview in the composer and on the sent bubble)
- **Custom uploadable emojis**: upload an image + `:shortcode:` and use it inline in any message (global registry; long-press your own to delete)
- Edits, read receipts, unread counts, and message deletion (with a tombstone)
- Group conversation management (rename, avatar, add/remove members, leave)
- Optional client-side **E2E encryption** (tweetnacl) plus optional at-rest encryption (Fernet) when a key is configured
- "Contact seller" flow that spins up a DM from a marketplace listing

### Maps & Navigation
- Full-screen interactive **Mapbox GL** map rendered through a `react-native-webview` bridge
- Forward geocoding, category/POI search, and reverse lookups via the Mapbox Search/Geocoding APIs
- **Turn-by-turn directions** (driving, walking, cycling, driving-with-traffic) with alternates, road exclusions (toll/motorway/ferry), and speed-limit annotations via the Mapbox Directions API
- Multiple map styles (streets, satellite, dark, outdoors)
- Live **ETA sharing**: share your real-time location/ETA to a destination over a WebSocket; recipients watch it move on a public link
- Optional **Foursquare** place matching to enrich a pin with a business profile (rating, hours, phone, website, photo)

### Profile & Settings
- Profiles with avatar, bio, username, and home/work saved locations
- **Verified blue checkmark** shown next to verified users (on posts, comments, profiles)
- Follow / unfollow, followers/following lists
- Friend requests (send, accept, reject, remove) with friend status
- A user's posts (originals plus reposts/quotes) shown on their profile, pinned first
- Tapping a post author (avatar or name) opens their profile
- **Account & security** screen: change your **email** (password-confirmed), change your **password** (current + new), and add a **phone number** (stored now, SMS verification planned)
- A customizable navigation bar; after login the app opens on the **first item in your nav bar** (not always the map)

### Legal & onboarding
- **Terms of Service & Privacy Policy**: agreement is required at sign-up (checkbox + in-app policy screens). Existing users who never agreed — or anyone after the policies are updated (versioned) — are re-prompted to accept before continuing.

### Developer API
- A detailed in-app **Developer API** section (Settings → Developer API): base URL, bearer-token auth, a quickstart, and a browsable endpoint reference grouped by area
- **Personal API keys**: generate labeled keys (shown once), list, and revoke them. Keys are long-lived bearer tokens that work anywhere the REST API is used.

### Creators & monetization (fake payments)
- **Tip** any creator (choose an amount + a note) and **subscribe** monthly at the creator's price, both through a reusable **test-mode checkout** (no real charge)
- A creator's earnings are tracked and shown in a **Wallet** screen: total earned, tips vs. subscriptions, active subscribers, recent transactions, and a control to set your own monthly subscription price
- The Wallet also shows a **Sent** section — the tips you've given and the subscriptions you pay for — plus your total spent and active-subscription count
- All money is credited as earnings to the recipient. (Designed so a real payment processor can be dropped into the fake-payment step later.)

### Roles & moderation
- Site **roles**: `user` / `mod` / `admin`. Bootstrap admins with the `ADMIN_EMAILS` env var.
- Admins can **verify** users and assign **mod/admin** roles from any profile
- Mods/admins can delete any post (owners can always delete their own)

### Discovery
- User search
- Saved **places** and **recents**
- **Guides**: curated, optionally public/cloneable collections of places (with shareable slugs)
- **Reviews** for places (1–5 stars + text)
- **Marketplace** listings (price, category, photos, condition, sold status) with **location + radius search** (Facebook-style: set your location, filter by distance, "N km away" on cards, "Nearest first" sort), **search + category filters**, a **saved/bookmarked** view, advanced listing fields (brand, quantity, negotiable, delivery), **seller profiles** (avatar, aggregate rating, listing grid), and **buyer/seller reviews** (1–5★)
- **Communities (forum)**: a Reddit-style section — create/discover communities, join/leave, post **threads** (title + body), vote (up/down via like/dislike), comment, and sort **Hot / New / Top**
- **Groups**: public/private chat communities with posts, pinned posts, join requests, and member roles (owner/admin/member) — distinct from the forum
- Notifications feed (with unread counts and mark-as-read)

---

## Tech stack

**Frontend**
- React Native `0.81` + **Expo SDK 54** (new architecture enabled)
- **expo-router** (file-based routing, typed routes) on top of React Navigation
- **TypeScript** (strict)
- **expo-video** and **expo-audio** for video playback and voice-note recording/playback
- **Mapbox GL JS** rendered inside `react-native-webview` (`MapboxWebView`)
- expo-location, expo-image-picker, expo-secure-store, expo-haptics, expo-blur, expo-linear-gradient, reanimated, gesture-handler
- `tweetnacl` for client-side E2E key material

**Backend**
- **FastAPI** + **Uvicorn** (ASGI)
- **Pydantic v2** models
- **PostgreSQL** via the async **asyncpg** driver, accessed through a thin MongoDB-style wrapper (`db.py`) so route code reads like Motor/PyMongo (each "collection" is a table with a single JSONB `doc` column)
- bcrypt for password hashing, `cryptography` (Fernet) for optional message encryption at rest
- `httpx` for outbound calls (Foursquare matching, link-preview scraping)
- WebSockets for live ETA sharing

> **Database note:** the running backend uses **PostgreSQL** (`DATABASE_URL`, `asyncpg`). The wrapper in `backend/db.py` deliberately mimics a Mongo API, which is why the older `backend/tests/` suite still imports `pymongo` and reads `MONGO_URL` / `DB_NAME`. The current code and deploy config (`render.yaml`, `DEPLOY.md`) use **`DATABASE_URL`**.

---

## Architecture overview

```
┌──────────────────────────┐         REST  /api/*  +  WS  /api/ws/eta/*        ┌──────────────────────────┐
│   Expo / React Native    │ ───────────────────────────────────────────────▶ │      FastAPI backend     │
│   (frontend/)            │   Authorization: Bearer <session_token>          │      (backend/)          │
│                          │ ◀─────────────────────────────────────────────── │                          │
│  - expo-router screens   │                                                   │  - routes/* (APIRouter)  │
│  - MapboxWebView (GL JS) │                                                   │  - PostgreSQL (asyncpg)  │
└──────────┬───────────────┘                                                   └──────────────────────────┘
           │
           │  direct client→Mapbox calls (geocode, search, directions)
           ▼
   ┌─────────────────┐        the backend also calls Foursquare (place match)
   │  Mapbox APIs    │        and scrapes link previews via httpx
   └─────────────────┘
```

- The frontend calls the backend at **`EXPO_PUBLIC_BACKEND_URL` + `/api`**. Auth is a Bearer **session token** stored in `expo-secure-store`.
- On **native**, the client uses the full `EXPO_PUBLIC_BACKEND_URL`. On **web**, it uses `EXPO_PUBLIC_BACKEND_URL` when set (production static build) and otherwise falls back to same-origin relative paths so the Metro dev proxy (`metro.config.js`) forwards `/api/*` and `/health` to the backend on port `8080` during local development.
- **Mapbox** work (geocoding, category search, turn-by-turn directions) happens **client-side** using `EXPO_PUBLIC_MAPBOX_TOKEN`.
- **Foursquare** place enrichment happens **server-side** (`/api/foursquare/match`) using the optional `FSQ_API_KEY`.
- Live ETA sharing rides a WebSocket at **`/api/ws/eta/{share_id}`**.

---

## Project structure

```
Nampo-deploy-readyzip/
├── README.md                  # this file
├── DEPLOY.md                  # deploy to Render (Postgres + the API)
├── render.yaml                # Render Blueprint (Postgres + API + Expo web static site)
├── design_guidelines.json     # design system (colors, typography, components)
├── test_result.md             # agent testing log / protocol
├── memory/                    # PRD and scratch notes
│
├── backend/                   # FastAPI service
│   ├── server.py              # app entry: CORS, routers, /health, ETA WebSocket, startup
│   ├── core.py                # shared deps: DB proxy, get_current_user(), helpers, env
│   ├── db.py                  # PostgreSQL-backed, Mongo-style async DB wrapper
│   ├── models.py              # all Pydantic request/response models
│   ├── requirements.txt       # Python dependencies
│   ├── Dockerfile             # container image (used by Render)
│   ├── apprunner.yaml         # optional AWS App Runner config
│   ├── routes/                # one APIRouter module per domain (see API overview)
│   │   ├── auth.py            # register/login, sessions, username, Google OAuth, E2E keys
│   │   ├── users.py          # search, follows, friends
│   │   ├── places.py         # saved places + recents
│   │   ├── guides.py         # guides + public/cloneable guides
│   │   ├── reviews.py        # place reviews
│   │   ├── messaging.py      # DMs, groups, messages, voice/place/media
│   │   ├── notifications.py  # notifications feed
│   │   ├── eta.py            # ETA share REST + WebSocket
│   │   ├── posts.py          # feed, posts, likes/dislikes, reposts, bookmarks, polls, reels, pinning, comment threads
│   │   ├── communities.py    # Reddit-style forum communities + threads
│   │   ├── marketplace.py    # listings (location/radius), seller profiles, reviews
│   │   ├── groups.py         # chat communities, members, pins, requests
│   │   ├── foursquare.py     # Foursquare place match
│   │   └── stories.py        # ephemeral stories
│   │   # users.py also hosts: tips, subscriptions, /wallet, /admin/users (roles/verify)
│   ├── services/
│   │   ├── encryption.py     # optional Fernet message encryption at rest
│   │   └── link_preview.py   # OpenGraph/link-preview scraping
│   └── tests/                # pytest suites (see Testing)
│
└── frontend/                  # Expo / React Native client
    ├── app.json               # Expo app manifest (name, plugins, permissions)
    ├── package.json           # scripts + dependencies
    ├── metro.config.js        # dev proxy of /api + /health to the backend
    ├── app/                   # expo-router routes
    │   ├── _layout.tsx        # root layout (auth gate, tab bar, providers)
    │   ├── (tabs)/            # main tabs: index(Map), feed, messages, groups,
    │   │                      #   marketplace, profile, directions, favorites
    │   ├── auth.tsx / login.tsx
    │   ├── chat/[id].tsx      # conversation screen
    │   ├── reels.tsx          # reels feed
    │   ├── story/[userId].tsx # story viewer
    │   ├── post/[id].tsx, hashtag/[tag].tsx, bookmarks.tsx, notifications.tsx
    │   ├── communities.tsx, c/[name].tsx   # forum: discover + a community page
    │   ├── wallet.tsx          # creator earnings (tips/subs)
    │   ├── advertise.tsx       # promote a post (fake-payment checkout)
    │   ├── group/[id]/...     # chat group detail + members
    │   ├── guide/[id].tsx, g/[slug].tsx (public guide)
    │   ├── eta/[shareId].tsx  # public ETA viewer
    │   └── user/[name].tsx, people.tsx, connections.tsx, settings.tsx, ...
    └── src/
        ├── api/client.ts      # typed API client (reads EXPO_PUBLIC_BACKEND_URL/MAPBOX_TOKEN)
        ├── api/mapbox.ts      # geocoding, category search, directions
        ├── utils/embeds.ts    # YouTube/Twitch/Vimeo + image/GIF link detection
        ├── components/        # PostCard, CommentsSheet, EmbedCard, InlineMedia, EmojiText,
        │                      #   CustomEmojiSheet, FakePaymentSheet, VerifiedBadge, MapboxWebView, …
        ├── context/           # Auth, Sidebar, NavBar contexts
        └── utils/             # secure storage, e2e helpers
```

---

## Prerequisites

- **Node.js 20+** and **npm** (or Yarn 1.x — the repo pins `yarn@1.22.22`)
- **Python 3.11**
- A **PostgreSQL** database (local or managed) reachable via a connection string
- The **Expo CLI** (run via `npx expo`, no global install needed)
- For device testing: the **Expo Go** app, or an iOS Simulator / Android Emulator
- A **Mapbox access token** (free tier) for maps, geocoding, and directions
- *(Optional)* a **Foursquare Places API key** for business-profile enrichment

---

## Environment variables

### Backend

| Variable          | Required | Secret | Default        | Description |
| ----------------- | :------: | :----: | -------------- | ----------- |
| `DATABASE_URL`    | **Yes**  | **Yes**| —              | PostgreSQL DSN the app connects to (asyncpg). |
| `CORS_ORIGINS`    | No       | No     | `*`            | Comma-separated allowed origins, or `*` for all. |
| `MESSAGE_ENC_KEY` | No       | **Yes**| *(none)*       | Fernet key. If set, messages are encrypted at rest; if absent/invalid, messaging still works in plaintext. |
| `FSQ_API_KEY`     | No       | **Yes**| `""`           | Foursquare Places API key for `/api/foursquare/match`. Without it, place matching returns nothing. |
| `ADMIN_EMAILS`    | No       | **Yes**| `""`           | Comma-separated emails auto-granted the **admin** role (verify users, set roles, moderate posts). |
| `PORT`            | No       | No     | `8080`         | Port Uvicorn binds to (Render injects this). |

> Auth is email/password only — Google sign-in was removed. `RENDER_EXTERNAL_URL` / `PUBLIC_BASE_URL` are read automatically for building absolute URLs.

> **Note:** the database connection is configured **only** through `DATABASE_URL`; `DB_NAME` is unused. The Render Blueprint (`render.yaml`) provisions a Postgres instance and wires `DATABASE_URL` into the service automatically.

### Frontend

Create `frontend/.env` (Expo automatically exposes `EXPO_PUBLIC_*` vars to the client bundle):

| Variable                   | Required | Secret | Description |
| -------------------------- | :------: | :----: | ----------- |
| `EXPO_PUBLIC_BACKEND_URL`  | **Yes** (native & prod web) | No | Base URL of the backend, no trailing slash and no `/api` (the client appends `/api`). Optional for local web dev (the Metro proxy serves `/api` same-origin); required for a deployed web build so it can reach the API cross-origin. |
| `EXPO_PUBLIC_MAPBOX_TOKEN` | **Yes**  | No*    | Mapbox public access token for maps, geocoding, and directions. |
| `EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME` | No | No* | Cloudinary cloud name. When set with the upload preset below, media (esp. video) uploads to the Cloudinary CDN and only a URL is stored — no size cap and a lighter feed. Without it, media falls back to base64 in the DB (≤25 MB/item). |
| `EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET` | No | No* | An **unsigned** Cloudinary upload preset name. See `frontend/CLOUDINARY_SETUP.md`. |

\* `EXPO_PUBLIC_*` values are bundled into the client and are therefore **not secret at runtime**. Use a Mapbox **public** token (URL/domain-scoped where possible).

---

## Local setup & running

The backend and frontend run as two separate processes.

### 1. Backend (FastAPI)

```bash
cd backend

# Install dependencies (a virtualenv is recommended)
pip install -r requirements.txt

# Point at your PostgreSQL database
export DATABASE_URL="postgresql://user:password@localhost:5432/nampo"
# Optional:
# export CORS_ORIGINS="*"
# export FSQ_API_KEY="..."
# export MESSAGE_ENC_KEY="$(python -c 'from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())')"

# Run with auto-reload on port 8080
uvicorn server:app --reload --port 8080
```

Health checks:
- `GET /health` → `{"status":"ok"}`
- `GET /` → `{"status":"ok","app":"Nami App API"}`
- `GET /api/` → API root for the auth router

### 2. Frontend (Expo)

```bash
cd frontend

# Create your env file
cat > .env <<'EOF'
EXPO_PUBLIC_BACKEND_URL=http://localhost:8080
EXPO_PUBLIC_MAPBOX_TOKEN=pk.your_mapbox_public_token
EOF

# Install dependencies
npm install        # or: yarn

# Start the dev server (then press i / a / w, or scan the QR in Expo Go)
npx expo start
```

Useful scripts (`frontend/package.json`): `npm run android`, `npm run ios`, `npm run web`, `npm run lint`.

> On **web**, the Metro dev server proxies `/api/*` and `/health` to `http://localhost:8080`, so the frontend and backend share an origin and you don't need `EXPO_PUBLIC_BACKEND_URL`. On **native devices**, set it to a URL your device can reach (your machine's LAN IP or a tunnel), not `localhost`.

Create your first account from the app's sign-up screen, or directly against the API:

```bash
curl -X POST http://localhost:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"supersecret","name":"You","username":"you"}'
```

A successful response returns a `session_token` and your user object.

---

## Deployment

- **Render (recommended):** `render.yaml` is a Render **Blueprint** that provisions a managed Postgres database (`nampo-db`), deploys the FastAPI API from `backend/Dockerfile` (`nampo-backend`, with a `/health` check and `autoDeploy`), **and** deploys the Expo web build as a static site (`nampo-web`). The database connection string is injected into the API as `DATABASE_URL` automatically (`fromDatabase`); the static site is configured with `EXPO_PUBLIC_BACKEND_URL` + `EXPO_PUBLIC_MAPBOX_TOKEN` (and optional `EXPO_PUBLIC_CLOUDINARY_*`). Mobile binaries are built separately with **EAS** — see **`frontend/IOS_BUILD.md`** for the iOS/App Store flow (no Mac required). Full backend step-by-step in **`DEPLOY.md`** (~15 minutes).
- **Docker:** `backend/Dockerfile` produces a self-contained image that runs `uvicorn server:app` on `$PORT` (default `8080`). Build/run it anywhere that supports containers and can reach a Postgres database via `DATABASE_URL`.
- **AWS App Runner:** `backend/apprunner.yaml` is provided for source-based App Runner deploys.
- **Other Postgres providers:** to bring your own database (Neon, Supabase, local), drop the `databases:` block from `render.yaml` and set `DATABASE_URL` yourself.

After the backend is live, set the frontend's `EXPO_PUBLIC_BACKEND_URL` to the deployed URL (no trailing slash, no `/api`) and rebuild/restart Expo.

---

## API overview

All routes are mounted under the **`/api`** prefix and (except auth/registration and a few public endpoints) require an `Authorization: Bearer <session_token>` header.

| Route group        | Base paths (examples) | What it does |
| ------------------ | --------------------- | ------------ |
| **Auth**           | `/auth/register`, `/auth/login`, `/auth/me`, `/auth/logout`, `/auth/username`, `/auth/me/email\|password\|phone`, `/auth/api-keys`, `/policies`, `/auth/accept-policies` | Email/username + password registration & login (bcrypt, session tokens), profile read/patch, username claim; **change email / password**, **set phone**; **developer API keys** (create/list/revoke); ToS/Privacy policy versions + acceptance. |
| **Users**          | `/users/search`, `/users/{id}/public`, `/users/{id}/follow`, `/friends/*`, `/users/{id}/tip`, `/users/{id}/subscribe`, `/wallet`, `/admin/users/{id}` | User search, public profiles, follow/friends; **tips & subscriptions** + the creator **wallet** (earned **and sent**); **admin** verify/role management. |
| **Posts / Feed**   | `/posts`, `/feed/home\|explore\|reels`, `/posts/{id}/like\|dislike\|repost\|bookmark\|vote\|view\|promote\|report\|pin`, `/posts/{id}/replies\|thread`, `/bookmarks`, `/hashtags/{tag}` | Create/edit/delete posts, feeds, replies + **full comment threads**, likes/dislikes, reposts/quotes, bookmarks, polls, views, promotion, reporting, **pinning**, hashtags. Forum posts carry `community_id` + `title`. |
| **Stories**        | `/stories`, `/stories/tray`, `/stories/user/{id}`, `/stories/{id}/view\|viewers\|reply` | Create 24h ephemeral stories, story tray, view counts, viewer lists, and replies. |
| **Messaging**      | `/conversations`, `/conversations/groups`, `/conversations/{id}/messages`, `/conversations/{id}/messages/{mid}/react`, `/conversations/{id}/read`, `/emojis` | DMs and group chats; text/place/media/voice/gif/file/contact/post messages; replies, ❤️ reactions, edits, receipts, deletion; **custom emoji** registry (`/emojis` GET/POST/DELETE). |
| **Communities**    | `/communities`, `/communities/{name}`, `/communities/{name}/join`, `/communities/{name}/posts?sort=hot\|new\|top` | Reddit-style forum: create/discover, join/leave, and the community's threads with Hot/New/Top sorting. |
| **Groups**         | `/groups`, `/groups/{id}/join\|leave\|posts\|pins\|requests\|members/*` | Public/private chat communities: membership & join requests, posts, pinned posts, member roles (promote/demote/remove). |
| **Marketplace**    | `/listings?lat&lng&radius_km&sort`, `/listings/{id}`, `/listings/{id}/contact\|save`, `/marketplace/users/{id}` | Create/update/delete listings, **location + radius** browse and nearby sort, save, seller profiles & reviews, and start a DM with a seller. |
| **Places**         | `/places`, `/recents` | Saved map places and recent searches (create/list/delete). |
| **Guides**         | `/guides`, `/guides/{id}/places/{pid}`, `/public/guides/{slug}`, `/public/guides/{slug}/clone` | Curated place collections; add/remove places; publish via slug; view/clone public guides. |
| **Reviews**        | `/reviews` | Create/list/delete 1–5★ place reviews. |
| **ETA**            | `/eta`, `/eta/{id}/update\|stop`, `/public/eta/{id}`, **WS** `/ws/eta/{share_id}` | Create and update live ETA shares; public read; real-time location stream over WebSocket. |
| **Notifications**  | `/notifications`, `/notifications/unread`, `/notifications/read-all` | Notification feed, unread counts, mark single/all read, delete. |
| **Foursquare**     | `/foursquare/match` | Match a place against Foursquare for a business profile (needs `FSQ_API_KEY`). |

The full set of endpoints is the source of truth — see each module under `backend/routes/`. (Interactive docs are available at `/docs` when running locally, since FastAPI exposes Swagger by default.)

---

## Testing / scripts

- **Backend tests** live in `backend/tests/` (pytest), covering auth, posts/newsfeed, reposts, recents/guides, ETA & race conditions, notifications, groups, and several feature iterations. Run with:
  ```bash
  cd backend
  pip install pytest pytest-asyncio httpx
  pytest
  ```
  > Heads-up: several test files were written against the earlier MongoDB build (they import `pymongo` and read `MONGO_URL`/`DB_NAME`). Treat them as reference/regression material; adapt fixtures if you run them against the current PostgreSQL backend.

- **Frontend lint:** `npm run lint` (eslint-config-expo).
- **Helper scripts** (`frontend/scripts/`): `check-pkg.js` (preinstall guard), `install-guard.sh`, and `reset-project.js` (Expo starter reset — not needed for normal development).
- `test_result.md` documents the project's agent-driven testing protocol and the latest test plan/status.

---

## License / notes

No license file is present in the repository. Treat this project as **proprietary / unlicensed** unless a `LICENSE` is added by the owner.

Additional context:
- The design system (colors, typography, component styles, map styles) is documented in `design_guidelines.json`.
- The product requirements live in `memory/PRD.md`.
