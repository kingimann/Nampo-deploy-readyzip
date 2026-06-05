# Nami REST API

Base URL: `https://nampo-backend.onrender.com/api`
Interactive docs (Swagger): `https://nampo-backend.onrender.com/docs`
OpenAPI schema: `https://nampo-backend.onrender.com/openapi.json`

All requests and responses are JSON over HTTPS.

## Authentication

Every endpoint (except a few public ones) requires a bearer token:

```
Authorization: Bearer <token>
```

A `<token>` is either a **session token** (from login) or a **personal API key**.
Generate API keys in the app: **Settings → Developer API → Generate**. Keys are
shown once; store them securely. Revoke anytime from the same screen.

```bash
curl https://nampo-backend.onrender.com/api/posts/feed \
  -H "Authorization: Bearer $NAMI_KEY"
```

```js
const res = await fetch("https://nampo-backend.onrender.com/api/posts/feed", {
  headers: { Authorization: `Bearer ${process.env.NAMI_KEY}` },
});
const feed = await res.json();
```

```python
import requests
r = requests.get(
    "https://nampo-backend.onrender.com/api/posts/feed",
    headers={"Authorization": f"Bearer {NAMI_KEY}"},
)
feed = r.json()
```

## Plans & access (paid)

The Developer API is a paid add-on with tiered plans — higher tier, more access.
Manage your plan in the app: **Settings → Developer API**.

| Plan | Price/mo | Keys | Access | Webhooks | Rate | Monthly requests |
| --- | --- | --- | --- | --- | --- | --- |
| Basic | $9.99 | 2 | read-only | – | 60/min | 10,000 |
| Pro | $29.99 | 10 | read + write | ✓ | 600/min | 200,000 |
| Business | $99.99 | 50 | read + write | ✓ | 6,000/min | 2,000,000 |

**Usage-based metering.** Each plan includes a monthly request quota. When you hit
it, requests return **429** `{"detail":{"code":"quota_exceeded","used","limit","resets_at","packs"}}`
— either **pay as you go** (buy a request pack, applied immediately to the current
period) or wait for the reset. Endpoints: `GET /payments/api-usage`,
`POST /payments/api-usage/buy` (Stripe), `POST /payments/api-usage/activate` (test).

Without an active plan, API-key requests fail with **402** and a structured body so
your code can branch on it:

```json
{ "detail": { "code": "api_plan_required", "message": "…", "plans": [ … ] } }
```

**Scopes** — keys are `read` or `read+write`. A read-only key calling a mutating
method (POST/PATCH/DELETE) gets **403** `{"detail":{"code":"write_not_allowed", …}}`.
Write scope requires Pro or higher.

`GET /payments/api-plan` returns the plan catalog + your current plan.

## Webhooks (Pro+)

Register endpoints to receive events. We `POST` a JSON body
`{event, data, created_at}` and sign it: header `X-Nami-Signature: sha256=<hmac>`
(HMAC-SHA256 of the raw body with your signing secret). Verify it before trusting.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/webhooks/events` | Available event types |
| GET | `/webhooks` | Your webhooks |
| POST | `/webhooks` | Register `{url, events?}` → returns the signing `secret` once |
| DELETE | `/webhooks/{id}` | Remove |

Events: `follow`, `friend_request`, `friend_accept`, `message`, `group_message`,
`tip`, `subscribe`, `post_like`, `post_reply`, `mention`.

## Conventions

- **Content type:** `application/json` for request and response bodies.
- **Errors:** non-2xx responses return `{"detail": "message"}`.
  | Code | Meaning |
  | --- | --- |
  | 400 | Bad request / validation error |
  | 401 | Missing or invalid token |
  | 403 | Authenticated but not allowed |
  | 404 | Not found |
  | 409 | Conflict (e.g. email already in use) |
  | 413 | Payload too large (media limits) |
  | 429 | Rate-limited |
- **Pagination:** list endpoints accept `?limit=` and `?offset=` where supported.
- **Rate limits:** fair-use; heavy automated traffic may be throttled (429).
- **Versioning:** `GET /version` and `GET /v1/info` describe the current API.

## Endpoint groups

> The interactive `/docs` page is the always-current source of truth. Highlights:

### Meta (public)
| Method | Path | Description |
| --- | --- | --- |
| GET | `/version` | API name + version |
| GET | `/v1/info` | Machine-readable overview & capabilities |

### Auth
| Method | Path | Description |
| --- | --- | --- |
| POST | `/auth/register` | Create account → `{session_token, user}` |
| POST | `/auth/login` | Log in (email or username) |
| GET | `/auth/me` | Current user |
| PATCH | `/auth/me` | Update profile |
| PATCH | `/auth/me/email\|password\|phone` | Change email / password / phone |
| POST | `/auth/username` | Claim a username |
| GET/POST/DELETE | `/auth/api-keys` | Manage developer API keys |
| GET | `/policies` · POST `/auth/accept-policies` | ToS/Privacy versions + acceptance |

### Users & social
| Method | Path | Description |
| --- | --- | --- |
| GET | `/users/search?q=` | Search users |
| GET | `/users/{id}/public` | Public profile (+ relationship state) |
| POST | `/users/{id}/follow` | Toggle follow |
| GET | `/users/{id}/followers` · `/following` | Connection lists |
| POST | `/friends/request/{id}` · `/accept/{id}` · `/reject/{id}` | Friend requests |
| POST | `/users/{id}/tip` | Tip a creator |
| POST/DELETE | `/users/{id}/subscribe` | Subscribe / unsubscribe |
| GET | `/wallet` | Earnings + money sent |

### Posts & feed
| Method | Path | Description |
| --- | --- | --- |
| GET | `/posts/feed` | Home feed |
| POST | `/posts` | Create post (text, media[], poll, parent_id, quote_of, community_id) |
| GET/DELETE | `/posts/{id}` | Fetch / delete |
| POST | `/posts/{id}/like\|dislike\|repost\|bookmark\|pin\|promote\|report` | Engagement |
| GET | `/posts/{id}/thread` | Threaded replies |
| GET | `/hashtags/{tag}` | Posts by tag |

### Stories
`GET /stories/tray` · `POST /stories` · `POST /stories/{id}/view|reply` · `GET /stories/{id}/viewers`

### Messaging
`GET/POST /conversations` · `GET/POST /conversations/{id}/messages` (text, media, voice,
place, post, gif, file, contact, **tip**) · `POST /conversations/{id}/messages/{mid}/react`

### Communities (forum)
`GET/POST /communities` · `GET /communities/{name}` · `POST /communities/{name}/join`
· `GET /communities/{name}/posts?sort=hot|new|top`

### Marketplace
`GET/POST /listings` (filters: `?lat&lng&radius_km&category&sort`) · `GET /listings/{id}`
· `POST /listings/{id}/contact` · `POST /listings/{id}/trade/start` · `POST /trades/confirm`
· `GET/POST /marketplace/users/{id}` (seller profile + reviews — reviews require a verified trade)

### Places, guides, reviews, ETA
`/places` · `/guides` (+ `/public/guides/{slug}`) · `/reviews` · `/eta`
(+ WebSocket `wss://…/ws/eta/{share_id}`)

### Notifications
`GET /notifications` · `GET /notifications/unread` · `POST /notifications/read-all`

### Payments (when Stripe is configured)
`GET /payments/config` · `POST /payments/payouts/setup` · `GET /payments/payouts/status`
· `POST /payments/checkout` (`kind`: tip | subscription | promote) · `POST /payments/webhook`

---

For request/response shapes and every parameter, see the live OpenAPI docs at
`/docs`. The in-app **Developer API** screen mirrors this reference with copy-able
examples and live API-key management.
