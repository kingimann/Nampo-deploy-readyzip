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
`tip`, `subscribe`, `post_like`, `post_reply`, `mention`, `poke`, `money_request`,
`money_received`, `money_request_paid`. (Webhook deliveries mirror in-app
notifications, so new notification types are delivered automatically.)

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
- **Errors:** non-2xx responses return `{"detail": "message"}`. Some return a
  structured `{"detail": {"code", "message", …}}` so clients can branch on `code`.
  | Code | Meaning |
  | --- | --- |
  | 400 | Bad request / validation error |
  | 401 | Missing or invalid token |
  | 402 | Payment required (API key needs an active plan) |
  | 403 | Authenticated but not allowed |
  | 404 | Not found |
  | 409 | Conflict (e.g. email already in use) |
  | 413 | Payload too large (media limits) |
  | 429 | Rate-limited / quota exceeded |
- **Structured `detail.code` values:** `account_too_new` (marketplace/monetization
  age gate), `banned`, `suspended`, `api_plan_required` (402), `write_not_allowed`
  (read-only API key on a mutating call), `security_not_set` / `wrong_answer` (money).
- **Pagination:** list endpoints accept `?limit=` and `?offset=` where supported.
- **Rate limits & quota:** fair-use; API-key requests are metered against your plan's
  monthly quota (429 when exceeded — buy an overage pack or wait for the reset).
- **API-key scopes:** keys can be read-only; mutating methods then return
  `403 write_not_allowed`.
- **Versioning:** `GET /version` and `GET /v1/info` describe the current API.

## Quick examples

```bash
# Auth
curl -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"identifier":"you@example.com","password":"…"}'
# → { session_token, user }

# Authenticated read
curl $API/posts/feed -H "Authorization: Bearer $TOKEN"

# Create a post (text + audience)
curl -X POST $API/posts -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello world #intro","comment_policy":"followers","likes_disabled":false}'

# Send money (requires your security answer)
curl -X POST $API/money/send -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"to_user_id":"u_123","amount":10,"note":"lunch","answer":"fluffy"}'
```

`$API` = `https://nampo-backend.onrender.com/api`. Get `$TOKEN` from login, or use a
Developer API key (Settings → Developer API).

## Endpoint groups

> The interactive `/docs` page (Swagger UI) is the always-current source of truth and
> lists **every** route with request/response schemas. Highlights below:

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
| GET | `/wallet` · `/wallet/export` | Earnings + money sent (incl. `balance`, `currency`) · CSV export |
| GET | `/wallet/balance` | Spendable wallet balance → `{balance, display, currency, symbol, rate, currencies}` |
| POST | `/wallet/topup` | Add funds — `{amount, embedded?}`. Stripe Checkout when live, instant in test mode |
| POST | `/wallet/currency` | Set preferred display currency — `{currency}` |
| GET | `/currencies` | Supported display currencies + fixed USD conversion rates |

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
| GET | `/posts/{id}/replies` | Direct replies |
| GET | `/hashtags/{tag}` | Posts by tag |
| GET | `/hashtags/trending` | Most-used hashtags (last 30 days) → `{hashtags:[{tag,count}]}` |
| GET | `/feed/home` · `/feed/explore` | Following feed · discovery feed |
| GET | `/posts/user/{id}` | A user's posts |

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
`GET /notifications` · `GET /notifications/unread` (count) ·
`POST /notifications/{id}/read` · `POST /notifications/read-all` · `DELETE /notifications/{id}`.

**Types:** `like`, `repost`, `reply`, `message`, `group_invite`, `group_message`,
`follow`, `poke`, `money_request`, `money_received`, `money_request_paid`,
`money_request_declined`, `money_accepted`, `money_declined`. Each carries
`actor_id/name/picture`, an optional `post_id`/`conversation_id`, a `message`
preview, and `read`. (Developer webhooks receive the same events — see Webhooks.)

### Payments (when Stripe is configured)
`GET /payments/config` · `POST /payments/payouts/setup` · `GET /payments/payouts/status`
· `POST /payments/checkout` (`kind`: tip | subscription | promote) · `POST /payments/webhook`
· `POST /payments/payouts/account-session` (embedded Connect onboarding)
· `GET/POST /payments/api-plan*` · `GET/POST /payments/api-usage*` (plans + pay-as-you-go)

`GET /payments/config` → `{enabled, platform_fee_percent, publishable_key, stripe_configured, test_mode, test_override}`.
**Test/simulated payments are off by default** — real Stripe is used whenever Stripe is
configured and no admin has forced test mode. The app only simulates payments when Stripe
isn't configured (down / not set up) or an admin turns test mode on.

**Admin (payments):** `GET/POST /admin/test-payments` (toggle simulated mode),
`POST /admin/reset/money` (wipe earnings/tips/subs/payouts/transfers/requests/wallet top-ups
and zero ad + wallet balances), `POST /admin/reset/analytics`.

### Money (peer-to-peer) & wallet
The **wallet** is a spendable balance you top up (`/wallet/topup`). Sending money draws from
it (it's a closed loop): the sender is debited on send, the recipient is credited on accept,
and a decline refunds the sender. Balances are stored in USD and shown in the user's chosen
display currency (`/wallet/currency`, `/currencies`).

Sending requires the **sender's transfer security question** (bcrypt-hashed answer).
Sent money is a **pending transfer the recipient accepts** before it's credited.
Insufficient funds → `400 insufficient_balance`.

| Method | Path | Description |
| --- | --- | --- |
| GET/POST | `/money/security` | Get / set the transfer security question |
| POST | `/money/send` | Send money — `{to_user_id, amount, note, answer}` → pending transfer |
| GET | `/money/transfers` | Incoming (to accept) + outgoing transfers |
| POST | `/money/transfers/{id}/accept\|decline` | Recipient accepts (credited) / declines |
| POST | `/money/request` | Request money — `{to_user_id, amount, note}` |
| GET | `/money/requests` | Incoming + outgoing requests |
| POST | `/money/requests/{id}/pay\|decline\|cancel` | Pay (needs `answer`) / decline / cancel |

> **Pay by QR:** the in-app pay code encodes `…/pay/{user_id}?amount=&note=`; scanning it
> opens the send-money flow pre-filled. (The pay screen is client-side; it calls `/money/send`.)

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

> **Account-age gates** (env-tunable, admins exempt) — `403 account_too_new`:
> selling on the marketplace needs **≥ 30 days**; monetizing (link ads, publisher
> sites, ad earnings) needs **≥ 60 days**.

**Publisher network** (display Nami ads on your own site & earn): `POST/GET/DELETE
/pub/sites` (manage sites, get a `site_key`) · public `GET /pub/ad?site=` (JSON ad) ·
`GET /pub/click?site=&ad=` (tracked redirect) · `GET /pub/unit?site=` (iframe ad unit) ·
`GET /pub/embed.js?site=` (drop-in `<script>`). Earnings require **valid traffic**:
established accounts on both sides, no self/related clicks, and a daily earning cap.

### Admin & moderation (admin/mod only)
| Method | Path | Description |
| --- | --- | --- |
| GET | `/admin/users?q=&limit=&offset=` | List / search every user |
| PATCH | `/admin/users/{id}` | Set `verified` and/or `role` (user\|mod\|admin) |
| POST | `/admin/users/{id}/ban` · `/unban` | Ban (`{reason}`) / lift |
| POST | `/admin/users/{id}/suspend` | Suspend `{days, reason}` |
| DELETE | `/admin/users/{id}` | Remove (delete) an account |
| GET | `/admin/audit` | Audit log of admin actions |
| GET | `/admin/ad-revenue` | Platform ad dashboard |
| GET/POST | `/admin/bot/posts` · `/admin/bot/run` | Test bot (wallet/analytics) |

Banned/currently-suspended users are blocked at login and on every request
(`403 banned` / `403 suspended`, with the moderator's reason). Admins are exempt;
you can't moderate yourself or another admin.

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
