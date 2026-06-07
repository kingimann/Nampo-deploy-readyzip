# Roadside Assistance

Members request help when stranded; nearby members accept and go help.

## Requesting help
A member opens **Roadside** and creates a request:
- **Tow** (carries a destination) or a **light service**: lockout, battery boost / jump start, tire change / flat repair.
- The request is pinned to the requester's location; they can add vehicle info, notes, and **photos**.

## Photo AI moderation
Uploaded photos are checked by AI vision (**Claude**, with an optional self-hosted **Ollama** fallback) and **non-automotive photos are flagged**. Requires `ANTHROPIC_API_KEY` (or `OLLAMA_HOST`); without it, photos are accepted unchecked. See **[[Configuration]]**.

## Helper flow
Nearby members see open requests and can **accept** or **decline**:
- An **accept/decline detail screen** shows the phone number (**revealed only after accepting**, for privacy), vehicle, address, notes, and photos.
- A **2-minute response timer** auto-declines on expiry; the list auto-refreshes so a call disappears once another helper takes it.
- After accepting, the job moves to a dedicated **"Your job"** tab with **En route → On location** steps. Marking **On location** is gated by a **GPS proximity check** (the helper must actually be near the requester).

## Disputes
If a requester disputes, a record is only created when a **valid support ticket** is actually opened (no phantom "disputed" state). See **Support & disputes** in the app.

## Staff
Mods/admins triage the verification queue at **Settings → Roadside verifications (staff)** (`/admin-roadside`).

## API
`/roadside/requests` (create/list), `/roadside/requests/{id}/accept|decline|enroute|arrived|cancel`. `arrived` enforces the proximity radius server-side.
