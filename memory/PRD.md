# Atlas — Mapbox Map App

Dark-themed Mapbox app with Apple-Maps/Google-Maps-level breadth, built on Expo + FastAPI + MongoDB.

## Feature surface (current)

**Maps & nav**
- 4 styles, traffic, 3D buildings, compass-reset
- Search + 6 category quick-filters + **Home/Work shortcut chips** (saved on user profile)
- Recents (per-user, 20-cap)
- Multi-stop directions, Drive/Walk/Cycle, turn-by-turn steps
- **Voice navigation** (expo-speech) with mute toggle
- **Live ETA-sharing** via WebSocket — public `/eta/{id}` viewer needs no account

**Place cards**
- Distance, ratings, reviews, Directions/Save/Share/Open-in-Maps
- 5-star write-a-review modal (race-safe upsert)

**Library**
- Places + Guides tabs; per-guide color, public toggle, unique slug

**Public guides**
- `/g/{slug}` no-auth viewer + clone-to-library

**Profile**
- Editable name + bio + **Home/Work addresses** (`PATCH /auth/me`), stats card

**Messaging**
- User search by email/name, conversations w/ unread badge & timestamps
- Text + share-place bubbles (tap to fly back to map)
- **Read receipts** (`POST /conversations/{id}/read`), **delete-own-message** (long-press), 3s polling

## Mongo collections
users · user_sessions (TTL) · places · recents · guides · reviews · conversations · messages · eta_shares (TTL)

## Tests
**111/111 backend tests passing** (iteration_5.json); newer endpoints (read receipts, delete-message, profile home/work) covered by existing user-flow tests + manual curl.

## Known not-shipped
Offline maps (needs native dev build via Publish), Foursquare business profiles (needs your API key), Street View, GTFS transit, traffic incidents (all need paid data sources).
