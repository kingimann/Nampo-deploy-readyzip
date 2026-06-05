# Deploying Nampo on Render

The backend is a **FastAPI** app that stores everything in **PostgreSQL**
(see `backend/db.py` — a Mongo-style wrapper over a JSONB table per
collection). Render can host both the database and the API for free and
redeploys automatically on every push. Total time: ~15 minutes, mostly waiting.

> Heads up: this project no longer uses Replit or MongoDB. The Replit config
> files have been removed and the old Mongo Atlas instructions are gone — the
> only database is Postgres, configured through `DATABASE_URL`.

---

## Step 1 — Push your code to GitHub, ~3 min

If it isn't already on GitHub:
```bash
git add .
git commit -m "Deploy to Render"
git push -u origin main
```
The `render.yaml` at the repo root tells Render exactly how to deploy: it
provisions a Postgres database **and** the API service together.

---

## Step 2 — Deploy on Render (Blueprint), ~5 min

1. Go to https://render.com and sign up with your GitHub account.
2. **New + → Blueprint**.
3. Pick your repo. Render reads `render.yaml` and shows two resources:
   - `nampo-db` — a free Postgres database
   - `nampo-backend` — the Docker web service
4. It will prompt for the optional secret:
   - `FSQ_API_KEY` → leave blank (only needed for Foursquare place matching).

   You do **not** need to enter a database URL — Render creates the Postgres
   instance and injects its connection string into the API as `DATABASE_URL`
   automatically (that's the `fromDatabase` block in `render.yaml`).
5. Click **Apply**. Render creates the database, builds the Docker image, and
   deploys. Watch the logs; when you see `Uvicorn running`, it's live.
6. Render gives you a URL like `https://nampo-backend.onrender.com`.

**Test it:** open `https://nampo-backend.onrender.com/health` — you should see
`{"status":"ok"}`. The tables are created automatically on first use, so there
is no migration step.

> Free-plan notes:
> - The web service spins down after ~15 min idle, so the first request after a
>   nap takes ~30s to wake. Upgrade to the $7/mo plan to keep it always-on.
> - The **free Postgres database expires after 30 days.** For anything
>   long-lived, upgrade the database to a paid tier (or point `DATABASE_URL` at
>   another Postgres provider such as Neon or Supabase — see below).

---

## Step 3 — Point the app at your backend, ~2 min

In the `frontend/` folder, create a `.env` file:
```
EXPO_PUBLIC_BACKEND_URL=https://nampo-backend.onrender.com
```
No trailing slash, no `/api` — the client adds that itself. (On the web build
the app talks to the same origin via `/api`, so this var is only needed for the
native/Expo builds.)

Then run the app:
```bash
cd frontend
npm install
npx expo start
```

---

## Creating your first account

The app uses plain email/password auth. Register through the sign-up screen, or
hit the API directly to confirm it works:
```bash
curl -X POST https://nampo-backend.onrender.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"supersecret","name":"You","username":"you"}'
```
A successful response returns a `session_token` and your user object.

---

## Using a different Postgres (Neon, Supabase, your own)

If you'd rather manage the database yourself, delete the `databases:` block in
`render.yaml`, then in the Render dashboard set `DATABASE_URL` to your own
Postgres connection string (the `postgresql://user:pass@host/db` form that
`asyncpg` accepts). Everything else stays the same.

---

## Environment variables (reference)

| Variable        | Required | Purpose                                                        |
|-----------------|----------|----------------------------------------------------------------|
| `DATABASE_URL`  | yes      | Postgres DSN. Provided automatically by the Render Blueprint.  |
| `CORS_ORIGINS`  | no       | Comma-separated allowed origins, or `*` (default).             |
| `FSQ_API_KEY`   | no       | Foursquare key for place matching. Safe to leave blank.        |
| `PORT`          | no       | Set by the host; the server binds to it (defaults to 8080).    |

No application logic depends on the host — the same image runs anywhere that
can run a Docker container and reach a Postgres database.
