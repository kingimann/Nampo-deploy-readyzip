# API Reference

All routes are under the versioned **`/api/v1`** prefix (with **`/api`** as a legacy alias). Except registration and a handful of public endpoints, every request needs `Authorization: Bearer <session token | API key>`.

Interactive docs: **`/docs`** (Swagger) · schema: **`/openapi.json`** · machine-readable overview: **`GET /api/v1/info`**.

For building third-party apps and embedding, see **[[Developer API]]**.

## Endpoint groups

| Group | Examples | What it does |
| --- | --- | --- |
| **Auth** | `/auth/register`, `/auth/login`(+`/2fa`,`/phone`), `/auth/me`, `/auth/logout`, `/auth/api-keys`, `/policies` | Email/username + password auth, SMS 2FA, phone OTP, password reset, API keys, ToS/Privacy. |
| **Users** | `/users/search`, `/users/{id}/public`, `/users/{id}/follow`, `/friends/*`, `/users/{id}/tip\|subscribe`, `/wallet` | Search, profiles, follow/friends, tips & subscriptions, creator wallet, admin moderation. |
| **Posts / Feed** | `/posts`, `/feed/home\|explore\|reels`, `/posts/{id}/like\|repost\|bookmark\|vote\|view\|promote\|report\|pin`, `/hashtags/{tag}` | Posts, feeds, threads, reactions, polls, reels, hashtags. |
| **Stories** | `/stories`, `/stories/tray`, `/stories/{id}/view\|viewers\|reply` | 24h stories. |
| **Messaging / Calls** | `/conversations`(+`/messages`,`/react`,`/read`,`/presence`), `/emojis`, `/calls/{id}/token\|ring`, `/push/register` | DMs & groups, reactions, presence, custom emoji; LiveKit calls; push tokens. |
| **Maps** | `/eta`(+`/update`,`/stop`), `/public/eta/{id}`, **WS** `/ws/eta/{id}`, `/foursquare/match`, `/transit/nearby` | Live ETA, Foursquare profiles, transit. |
| **Marketplace** | `/listings?lat&lng&radius_km`, `/listings/{id}`(+`/contact`,`/save`), `/marketplace/users/{id}` | Listings, radius search, seller profiles & reviews. |
| **Communities / Groups** | `/communities`(+`/{name}/join\|posts`), `/groups`(+`/{id}/join\|posts\|pins\|requests\|members/*`) | Reddit-style forum + chat groups. |
| **Roadside** | `/roadside/requests`(+`/{id}/accept\|decline\|enroute\|arrived\|cancel`) | See **[[Roadside Assistance]]**. |
| **Support** | `/support/tickets`(+`/{id}/messages`), `/admin/support/*` | Tickets & disputes. |
| **Forms** | `/forms`(+`/{id}`,`/{id}/submissions{,.csv}`), `/pub/form*`, `/pub/form-checkout`, `/pub/form-paid` | See **[[Forms]]**. |
| **Embed content** | `/pub/post/{id}`, `/pub/profile/{username}`(+`/posts`), `/pub/listing/{id}`, `/pub/guide/{slug}`, `/pub/community/{name}`, `/pub/*-card`, `/pub/content-embed.js`, `/pub/oembed` | Public JSON + themeable cards + oEmbed. See **[[Developer API]]**. |
| **Webhooks** | `/webhooks`(+`/{id}`,`/{id}/test`,`/{id}/deliveries`,`/{id}/deliveries/{d}/redeliver`), `/webhooks/events` | See **[[Webhooks]]**. |
| **Login with OkaySpace (OAuth2)** | `/oauth/apps`, `/oauth/authorize`, `/oauth/token`, `/oauth/userinfo` | OAuth2 provider. |
| **Publisher / Ads** | `/promoted/*`, `/pub/sites*`, `/pub/embed.js`, `/pub/unit`, `/pub/ad` | Promoted posts, reel ads, publisher network (serving paths are `/promoted/*`, not `/ads/*`, so ad blockers don't strip them). |
| **Payments / Money** | `/payments/*`, `/money/*`, `/wallet/*`, `/currencies` | See **[[Payments and Money]]**. |
| **Admin** | `/admin/users\|audit\|badges\|revenue\|fees\|integrations`, `/admin/render/*` | See **[[Admin Tools]]**. |
| **Meta** | `/version`, `/v1/info`, `/public/app-config` | Version, capabilities, public client config. |

## Conventions
- **Format:** JSON in/out (`Content-Type: application/json`).
- **Versioning:** stable base `/api/v1`; `/api` is a legacy alias.
- **Pagination:** `?limit=` + `?offset=`; some endpoints also support cursor paging (`?cursor=` → `next_cursor`).
- **Idempotency:** send `Idempotency-Key: <unique>` on writes — retries replay the first response (`Idempotent-Replay: true`).
- **Errors:** one shape — `{"error":{"code","message"}}` (mirrored under `detail`).
- **Rate limits:** fair-use; heavy traffic may be throttled (429).
- **CORS:** open, so browser/mobile apps can call directly.
