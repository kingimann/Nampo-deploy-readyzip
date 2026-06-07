# Contributing

## Repo layout
Monorepo: `backend/` (FastAPI) and `frontend/` (Expo). See **[[Architecture]]** for the module map. Reference docs: root `README.md`, `API.md`, `DEPLOY.md`, plus `frontend/CLOUDINARY_SETUP.md`, `frontend/EAS_SETUP.md`, `frontend/IOS_BUILD.md`, `backend/STRIPE_SETUP.md`.

## Local dev
See **[[Getting Started]]**. Backend: `uvicorn server:app --reload --port 8080`. Frontend: `npx expo start --clear`.

## Conventions
- **Backend:** Python 3.11, FastAPI + Pydantic v2. Routes go in `backend/routes/<domain>.py` and are registered in `backend/server.py`'s `_register()`. Use the Mongo-style `db` wrapper. Keep new public endpoints under `/pub/*` (no auth) or admin-gated with `is_admin`.
- **Frontend:** TypeScript (strict), expo-router. Match the surrounding file's style, the WhatsApp-inspired theme (`src/theme.ts`), and reuse shared components/animation primitives.
- **JSX gotcha:** never put a literal `<word>` in JSX **text** (e.g. `<unique>`) — Metro parses it as a tag and the web build fails. Use a code/`{}` expression or rephrase.
- **Animations:** use the core `Animated` API (native driver) unless you specifically need Reanimated worklets (enabled via `frontend/babel.config.js`; run `expo start --clear` after changing it).

## Checks
- Backend: `python -m py_compile <files>`; tests in `backend/tests/` (pytest) — note several were written against the older MongoDB build (`pymongo`/`MONGO_URL`) and are reference material.
- Frontend: `npm run lint`; verify a real Metro/EAS build before merging UI changes.

## Git workflow
- Develop on a feature branch; commit with clear messages.
- Open a PR into `main`; **do not** create a PR unless asked. Don't push to `main` directly.
- Keep commits scoped; document money/infra-touching changes carefully.

## API surface, kept in sync
When you add an endpoint group, update: the in-app **Developer API** screen (`frontend/app/developer.tsx`), the machine-readable `CAPABILITIES` in `backend/routes/meta.py`, and the relevant wiki page.
