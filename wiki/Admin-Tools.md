# Admin Tools

Admin screens live under **Settings** and require the `admin` role (bootstrap via `ADMIN_EMAILS`). Mods get a subset.

## Integrations & SDKs
**Settings → Integrations & SDKs (admin)** — a live status board of every external service.
- Shows whether each is **configured** (per-env-var **set/unset** chips), what breaks without it, the exact env var(s) to set, and a docs link.
- **Run live tests** (all) or **Test** a single service — each live check confirms the credentials actually work and reports **latency**.
- A **"show only issues"** filter.
- Covers: database, Stripe, Twilio, TransitLand, Foursquare, email/SMTP, LiveKit, Anthropic, Ollama, Expo Push, message encryption, owner recovery, **Render**, plus client SDKs (Mapbox, Cloudinary, Tenor) checked in the app build.
- API: `GET /api/admin/integrations?live=1` (or `?only=<key>`).

## Render hosting management
**Settings → Render (admin)** — manage your Render deployment without leaving the app (needs `RENDER_API_KEY`; see **[[Configuration]]**).
- **View** services + status, recent **deploys**, and **environment variables**.
- **Edit env vars** (set / add / delete) — values are **masked with tap-to-reveal**; saving triggers a Render redeploy (each action confirmed in-app).
- **Deploy** (optional cache clear), **Restart**, and **Suspend / Resume** services.
- API: `/api/admin/render/services`, `…/{id}/deploys` (GET/POST), `…/restart`, `…/suspend`, `…/resume`, `…/env-vars` (GET/PUT/DELETE).

> High-privilege: the Render API key is owner-level and env-var values are secrets surfaced to admins. Suspend can take production offline.

## Other admin panels
- **Manage users** — verify, set roles (mod/admin), ban/suspend/remove, audit log; enable/disable messaging & marketplace per user.
- **Payments & data** — toggle simulated payments, set revenue split + transaction fee, view platform/ad revenue, reset fake money/analytics, set a user's wallet balance, toggle **mobile-only** mode.
- **Ad revenue**, **Custom badges**, **Test bot** (@claude), **Roadside verifications** (staff), **Support** triage.

## Webhooks (developer-facing)
Not admin-only, but related: signed event webhooks with retries, delivery logs, test pings, and redelivery — see **[[Webhooks]]**.
