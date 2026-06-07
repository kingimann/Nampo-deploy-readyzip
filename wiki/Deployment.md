# Deployment

## Render (recommended)
`render.yaml` is a Render **Blueprint** that provisions:
- a managed **Postgres** database (`nampo-db`),
- the **FastAPI API** from `backend/Dockerfile` (`nampo-backend`, with a `/health` check and `autoDeploy`),
- the **Expo web build** as a static site (`nampo-web`).

`DATABASE_URL` is injected automatically (`fromDatabase`). The static site gets `EXPO_PUBLIC_BACKEND_URL` + `EXPO_PUBLIC_MAPBOX_TOKEN` (and optional `EXPO_PUBLIC_CLOUDINARY_*`). Add the secret env vars from **[[Configuration]]** in the Render dashboard (or manage them in-app via **[[Admin Tools]]** once `RENDER_API_KEY` is set).

Step-by-step lives in **`DEPLOY.md`** (~15 minutes).

## Docker
`backend/Dockerfile` builds a self-contained image that runs `uvicorn server:app` on `$PORT` (default `8080`). Run it anywhere that can reach Postgres via `DATABASE_URL`.

## AWS App Runner
`backend/apprunner.yaml` is provided for source-based deploys.

## Mobile binaries (EAS)
Built with **EAS** — see **`frontend/IOS_BUILD.md`** (iOS/App Store, no Mac required) and `frontend/EAS_SETUP.md`.

```bash
cd frontend
eas login && eas init
eas build --profile development --platform ios   # or android
```

Features needing a dev/prod build (not Expo Go): **voice/video calls** (WebRTC) and **Reanimated worklets**.

## After the backend is live
Set the frontend's `EXPO_PUBLIC_BACKEND_URL` to the deployed URL (no trailing slash, no `/api`) and rebuild/restart Expo.

## Webhooks
Point **Stripe** at `POST {backend}/api/payments/webhook` and set `STRIPE_WEBHOOK_SECRET`. This finalizes tips, subscriptions, top-ups, and **paid form submissions** (see **[[Payments and Money]]**).

## Other Postgres providers
To bring your own (Neon, Supabase, local), drop the `databases:` block from `render.yaml` and set `DATABASE_URL` yourself.

## PWA / web
The web build is an installable PWA (`frontend/public/manifest.json` + meta in `app/+html.tsx`). After deploy, confirm `/manifest.json` and `/icon.png` return 200. See **[[Mobile and Web]]**.
