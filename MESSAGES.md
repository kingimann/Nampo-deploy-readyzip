# OkaySpace — Messages & Chat (Complete Feature Reference)

Everything the messaging system does, with file locations and exact API calls.

**Where it lives**
- Inbox: `frontend/app/(tabs)/messages.tsx`
- Chat thread: `frontend/app/chat/[id].tsx` (the big one — ~2,500 lines)
- Voice/video call: `frontend/app/call/[id].tsx`
- E2E crypto: `frontend/src/utils/e2e.ts`
- Backend: `backend/routes/messaging.py` (+ `calls.py`)
- Chat sub-components: `VoiceMessage`, `CustomEmojiSheet`, `EmojiText`, `GifPickerSheet`, `ContactPickerSheet`, `FormPickerSheet`, `UnlockChatSheet`, `FakePaymentSheet`, `MediaGrid`, `QuoteCard`, `LinkPreviewCard`, `RichText`, `RestrictionBanner`.

---

## 1. Inbox (`app/(tabs)/messages.tsx`)

**Conversation list**
- Conversations are split into three auto-sections — **Direct messages**, **Marketplace** (DMs attached to a listing, shown with a 🏷️ listing tag), and **Group chats**. Empty sections are hidden.
- Each row shows: avatar (group rows are purple with a people icon; DMs show picture or initial), name, **group member-count pill**, last-message timestamp, and a **last-message preview** that adapts to type — `🚫 Message deleted`, `📍 place`, `📎 Media`, `🎤 Voice message`, `📄 Shared a post`, `📊 Poll`, or text.
- **Unread**: rows with unread messages get an accent border + a numeric unread badge, and the preview goes bold.
- **Search** box filters by conversation/participant name or listing title.
- **Floating frosted top bar** hides on scroll-down, returns on scroll-up. **Pull-to-refresh**. Reloads on focus.
- **Restriction banner** if the account's messaging is admin-disabled (with a "Dispute" link).

**Encryption in the inbox**
- E2E last-message previews are **decrypted on-device** so the inbox shows real text instead of "Encrypted message".
- If some chats can't be decrypted (key missing on this device), a **"N chats locked — tap to enter your PIN and unlock"** banner appears → opens `UnlockChatSheet`. Otherwise a subtle "Your chats are encrypted" note shows.

**Starting conversations** (compose modal)
- **New 1:1**: search users by name/email → opens the chat.
- **Notes to self**: a private self-conversation ("A private place to save thoughts & places").
- **New group**: name + add members as removable chips → create.
- Toggle between 1:1 and group modes in the same sheet.

**Row actions** — long-press opens an action sheet: **Delete chat** (DM, soft-hides for you; the other person keeps it) or **Leave group**, each behind an in-app confirm dialog.

**API:** `listConversations`, `searchUsers`, `getOrCreateConversation`, `createGroupChat`, `deleteConversation`. (Decryption helpers: `isE2E`, `tryDecrypt`, `getPeerPublicKey`.)

---

## 2. Chat thread (`app/chat/[id].tsx`)

### Header
- Back · **title** (group/conversation name) · search toggle · **voice call** · **video call** · options (•••).
- The subtitle is a live status line that cycles through: **"Disappears after \<duration\>"** (if a timer is set) → **"writing…"** (peer typing) → **"active now"** (green dot) → **"End-to-end encrypted"** / **"Encrypted"** (lock icon).

### Sending & message lifecycle
- **Text** messages, encrypted to the recipient(s) before send when E2E keys are present (`encryptForPeer` / `encryptForRecipients`); the bubble shows plaintext immediately via a local decrypted cache.
- **Reply** to a message (shows a reply preview banner above the composer; `reply_to`).
- **Edit** sent messages, with an **edit-history viewer** (decrypts each prior version).
- **Delete** (soft delete → "Message deleted" tombstone, optimistic).
- **Copy** message text. **Pin** message (and **jump to** a pinned/searched message).
- **Reactions**: double-tap a bubble for ❤️, or open the **emoji reaction picker**; shows a reaction tally (e.g. "❤️ 2"); optimistic then synced.
- **Tap-to-reveal**: single tap reveals a message's timestamp + read/seen status (Messenger-style); double-tap reacts.
- **Delivery status**: Sent → Delivered → Read. In groups it aggregates per-member: **"Read by N"**, **"Delivered to N"**.
- **Live updates**: polls `listMessages` every 3s using a change-signature (new/edited/deleted/read/delivered), and **won't clobber** in-flight optimistic reactions/pins/votes. Marks the conversation read on entry.
- **Presence**: 3s heartbeat publishing your typing/active state and reading the peer's (drives "writing…" / "active now").

**API:** `listMessages`, `sendMessage`, `editMessage`, `deleteMessage`, `pinMessage`, `reactToMessage`, `markConversationRead`, `setPresence`, `getPresence`.

### Message types you can send
| Type | How | Notes / API payload |
|------|-----|---------------------|
| **Text** | composer | E2E-encrypted; supports @mentions/links/hashtags via RichText |
| **Photo/Video** | attach → library | up to 4, quality 0.7, video ≤60s; E2E-sealed if keys present (`type:"media"`, `media[]`) |
| **Voice note** | hold mic | records with live timer (expo-audio), encodes base64, E2E; can be **AI-transcribed** (`type:"voice"`, `audio_base64`, `audio_duration_ms`) |
| **GIF** | GIF picker | Tenor (`type:"gif"`, `gif_url`) |
| **File** | attach → file | web `<input>` / native DocumentPicker; ≤~6 MB (E2E ≤5 MB) (`type:"file"`, `file_base64/name/size/mime`) |
| **Location** | attach → location | GPS + reverse-geocode → place bubble that opens the map (`type:"place"`, lat/lng/name/address) |
| **Contact** | attach → contact | share a user as a card (`type:"contact"`, `contact_user_id/name/picture`) via `ContactPickerSheet` |
| **Form** | attach → form | share a saved form (`type:"form"`, `form_id`) via `FormPickerSheet` |
| **Poll** | attach → poll | question + 2–6 options; interactive vote with optimistic bars (`type:"poll"`, `poll_question/options`; `votePollMessage`) |
| **Tip** | attach → tip | send money inside a DM; credits the recipient's wallet, renders an inline tip bubble (`type:"tip"`, `amount`) via `FakePaymentSheet` (wallet or card; `getPaymentsConfig`, `getWalletBalance`, `stripeCardPay`) |
| **Shared post** | from feed share | hydrates a preview card (`type:"post"`, `post_id`; `getPost`) |

E2E attachments are capped at **5 MB** (pure-JS crypto), enforced with a friendly "Too large to encrypt" message.

### Smart / AI features
- **Summarize chat (AI)** — assembles the last ~150 decrypted messages on-device and sends the transcript to the server's Claude endpoint (`summarizeConversation`); works even for E2E chats.
- **Voice transcription** — transcribe any voice note (`transcribeVoiceMessage`; passes the decrypted audio for E2E notes).
- **Scam check** — analyze a suspicious message for risk (low/medium/high + reason) via `scamCheckMessage` (passes decrypted text for E2E).

### Scheduling
- **Schedule a message** for a future time (date/time picker, must be ≥1 min out; encrypted like a normal send), **view** the scheduled list, and **cancel** scheduled sends. The backend dispatches them on a timer. API: `scheduleMessage`, `listScheduledMessages`, `cancelScheduledMessage`.

### In-chat search
- Toggle a search bar that searches the loaded thread (works with E2E since text is decrypted locally); shows **match count**, prev/next navigation, and scroll-to-match.

### Conversation settings (••• options menu)
- **Change group name** (groups only; `patchGroupChat`).
- **Theme** — 8 Messenger-style color themes (default, ocean, sunset, forest, grape, rose, midnight, mono) that recolor the thread background + your sent bubbles (`setConversationTheme`).
- **Shared media, files & links** — a gallery of everything shared in the chat (with lightbox).
- **Summarize chat (AI)** (above).
- **Disappearing messages** — Off / 1 min / 1 hour / 1 day / 1 week (`setDisappearing`).
- **Read receipts** — toggle on/off (`setReadReceipts`).
- **Clear conversation** — hides all messages for you; the other person keeps their copy (`clearConversation`).

### Calls
- Voice and video **call** buttons ring the peer (`ringCall`) and open `/call/[id]` (LiveKit room; `callToken`). Video passes `video:"1"`.

### Custom emoji
- `CustomEmojiSheet` lets you browse standard emoji categories and **upload/manage custom emojis** (shortcode-based); `EmojiText` renders `:shortcode:` inline in bubbles.

---

## 3. End-to-end encryption (`src/utils/e2e.ts`)

- **Algorithm:** NaCl box (X25519 + XSalsa20-Poly1305). On login the app **generates a keypair** and publishes the public key; it fetches the **peer's public key** (DM) or **every member's key** (group).
- **Group E2E** is enabled **only when every other member has published a key** (otherwise someone couldn't read the message); the message is sealed to each recipient.
- **Lazy decryption:** text, media, voice, and file payloads are decrypted on-device as they render (cached by message id).
- **Key backup/restore:** a **PIN-protected backup** of the private key lets you restore on another device (`/encryption-key` screen, `UnlockChatSheet`). The thread shows a **"N messages locked — enter your PIN"** restore banner when the key is missing, and a **"Set a PIN to back up your key"** nudge once you've sent encrypted messages.
- Helpers: `ensureKeyPair`, `getPeerPublicKey`, `encryptForPeer`, `encryptForRecipients`, `encryptDataForRecipients`, `decryptData`, `tryDecrypt`, `isE2E`, `isE2EMedia`, `hasBackup`, `restoreKey`. Backend key store: `uploadE2EKey`, `getUserE2EKey`, `uploadE2EBackup`, `getE2EBackup`, `deleteE2EBackup`.

---

## 4. Backend (`backend/routes/messaging.py`, prefix `/conversations`)

- **Conversations:** get-or-create DM (auto-reopens a soft-deleted DM on new activity), create group (≥2 members), list, **patch** group (name/avatar/theme/receipts/disappearing), **leave** (owner must transfer first), add/remove members, soft-delete.
- **Messages:** list (paginated, returns E2E ciphertext for client-side decrypt), send (all types above), edit, soft-delete, **react**/unreact, **read** receipts (marks message + preceding), **pin**.
- **Realtime:** typing indicators + presence; **scheduled-message dispatcher** runs on startup (`start_scheduled_dispatcher`) to deliver future sends.
- **Disappearing messages:** TTL enforced server-side.
- **Custom emojis:** create/list/delete (group-scoped).
- **Notifications:** new messages/group invites/tips can mirror to **push + SMS** (if opted in) via `notifications.py`.
- **Calls** (`calls.py`, `/calls`): `POST /calls/{conversation_id}/token` (LiveKit room token), `POST /calls/{conversation_id}/ring` (incoming-call alert).

---

## 5. Feature checklist (quick scan)

Text · photos · videos · voice notes · GIFs · files · location · contacts · forms · polls · tips/money · shared posts · replies · edits (+history) · deletes · copy · pin/jump · emoji reactions · custom emojis · read receipts (per-member in groups) · typing & active presence · disappearing messages · 8 chat themes · group rename · shared-media gallery · in-chat search · AI chat summary · voice transcription · scam detection · scheduled messages · notes-to-self · marketplace-linked chats · voice & video calls · full end-to-end encryption with PIN key backup/restore · message-restriction banner · push/SMS notifications.
