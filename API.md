# Nami REST API

Base URL: `https://nampo-backend.onrender.com/api`
Interactive docs (Swagger): `https://nampo-backend.onrender.com/docs`
OpenAPI schema: `https://nampo-backend.onrender.com/openapi.json`

All requests and responses are JSON over HTTPS.

## Contents

**Getting started**
[Authentication](#authentication) ·
[Plans & access](#plans--access-paid) ·
[Webhooks](#webhooks-pro) ·
[Login with Nami (OAuth2)](#login-with-nami-oauth2) ·
[Conventions](#conventions) ·
[Quick examples](#quick-examples)

**Endpoint groups**
[Meta](#meta-public) ·
[Auth](#auth) ·
[Users & social](#users--social) ·
[Posts & feed](#posts--feed) ·
[Stories](#stories) ·
[Messaging](#messaging) ·
[Calls](#calls-livekit-voice) ·
[Communities](#communities-forum) ·
[Groups](#groups-chat-communities) ·
[Marketplace](#marketplace) ·
[Places, guides, reviews](#places-guides-reviews) ·
[ETA sharing](#eta-sharing-live-location) ·
[Maps extras](#maps-extras-foursquare--transit) ·
[Notifications](#notifications) ·
[Payments](#payments-when-stripe-is-configured) ·
[Money & wallet](#money-peer-to-peer--wallet) ·
[Ads](#ads--advertising) ·
[Publisher network](#publisher-network-display-nami-ads-on-your-site--earn) ·
[Payouts](#payouts) ·
[OAuth / connected apps](#login-with-nami-oauth2--connected-apps) ·
[Admin & moderation](#admin--moderation-adminmod-only) ·
[Developer & E2E keys](#developer-api-keys--e2e-keys) ·
[Webhooks endpoints](#webhooks-pro-1)

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
> lists **every** route with request/response schemas. This reference documents the
> full surface (~300 endpoints) grouped by area. Path params are `{in_braces}`; query
> params follow `?`. Unless noted, every endpoint needs `Authorization: Bearer`.

### Meta (public)
| Method | Path | Description |
| --- | --- | --- |
| GET | `/public/app-config` | Public client config (feature flags, public keys) — no auth |
| GET | `/version` | API name + version — no auth |
| GET | `/v1/info` | Machine-readable overview & capabilities (plans, scopes, limits) — no auth |

### Auth
| Method | Path | Description |
| --- | --- | --- |
| POST | `/auth/register` | Create account → `{session_token, user}` |
| POST | `/auth/login` | Log in (email or username). Returns `{session_token, user}`, **or** `{twofa_required:true, identifier, masked_phone, sent}` when SMS 2FA is on |
| POST | `/auth/login/2fa` | Finish 2FA login — `{identifier, code}` → `{session_token, user}` |
| POST | `/auth/2fa` | Toggle SMS two-factor — `{enabled, password?}` (enable needs a verified phone; disable needs the password) |
| POST | `/auth/login/phone/start` | Phone OTP login: text a code to a verified phone — `{phone}` → `{exists, masked_phone, dev_code?}` |
| POST | `/auth/login/phone/verify` | Finish phone OTP login — `{phone, code}` → `{session_token, user}` |
| POST | `/auth/forgot-password` · `/auth/forgot-password/sms` | Send a reset code by **email** (`{email}`) or **SMS** (`{identifier}` = email/username/phone) |
| POST | `/auth/reset-password` · `/auth/reset-password/code` | Reset with the code — email form `{email, code, new_password}`, or `{identifier, code, new_password}` |
| POST | `/auth/recover-password` | Owner break-glass reset — `{secret, identifier, new_password}` (needs `RECOVERY_SECRET`) |
| POST | `/auth/phone/send-code` · `/auth/phone/verify` | Verify a phone number via SMS code (when signed in) |
| GET | `/auth/me` | Current user (incl. `picture`, `wallet_balance`, `currency`, `twofa_enabled`, `sms_notifications`) |
| PATCH | `/auth/me` | Update profile — `name`, `bio`, `picture`, home/work, `sub_price`, `payout_frequency\|threshold`, `default_comment_policy\|likes_disabled`, `currency`, `sms_notifications` |
| PATCH | `/auth/me/email\|password\|phone` | Change email / password / phone |
| POST | `/auth/username` | Claim a username |
| GET/POST/DELETE | `/auth/api-keys` | Manage developer API keys |
| GET | `/policies` · POST `/auth/accept-policies` | ToS/Privacy versions + acceptance |

### Users & social
| Method | Path | Description |
| --- | --- | --- |
| POST | `/presence/ping` | Heartbeat to mark yourself online (called ~every 50s) |
| GET | `/users/search?q=&limit=` | Search users by name/username |
| GET | `/users/by-username/{username}` | Resolve a username → `{user_id, name, username}` |
| GET | `/users/{id}/public` | Public profile + relationship state (online, badges, `is_following`, `friend_status`, `poked_me`, counts) |
| POST | `/users/{id}/follow` | Toggle follow |
| POST | `/users/{id}/poke` | Poke (Facebook-style); they can poke back |
| GET | `/users/{id}/followers` · `/users/{id}/following` | Connection lists |
| POST | `/friends/request/{id}` | Send a friend request |
| POST | `/friends/accept/{id}` · `/friends/reject/{id}` | Accept / reject a request |
| DELETE | `/friends/request/{id}` | Cancel a request you sent |
| DELETE | `/friends/{id}` | Unfriend |
| GET | `/friends` · `/friends/requests` | Your friends · incoming/outgoing requests |
| POST | `/users/{id}/tip` | Tip a creator — `{amount, message?}` |
| GET | `/subscription-tiers` | The three fixed subscription tiers |
| POST | `/users/{id}/subscribe` | Subscribe — `{tier}` |
| DELETE | `/users/{id}/subscribe` | Unsubscribe |
| GET | `/wallet` | Earnings summary (`balance`, `currency`, recent received/sent) |
| GET | `/wallet/export` | CSV export of wallet activity |

> Profile fields (`name`, `bio`, `picture`, home/work, `sub_price`, payout prefs,
> privacy defaults, `currency`, `sms_notifications`) are read via `GET /auth/me` and
> updated via `PATCH /auth/me` (see **Auth**).

### Posts & feed
| Method | Path | Description |
| --- | --- | --- |
| POST | `/posts` | Create — `{text?, media[]?, poll?, parent_id?, quote_of?, place_*?, community_id?, title?, likes_disabled?, comment_policy?}` |
| GET | `/posts/{id}` | Fetch one (hydrated for the viewer) |
| PATCH | `/posts/{id}` | Edit — `{text?, media?}` |
| DELETE | `/posts/{id}` | Delete your post |
| PATCH | `/posts/{id}/privacy` | Per-post `{likes_disabled?, comment_policy?}` (everyone\|followers\|friends\|nobody) |
| GET | `/feed/home` · `/feed/explore` · `/feed/reels` | Following feed · ranked discovery · video reels (all skip "not interested") |
| GET | `/posts/user/{id}` · `/posts/user/{id}/all` | A user's top-level posts · incl. replies |
| GET | `/posts/{id}/replies` · `/posts/{id}/thread` | Direct replies · full threaded view |
| POST | `/posts/{id}/react` | React with any emoji — `{emoji}` (toggles/switches) |
| POST | `/posts/{id}/like` · `/posts/{id}/dislike` | 👍 / 👎 shims over the reaction system |
| POST | `/posts/{id}/repost` | Toggle repost |
| POST | `/posts/{id}/bookmark` | Toggle bookmark |
| GET | `/bookmarks` | Your bookmarked posts |
| POST | `/posts/{id}/pin` | Pin/unpin (author, or parent author for replies) |
| POST | `/posts/{id}/promote` | Promote — `{days?, budget?, cpc?}` (boost / pay-per-click) |
| POST | `/posts/{id}/vote` | Vote on the attached poll — `{option_id}` |
| POST | `/posts/{id}/view` | Record a unique view (idempotent per user) |
| GET | `/posts/{id}/viewers` | Who viewed (author/mod/admin only) |
| GET | `/posts/{id}/analytics` | Detailed performance (author/mod/admin) — impressions, unique viewers, clicks, reactions+breakdown, comments, reposts, quotes, bookmarks, interactions, engagement rate, ad stats |
| GET | `/posts/{id}/likers` · `/posts/{id}/reposters` | Who reacted / reposted |
| POST | `/posts/{id}/report` | Report — `{reason}` (one per user) |
| POST | `/posts/{id}/not-interested` | Hide + feed fewer like it (home/explore skip it) |
| GET | `/hashtags/{tag}` · `/hashtags/{tag}/count` | Posts by tag · count |
| GET | `/hashtags/trending` | Most-used tags (last 30 days) → `{hashtags:[{tag,count}]}` |
| POST | `/media/resolve-video` | Resolve a pasted video link (imgur/streamable/…) to a playable URL |

Posts carry `reactions[]`, `reactions_total`, `my_reaction`, `likes_count` (= total
reactions), `likes_disabled`, `comment_policy`, and a per-viewer `can_comment`. New
posts default to the author's `default_comment_policy` / `default_likes_disabled`.

### Stories
| Method | Path | Description |
| --- | --- | --- |
| POST | `/stories` | Post a 24h story — `{media}` (image/video) |
| GET | `/stories/tray` | Story tray (you + people you follow, unviewed flags) |
| GET | `/stories/user/{id}` | A user's active stories |
| POST | `/stories/{id}/view` | Mark viewed |
| GET | `/stories/{id}/viewers` | Viewer list (author only) |
| POST | `/stories/{id}/reply` | Reply to a story (opens a DM) |
| DELETE | `/stories/{id}` | Delete your story |

### Messaging
| Method | Path | Description |
| --- | --- | --- |
| GET | `/conversations` | Your inbox (DMs + groups; DMs from a listing carry `listing_id`/`listing_title`) |
| POST | `/conversations` | Start/get a DM — `{user_id}` |
| POST | `/conversations/groups` | Create a group — `{name, member_ids[]}` |
| PATCH | `/conversations/{id}` | Rename / set avatar (group) |
| POST | `/conversations/{id}/leave` | Leave a group |
| GET | `/conversations/{id}/messages` | Message history |
| POST | `/conversations/{id}/messages` | Send — `{type, text?/media?/place_*?/post_id?/amount?…}` (text, media, voice, place, post, gif, file, contact, **tip**) |
| PATCH | `/conversations/{id}/messages/{mid}` | Edit a message |
| DELETE | `/conversations/{id}/messages/{mid}` | Delete (tombstone) |
| POST | `/conversations/{id}/messages/{mid}/react` | React to a message — `{emoji}` |
| POST | `/conversations/{id}/read` | Mark read (read receipts) |
| POST | `/conversations/{id}/presence` · GET | Typing heartbeat `{typing}` · `{typing, active}` |
| POST | `/conversations/{id}/clear` | Clear my copy of the history (conversation stays) |
| DELETE | `/conversations/{id}` | Hide the conversation from my inbox |
| GET/POST | `/emojis` · DELETE `/emojis/{id}` | Custom emoji registry |

Messages return `delivered_at` / `read_at` so clients can show Sent → Delivered → Read.

**End-to-end encryption (optional, client-side):** `POST /auth/keys` publish your X25519
public key · `GET /users/{id}/key` fetch a peer's · `POST|GET|DELETE /auth/keys/backup`
store/fetch a passphrase-encrypted private-key backup (opaque blob). Bodies are sealed
client-side with NaCl `box`; the server only stores ciphertext for E2E messages (and
supports server-side encryption at rest regardless).

### Calls (LiveKit voice)
| Method | Path | Description |
| --- | --- | --- |
| POST | `/calls/{conversation_id}/token` | Mint a LiveKit room token (members only) → `{token, url, room, identity}` |
| POST | `/calls/{conversation_id}/ring` | Ring the other participant(s) (`call` notification) → `{ok, room}` |

Needs `LIVEKIT_*`; returns `503 calls_not_configured` otherwise. Room = `call_{conversation_id}`.

### Communities (forum)
| Method | Path | Description |
| --- | --- | --- |
| GET/POST | `/communities` | Discover / create (`{name, title, description?}`) |
| GET | `/communities/{name}` | Community details |
| POST/DELETE | `/communities/{name}/join` | Join / leave |
| GET | `/communities/{name}/posts?sort=hot\|new\|top` | Threads with sorting |

### Groups (chat communities)
| Method | Path | Description |
| --- | --- | --- |
| GET/POST | `/groups` | Your groups / create |
| GET | `/groups/{id}` | Group details |
| PATCH | `/groups/{id}` · DELETE | Edit / delete (owner) |
| POST | `/groups/{id}/join` · `/groups/{id}/leave` | Join (or request) / leave |
| GET | `/groups/{id}/members` | Member list with roles |
| POST | `/groups/{id}/members/{uid}/promote` · `/demote` · DELETE `/groups/{id}/members/{uid}` | Manage members |
| GET | `/groups/{id}/requests` · POST `…/{uid}/approve` · `…/{uid}/reject` | Join-request moderation |
| GET/POST | `/groups/{id}/posts` | Group feed |
| GET | `/groups/{id}/pins` · POST/DELETE `/groups/{id}/pins/{post_id}` | Pinned posts |

### Marketplace
| Method | Path | Description |
| --- | --- | --- |
| GET | `/listings?lat&lng&radius_km&category&condition&sort&q` | Browse (location + radius, nearby sort) |
| POST | `/listings` | Create a listing (needs account ≥ 30 days) |
| GET | `/listings/saved` | Your saved listings |
| GET | `/listings/user/{id}` | A seller's listings |
| GET | `/listings/{id}` | Listing detail (counts a view) |
| PATCH | `/listings/{id}` · DELETE | Edit / delete (owner) |
| POST/DELETE | `/listings/{id}/save` | Save / unsave |
| POST | `/listings/{id}/contact` | Message the seller (tags the DM with the listing) |
| POST | `/listings/{id}/trade/start` · `/trades/confirm` | Start a trade · both confirm (unlocks reviews) |
| GET | `/marketplace/users/{id}` · `/marketplace/users/{id}/reviews` | Seller profile · reviews |
| POST | `/marketplace/users/{id}/reviews` | Leave a seller review (verified trade required) |

### Places, guides, reviews
| Method | Path | Description |
| --- | --- | --- |
| GET/POST | `/places` | Saved map places (create/list) |
| GET/DELETE | `/places/{id}` | Fetch / delete a saved place |
| GET/POST | `/recents` · DELETE `/recents/{id}` · DELETE `/recents` | Recent searches (list/add/remove/clear) |
| GET/POST | `/guides` | Curated place collections |
| PATCH/DELETE | `/guides/{id}` | Edit / delete a guide |
| POST/DELETE | `/guides/{id}/places/{place_id}` | Add / remove a place |
| GET | `/public/guides/{slug}` | View a published guide (public) |
| POST | `/public/guides/{slug}/clone` | Clone a public guide to your account |
| GET/POST | `/reviews` · DELETE `/reviews/{id}` | 1–5★ place reviews |

### ETA sharing (live location)
| Method | Path | Description |
| --- | --- | --- |
| POST | `/eta` | Create a live ETA share → `{share_id, …}` |
| POST | `/eta/{share_id}/update` | Push a position/ETA update |
| POST | `/eta/{share_id}/stop` | End the share |
| GET | `/public/eta/{share_id}` | Public read of a share (no auth) |
| WS | `wss://…/ws/eta/{share_id}` | Real-time location stream |

### Maps extras (Foursquare + transit)
| Method | Path | Description |
| --- | --- | --- |
| GET | `/foursquare/match?name&lng&lat` | Business profile for one place (rating, hours, photo, phone, website) |
| GET | `/foursquare/search?query&lng&lat&radius&limit` | **Nearby places matching a query** (e.g. all "McDonald's"), nearest first → `{configured, results:[{fsq_id,name,address,category,latitude,longitude,distance,rating,price}]}` |
| GET | `/transit/nearby?lat&lon&radius&dest_lat&dest_lon` | Nearby stops + next departures (real-time where published). `dest_*` keeps only routes toward the destination (`filtered:true`) |
| GET | `/transit/plan?route_id&board_lat&board_lon&dest_lat&dest_lon` | Where to get off a given route for a destination → `{found, alight:{name,lat,lon,walk_to_dest_m}, ride_meters}` |

Foursquare needs `FSQ_API_KEY`; transit needs `TRANSITLAND_API_KEY`; both return
`{configured:false}` when unset. Each transit departure includes `route`, `kind`,
`headsign`, `stop_name`, `stop_distance`, `board_lat/lon`, `minutes`, `time_label`,
`realtime`, and `delay` (seconds, +late/−early).

### Notifications
`GET /notifications` · `GET /notifications/unread` (count) ·
`POST /notifications/{id}/read` · `POST /notifications/read-all` · `DELETE /notifications/{id}`.

**Types:** `like`, `repost`, `reply`, `message`, `group_invite`, `group_message`,
`follow`, `poke`, `tip`, `subscribe`, `money_request`, `money_received`, `money_request_paid`,
`money_request_declined`, `money_accepted`, `money_declined`, `money_reversed`,
`wallet_topup`, `payout_setup`. Each carries
`actor_id/name/picture`, an optional `post_id`/`conversation_id`, a `message`
preview, and `read`. (Developer webhooks receive the same events — see Webhooks.)

### Payments (when Stripe is configured)
| Method | Path | Description |
| --- | --- | --- |
| GET | `/payments/config` | Real-payments live? + fee config (see below) |
| POST | `/payments/checkout` | Create Checkout — `{kind: tip\|subscription\|promote, creator_id?, amount?, tier?, post_id?, days?, budget?, cpc?, conversation_id?, note?, embedded?}` → `{url?}` or `{client_secret, id, embedded}` |
| POST | `/payments/pay-intent` · `/payments/pay-intent/confirm` | Inline (in-app) PaymentIntent flow → `{client_secret, intent_id, publishable_key}` then confirm |
| POST | `/payments/pay-wallet` | Pay a creator from your wallet balance — `{kind, creator_id, amount?/tier?, note?, conversation_id?}` |
| POST | `/payments/payouts/setup` | Create/reuse the creator's Connect account → onboarding `{url}` |
| GET | `/payments/payouts/status` | `payouts_enabled`, `requirements_due/eventually/pending`, `capabilities`, `disabled_reason`, `platform` |
| GET | `/payments/payouts/requirements` | Outstanding KYC requirements detail |
| POST | `/payments/payouts/account-session` | Embedded Connect onboarding → `{client_secret, publishable_key}` |
| POST | `/payments/payouts/debit-card` | Attach a debit card (inline) for instant cash-out |
| POST | `/payments/payouts/bank-account` | Attach a bank account for direct deposit |
| POST | `/payments/payouts/verification` · `/payments/payouts/verification-document` | Submit identity info / upload an ID document (KYC) |
| POST | `/payments/payouts/cashout` | **Instant debit-card cash-out** — `{amount?}` (omit = whole balance); refunded on failure |
| GET | `/payments/api-plan` | Developer-API plan catalog + your current plan |
| POST | `/payments/api-plan/checkout` · `/payments/api-plan/activate` | Subscribe to a plan (Stripe) / activate (test) |
| GET | `/payments/api-usage` | Your metered usage `{used, limit, resets_at, packs}` |
| POST | `/payments/api-usage/buy` · `/payments/api-usage/activate` | Buy an overage pack (Stripe) / activate (test) |
| POST | `/payments/webhook` | Stripe webhook (signature-enforced) — no auth |

`GET /payments/config` → `{enabled, platform_fee_percent, transaction_fee_cents, publishable_key, stripe_configured, test_mode, test_override}`.
**Test/simulated payments are off by default** — real Stripe is used whenever Stripe is
configured and no admin has forced test mode. The app only simulates payments when Stripe
isn't configured (down / not set up) or an admin turns test mode on.

**Fees & revenue split:** the platform keeps an admin-set percent of each subscription/tip
(e.g. `platform_fee_percent=30` → a 70/30 split) plus a flat per-payment `transaction_fee_cents`
(default 10¢) charged to the payer on tips and peer-to-peer sends. `GET /payments/config`
returns both values.

The flat fee is **charged to the payer** (tips & peer-to-peer sends) and booked to platform
revenue when the payment settles; **admins are exempt** from the flat fee on their own sends.

**Admin (payments):** `GET/POST /admin/test-payments` (toggle simulated mode),
`GET/POST /admin/fees` (`{platform_fee_percent, transaction_fee_cents}` — revenue split + flat fee),
`GET /admin/revenue` → `{total, count, by_source, platform_fee_percent, transaction_fee_cents}`
(computed from settled payments), `POST /admin/reset/money` (wipe earnings/tips/subs/payouts/
transfers/requests/wallet top-ups/platform-revenue and zero ad + wallet balances),
`POST /admin/reset/analytics`.

### Money (peer-to-peer) & wallet
The **wallet** is a spendable balance you top up (`/wallet/topup`). Sending money draws from
it (it's a closed loop): the sender is debited on send, the recipient is credited on accept,
and a decline refunds the sender. Balances are stored in USD and shown in the user's chosen
display currency (`/wallet/currency`, `/currencies`).

Sending requires the **sender's transfer security question** (bcrypt-hashed answer).
Sent money is a **pending transfer the recipient accepts** before it's credited.
Insufficient funds → `400 insufficient_balance`. For the first **5 minutes** the sender can
**reverse** a transfer (mistake undo) and the recipient can't accept it yet (`claimable_at`;
accepting early → `409 not_yet_claimable`). Receiving money records the sender, time and
message, notifies the recipient, and (if they haven't set up Stripe) nudges them to connect
payouts to cash out (`payout_setup` notification).

| Method | Path | Description |
| --- | --- | --- |
| GET/POST | `/money/security` | Get / set the transfer security question |
| POST | `/money/send` | Send money — `{to_user_id, amount, note, answer}` → pending transfer |
| GET | `/money/transfers` | Incoming (to accept) + outgoing transfers (pending-centric) |
| GET | `/money/transfers/history` | All transfers, both directions, every status (`accepted\|declined\|reversed\|pending`) |
| POST | `/money/transfers/{id}/accept\|decline` | Recipient accepts (credited; `409 not_yet_claimable` during the hold) / declines (refunds sender) |
| POST | `/money/transfers/{id}/reverse` | Sender reverses a transfer while pending (mistake undo); refunded |
| POST | `/money/request` | Request money — `{to_user_id, amount, note}` |
| GET | `/money/requests` | Incoming + outgoing requests |
| POST | `/money/requests/{id}/pay\|decline\|cancel` | Pay (needs `answer`) / decline / cancel |

#### Wallet & currency
| Method | Path | Description |
| --- | --- | --- |
| GET | `/wallet` | Earnings summary (incl. `balance`, `currency`, recent received/sent, each with `message`) |
| GET | `/wallet/balance` | `{balance, display, currency, symbol, rate, currencies}` (USD balance + chosen-currency view) |
| POST | `/wallet/topup` | Add funds — `{amount, embedded?}`. Stripe Checkout when live (`{url}`/`{client_secret}`), instant credit in test mode |
| POST | `/wallet/topup/intent` · `/wallet/topup/confirm-intent` | Inline PaymentIntent top-up → `{client_secret}` then confirm |
| POST | `/wallet/topup/confirm` | Confirm a Checkout top-up on return — `{session_id}` (idempotent) |
| POST | `/wallet/topup/sync` | Reconcile recent Stripe payments; credit any paid top-up a missed webhook dropped |
| POST | `/wallet/topup/{tid}/cancel` | Cancel a pending top-up |
| GET | `/wallet/topups` | Top-up history with `status` (processing\|completed\|failed) |
| GET | `/wallet/activity` | Unified wallet ledger (top-ups, sends, receives, cash-outs) |
| POST | `/wallet/currency` | Set preferred display currency — `{currency}` |
| GET | `/currencies` | Supported display currencies + fixed USD rates |

> **Pay by QR:** the in-app pay code encodes `…/pay/{user_id}?amount=&note=`; scanning it
> opens the send-money flow pre-filled. (The pay screen is client-side; it calls `/money/send`.)

### Ads & advertising
| Method | Path | Description |
| --- | --- | --- |
| GET | `/ads/next?placement=&slot=` | Next sponsored post for a feed slot |
| POST | `/ads/{id}/event` | Record `impression` / `click` — `{type}` (attribution + billing) |
| POST | `/ads/{id}/hide` · `/ads/{id}/report` | Hide / report a sponsored post |
| GET | `/ads/campaigns` | Your promoted-post analytics |
| GET | `/ads/account` · POST `/ads/account/topup` | Prepaid ad balance + top-up |
| POST/GET/DELETE | `/ads/links` · POST `/ads/links/{id}/event` | **Link ads** — advertise your website (create/list/delete, track events) |
| POST/GET/DELETE | `/ads/reels` · GET `/ads/reels/serve` · POST `/ads/reels/{id}/event` | **Reel (video) ads** — manage, serve into the reels feed, track |
| POST | `/users/{id}/view` | Profile-view revenue tracking |

> **Account-age gates** (env-tunable, admins exempt) — `403 account_too_new`:
> selling on the marketplace needs **≥ 30 days**; monetizing (link ads, publisher
> sites, ad earnings) needs **≥ 60 days**.

### Publisher network (display Nami ads on your site & earn)
| Method | Path | Description |
| --- | --- | --- |
| POST/GET | `/pub/sites` · DELETE `/pub/sites/{id}` | Manage your sites; each gets a `site_key` |
| GET | `/pub/ad?site=` | Fetch a JSON ad to render — public |
| GET | `/pub/click?site=&ad=` | Tracked click redirect — public |
| GET | `/pub/unit?site=` | Ready-made iframe ad unit — public |
| GET | `/pub/embed.js?site=` | Drop-in `<script>` embed — public |

Earnings require **valid traffic**: established accounts on both sides, no self/related
clicks, and a daily earning cap.

### Payouts
| Method | Path | Description |
| --- | --- | --- |
| GET | `/payouts` | Balance, schedule, and payout history |
| POST | `/payouts/run` | Trigger a payout run (admin, or `X-Cron-Key` header for cron) |

Per-creator `payout_frequency` (weekly\|biweekly\|monthly, changeable once a month) and
`payout_threshold` are set via `PATCH /auth/me`.

### Login with Nami (OAuth2) & connected apps
| Method | Path | Description |
| --- | --- | --- |
| POST/GET | `/oauth/apps` · DELETE `/oauth/apps/{client_id}` | Manage your OAuth apps (you get `client_id`/`client_secret`) |
| GET | `/oauth/app/{client_id}` | Public app metadata (name, logo) for the consent screen |
| POST | `/oauth/authorize` | Approve a consent request → authorization `code` |
| POST | `/oauth/token` | Exchange `code` → `{access_token, token_type, expires_in, scope}` — no bearer (uses `client_secret`) |
| GET | `/oauth/userinfo` | Profile for the access token → `{sub, name, preferred_username, picture, verified, email?}` |
| GET | `/oauth/connections` · DELETE `/oauth/connections/{client_id}` | Apps you've authorized · revoke one |
| POST | `/oauth/revoke` | Revoke a token |

See **Login with Nami (OAuth2)** above for the full flow and scopes.

### Admin & moderation (admin/mod only)
**Users & moderation**
| Method | Path | Description |
| --- | --- | --- |
| GET | `/admin/users?q=&limit=&offset=` | List / search every user |
| PATCH | `/admin/users/{id}` | Set `verified` and/or `role` (user\|mod\|admin) |
| POST | `/admin/users/{id}/ban` · `/admin/users/{id}/unban` | Ban (`{reason}`) / lift |
| POST | `/admin/users/{id}/suspend` | Suspend — `{days, reason}` |
| DELETE | `/admin/users/{id}` | Delete an account |
| GET | `/admin/audit` | Audit log of admin actions |

**Wallet & transactions (admin)**
| Method | Path | Description |
| --- | --- | --- |
| POST | `/admin/users/{id}/wallet` | Adjust a user's wallet balance |
| POST | `/admin/users/{id}/transaction` | Add a ledger transaction — `{kind: topup\|received\|sent\|cashout, amount, note?, counterparty?, adjust_balance?, created_at?}` |
| GET | `/admin/users/{id}/transactions` | List a user's transactions |
| PATCH/DELETE | `/admin/users/{id}/transaction` | Edit / delete a transaction (re-add lost ones, fix dates) |

**Badges, revenue & config (admin)**
| Method | Path | Description |
| --- | --- | --- |
| GET | `/badges` | All site-wide custom badges (public) |
| POST | `/admin/badges` · DELETE `/admin/badges/{id}` | Create / remove a custom badge |
| POST | `/admin/users/{id}/badge` | Grant/revoke a badge — `{badge_id, action: add\|remove}` |
| GET/POST | `/admin/fees` | Revenue split + flat fee — `{platform_fee_percent, transaction_fee_cents}` |
| GET | `/admin/revenue` | Platform revenue from the ledger → `{total, count, by_source, …}` |
| GET | `/admin/ad-revenue` | Platform ad dashboard |
| GET/POST | `/admin/test-payments` | Toggle simulated-payments mode |
| GET/POST | `/admin/mobile-only` | Toggle mobile-only payment restriction |
| POST | `/admin/reset/money` · `/admin/reset/analytics` | Wipe money/analytics data (destructive) |
| GET/POST | `/admin/bot/posts` · `/admin/bot/run` | Test bot (wallet/analytics) |
| GET | `/admin/integrations?live=1` | Integration/SDK status board — each service's `configured`, `status`, `env` vars, a `fix` string, and (with `?live=1`) a real health-check `detail` |

Banned/currently-suspended users are blocked at login and on every request
(`403 banned` / `403 suspended`, with the moderator's reason). Admins are exempt;
you can't moderate yourself or another admin.

### Developer API keys & E2E keys
| Method | Path | Description |
| --- | --- | --- |
| POST | `/auth/api-keys` | Create a key — `{label?, scopes?}` → full token shown **once** |
| GET | `/auth/api-keys` | List your keys (masked prefixes) |
| DELETE | `/auth/api-keys/{id}` | Revoke a key |
| POST | `/auth/keys` | Publish your X25519 public key (E2E) |
| GET | `/users/{id}/key` | Fetch a peer's public key |
| POST/GET/DELETE | `/auth/keys/backup` | Store / fetch / delete a passphrase-encrypted private-key backup |

### Webhooks (Pro+)
| Method | Path | Description |
| --- | --- | --- |
| GET | `/webhooks/events` | Available event types |
| GET/POST | `/webhooks` | List / register `{url, events?}` (secret returned once) |
| DELETE | `/webhooks/{id}` | Remove a webhook |

See **Webhooks** above for the signature scheme and event list.

---

For request/response shapes and every parameter, see the live OpenAPI docs at
`/docs`. The in-app **Developer API** screen mirrors this reference with copy-able
examples and live API-key management.
