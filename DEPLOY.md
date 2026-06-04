# Getting Nampo running (the easy way)

No AWS. This uses **MongoDB Atlas** (free database) + **Render** (free hosting
that deploys from your GitHub repo). Total time: ~15 minutes, mostly waiting.

---

## Step 1 — Database (MongoDB Atlas), ~5 min

1. Go to https://www.mongodb.com/cloud/atlas/register and sign up (free).
2. Create a **free M0 cluster** (pick any cloud/region near you).
3. **Database Access** → Add New Database User. Give it a username + password,
   role "Read and write to any database". Save the password somewhere.
4. **Network Access** → Add IP Address → "Allow access from anywhere"
   (`0.0.0.0/0`). Render's IPs aren't fixed on the free plan, so this is the
   simple route. (Tighten later if you want.)
5. **Database → Connect → Drivers → Python**. Copy the connection string. It
   looks like:
   ```
   mongodb+srv://USER:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
   Replace `<password>` with the real password from step 3. Keep this handy.

---

## Step 2 — Push your code to GitHub, ~3 min

If it isn't already on GitHub:
```bash
cd Nampo-main
git init
git add .
git commit -m "Self-hostable backend"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/Nampo.git
git push -u origin main
```
The `render.yaml` at the repo root tells Render exactly how to deploy.

---

## Step 3 — Deploy on Render, ~5 min

1. Go to https://render.com and sign up with your GitHub account.
2. **New + → Blueprint**.
3. Pick your `Nampo` repo. Render finds `render.yaml` and shows the
   `nampo-backend` service.
4. It will ask you to fill in the two secret env vars:
   - `MONGO_URL` → paste the Atlas string from Step 1.5
   - `FSQ_API_KEY` → leave blank (only needed for Foursquare place matching)
5. Click **Apply**. Render builds the Docker image and deploys. Watch the logs;
   when you see `MongoDB indexes ready` and `Uvicorn running`, it's live.
6. Render gives you a URL like `https://nampo-backend.onrender.com`.

**Test it:** open `https://nampo-backend.onrender.com/health` in a browser.
You should see `{"status":"ok"}`. Then `/api/` shows `{"message":"Map App API"}`.

> Free-plan note: Render spins the service down after ~15 min idle, so the
> first request after a nap takes ~30s to wake. Fine for development. Upgrade
> to the $7/mo plan to keep it always-on.

---

## Step 4 — Point the app at your backend, ~2 min

In the `frontend/` folder, create a `.env` file (copy from `.env.example`):
```
EXPO_PUBLIC_BACKEND_URL=https://nampo-backend.onrender.com
```
No trailing slash, no `/api` — the app adds that itself, and derives the
secure WebSocket URL (`wss://`) from it automatically.

Then run the app:
```bash
cd frontend
npm install      # or: yarn
npx expo start
```

---

## Creating your first account

Emergent OAuth is gone — the app now uses plain email/password. Register through
the app's sign-up screen, or hit the API directly to confirm it works:
```bash
curl -X POST https://nampo-backend.onrender.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"supersecret","name":"You","username":"you"}'
```
A successful response returns a `session_token` and your user object.

---

## What changed from the original (for your reference)

- **Removed** Emergent OAuth (`/api/auth/session` now returns 410). Your
  built-in bcrypt email/password auth (`/register`, `/login`) is the only path.
- **Added** CORS middleware (configurable via `CORS_ORIGINS`) and a `/health`
  endpoint for the host's health check.
- **Cleaned** `requirements.txt` — dropped the Emergent-hosted `litellm` wheel
  and `emergentintegrations` (neither was imported), so it installs from plain
  PyPI anywhere.
- **Added** `Dockerfile`, `render.yaml`, `.dockerignore`, and `.env.example`
  files. (`apprunner.yaml` is also included if you ever want AWS.)

No application logic changed. All 122 API routes and the WebSocket work as
before.
