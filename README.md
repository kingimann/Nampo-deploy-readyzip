# OkaySpace

**OkaySpace** is a social + maps super-app for mobile and the web. It blends a
Twitter/Instagram-style social network with a Google-Maps-style navigation
experience, a location-aware marketplace, creator monetization, peer-to-peer
payments, roadside assistance, and a full **Developer API** for building on top
of and embedding OkaySpace anywhere.

The repo is a monorepo: a **React Native + Expo** client (`frontend/`) talking
over REST + WebSockets to a **FastAPI** server (`backend/`) backed by
**PostgreSQL**.

---

## Contents

- [Key features](#key-features)
- [Tech stack](#tech-stack)
- [Architecture overview](#architecture-overview)
- [Project structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Environment variables](#environment-variables)
- [Local setup & running](#local-setup--running)
- [Deployment](#deployment)
- [API overview](#api-overview)
- [Developer API & embedding](#developer-api--embedding)
- [Testing & scripts](#testing--scripts)
- [License & notes](#license--notes)

---

## Key features

### Social & feed
- Home/following feed and an explore feed with text, photos, and videos
- Likes **and dislikes** (mutually exclusive), replies/threads, bookmarks, reposts, and quote-reposts
- **Threaded comments** with "replying to @user" labels, tappable `@mentions`, and owner **pin a comment**
- **Compose a thread** — publish several connected posts at once (each with its own media); the post detail view stitches the author's chain back together so it reads top-to-bottom
- **Save drafts** of posts — text, photos, **videos and reels** — to finish later (server-backed, so drafts follow you across devices)
- **Pin** your own posts to the top of your profile
- **Inline media & embeds**: YouTube/Twitch/Vimeo links play inline; image / imgur / giphy links render inline (posts *and* comments); GIF picker in comments
- Polls (timed, single-choice), hashtags (browse by tag with counts), and rich link previews
- Impression / view-count tracking; likers and reposters lists
- **Content reporting** (one report per user) for moderation

### Reels & stories
- **Reels**: a vertical, full-screen video feed (`/feed/reels`) with a cover-fit, controls-free web player
- Upload reels (Cloudinary CDN) **or** paste a link from a verified host (imgur / streamable / direct `.mp4`), auto-resolved to a playable file. YouTube/TikTok stay regular video posts.
- **Video ads in reels**: full-screen sponsored overlays (5–60s) with progress bar, CTA, skip-after-5s, and CTR tracking
- **Stories**: 24-hour ephemeral image/video stories with a tray, view counts, viewer lists, and replies

### Messaging & calls
- One-to-one and group conversations; message types: text, **place/location**, media, **voice notes**, **GIFs**, **shared posts**, **contacts**, and **file/document attachments**
- **❤️ reactions**, **replies** (quoted preview), edits, read receipts, unread counts, deletion (tombstone)
- **Custom uploadable emojis** (`:shortcode:` global registry)
- **Snapchat-style presence** (delivered/sent/read, "writing…", "active now") and **Clear conversation**
- Optional client-side **E2E encryption** (tweetnacl) + optional at-rest encryption (Fernet)
- **Voice/video calls** over **LiveKit** (WebRTC) with in-app + push ringing
- "Contact seller" flow spins up a DM from a marketplace listing

### Maps & navigation
- Full-screen interactive **Mapbox GL JS** map rendered via a `react-native-webview` bridge
- Forward geocoding, category/POI search, and reverse lookups (Mapbox Search/Geocoding)
- **Turn-by-turn directions** (driving, walking, cycling, traffic) with alternates, road exclusions, and speed limits
- Multiple map styles (streets, satellite, dark, outdoors)
- Live **ETA sharing** over a WebSocket; recipients watch it move on a public link
- **Foursquare business profiles**: enrich a pin (and a dedicated profile screen) with rating, hours, phone, website, and photos
- **Transit**: nearby stops + next departures via TransitLand (real-time where available)

### Marketplace
- Listings with price, currency, category, condition, photos, brand, quantity, negotiable, and delivery
- **Location + radius search** (set your location, filter by distance, "N km away", "Nearest first")
- Search + category filters, **seller profiles** (avatar, rating, listing grid), and **buyer/seller reviews** (1–5★)
- **Personal + business profiles**: run a **business storefront** that's a separate selling identity from your personal/social profile — its own name, logo, banner, accent, tagline, bio, category, contact details, and policies. **Switch between Personal and Business** right in My Marketplace and on your profile; a **"List as Personal / Business"** picker in the composer attributes each listing, and listing cards show the business brand.
  - **Completely separate reviews**: a business earns its own reviews/rating from trades made *with the business*; personal trades earn personal reviews — the two reputations never mix.
  - **Ban cascade**: if the owner's personal account is banned, the business storefront is hidden too.
- Brand-your-storefront editor (shop name/logo/banner/accent/policies) for the personal seller profile, separate from the business entity
- A personal **My Marketplace** hub gathering your listings, saved/bookmarked items, and your marketplace reviews in one place
- AI spam/moderation gate on new listings; "Contact seller" opens a DM

### Roadside assistance
- Members **request help when stranded** — a tow (with destination) or a light service (lockout, battery boost/jump, tire change/flat)
- Nearby members see open requests and **accept** one; an **accept/decline detail screen** shows phone (revealed **after accept** only), vehicle, address, notes, and photos
- A **2-minute response timer** (auto-declines on expiry) with auto-refresh so a call disappears once another helper takes it
- A dedicated **"Your job"** tab with **en route → on location** steps; arrival is gated by a **GPS proximity check**
- **Photo AI moderation** flags non-automotive photos (Claude vision, with an optional self-hosted Ollama fallback)
- **Disputes** are only recorded when a valid **support ticket** is opened
- **Daily call numbers**: every request gets a queue number that starts at **1** and **resets at local midnight** (timezone configurable)
- **Admin dispatch console** (`/admin-roadside-calls`): create **test or real** calls, **search the day's calls by number**, and view full details (requester/helper, phone, vehicle, location, notes, timestamps)
- Staff verification queue (`/admin-roadside`)

### Custom forms (Contact-Form-7 style)
- Build forms in-app with 9 field types (text, email, phone, number, paragraph, date, dropdown, single-choice, checkboxes), required toggles, reorder, and options
- **Use them anywhere**: render in-app, open a hosted page, or embed on any website via a `<script>` snippet or iframe
- **Themeable embeds** via `data-*` / query params: `theme` (light/dark), `accent`, `bg`, `radius`, `hide_title`, `redirect`-after-submit, and field **prefill**
- **Responses**: in-app viewer, **CSV export**, a **per-form email recipient** override, plus **`form.submission` webhooks** to your own server
- Spam protection: a hidden **honeypot** field + a per-IP **rate limit**

### Profile, settings & legal
- Profiles with avatar, bio, username, and home/work saved locations
- **Deep profile customization** (Edit profile is organized into **Basics / Look / About / Links / Privacy** tabs):
  - **Avatar gallery** — a huge multi-style avatar picker (14 DiceBear art styles) with a **Shuffle** for effectively unlimited options, or upload your own
  - **Look**: a **cover/banner photo**, an **accent color** (curated palette + custom hex), **one-tap theme presets**, **Steam-style avatar frames** (gradient rings) and **full-profile backgrounds**
  - **About**: a short **status** (emoji + text), a **headline** tagline, pronouns, location, birthday, and **interest tags**
  - **Links**: social links + a **link-in-bio** list of featured links
  - **Privacy tab**: private account, appear-in-search, show active status, show points, and who-can **message / comment / tag / see-connections**, all in one place
  - **Custom profile link**: pick your `@username` and it becomes your shareable vanity URL `okayspace.ca/<username>`, with a live availability check (Available / Taken) as you type
- **Share anything**: a Share / Copy-link action on profiles, posts, photos, videos, reels, marketplace listings, and business storefronts builds a clean `okayspace.ca` link and opens the native share sheet (or copies on desktop web)
- **Activity points (Snapscore-style)** — earn points for real activity: posting, stories, messages, gaining followers, and community upvotes (**not** just for being online), shown as a flame **points + level** card with progress; **level tiers** (Newcomer → Mythic) and a **global leaderboard** (`/leaderboard`)
- **Verified blue checkmark** across posts, comments, and profiles
- **Per-post privacy**: who can comment (everyone/followers/friends/nobody), likes off, and viewer list
- **Privacy controls**: default comment policy, disable likes, hide the stories row, chat-button position, **activity status** (green "active now" dot), and **read receipts** toggles
- Follow/unfollow, followers/following, friend requests (send/accept/reject/remove)
- **Account & security**: change email (password-confirmed), change password, **verify phone** via SMS, **SMS two-factor**, and **phone OTP login**
- Customizable navigation bar (the app opens on your first nav item) and sidebar
- **Terms of Service & Privacy Policy** acceptance required at sign-up (versioned; re-prompted on update)
- **Support & disputes**: open tickets, message staff back and forth, and track resolution

### Payments, wallet & money (real Stripe, with a test-mode fallback)
- **Real payments via Stripe** when configured (`STRIPE_SECRET_KEY`): tips, monthly **subscriptions**, and post **promotion**, paid with an **inline card field** (Stripe.js Elements + PaymentIntents/Subscriptions). When Stripe isn't configured (or an admin enables test mode) the app falls back to a simulated checkout. **Test payments are off by default.**
- **Wallet** with a spendable **balance** you **top up** with an **in-app card form** (web Payment Element / native PaymentSheet via `automatic_payment_methods`; credited instantly on confirm, with webhook + on-return confirm + per-visit reconcile as backstops), shown in a **display currency you choose** (12 currencies; stored in USD)
- **Stripe-native wallet rail** (`/api/v1/stripe/*`): treats the connected-account balance as the wallet — create/onboard the Express account, read **balance**, **transfer** money user→user (platform-mediated), **payout** to bank/card, and list **balance transactions**, kept in sync by a dedicated **Connect webhook** (`STRIPE_CONNECT_WEBHOOK_SECRET`). Runs additively alongside the in-app ledger.
- **Instant cash-out to a debit card** (Stripe Instant Payouts): **$5 minimum**, **$1.99 flat fee**, disabled until a debit card is attached
- **Fully in-app payouts (no Stripe-hosted screens)**: identity verification (in-app Stripe Identity modal via the session `client_secret`), **debit card** and **bank details** are native forms tokenized client-side by Stripe.js, and **saved destinations** are listed/managed in-app (`/payments/payouts/methods` — "Visa •• 4242 · default", set-default, remove). The only Stripe-owned pixels are the PCI-required card-number field.
- **Payout schedule**: free scheduled bank payouts weekly (default), bi-weekly, or monthly — changeable once a month
- **Peer-to-peer money**: send (gated by a personal **security question**) and **request** money; sends are a pending transfer with a **5-minute reversal window**, full history, and accept/decline
- **Pay by QR**: a branded on-device pay QR (with your avatar) + an in-app scanner
- **Unified "All activity" feed** (`/activity`): top-ups, cash-outs, tips & subscriptions (sent/received), and transfers in one timeline
- **Fees**: an admin-controlled **revenue split** plus a flat **per-payment transaction fee**, booked to the platform-revenue ledger (and reversed if a transfer is)

### Ads & advertising
- Prepaid ad accounts, **promoted posts** (budget/CPC) and **reel video ads**, **link ads** for your own site, and a **publisher network** to embed customizable OkaySpace ad units on your site and earn — with click-fraud guards and account-age gates

### Roles & moderation
- Site roles: `user` / `mod` / `admin`; bootstrap admins via `ADMIN_EMAILS`
- Admins **verify** users and assign roles from any profile; mods/admins can delete any post
- **Admin panels**: payments & fees, platform/ad revenue, user moderation (ban/suspend/role/verify) + audit log, custom badges, the **@claude test bot**, roadside verifications, support triage, and an **Integrations & SDKs** status board (configured + live health checks + remediation)
- **In-site UX guards (web)**: important confirmations use in-app dialogs, while simpler `Alert.alert` prompts route through the browser's native dialog on web (so their buttons actually work); plus a keyboard-refresh confirm and disabled right-click / dev-tools shortcuts

### Discovery
- User search, saved **places** + **recents**, **guides** (curated, optionally public/cloneable collections with shareable slugs), place **reviews** (1–5★)
- **Communities (forum)**: a full Reddit-style system — create/discover (favorites first, **trending** sort + relevance search), join/favorite, post threads, up/down-vote, comment, and sort **Hot / New / Top / Rising** (real time-decayed "hot") with **flair filters** and **in-community search**. Each community has a **banner**, editable **rules**, **post flairs**, an **About/wiki** page, and **auto-moderation** (banned-word blocklist). **Moderators** (owner promotes members) can **remove/pin** posts, **manage members**, and edit settings. **Karma** (a 👍 on your post) feeds both your global points and a **per-community karma badge + leaderboard**. A **"Your feed"** tab aggregates threads across the communities you've joined, and mods/authors get **community notifications** (pinned/removed/promoted)
- **Groups**: public/private chat communities with posts, pinned posts, join requests, and member roles — distinct from the forum
- Notifications feed (unread counts, mark-as-read)

### Web app (responsive + PWA)
- The same Expo client runs in any browser, exported as a **static site** (`okayspace.ca`) — no separate web codebase.
- **Desktop chrome (≥ 900px)**: a three-column shell — a **left nav rail**, a **centred content column** flush against both rails, and a **right rail** with **search**, **trending hashtags** and **top members**. Below 900px it falls back to the full mobile UI with the floating tab bar.
- **Vanity profile URLs**: every profile is shareable at `okayspace.ca/<username>` (the address bar rewrites `/user/<name>` → the handle once a profile loads); route groups are hidden so URLs stay clean (`/feed`, `/marketplace`, `/profile`).
- **Installable PWA**: web manifest + branded launch splash, locked viewport with internal scrolling, and a **pull-to-refresh** gesture on touch devices. Native confirmations are used for key actions; simpler `Alert`s fall back to the browser dialog on web.
- **Auto-updating (web-update kill switch)**: the server publishes a `web_build` token (the deploy's commit) in `/public/app-config`; open browsers re-check it on launch, every 2 minutes, and on tab-focus, and when it changes they unregister any stale service worker, clear caches, and hard-refresh **once** to the new bundle — so deploys reach every web client automatically (no manual cache-clear). Admins can also force it instantly from **Settings → Payments → Access → "Force web update"** (`POST /api/admin/web-build`).

### Developer API
A first-class, paid Developer API (Settings → Developer API) for building on OkaySpace
and embedding it anywhere — see [Developer API & embedding](#developer-api--embedding).
Highlights: personal **API keys** (read/write scopes), paid **plans + usage
quotas**, signed **webhooks** (21 event types, retries, delivery logs, test pings),
**Login with OkaySpace** (OAuth2 provider), the **publisher ad network**, **custom
forms**, **embeddable content + oEmbed**, **idempotency keys**, cursor
pagination, open CORS, a versioned `/api/v1`, and **tagged OpenAPI/Swagger docs**.
The in-app reference documents the **full surface (~460 endpoints across ~37 groups,
including the admin console)** with **tap-to-try** request snippets per endpoint,
hand-written client kits for **cURL, JavaScript, Python, Dart/Flutter, Swift,
Kotlin, Go, and Rust**, one-click **Postman/Insomnia import**, example response
shapes, and machine-readable discovery + changelog (`/v1/info`, `/v1/changelog`).

---

## Tech stack

**Frontend**
- React Native `0.81` + **Expo SDK 54** (new architecture)
- **expo-router** (file-based, typed routes) on React Navigation
- **TypeScript** (strict)
- **expo-video** / **expo-audio** for playback and voice notes
- **Mapbox GL JS** inside `react-native-webview` (`MapboxWebView`)
- expo-location, expo-image-picker, expo-document-picker, expo-secure-store, expo-clipboard, expo-sharing, expo-haptics, expo-blur, reanimated, gesture-handler
- `tweetnacl` for client-side E2E key material

**Backend**
- **FastAPI** + **Uvicorn** (ASGI), **Pydantic v2**
- **PostgreSQL** via async **asyncpg**, through a thin MongoDB-style wrapper (`db.py`) so route code reads like Motor/PyMongo (each "collection" is a table with a single JSONB `doc` column)
- bcrypt (passwords), `cryptography` (Fernet, optional at-rest message encryption)
- `httpx` for outbound calls (Foursquare, TransitLand, link previews, webhook delivery, AI hosts)
- WebSockets for live ETA sharing

**External & optional services**
- **Stripe** (payments, Connect payouts, instant cash-out), **Cloudinary** (media CDN), **Mapbox** (maps/geocoding/directions), **Foursquare** (place enrichment), **TransitLand** (transit), **Twilio** (SMS), **SMTP** (email), **LiveKit** (WebRTC calls), **Expo Push** (notifications)
- **AI**: Anthropic **Claude** (vision + text — roadside photo moderation, document verification, spam classification, and the in-app **@claude** assistant), with an optional self-hosted **Ollama** vision fallback

> **Database note:** the running backend uses **PostgreSQL** (`DATABASE_URL`, `asyncpg`). The wrapper in `backend/db.py` deliberately mimics a Mongo API, which is why the older `backend/tests/` suite still imports `pymongo`/`MONGO_URL`. Current code and deploy config use **`DATABASE_URL`**.

---

## Architecture overview

```
┌──────────────────────────┐     REST /api/* (+ /api/v1/*)  +  WS /api/ws/eta/*    ┌──────────────────────────┐
│   Expo / React Native    │ ─────────────────────────────────────────────────▶  │      FastAPI backend     │
│   (frontend/)            │      Authorization: Bearer <session token | API key> │      (backend/)          │
│                          │ ◀─────────────────────────────────────────────────  │                          │
│  - expo-router screens   │                                                       │  - routes/* (APIRouter)  │
│  - MapboxWebView (GL JS) │                                                       │  - PostgreSQL (asyncpg)  │
└──────────┬───────────────┘                                                       └─────────────┬────────────┘
           │ direct client→Mapbox (geocode, search, directions)                                  │
           ▼                                                                                      ▼
   ┌─────────────────┐                                            Stripe · Cloudinary · Foursquare · TransitLand
   │  Mapbox APIs    │                                            Twilio · SMTP · LiveKit · Expo Push · Claude/Ollama
   └─────────────────┘
```

- The frontend calls the backend at **`EXPO_PUBLIC_BACKEND_URL` + `/api`**. Auth is a Bearer **session token** (or a developer **API key**) stored in `expo-secure-store`.
- On **native**, the client uses the full `EXPO_PUBLIC_BACKEND_URL`. On **web**, it uses that URL when set, otherwise falls back to same-origin so the Metro dev proxy (`metro.config.js`) forwards `/api/*` and `/health` to the backend on port `8080` during local development.
- **Mapbox** work happens **client-side** with `EXPO_PUBLIC_MAPBOX_TOKEN`. **Foursquare/TransitLand/Stripe webhooks/AI** happen **server-side**.
- The stable, versioned base is **`/api/v1`**; **`/api`** is kept as a legacy alias. CORS is open so browser/mobile/3rd-party apps can call directly.
- Live ETA sharing rides a WebSocket at **`/api/ws/eta/{share_id}`**.

---

## Project structure

```
OkaySpace/
├── README.md                  # this file
├── API.md                     # developer-facing API reference
├── DEPLOY.md                  # deploy to Render (Postgres + the API)
├── render.yaml                # Render Blueprint (Postgres + API + Expo web static site)
├── design_guidelines.json     # design system (colors, typography, components)
├── test_result.md             # agent testing log / protocol
├── memory/                    # PRD and scratch notes
│
├── backend/                   # FastAPI service
│   ├── server.py              # app entry: CORS, idempotency, routers, /health, ETA WS, startup
│   ├── core.py                # shared deps: DB proxy, get_current_user(), helpers, env
│   ├── db.py                  # PostgreSQL-backed, Mongo-style async DB wrapper
│   ├── models.py              # Pydantic request/response models
│   ├── requirements.txt       # Python dependencies
│   ├── Dockerfile             # container image (used by Render)
│   ├── apprunner.yaml         # optional AWS App Runner config
│   ├── routes/                # one APIRouter module per domain
│   │   ├── auth.py            # register/login, sessions, 2FA, phone OTP, password reset, API keys, policies
│   │   ├── users.py           # search, follows, friends, tips, subscriptions, /wallet, /admin/users
│   │   ├── posts.py           # feed, posts, likes/dislikes, reposts, bookmarks, polls, reels, pinning, threads
│   │   ├── drafts.py          # per-user post drafts (text/media/poll/privacy/thread)
│   │   ├── stories.py         # 24h ephemeral stories
│   │   ├── messaging.py       # DMs, groups, messages, voice/place/media, reactions, custom emoji
│   │   ├── calls.py           # LiveKit room tokens + ring (voice/video)
│   │   ├── push.py            # device push-token registration
│   │   ├── notifications.py   # notifications feed
│   │   ├── places.py          # saved places + recents
│   │   ├── guides.py          # guides + public/cloneable guides
│   │   ├── reviews.py         # place reviews
│   │   ├── foursquare.py      # Foursquare place match / business profiles
│   │   ├── transit.py         # nearby transit stops + departures (TransitLand)
│   │   ├── eta.py             # ETA share REST + WebSocket
│   │   ├── marketplace.py     # listings (location/radius), seller profiles, reviews
│   │   ├── communities.py     # Reddit-style forum communities + threads
│   │   ├── groups.py          # chat communities, members, pins, requests
│   │   ├── roadside.py        # roadside assistance (request/accept, en route/on location, photos, disputes, daily call numbers, admin dispatch)
│   │   ├── support.py         # support & dispute tickets
│   │   ├── forms.py           # custom form builder + public themeable embeds + submissions/CSV/webhooks
│   │   ├── embed.py           # public embeddable content: post/profile JSON, cards, content-embed.js, oEmbed
│   │   ├── webhooks.py        # developer event webhooks (signed, retries, delivery logs, test ping)
│   │   ├── oauth.py           # "Login with OkaySpace" OAuth2 provider (apps, authorize/token/userinfo)
│   │   ├── ads.py             # promoted posts, reel video ads, ad accounts, link ads
│   │   ├── adnetwork.py       # publisher network: sites + customizable embeddable ad units
│   │   ├── payments.py        # Stripe Connect, inline payments, payouts, cash-out, webhook, API plans/usage
│   │   ├── money.py           # peer-to-peer send/request, wallet balance/top-up, currency, reversal, history
│   │   ├── payouts.py         # scheduled creator payouts
│   │   ├── integrations.py    # admin integrations/SDK status board + live health checks
│   │   └── meta.py            # /version, machine-readable /v1/info + /v1/changelog, public /app-config (web-update token)
│   ├── services/
│   │   ├── claude_ai.py       # Claude vision/text (photo moderation, doc verification, spam)
│   │   ├── ollama.py          # optional self-hosted AI vision fallback
│   │   ├── claude_bot.py      # in-app @claude assistant bot
│   │   ├── email.py           # SMTP email (password reset, form notifications)
│   │   ├── sms.py             # Twilio SMS (verification, OTP, 2FA, notifications)
│   │   ├── push.py            # Expo push delivery
│   │   ├── encryption.py      # optional Fernet message encryption at rest
│   │   └── link_preview.py    # OpenGraph/link-preview scraping
│   └── tests/                 # pytest suites (see Testing)
│
└── frontend/                  # Expo / React Native client
    ├── app.json               # Expo manifest (name, plugins, permissions)
    ├── package.json           # scripts + dependencies
    ├── metro.config.js        # dev proxy of /api + /health to the backend
    ├── app/                   # expo-router routes
    │   ├── _layout.tsx        # root layout (auth gate, tab bar, providers)
    │   ├── (tabs)/            # main tabs: index(Map), feed, messages, groups, marketplace, profile, directions, favorites
    │   ├── login.tsx, auth.tsx, legal/        # auth + ToS/Privacy
    │   ├── chat/[id].tsx, call/               # conversation + voice/video call
    │   ├── reels.tsx, story/[userId].tsx      # reels + story viewer
    │   ├── post/[id].tsx, hashtag/[tag].tsx, bookmarks.tsx, notifications.tsx, leaderboard.tsx
    │   ├── communities.tsx, c/[name].tsx      # forum: discover + community page
    │   ├── group/[id]/...                     # chat group detail + members
    │   ├── listing/, seller/, my-listings.tsx # marketplace
    │   ├── place/[id].tsx                     # Foursquare business profile
    │   ├── roadside.tsx, admin-roadside.tsx, admin-roadside-calls.tsx  # roadside request + staff queue + admin call dispatch
    │   ├── support.tsx, support/[id].tsx, admin-support.tsx  # tickets
    │   ├── forms.tsx, forms/[id].tsx, f/[key].tsx  # form list, builder, public renderer
    │   ├── developer.tsx, oauth/, connected-apps.tsx  # Developer API + OAuth consent
    │   ├── advertise.tsx, monetize.tsx        # promote / publisher
    │   ├── wallet.tsx, money.tsx, activity.tsx, pay/, pay-qr.tsx, pay-scan.tsx
    │   ├── verify-payouts.tsx, add-card.tsx, add-bank.tsx     # in-app KYC/payout forms
    │   ├── guide/[id].tsx, g/[slug].tsx, eta/[shareId].tsx    # guides + public ETA viewer
    │   ├── account.tsx, privacy.tsx, customize-nav.tsx, customize-sidebar.tsx, settings.tsx
    │   └── admin-* (users, payments, revenue, badges, bot, integrations, audit)
    └── src/
        ├── api/client.ts      # typed API client (reads EXPO_PUBLIC_BACKEND_URL/MAPBOX_TOKEN)
        ├── api/mapbox.ts      # geocoding, category search, directions
        ├── components/        # PostCard, CommentsSheet, EmbedCard, InlineMedia, MapboxWebView, …
        ├── context/           # Auth, Confirm, Sidebar, NavBar contexts
        └── utils/             # secure storage, e2e helpers, nav, embeds
```

---

## Prerequisites

- **Node.js 20+** and **npm** (or Yarn 1.x — the repo pins `yarn@1.22.22`)
- **Python 3.11**
- A **PostgreSQL** database (local or managed) reachable via a connection string
- The **Expo CLI** (run via `npx expo`, no global install needed)
- For device testing: **Expo Go**, or an iOS Simulator / Android Emulator
- A **Mapbox access token** (free tier) for maps/geocoding/directions
- *(Optional)* keys for Foursquare, Stripe, Cloudinary, Twilio, SMTP, LiveKit, TransitLand, and Anthropic — each feature degrades gracefully when its key is absent

---

## Environment variables

### Backend

| Variable | Required | Secret | Default | Description |
| --- | :---: | :---: | --- | --- |
| `DATABASE_URL` | **Yes** | **Yes** | — | PostgreSQL DSN (asyncpg). |
| `CORS_ORIGINS` | No | No | `*` | Comma-separated allowed origins, or `*`. |
| `LEGACY_API_SUNSET` | No | No | `Wed, 31 Dec 2026 23:59:59 GMT` | `Sunset` date sent on the deprecated unversioned `/api` alias responses. |
| `WEB_APP_URL` | No | No | `https://okayspace.ca` | Public web app origin, used for payment return URLs and the canonical links in embeds/oEmbed. |
| `MESSAGE_ENC_KEY` | No | **Yes** | *(none)* | Fernet key. If set, messages are encrypted at rest; otherwise plaintext. |
| `FSQ_API_KEY` | No | **Yes** | `""` | Foursquare Places API key for `/api/foursquare/match`. |
| `MAPBOX_TOKEN` | No | **Yes** | `""` | Server-side Mapbox token for address autocomplete on **embedded forms** (`/pub/geocode`). Without it, form address fields still work as plain text. (App maps use the client `EXPO_PUBLIC_MAPBOX_TOKEN`.) |
| `TRANSITLAND_API_KEY` | No | **Yes** | `""` | [TransitLand](https://www.transit.land/) key for `/api/transit/nearby`. |
| `ADMIN_EMAILS` | No | **Yes** | `""` | Comma-separated emails auto-granted the **admin** role. |
| `STRIPE_SECRET_KEY` | No | **Yes** | *(none)* | Stripe secret (`sk_live_…`/`sk_test_…`). Enables real payments/payouts; otherwise simulated. |
| `STRIPE_WEBHOOK_SECRET` | No | **Yes** | *(none)* | Signing secret for `/api/payments/webhook` (enforced when set). |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | No | No | *(falls back to `STRIPE_WEBHOOK_SECRET`)* | Signing secret for the **Connect** webhook `/api/v1/stripe/webhook` (`account.updated`, `payout.*`). |
| `STRIPE_PUBLISHABLE_KEY` | No | No | *(none)* | Publishable key for embedded onboarding/checkout (web uses `EXPO_PUBLIC_STRIPE_KEY`). |
| `PLATFORM_FEE_PERCENT` | No | No | `0` | Default platform cut of subscriptions/tips (admin-tunable at runtime). |
| `ANTHROPIC_API_KEY` | No | **Yes** | *(none)* | Enables Claude **vision only** — roadside **photo** moderation and **document** verification. (All text AI runs on Ollama; see below.) |
| `CLAUDE_VISION_MODEL` | No | No | *(sane default)* | Override the Claude vision model. |
| `OLLAMA_HOST` | No | No | *(none)* | Self-hosted **Ollama** host (e.g. `http://localhost:11434`). Powers **all text AI**: the **@claude assistant**, chat summaries, **scam/spam detection**, marketplace listing-text checks, and form-answer validation — plus optional local vision. Set `OLLAMA_TEXT_MODEL` (default `llama3.2`) / `OLLAMA_VISION_MODEL` (default `llama3.2-vision`). When unset, text-AI features report they aren't configured. |
| **Voice transcription** (pick one) | No | No | *(none)* | Speech-to-text for the **Transcribe** button on voice notes. Set **one** of: **OpenAI Whisper** (`OPENAI_API_KEY`, model `OPENAI_STT_MODEL` default `whisper-1`) or **Deepgram** (`DEEPGRAM_API_KEY`, model `DEEPGRAM_STT_MODEL` default `nova-2`). End-to-end-encrypted voice notes are decrypted client-side and never stored. When unset, the button reports transcription isn't configured. |
| **SMS provider** (pick one) | No | **Yes** | *(none)* | SMS for phone verification, OTP login, 2FA, password reset, and notifications. The sender is provider-agnostic — set **one** of: **Vonage** (`VONAGE_API_KEY`, `VONAGE_API_SECRET`, `VONAGE_FROM`), **Plivo** (`PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_FROM`), or **Twilio** (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`). Optionally force one with `SMS_PROVIDER=vonage\|plivo\|twilio`. When none is set, codes are returned in the API response (`dev_code`). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | No | **Yes** | `SMTP_PORT=587` | SMTP for password-reset emails and **form submission emails**. Needs at least `SMTP_HOST` + `SMTP_FROM`. |
| `RECOVERY_SECRET` | No | **Yes** | *(none)* | Break-glass owner password recovery via `/api/auth/recover-password`. |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` / `LIVEKIT_URL` | No | **Yes** | *(none)* | [LiveKit](https://cloud.livekit.io/) for in-app voice/video calls (WebRTC). |
| `EXPO_ACCESS_TOKEN` | No | **Yes** | *(none)* | Optional Expo token to raise push rate limits. |
| `RENDER_API_KEY` | No | **Yes** | *(none)* | Owner API token (Render → Account Settings → API Keys). Enables **Settings → Render (admin)** to view services/deploys and view/edit env vars, deploy, restart, and suspend/resume — without leaving the app. Admin-only; env-var values are masked with tap-to-reveal. |
| `ROADSIDE_TZ` | No | No | `America/Toronto` | IANA timezone whose **midnight** resets the daily roadside call-number counter. Falls back to UTC if tzdata is unavailable. |
| `PORT` | No | No | `8080` | Port Uvicorn binds to (Render injects this). |

> **Admin → Integrations & SDKs:** signed in as an admin, open **Settings → Integrations & SDKs (admin)** for a live status board of every service above — what's configured, a one-tap "Run live tests" to confirm credentials work, and the exact env var(s) to set for anything missing (`GET /api/admin/integrations?live=1`).

> **Notes:** auth is email/password only (Google sign-in was removed). `RENDER_EXTERNAL_URL` / `PUBLIC_BASE_URL` are read automatically for absolute URLs. The DB is configured **only** via `DATABASE_URL` (`DB_NAME` is unused).

### Voice/video calls & background ringing

Calls use **LiveKit** (WebRTC). The web app works once `LIVEKIT_*` is set. On
**native**, calling needs an **EAS dev/production build** (WebRTC isn't in Expo Go):

```bash
cd frontend
eas login && eas init
eas build --profile development --platform ios   # or android
```

**Background ringing** is layered: (1) a high-priority **Expo push** on ring
(`POST /api/push/register` stores device tokens; `/calls/{id}/ring` sends it) —
works with a dev build + notification permission; (2) a full-screen
CallKit/ConnectionService ring is a manual next step (add `react-native-callkeep`
+ a VoIP/PushKit path). The token-registration and ring endpoints are already in place.

### Frontend

Create `frontend/.env` (Expo exposes `EXPO_PUBLIC_*` vars to the client bundle):

| Variable | Required | Secret | Description |
| --- | :---: | :---: | --- |
| `EXPO_PUBLIC_BACKEND_URL` | **Yes** (native & prod web) | No | Backend base URL, no trailing slash and no `/api`. Optional for local web dev (Metro proxy serves `/api`); required for a deployed web build. |
| `EXPO_PUBLIC_MAPBOX_TOKEN` | **Yes** | No\* | Mapbox public token for maps/geocoding/directions. |
| `EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME` | No | No\* | Cloudinary cloud name. With the preset below, media uploads to the CDN (URL stored). |
| `EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET` | No | No\* | An **unsigned** Cloudinary preset. **Required for video/reels uploads** (see `frontend/CLOUDINARY_SETUP.md`). |
| `EXPO_PUBLIC_STRIPE_KEY` | No | No\* | Stripe **publishable** key. When set, card fields/onboarding render **embedded in the web app**. |

\* `EXPO_PUBLIC_*` values are bundled into the client and are **not secret at runtime**. Use a Mapbox **public** token (domain-scoped where possible).

---

## Local setup & running

The backend and frontend run as two separate processes.

### 1. Backend (FastAPI)

```bash
cd backend
pip install -r requirements.txt              # a virtualenv is recommended

export DATABASE_URL="postgresql://user:password@localhost:5432/okayspace"
# Optional, e.g.:
# export MESSAGE_ENC_KEY="$(python -c 'from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())')"

uvicorn server:app --reload --port 8080      # auto-reload on :8080
```

Health checks:
- `GET /health` → `{"status":"ok"}`
- `GET /` → `{"status":"ok","app":"OkaySpace API"}`
- `GET /api/v1/info` → machine-readable API overview & capabilities

### 2. Frontend (Expo)

```bash
cd frontend

cat > .env <<'EOF'
EXPO_PUBLIC_BACKEND_URL=http://localhost:8080
EXPO_PUBLIC_MAPBOX_TOKEN=pk.your_mapbox_public_token
EOF

npm install        # or: yarn
npx expo start     # then press i / a / w, or scan the QR in Expo Go
```

Useful scripts (`frontend/package.json`): `npm run android`, `npm run ios`, `npm run web`, `npm run lint`.

> On **web**, the Metro dev server proxies `/api/*` and `/health` to `http://localhost:8080`, so you don't need `EXPO_PUBLIC_BACKEND_URL`. On **native devices**, set it to a URL the device can reach (LAN IP or a tunnel), not `localhost`.

Create your first account from the sign-up screen, or directly against the API:

```bash
curl -X POST http://localhost:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"supersecret","name":"You","username":"you"}'
```

A successful response returns a `session_token` and your user object.

---

## Deployment

- **Render (recommended):** `render.yaml` is a Render **Blueprint** that deploys the FastAPI API from `backend/Dockerfile` (`okayspace-v0vx`, with a `/health` check and `autoDeploy`) **and** the Expo web build as a static site (`okayspace-web`). The database is an **external Postgres you control** — e.g. a free [Neon](https://neon.com) or Supabase instance — so set `DATABASE_URL` yourself in the Render dashboard (`sync: false`, kept out of git). The static site gets `EXPO_PUBLIC_BACKEND_URL` + `EXPO_PUBLIC_MAPBOX_TOKEN` (and optional `EXPO_PUBLIC_CLOUDINARY_*`). Full backend step-by-step in **`DEPLOY.md`** (~15 minutes).
- **Docker:** `backend/Dockerfile` produces a self-contained image running `uvicorn server:app` on `$PORT` (default `8080`). Run it anywhere that can reach Postgres via `DATABASE_URL`.
- **AWS App Runner:** `backend/apprunner.yaml` is provided for source-based deploys.
- **Mobile binaries:** built with **EAS** — see **`frontend/IOS_BUILD.md`** for the iOS/App Store flow (no Mac required) and `frontend/EAS_SETUP.md`.
- **Database:** any Postgres works (Neon, Supabase, local, or a Render-managed instance) — just point `DATABASE_URL` at it. The Blueprint ships with a Render-managed `databases:` block commented out (Render's free Postgres expires after 30 days); uncomment it and switch `DATABASE_URL` back to `fromDatabase` if you'd rather Render host it.

After the backend is live, set the frontend's `EXPO_PUBLIC_BACKEND_URL` to the deployed URL (no trailing slash, no `/api`) and rebuild/restart Expo.

---

## API overview

All routes are mounted under the versioned **`/api/v1`** prefix (with **`/api`** as
a legacy alias) and — except registration and a handful of public endpoints —
require an `Authorization: Bearer <session token | API key>` header.

| Route group | Base paths (examples) | What it does |
| --- | --- | --- |
| **Auth** | `/auth/register`, `/auth/login`(+`/2fa`,`/phone`), `/auth/me`, `/auth/logout`, `/auth/username`, `/auth/me/email\|password\|phone`, `/auth/forgot-password{,/sms}`, `/auth/reset-password{,/code}`, `/auth/recover-password`, `/auth/api-keys`, `/policies`, `/auth/accept-policies` | Email/username + password auth (bcrypt, session tokens), **SMS 2FA**, **phone OTP login**, phone verification, password reset by email/SMS, developer **API keys**, ToS/Privacy acceptance. |
| **Users** | `/users/search`, `/users/{id}/public`, `/users/{id}/follow`, `/friends/*`, `/users/{id}/tip\|subscribe`, `/wallet`, `/presence/ping`, `/points/leaderboard`, `/admin/users/{id}` | Search, public profiles, follow/friends, **tips & subscriptions**, the creator **wallet**, **activity points + leaderboard**, and admin verify/role/ban/suspend + audit. |
| **Posts / Feed** | `/posts`, `/feed/home\|explore\|reels`, `/posts/{id}/like\|dislike\|repost\|bookmark\|vote\|view\|promote\|report\|pin`, `/posts/{id}/replies\|thread`, `/drafts`, `/bookmarks`, `/hashtags/{tag}` | Posts, feeds, full comment threads, likes/dislikes, reposts/quotes, bookmarks, polls, views, promotion, reporting, pinning, hashtags, and **post drafts**. |
| **Stories** | `/stories`, `/stories/tray`, `/stories/{id}/view\|viewers\|reply` | 24h stories, tray, views, viewer lists, replies. |
| **Messaging** | `/conversations`, `/conversations/groups`, `/conversations/{id}/messages`(+`/react`,`/read`,`/presence`), `/emojis` | DMs & group chats; text/place/media/voice/gif/file/contact/post; reactions, edits, receipts, presence, custom emoji. |
| **Calls / Push** | `/calls/{id}/token\|ring`, `/push/register` | LiveKit room tokens + ring; device push-token registration. |
| **Maps** | `/eta`(+`/update`,`/stop`), `/public/eta/{id}`, **WS** `/ws/eta/{id}`, `/places`, `/recents`, `/foursquare/search\|match`, `/transit/nearby\|plan` | Saved places & recents, live ETA shares (REST + WS + public read), Foursquare place search + business profiles, and transit departures + route planning. |
| **Marketplace** | `/listings?lat&lng&radius_km&sort`, `/listings/{id}`(+`/contact`,`/save`), `/marketplace/users/{id}` | Listings, location/radius browse, save, seller profiles & reviews, start a DM. |
| **Communities / Groups** | `/communities`(+`/feed`,`/{name}` PATCH,`/{name}/join\|favorite\|posts\|members\|top\|mods/{id}\|members/{id}\|posts/{id}/remove\|pin`), `/groups`(+`/{id}/join\|posts\|pins\|requests\|members/*`) | Reddit-style forum (Hot/New/Top/Rising, flairs, rules, banner, wiki, auto-mod, favorites, karma+leaderboard, cross-community feed, moderators) and public/private chat groups. |
| **Roadside** | `/roadside/requests`(+`/{id}/accept\|decline\|enroute\|arrived\|cancel`), `/roadside/admin/calls`, `/admin/roadside/*` | Request roadside help, helper accept/decline + en route/on location (GPS-gated), photo AI moderation, **daily call numbers**, **admin dispatch** (create/search/view calls), staff verification. |
| **Support** | `/support/tickets`(+`/{id}/messages`), `/admin/support/*` | Open tickets/disputes, message staff, admin triage/resolve. |
| **Forms** | `/forms`(+`/{id}`,`/{id}/submissions{,.csv}`), `/pub/form`, `/pub/form-submit`, `/pub/form-embed.js`, `/pub/form-unit` | Build forms, list/export responses, and public (no-auth) render/submit/themeable embeds. |
| **Embed content** | `/pub/post/{id}`, `/pub/profile/{username}`(+`/posts`), `/pub/listing/{id}`, `/pub/guide/{slug}`, `/pub/{post,profile,listing,guide}-card`, `/pub/content-embed.js`, `/pub/oembed` | Public JSON, themeable iframe cards (posts, profiles, marketplace listings, guides), a `<script>` loader, cursor-paginated profile feed, and an **oEmbed** provider. |
| **Webhooks** | `/webhooks`(+`/{id}`,`/{id}/test`,`/{id}/deliveries`), `/webhooks/events` | Register signed event webhooks (20+ events), test pings, and delivery logs. |
| **Login with OkaySpace (OAuth2)** | `/oauth/apps`, `/oauth/authorize`, `/oauth/token`, `/oauth/userinfo`, `/oauth/connections` | OAuth2 authorization-code provider so other sites can "Sign in with OkaySpace". |
| **Publisher / Ads** | `/promoted/next`, `/promoted/{id}/event`, `/promoted/reels*`, `/promoted/campaigns`, `/promoted/account*`, `/promoted/links*`, `/pub/sites*`, `/pub/embed.js`, `/pub/unit`, `/pub/ad` | Sponsored posts, reel video ads, prepaid ad accounts, link ads, and the publisher network (customizable embeddable ad units + earn). The serving/event paths use `/promoted/*` (not `/ads/*`) so ad blockers don't strip them. |
| **Payments / Money** | `/payments/config\|pay-intent\|checkout\|payouts/*\|webhook\|api-plan*\|api-usage*`, `/money/*`, `/wallet/*`, `/currencies` | Inline card payments, in-app payout setup, instant cash-out, P2P send/request (security question, reversal), wallet top-up/cash-out, display currency, and Developer-API plans/usage. |
| **Admin** | `/admin/users\|audit\|badges\|revenue\|ad-revenue\|fees\|test-payments\|mobile-only\|web-build\|reset/*`, `/admin/users/{id}/wallet`, `/admin/render/*`, `/admin/integrations?live=1` | User moderation, audit log, badges, revenue/fees, simulated-payment toggle, **web-update kill switch**, set a wallet balance, Render infra controls, and the integrations/SDK status board. |
| **Meta** | `/version`, `/v1/info`, `/v1/changelog`, `/public/app-config` | API name/version, machine-readable capability overview + changelog, and public client config (incl. the web-update token). |

The full set of endpoints is the source of truth — see each module under
`backend/routes/`. For a developer-facing reference see **`API.md`**, the in-app
**Developer API** screen (which documents **~460 endpoints across ~37 tagged groups**
— including the admin console — each kept in sync with the live routes, with a
**tap-to-try** snippet per endpoint), the machine-readable **`GET /api/v1/info`**
and **`GET /api/v1/changelog`**, and the interactive **Swagger docs at `/docs`**
(`/openapi.json` for the schema).

---

## Developer API & embedding

The Developer API (Settings → Developer API) is a paid add-on for building on
OkaySpace and embedding it on any site or app.

- **API keys** — generate labeled keys (shown once) with **read** or **read+write** scopes; list and revoke. Keys are long-lived bearer tokens.
- **Plans, usage & quotas** — tiered plans (more keys, write access, webhooks, higher rate limits) with a usage meter and **pay-as-you-go** request packs (Stripe, with a test-mode fallback).
- **Webhooks** — subscribe to **21 signed event types** (follows, messages, tips, subscriptions, likes/replies/reposts, roadside, support, `form.submission`, …). Delivery is **HMAC-signed** (`X-OkaySpace-Signature`), **retried with backoff**, and recorded in a **delivery log** you can **re-send (redeliver)** from; a **test ping** verifies your endpoint. Choose specific events or receive all.
- **Login with OkaySpace (OAuth2)** — register an app for a client ID/secret and use the authorization-code flow (`/oauth/authorize` → `/oauth/token` → `/oauth/userinfo`) to add a "Sign in with OkaySpace" button.
- **Custom forms** — build a form and embed it anywhere via a `<script>` snippet or iframe; theme it with `data-*` / query params (`theme`, `accent`, `bg`, `radius`, `hide_title`, `redirect`, prefill). Collect responses in-app, export **CSV**, and receive `form.submission` webhooks.
- **Embeddable content + oEmbed** — public JSON and **themeable iframe cards** for posts, profiles, **marketplace listings**, **guides**, and **communities**; a drop-in `content-embed.js` loader (`data-post` / `data-profile` / `data-listing` / `data-guide` / `data-community`); a **cursor-paginated profile feed** for building a OkaySpace feed widget; and an **oEmbed** provider so pasted OkaySpace links auto-expand in WordPress/Discourse/Notion. Only public content is served (no subscriber-only posts, no sold/flagged listings, no banned users).
- **Publisher ad network** — embed customizable OkaySpace ad units on your site and earn a revenue share.
- **Conventions** — versioned base **`/api/v1`** (the `/api` legacy alias sends `Deprecation`/`Sunset` headers), open **CORS** (24h preflight cache), a single canonical error envelope (`{"error":{"code","message","fields"}}`, with a `detail` back-compat alias) whose codes are published at **`/errors`**, `?limit=`/`?offset=` plus **cursor** pagination where supported, **`Idempotency-Key`** on writes (durably stored — retries replay the first response, in-flight duplicates get `409`), and fair-use rate limits returning **`Retry-After` + `X-RateLimit-*`** on `429`. Auth resolves **before** body validation (unauthenticated calls `401`, not `422`). Machine-readable **discovery (`/v1/info`)**, runtime **capabilities (`/capabilities`)**, error registry (**`/errors`**), and **changelog (`/v1/changelog`)** are public.
- **Typed OpenAPI** — the **entire money surface** (`/stripe/*`, `/payments/*`, `/wallet/*`) and a growing share of the rest declare response schemas, so `/openapi.json` is complete enough for code generators to produce typed clients (guarded by a CI contract test). The official **Dart/Flutter** package (`mobile_flutter/packages/okayspace_api`) ships typed wrappers for auth, feed, users, messaging, notifications, and the full wallet/Stripe surface.
- **SDKs & tooling** — it's plain JSON+HTTPS, so it works from any language. The in-app reference ships **copy-paste client kits** (cURL, JavaScript, Python, Dart/Flutter, Swift, Kotlin, Go, Rust) each handling the Bearer auth and error envelope, plus a **tap-to-try** snippet on every endpoint and **example response shapes**. For a fully-typed client, generate one from `/openapi.json` (`dart-dio`, `swift5`, `kotlin`, `go`, `typescript-fetch`, …) or **import the OpenAPI URL straight into Postman/Insomnia** to try every endpoint with no code. A Flutter `WebView` can embed any of the `/pub/*` units directly.

---

## Testing & scripts

- **Backend tests** live in `backend/tests/` (pytest), covering auth, posts/newsfeed, reposts, recents/guides, ETA & race conditions, notifications, groups, and feature iterations:
  ```bash
  cd backend
  pip install pytest pytest-asyncio httpx
  pytest
  ```
  > Heads-up: several test files were written against the earlier MongoDB build (they import `pymongo` and read `MONGO_URL`/`DB_NAME`). Treat them as reference/regression material; adapt fixtures to run them against the current PostgreSQL backend.
- **Frontend lint:** `npm run lint` (eslint-config-expo).
- **Helper scripts** (`frontend/scripts/`): `check-pkg.js` (preinstall guard), `install-guard.sh`, `reset-project.js` (Expo starter reset).
- `test_result.md` documents the project's agent-driven testing protocol and latest status.

---

## License & notes

No license file is present in the repository. Treat this project as
**proprietary / unlicensed** unless a `LICENSE` is added by the owner.

- The design system (colors, typography, components, map styles) is in `design_guidelines.json`.
- Product requirements live in `memory/PRD.md`.
- Feature setup guides: `backend/STRIPE_SETUP.md`, `frontend/CLOUDINARY_SETUP.md`, `frontend/EAS_SETUP.md`, `frontend/IOS_BUILD.md`.
