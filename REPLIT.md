# Running Nampo on Replit (edit + view in your browser)

This is the no-AWS, no-local-machine path. You edit code and see it run, all in
one browser tab. The only outside piece is a free database (one connection
string, pasted once).

---

## Step 1 — Free database (5 min, one time)

1. Sign up at https://www.mongodb.com/cloud/atlas/register
2. Create a **free M0 cluster** (any region).
3. **Database Access** → add a user with a password, role "Read and write to
   any database."
4. **Network Access** → Add IP → **Allow access from anywhere** (`0.0.0.0/0`).
   Replit's IPs aren't fixed, so this is required.
5. **Database → Connect → Drivers → Python** → copy the string and replace
   `<password>`:
   ```
   mongodb+srv://USER:THEPASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
   Keep it for Step 3.

---

## Step 2 — Import the project into Replit (2 min)

Pick whichever is easier:

**A. From GitHub** (best if your code is already pushed)
- Replit → **Create Repl → Import from GitHub** → paste your repo URL.

**B. Upload the zip**
- Replit → **Create Repl → choose "Python"** → name it → Create.
- In the file panel, use the **⋮ menu → Upload folder** (or drag the unzipped
  project in). Make sure `.replit`, `replit.nix`, and the `backend/` folder
  land at the top level of the Repl.

---

## Step 3 — Add your database secret (1 min)

In the Repl, click the **lock icon (Secrets)** in the left sidebar and add:

| Key         | Value                                  |
| ----------- | -------------------------------------- |
| `MONGO_URL` | the Atlas string from Step 1.5         |

That's the only secret you need. `DB_NAME` and `CORS_ORIGINS` are already set in
`.replit`. (`FSQ_API_KEY` is optional — only for Foursquare place matching.)

---

## Step 4 — Press Run

Hit the big green **Run** button. Replit installs the Python deps and starts the
server. In the logs you'll see `MongoDB indexes ready` and
`Uvicorn running`. A **Webview** pane opens with your live URL, something like:
```
https://nampo.YOUR-USERNAME.repl.co
```

**Check it works:** add `/health` to that URL → `{"status":"ok"}`.
Then `/api/` → `{"message":"Map App API"}`.

Editing any backend file auto-reloads the server (the run command uses
`--reload`), so you change code and refresh — no redeploy.

---

## Step 5 — Point the app at it

This Repl runs the **backend (the API)**. The Nampo frontend is a React Native
/ Expo app, so to actually use the UI you run the frontend separately (on your
machine or its own Repl) and point it at the backend URL.

In `frontend/.env`:
```
EXPO_PUBLIC_BACKEND_URL=https://nampo.YOUR-USERNAME.repl.co
```
(No trailing slash, no `/api` — the app adds those itself.)

To sanity-check the backend alone without the frontend, register a user right
from the Replit Shell:
```bash
curl -X POST https://nampo.YOUR-USERNAME.repl.co/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"supersecret","name":"You","username":"you"}'
```
A `session_token` in the response means everything works end to end.

---

## Notes

- **Free Repls sleep when idle** and wake on the next request (a few seconds'
  delay). Fine for testing. Replit's paid "Always On" keeps it awake.
- **Login is email/password** (Emergent OAuth was removed). Use the app's
  sign-up screen or the curl above.
- Want me to make the *frontend* runnable in the browser too? That's a separate
  setup (Expo web) — just ask.
