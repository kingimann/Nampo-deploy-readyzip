---
name: Installing frontend (Expo) packages
description: Where Expo deps must land and how to install them correctly in this repo
---

# Frontend deps must be installed in ./frontend, not repo root

The Expo app lives in `./frontend` as a **standalone npm project** (its own
`package.json` + `package-lock.json` + `node_modules`). The repo root is NOT an
npm/Expo project and has no `package.json` of its own.

**Symptom of getting this wrong:** Metro crash `UnableToResolveError Unable to
resolve module <pkg>` even though the package appears in `frontend/package.json` —
because it was never installed into `frontend/node_modules`.

**Why the generic package tool fails here:** `installLanguagePackages({language:"nodejs"})`
runs at the repo root, so it creates a stray root `package.json`/`package-lock.json`
and installs into root `node_modules` — the wrong place, often with an SDK-incompatible
version (e.g. it resolved `expo-audio@^56` when Expo SDK 54 needs `~1.1.x`).

**How to apply:** Install Expo packages with `cd frontend && npx expo install <pkg>` —
this picks the SDK-compatible version and writes to `frontend/`. After installing,
delete any stray root `package.json`/`package-lock.json`/`node_modules` the generic
tool created, clear Metro cache (`rm -rf frontend/.metro-cache frontend/node_modules/.cache`),
and restart the `Start frontend` workflow.
