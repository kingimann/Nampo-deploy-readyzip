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

## Login with Nami (OAuth2)

Let users sign in to your site with their Nami account (authorization-code flow).

1. **Register an app** in-app (Settings → Developer API → Login with Nami) → get a
   `client_id`, `client_secret`, and one or more redirect URIs.
2. **Send the user** to the consent screen:
   ```
   https://nampo-web.onrender.com/oauth/authorize?client_id=...&redirect_uri=...&response_type=code&scope=profile%20email&state=xyz
   ```
   On approval we redirect to `redirect_uri?code=...&state=xyz`.
3. **Exchange the code** (server-side):
   ```bash
   curl -X POST https://nampo-backend.onrender.com/api/oauth/token \
     -H "Content-Type: application/json" \
     -d '{"grant_type":"authorization_code","code":"...","client_id":"...","client_secret":"...","redirect_uri":"..."}'
   # → { access_token, token_type: "Bearer", expires_in, scope }
   ```
4. **Get the profile**:
   ```bash
   curl https://nampo-backend.onrender.com/api/oauth/userinfo \
     -H "Authorization: Bearer <access_token>"
   # → { sub, name, preferred_username, picture, verified, email? }
   ```

Scopes: `profile` (default) and `email`. Codes are single-use and expire in 10 min.

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
| POST | `/users/{id}/poke` | Poke (Facebook-style); they can poke back |
| GET | `/subscription-tiers` | The three fixed subscription tiers |
| POST/DELETE | `/users/{id}/subscribe` | Subscribe (body `{tier}`) / unsubscribe |
| GET | `/wallet` · `/wallet/export` | Earnings + money sent · CSV export |

### Posts & feed
| Method | Path | Description |
| --- | --- | --- |
| GET | `/posts/feed` | Home feed |
| POST | `/posts` | Create post (text, media[], poll, parent_id, quote_of, community_id) |
| GET/DELETE | `/posts/{id}` | Fetch / delete |
| POST | `/posts/{id}/like\|dislike\|repost\|bookmark\|pin\|promote\|report` | Engagement |
| POST | `/posts/{id}/view` · GET `/posts/{id}/viewers` | Record a view · who viewed (author only) |
| PATCH | `/posts/{id}/privacy` | Per-post `likes_disabled` + `comment_policy` (everyone\|followers\|friends\|nobody) |
| GET | `/posts/{id}/thread` | Threaded replies |
| GET | `/hashtags/{tag}` | Posts by tag |

Posts carry `likes_disabled`, `comment_policy` and a per-viewer `can_comment`.
New posts default to the author's `default_comment_policy` / `default_likes_disabled`.

### Stories
`GET /stories/tray` · `POST /stories` · `POST /stories/{id}/view|reply` · `GET /stories/{id}/viewers`

### Messaging
`GET/POST /conversations` · `POST /conversations/groups` · `GET/POST /conversations/{id}/messages`
(text, media, voice, place, post, gif, file, contact, **tip**) ·
`PATCH|DELETE /conversations/{id}/messages/{mid}` · `POST .../{mid}/react` ·
`POST /conversations/{id}/read` (read receipts).

**Presence & status (Snapchat-style):** `POST /conversations/{id}/presence` `{typing}`
heartbeat · `GET /conversations/{id}/presence` → `{typing, active}`. Messages return
`delivered_at` and `read_at` so clients can show Sent → Delivered → Read.

**End-to-end encryption (optional, client-side):** `POST /auth/keys` publish your X25519
public key · `GET /users/{id}/key` fetch a peer's · `POST|GET|DELETE /auth/keys/backup`
store/fetch a passphrase-encrypted private-key backup (opaque blob). Text/media bodies are
sealed client-side with NaCl `box`; the server only ever stores ciphertext for E2E messages.
Messages also support server-side encryption at rest regardless.

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
· `GET/POST /payments/api-plan*` · `GET/POST /payments/api-usage*` (plans + pay-as-you-go)

### Money (peer-to-peer)
| Method | Path | Description |
| --- | --- | --- |
| GET/POST | `/money/security` | Get / set the sender's transfer security question (answer is hashed) |
| POST | `/money/send` | Send money — body `{to_user_id, amount, note, answer}` (security answer required) |
| POST | `/money/request` | Request money from someone |
| GET | `/money/requests` | Incoming + outgoing requests |
| POST | `/money/requests/{id}/pay\|decline\|cancel` | Pay (needs `answer`) / decline / cancel |

### Ads & advertising
| Method | Path | Description |
| --- | --- | --- |
| GET | `/ads/next?placement=&slot=` | Next sponsored post for a slot |
| POST | `/ads/{id}/event` | Record `impression` / `click` (host attribution + billing) |
| POST | `/ads/{id}/hide\|report` | Hide / report an ad |
| GET | `/ads/campaigns` | Your promoted-post analytics |
| GET/POST | `/ads/account` · `/ads/account/topup` | Prepaid ad balance + top-up |
| POST/GET/DELETE | `/ads/links` · `POST /ads/links/{id}/event` | Link ads — advertise your website |
| POST | `/users/{id}/view` | Profile-view revenue tracking |

**Publisher network** (display Nami ads on your own site & earn): `POST/GET/DELETE
/pub/sites` (manage sites, get a `site_key`) · public `GET /pub/ad?site=` (JSON ad) ·
`GET /pub/click?site=&ad=` (tracked redirect) · `GET /pub/unit?site=` (iframe ad unit) ·
`GET /pub/embed.js?site=` (drop-in `<script>`). Earnings require **valid traffic**:
established accounts on both sides, no self/related clicks, and a daily earning cap.
| GET | `/admin/ad-revenue` | Platform ad dashboard (admin) |
| GET/POST | `/admin/bot/posts` · `/admin/bot/run` | Test bot for wallet/analytics (admin) |

### Payouts
`GET /payouts` (balance, schedule, history) · `POST /payouts/run` (admin or `X-Cron-Key`).
Per-creator `payout_frequency` and `payout_threshold` via `PATCH /auth/me`.

### Login with Nami (OAuth2) & connected apps
`GET/POST /oauth/apps` (manage your apps) · `/oauth/authorize` · `POST /oauth/token` ·
`GET /oauth/userinfo` · `GET /oauth/connections` · `DELETE /oauth/connections/{client_id}` ·
`POST /oauth/revoke`. See **Login with Nami** above for the full flow.

---

For request/response shapes and every parameter, see the live OpenAPI docs at
`/docs`. The in-app **Developer API** screen mirrors this reference with copy-able
examples and live API-key management.
