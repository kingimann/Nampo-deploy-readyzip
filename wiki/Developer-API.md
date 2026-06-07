# Developer API

A first-class, paid add-on for building on Nami and embedding it on any site or app. In the app: **Settings → Developer API** (key management, plans, usage, webhooks, OAuth apps, quickstart, and a browsable endpoint reference). See also **[[API Reference]]**.

## API keys
Generate labeled keys (shown once) with **read** or **read+write** scopes; list and revoke. Keys are long-lived bearer tokens — `Authorization: Bearer <key>` on every request.

## Plans, usage & quotas
Tiered plans unlock more keys, write access, webhooks, and higher rate limits, with a usage meter and **pay-as-you-go** request packs (Stripe, with a test-mode fallback). Quota is queryable at `/payments/api-usage`.

## Webhooks
Subscribe to **20+ signed event types** (follows, messages, tips, subscriptions, likes/replies/reposts, roadside, support, `form.submission`, …). Delivery is **HMAC-signed** (`X-Nami-Signature`), **retried with backoff**, recorded in a **delivery log** you can **re-send** from, and a **test ping** verifies your endpoint. Full details: **[[Webhooks]]**.

## Login with Nami (OAuth2)
Register an app for a client ID/secret and use the authorization-code flow: `/oauth/authorize` → `/oauth/token` → `/oauth/userinfo`. Adds a "Sign in with Nami" button to any site.

## Embeddable content + oEmbed
Embed Nami **content** anywhere — public JSON, themeable iframe **cards**, a drop-in loader, and an **oEmbed** provider so pasted links auto-expand in WordPress/Discourse/Notion.

| Type | JSON | Card | Loader attribute |
| --- | --- | --- | --- |
| Post | `/pub/post/{id}` | `/pub/post-card?post=ID` | `data-post` |
| Profile | `/pub/profile/{username}` (+ `/posts`, cursor-paginated) | `/pub/profile-card?profile=USER` | `data-profile` |
| Listing | `/pub/listing/{id}` | `/pub/listing-card?listing=ID` | `data-listing` |
| Guide | `/pub/guide/{slug}` | `/pub/guide-card?guide=SLUG` | `data-guide` |
| Community | `/pub/community/{name}` | `/pub/community-card?community=NAME` | `data-community` |

```html
<script async src="https://<backend>/api/pub/content-embed.js"
  data-post="POST_ID" data-theme="dark" data-accent="7C3AED"></script>
```

- Cards accept `theme` (light/dark), `accent`, `radius` (via query or `data-*`).
- **oEmbed:** `GET /pub/oembed?url=<nami link>` — only public content is served (no subscriber-only posts, no sold/flagged listings, no banned users).

For embeddable **forms** (including paid forms), see **[[Forms]]**. For the publisher **ad** units, see the in-app Publisher section.

## Conventions & SDKs
- Versioned base `/api/v1`; open CORS; `Idempotency-Key` on writes; `?limit/offset` + cursor pagination; consistent error envelope. (See **[[API Reference]]**.)
- It's plain JSON+HTTPS, so it works from any language. Generate a typed client from `/openapi.json`, e.g.:

```bash
openapi-generator generate -i https://<backend>/openapi.json -g dart-dio -o ./nami_client
# swap dart-dio for swift5, kotlin, go, typescript-fetch, ...
```

A Flutter `WebView` can embed any `/pub/*` unit directly.
