# Configuration

Every integration is optional except the database + Mapbox; unset features degrade gracefully. Sign in as an admin and open **Settings → Integrations & SDKs (admin)** for a live status board (configured + one-tap live tests + the exact env var to set). See **[[Admin Tools]]**.

## Backend environment variables

| Variable | Required | Secret | Default | Description |
| --- | :---: | :---: | --- | --- |
| `DATABASE_URL` | **Yes** | **Yes** | — | PostgreSQL DSN (asyncpg). |
| `CORS_ORIGINS` | No | No | `*` | Comma-separated allowed origins, or `*`. |
| `WEB_APP_URL` | No | No | `https://nampo-web.onrender.com` | Public web origin for payment return URLs and the canonical links in embeds/oEmbed. |
| `MESSAGE_ENC_KEY` | No | **Yes** | *(none)* | Fernet key — encrypts stored messages at rest. |
| `FSQ_API_KEY` | No | **Yes** | `""` | Foursquare Places key for business profiles. |
| `TRANSITLAND_API_KEY` | No | **Yes** | `""` | TransitLand key for nearby transit departures. |
| `ADMIN_EMAILS` | No | **Yes** | `""` | Comma-separated emails auto-granted the **admin** role. |
| `STRIPE_SECRET_KEY` | No | **Yes** | *(none)* | Enables real payments/payouts; otherwise simulated. |
| `STRIPE_WEBHOOK_SECRET` | No | **Yes** | *(none)* | Verifies `/api/payments/webhook` (enforced when set). |
| `STRIPE_PUBLISHABLE_KEY` | No | No | *(none)* | For embedded onboarding/checkout (web uses `EXPO_PUBLIC_STRIPE_KEY`). |
| `PLATFORM_FEE_PERCENT` | No | No | `0` | Default platform cut of subscriptions/tips/form payments (admin-tunable). |
| `ANTHROPIC_API_KEY` | No | **Yes** | *(none)* | Claude vision + text: roadside photo moderation, document verification, listing spam, and the @claude bot. |
| `CLAUDE_VISION_MODEL` / `CLAUDE_TEXT_MODEL` | No | No | *(sane defaults)* | Override the Claude models. |
| `OLLAMA_HOST` | No | No | *(none)* | Optional self-hosted AI vision instead of Claude. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | No | **Yes** | *(none)* | SMS: phone verification, OTP login, 2FA, password reset, notifications. Unset → codes returned as `dev_code`. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | No | **Yes** | `SMTP_PORT=587` | Email: password reset + form-submission emails. Needs at least `SMTP_HOST` + `SMTP_FROM`. |
| `RECOVERY_SECRET` | No | **Yes** | *(none)* | Break-glass owner password recovery via `/api/auth/recover-password`. |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` / `LIVEKIT_URL` | No | **Yes** | *(none)* | In-app voice/video calls (WebRTC). |
| `EXPO_ACCESS_TOKEN` | No | **Yes** | *(none)* | Optional Expo token to raise push rate limits. |
| `RENDER_API_KEY` | No | **Yes** | *(none)* | Owner API token (Render → Account Settings → API Keys). Powers **Settings → Render (admin)** to view/edit env vars, deploy, restart, suspend/resume. See **[[Admin Tools]]**. |
| `PORT` | No | No | `8080` | Port Uvicorn binds to (Render injects this). |

> `RENDER_EXTERNAL_URL` / `PUBLIC_BASE_URL` / `RENDER_SERVICE_ID` are read automatically when present. Auth is email/password only (Google sign-in was removed).

## Frontend environment variables

Create `frontend/.env` (Expo exposes `EXPO_PUBLIC_*` to the client bundle):

| Variable | Required | Description |
| --- | :---: | --- |
| `EXPO_PUBLIC_BACKEND_URL` | **Yes** (native & prod web) | Backend base URL, no trailing slash, no `/api`. Optional for local web dev. |
| `EXPO_PUBLIC_MAPBOX_TOKEN` | **Yes** | Mapbox public token for maps/geocoding/directions. |
| `EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME` | No | Cloudinary cloud name (media CDN). |
| `EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET` | No | Unsigned Cloudinary preset — **required for video/reels uploads**. |
| `EXPO_PUBLIC_STRIPE_KEY` | No | Stripe publishable key — renders card fields/onboarding embedded in the web app. |
| `EXPO_PUBLIC_TENOR_KEY` | No | Google Tenor key for the GIF picker. |

> `EXPO_PUBLIC_*` values are bundled into the client and are **not secret at runtime**. Use a Mapbox public (domain-scoped) token.
