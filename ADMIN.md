# OkaySpace — Admin Settings & Admin Suite (Complete Feature Reference)

Everything the admin/staff tools do, with file locations, exact API calls, and what each control does. Anchored on the **Admin Settings hub** (`/admin-settings`), which links out to every tool.

**Where it lives**
- Hub: `frontend/app/admin-settings.tsx`
- Tools: `frontend/app/admin-users.tsx`, `admin-audit.tsx`, `admin-payments.tsx`, `admin-revenue.tsx`, `admin-badges.tsx`, `admin-bot.tsx`, `admin-integrations.tsx`, `admin-render.tsx`, `admin-roadside.tsx`, `admin-roadside-calls.tsx`, `admin-support.tsx`
- Backend: `backend/routes/users.py` (admin), `payments.py` (admin), `render_admin.py`, `integrations.py`, `ads.py`, plus badge/audit endpoints
- Reached from: **Settings → Admin settings** (`app/settings.tsx`, shown only to staff)

---

## 1. Permission model

Roles live on the user (`user.role`): **`user` | `mod` | `admin`**.

- **Admin** sees **everything** — the Moderation, Money & growth, System, and Staff groups.
- **Mod (staff)** sees **only the Staff group** — Roadside verifications + Support queue.
- Most screens **self-gate** as well: opening an admin-only tool as a non-admin shows an "Admins only" lock screen and (for several) **bounces you to `/`**; staff-only tools bounce non-staff to `/` or `/support`.

| Tool | Minimum role |
|------|--------------|
| Manage users, Audit log, Payments & data, Ad revenue, Custom badges, Test bot, Integrations, Render hosting, Roadside **calls** | **admin** |
| Roadside **verifications**, Support queue | **mod** or admin |

---

## 2. The hub — `/admin-settings` (`app/admin-settings.tsx`)

A single scrollable list of icon rows grouped by area. Header: back + "Admin settings". Each row pushes its tool.

- **Moderation** (admin) — **Manage users** → `/admin-users` · **Audit log** → `/admin-audit`
- **Money & growth** (admin) — **Payments & data** → `/admin-payments` · **Ad revenue** → `/admin-revenue` · **Custom badges** → `/admin-badges`
- **System** (admin) — **Test bot** → `/admin-bot` · **Integrations & SDKs** → `/admin-integrations` · **Render hosting** → `/admin-render`
- **Staff** (mod + admin) — **Roadside verifications** → `/admin-roadside` · **Support queue** → `/admin-support`

(The whole admin-only block is hidden for mods; only the Staff group renders.)

---

## 3. Manage users — `/admin-users` (`app/admin-users.tsx`)

The biggest tool: search any user and apply every moderation/account action.

**Layout:** Header (back · "Admin · Users" · link to `/admin-audit`) → optional **"Verify myself"** button (if the admin is unverified) → **search bar** (debounced 300 ms) → **user list** (avatar, name + verified check, ADMIN/MOD role pill, email/username, red Banned/Suspended badge). Tapping a user opens a **detail sheet** with all actions; several actions open their own modals.

**Actions (and the exact API call):**
- **Search** → `adminListUsers(q, 100, 0)`
- **Verify myself / Verify toggle** → `adminPatchUser(id, { verified })`
- **Make / remove mod** → `adminPatchUser(id, { role: 'mod' | 'user' })`
- **Make / remove admin** → `adminPatchUser(id, { role: 'admin' | 'user' })`
- **Ban** → modal with reason (≤300 chars) → `adminBanUser(id, reason)`
- **Suspend** → modal with duration chips (1d/3d/1wk/1mo or custom days) + reason → `adminSuspendUser(id, days, reason)`
- **Lift ban/suspension** → `adminUnbanUser(id)`
- **Disable/enable messaging** → `adminSetRestrictions(id, { messaging_disabled })`
- **Disable/enable marketplace** → `adminSetRestrictions(id, { marketplace_disabled })`
- **Disable/enable posting** → `adminSetRestrictions(id, { posting_disabled })`
- **Set wallet balance** → modal (USD) → `adminSetWallet(id, amount)`
- **View/edit transactions** → `adminListTransactions(id)`; per-row edit → `adminEditTransaction(id, {...})`, delete (confirm) → `adminDeleteTransaction(id, ref, adjust)`
- **Re-add lost transaction** → modal (kind: top-up/received/sent/cash-out · amount · counterparty · note · date · time · "adjust balance" checkbox) → `adminAddTransaction(id, {...})`
- **Assign badges** → loads `listBadges()` + `getPublicUser(id)`; toggling → `adminSetUserBadge(id, badgeId, 'add'|'remove')`
- **Remove account** → confirm → `adminRemoveUser(id)`

Every detail-sheet toggle is optimistic (applies instantly, then reconciles with the server response).

**Navigates to:** `/admin-audit`.

---

## 4. Audit log — `/admin-audit` (`app/admin-audit.tsx`)

Read-only log of every admin action. Header (back · "Admin · Activity log") → pull-to-refresh list. Each row: a colored icon dot keyed to the action type, the sentence "**\<admin\>** \<action\> **\<target\>**" with an optional quoted detail, and a relative timestamp (now/5m/2h/3d/date). **API:** `adminAuditLog()`. No interactions beyond refresh.

---

## 5. Payments & data — `/admin-payments` (`app/admin-payments.tsx`)

Stripe mode, platform fees, revenue, and destructive resets.

- **Test payments toggle** → `adminSetTestPayments(on)` — switches Stripe between **test** and **live**; shows the live/test/not-configured status. Reads with `adminGetTestPayments()`.
- **Mobile-only toggle** → `adminSetMobileOnly(on)` (reads `adminGetMobileOnly()`) — the **PC-gate switch** (when on, desktop browsers get the "open on your phone" screen).
- **Force web update** → confirm → `adminBumpWebBuild()` (reads `adminGetWebBuild()`) — bumps the web-build token so open browser tabs clear cache and reload to the latest deploy within minutes (mobile apps unaffected).
- **Platform revenue card** → `adminGetRevenue()` — total fees collected, breakdown (transfer/send fees, cash-out fees, total paid to creators), fee-paying event count, per-send fee, per-cash-out fee.
- **Fees & revenue split** → inputs for **platform cut %** (subs/tips) and **per-transaction fee ¢**, with a live "creators keep X% / you keep Y%" split; **Save** → `adminSetFees({ platform_fee_percent, transaction_fee_cents })`. Reads `adminGetFees()`.
- **Reset money** → confirm → `adminResetMoney()` — wipes all wallets, tips, subscriptions, payouts, transfers, ad balances.
- **Reset analytics** → confirm → `adminResetAnalytics()` — wipes impressions/clicks/spend/views.

---

## 6. Ad revenue — `/admin-revenue` (`app/admin-revenue.tsx`)

Read-only ad-revenue dashboard. **API:** `getAdRevenue()` (pull-to-refresh / retry). Shows: **platform cut**, total ad spend, paid to creators; a stat grid (spend, impressions, clicks, **CTR %**, creator payouts, active campaigns); and ranked **top earners** and **top advertisers** lists.

---

## 7. Custom badges — `/admin-badges` (`app/admin-badges.tsx`)

Create the badges that can be pinned to users (in §3).

- **New badge card:** label (≤40), icon (emoji **or** image URL), an 8-swatch color picker, and a live preview rendered with the real `UserBadges` component.
- **Create** → `adminCreateBadge({ label, icon, color })` (requires label + icon).
- **All badges list:** each row has a trash button → confirm "remove from everyone who has it" → `adminDeleteBadge(id)`.
- Reads with `listBadges()`. Assignment happens in **Manage users**.

---

## 8. Test bot — `/admin-bot` (`app/admin-bot.tsx`)

**Admin-only** (non-admins see "Admins only."). Simulates ad traffic to exercise the wallet/analytics/earnings flow — counters move like real traffic, but **no real likes/comments are posted**, and earnings are credited to you so you can verify money flow.

- **Pick a sponsored post** (radio list with text/owner/stats) ← `getBotPosts()`.
- **Traffic inputs:** Views (100), Clicks (10), Likes (20), Comments (5).
- **Run bot** → `runBot({ post_id, views, clicks, likes, comments })` → result card: **"you earned $X"**, advertiser spend + amount debited from their ad balance, and the totals added.
- **Wallet** button / "Check your wallet →" → `/wallet`.

---

## 9. Integrations & SDKs — `/admin-integrations` (`app/admin-integrations.tsx`)

Health view of every backend integration and client SDK (Stripe, Mapbox, Cloudinary, Tenor, email, SMS, LiveKit, etc.).

- **Summary:** "{ok}/{total} configured" + **Run live tests** → `adminIntegrations(true)` (live-tests all; shows latency/result per card).
- **Show only issues** filter (not_configured / error).
- **Per-integration card:** name (with `*` if required) + status pill, summary, tested latency, **env-var chips** (green check if set / hollow if missing), a yellow **fix box** with setup instructions, an optional **Test** button → `adminIntegrations(false, key)` (tests just that one), and an **Open docs** link.

---

## 10. Render hosting — `/admin-render` (`app/admin-render.tsx`)

Operate the Render-hosted services. If `RENDER_API_KEY` isn't set, shows a "Render API not connected" setup screen.

Per **service card** (the current app is tagged "this app"): name + type/branch + deploy status dot ("Deploy live / Building… / failed"), service URL link, then:
- **Deploy** → confirm → `renderTriggerDeploy(sid, false)` (then polls status)
- **Clear cache & deploy** → confirm → `renderTriggerDeploy(sid, true)`
- **Restart** → confirm → `renderRestart(sid)`
- **Suspend / Resume** → confirm → `renderSuspend(sid)` / `renderResume(sid)`
- **Environment variables** (collapsible) ← `renderEnvVars(sid)`: reveal (eye), **edit** → confirm ("triggers a redeploy") → `renderSetEnv(sid, key, val)`, **delete** → confirm → `renderDeleteEnv(sid, key)`, **add** new key/value → `renderSetEnv(...)`
- **Recent deploys** (collapsible) ← `renderDeploys(sid)`: commit message, status, commit id, timestamp
- **Render dashboard** external link

Services list ← `renderServices()`.

---

## 11. Roadside verifications — `/admin-roadside` (`app/admin-roadside.tsx`)

**Staff (mod/admin).** Manual review of roadside document submissions when the AI verifier is unavailable; documents are deleted on decision.

- List ← `adminRoadsideVerifications()`. Each card: user (avatar/name/email), vehicle, note, and **Insurance** + **Ownership** photo thumbnails (tap → fullscreen lightbox).
- **Approve** → `decideRoadsideVerification(id, true)` (removes card).
- **Reject** → modal with a reason shown to the member → `decideRoadsideVerification(id, false, reason)`.
- Admins get a header **call icon** → `/admin-roadside-calls`.

---

## 12. Roadside calls — `/admin-roadside-calls` (`app/admin-roadside-calls.tsx`)

**Admin-only.** Create, search, and bulk-erase roadside service calls.

- **Create a call:** service chips (Tow/Lockout/Battery/Tire/Gas), caller name, place/address, **vehicle** (year/make/model/color/plate), notes, **price**, up to **6 photos** (`pickImages`), optional lat/lng (defaults to downtown Toronto). **Test call** → `adminCreateRoadsideCall({..., is_test: true})`; **Real call** → same with `is_test: false` (returns the assigned call number).
- **Find calls:** date (YYYY-MM-DD) + call # → **Search** → `adminListRoadsideCalls({ date, call_number })`; **Recent (all)** clears filters.
- **Bulk erase:** **Erase test calls** → confirm → `adminEraseRoadsideCalls({ ..., test_only: true })`; **Erase all** → confirm (destructive) → `adminEraseRoadsideCalls({...})`.
- **Call cards:** call #, service, TEST/status tags, requester + helper (name/phone), vehicle/place/coords/destination/note, photo grid (lightbox), timestamps (created/accepted/completed), and payment line (method/amount/settled-or-held). Per-card **delete** → confirm → `adminDeleteRoadsideCall(id)`.

---

## 13. Support queue — `/admin-support` (`app/admin-support.tsx`)

**Staff (mod/admin).** The support inbox.

- **Filter chips:** Open / All / Resolved / Closed → `adminTickets(status?)`.
- **Ticket rows:** subject, user + category + time-ago, colored status pill. Tap → `/support/[id]` (the shared ticket thread where staff reply and set status via `getTicket`, `replyTicket`, `setTicketStatus`).

---

## 14. Backend (admin endpoints)

- **`users.py`** (`/admin`) — `users/{id}` PATCH (verify/role), `audit`, `users` (list/search), `users/{id}/ban|unban|suspend|restrictions`, `users/{id}/balance` GET/POST, `users/{id}/transactions` GET/POST (+ edit/delete), `users/{id}/badge`.
- **`payments.py`** (`/admin/...`) — `test-payments` GET/POST, `fees` GET/POST, `revenue`, `mobile-only` GET/POST, `web-build` GET/bump, `reset-money`, `reset-analytics`.
- **`ads.py`** — `/admin/ad-revenue`; **bot** — `/admin/bot/posts`, `/admin/bot/run`.
- **`integrations.py`** — `/admin/integrations` (status + live tests).
- **`render_admin.py`** (`/admin/render`) — `services`, `services/{id}/deploys` (list/trigger), `restart`, `suspend`, `resume`, `env-vars` (get/set/delete).
- **Badges** — `/admin/badges` (create/delete), `/admin/users/{id}/badge`.
- **Roadside** — `/admin` roadside verifications (list/decide) + roadside calls (create/list/delete/erase).
- **Support** — `adminTickets` queue; ticket thread shared with users.

All admin endpoints require an admin (or staff, where noted) session; the backend enforces the role server-side regardless of what the client shows.

---

## 15. Feature checklist (quick scan)

Role-gated hub · user search · verify · promote/demote mod & admin · ban (reason) · suspend (duration + reason) · lift ban · disable posting/messaging/marketplace · set wallet balance · add/edit/delete transactions · assign/remove custom badges · delete account · audit log · Stripe test/live toggle · PC-gate (mobile-only) toggle · force web update · platform fee % + per-tx ¢ · revenue dashboard · reset money / reset analytics · ad-revenue analytics + top earners/advertisers · create/delete badges · ad-traffic test bot · integration health + live tests + env-var checks · Render deploy/restart/suspend/resume + env-var editing + deploy history · roadside doc verification approve/reject · roadside call create/search/erase · support ticket queue with status filters.
