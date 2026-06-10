# OkaySpace — Feature & Navigation Map (Detailed)

A complete reference to **what every screen does**, **where it lives**, **the exact API calls it makes**, and **how navigation is wired**. OkaySpace is one Expo / React Native codebase shipping to **iOS, Android, and the web** (web is now phone-first — PCs are gated, §16).

- **Frontend:** `frontend/` — Expo Router (file-based routing). Routes in `frontend/app/`, reusable UI in `frontend/src/`.
- **Backend:** `backend/` — FastAPI (Python). Storage is **PostgreSQL with a JSONB document wrapper** (`db.py`) that exposes a Mongo/Motor-compatible async API. Routes in `backend/routes/`. Entry point `backend/server.py`.
- **API client:** `frontend/src/api/client.ts` — ~425 typed methods = the full feature surface.

Each screen entry below is formatted: **Purpose · Sections/UI · API calls · Components · Navigates to.**

---

## 1. Navigation architecture (the backbone)

**Root layout:** `frontend/app/_layout.tsx`. Provider/gate nesting (outer→inner):

```
GestureHandlerRootView
└ SafeAreaProvider
 └ AuthProvider            session/user (src/context/AuthContext.tsx)
  └ SidebarProvider         left sidebar open/close
   └ NavBarProvider          customizable bottom tabs
    └ SidebarMenuProvider     sidebar menu data
     └ ConfirmProvider         in-app confirm dialogs
      └ NavHistoryProvider      back-stack tracking
       ├ WebNavGuard            blocks F5/save/devtools on web
       └ MobileOnlyGate         §16 PC gate → app or "get the app" screen
          ├ WebPullToRefresh    touch pull-to-reload (phones)
          └ MobileFrame
             ├ DesktopShell     desktop web left rail (no-op on mobile)
             │  └ <Stack/>       screen router (AppErrorBoundary-wrapped)
             ├ GlobalTabBar      floating LiquidTabBar (mobile); hidden on desktop
             ├ AuthedSidebar     LeftSidebar (logged-in only)
             ├ UsernameGate      forces username pick on first run
             └ PolicyGate        forces ToS/policy acceptance
          ├ PushManager          push-notification registration
          └ AuthRedirect         bounces logged-out users to /login
```

**Three navigation surfaces:**
1. **Bottom tab bar** (`LiquidTabBar.tsx`) — mobile only; floating pill; **user-customizable** (§2).
2. **Left sidebar** (`LeftSidebar.tsx`) — the "everything" drawer; customizable via `/customize-sidebar`.
3. **Desktop left rail** (`DesktopShell.tsx`) — replaces the bottom pill on desktop web.

**Auth routing:** `(tabs)/_layout.tsx` redirects to `/login` if logged out. `AuthRedirect` bounces any non-public route to `/login`. Public prefixes: `/login`, `/auth`, `/legal`, `/oauth`, `/eta/`. The app's "home" is the user's **first customized nav shortcut** (so `/`, `/auth`, `/index` resolve to the user's chosen first tab).

**Bottom-bar visibility:** `shouldShowBar()` hides the bar on immersive screens (chat threads, reels, post/listing detail, wallet, money, admin, etc. — full list in `HIDDEN_BAR_PREFIXES`).

---

## 2. Primary navigation — the bottom tabs

Defined in `src/context/NavBarContext.tsx` (`NAV_CATALOG`). Users pick 3–4 via **`/customize-nav`**; **Profile is locked**. Default: `feed, map, groups, profile`.

| Tab | Route | Screen file | Active also on |
|-----|-------|-------------|----------------|
| **Home** | `/feed` | `app/(tabs)/feed.tsx` | `/post`, `/user`, `/hashtag` |
| **Map** | `/` | `app/(tabs)/index.tsx` | `/directions`, `/eta`, `/place`, `/guide`, `/g` |
| **Groups** | `/groups` | `app/(tabs)/groups.tsx` | `/group` |
| **Market** | `/marketplace` | `app/(tabs)/marketplace.tsx` | — |
| **Reels** | `/reels` | `app/reels.tsx` | — |
| **You** | `/profile` | `app/(tabs)/profile.tsx` | — |

---

## 3. Feed & social

### `/feed` — Home feed (`app/(tabs)/feed.tsx`)
- **Purpose:** Personalized timeline with Following / Explore tabs, live new-post polling, and composition.
- **Sections/UI:** Segmented control (Explore/Following); story tray; FlatList of `PostCard` with `AdSlot` interleaving; floating "new posts" pill; frosted top bar (search, compose, notifications); CommentsSheet; PostComposer; post action menu (Edit/Pin/Privacy/Promote/Delete).
- **API:** `homeFeed`, `exploreFeed`, `unreadNotificationsCount`, `recordPostView`, `toggleLike`, `toggleDislike`, `toggleRepost`, `toggleBookmark`, `deletePost`, `pinPost`, `listReplies`.
- **Components:** SidebarMenuButton, PostCard, AdSlot, FadeIn, PostSkeleton, StoryTray, CommentsSheet, PostPrivacySheet, ConfirmModal, RestrictionBanner, PostComposer.
- **Navigates to:** `/search`, `/notifications`, `/messages`, `/advertise`, `/post/[id]`.

### `/post/[id]` — Post detail (`app/post/[id].tsx`)
- **Purpose:** Root post + author thread + all replies.
- **Sections/UI:** Back header; "Thread · N posts" banner; root PostCard; thread connector lines; replies list; Reply FAB.
- **API:** `getPost`, `listReplies`, `postThread`, `recordPostView`, `toggleLike`, `toggleDislike`, `toggleRepost`, `toggleBookmark`.
- **Components:** PostCard, PostComposer.

### `/hashtag/[tag]` — Hashtag feed (`app/hashtag/[tag].tsx`)
- **Purpose:** All posts under a hashtag.
- **API:** `hashtagPosts`, `toggleLike`, `toggleRepost`, `toggleBookmark`. **Components:** PostCard. **Navigates to:** `/post/[id]`.

### `/reels` — Reels (`app/reels.tsx`)
- **Purpose:** Full-screen vertical video feed with Explore/Following scope, reactions, editing, ad injection.
- **Sections/UI:** Top scope tabs; paginated vertical FlatList; per-reel: playback, double-tap heart, mute/speed, right engagement column (reactions, like, comment, repost, share, views, edit/promote/report), bottom metadata; `AdReel` with skip countdown.
- **API:** `reelsFeed`, `serveReelAd`, `recordPostView`, `reelAdEvent`, `searchUsers`, `editPost`, `reactToPost`, `toggleRepost`, `reportPost`.
- **Components:** SidebarMenuButton, ReelVideo (+ `.web`), ReelPoster, VerifiedBadge, UserBadges, CommentsSheet.
- **Navigates to:** `/user/[name]`, `/advertise`, `/post/[id]`, `/chat/[id]`.

### `/story/[userId]` — Story viewer (`app/story/[userId].tsx`)
- **Purpose:** Immersive stories with progress bars, auto-advance, viewer list (owner), reply.
- **API:** `listUserStories`, `viewStory`, `listStoryViewers`, `replyToStory`, `deleteStory`. **Components:** expo-video VideoView.

### `/bookmarks` (`app/bookmarks.tsx`)
- **Purpose:** Saved posts. **API:** `listBookmarks`, `toggleLike`, `toggleRepost`, `toggleBookmark`. **Components:** PostCard, SidebarMenuButton. **Navigates to:** `/post/[id]`.

### `/activity` (`app/activity.tsx`)
- **Purpose:** Financial activity log (topup, cashout, sent, received, subs, transfers) with status. **API:** `getActivity`. **Navigates to:** `/wallet`.

### `/notifications` (`app/notifications.tsx`)
- **Purpose:** Two tabs — Notifications (you) + Activity (network). **API:** `listNotifications`, `markNotificationRead`, `markAllNotificationsRead`, `deleteNotification`, `listActivity`. **Navigates to:** `/call/[id]`, `/support`, `/money`, `/roadside`, `/my-listings`, `/chat/[id]`, `/user/[name]`, `/post/[id]`, `/feed`.

### `/muted-words` (`app/muted-words.tsx`)
- **Purpose:** Mute keywords (hide) and prioritize keywords (boost). **API:** `updateMe`.

### `/search` (`app/search.tsx`)
- **Purpose:** Unified search (people, communities, marketplace, hashtags) + trending/popular when empty.
- **API:** `searchUsers`, `listCommunities`, `listListings`, `trendingHashtags`, `popularReels`, `popularPosts`.
- **Navigates to:** `/hashtag/[tag]`, `/user/[name]`, `/c/[name]`, `/listing/[id]`, `/reels`, `/post/[id]`.

### `/people` (`app/people.tsx`)
- **Purpose:** Friend discovery/management (requests + friends). **API:** `listFriendRequests`, `listFriends`, `searchUsers`. **Components:** UserRow.

### `/connections` (`app/connections.tsx`)
- **Purpose:** Followers/Following with bulk-unfollow manage mode. **API:** `listFollowers`, `listFollowing`, `unfollowBulk`. **Components:** UserRow.

---

## 4. Profiles

### `/profile` — Your profile (`app/(tabs)/profile.tsx`)
- **Purpose:** Self profile with edit, post management, visual customization, personal↔business switch.
- **Sections/UI:** Hero (cover, avatar, score, status, interests, links); privacy card; tabs (posts/replies/reposts/media/likes); avatar picker; 5-tab edit modal (basics/look/about/links/privacy); PostComposer; post action sheet.
- **API:** `myBusiness`, `listUserPostsAll`, `listUserReplies`, `listUserReposts`, `listUserLikes`, `getPublicUser`, `toggleLike`, `toggleDislike`, `toggleRepost`, `toggleBookmark`, `deletePost`, `updateMe`, `usernameAvailable`, `setUsername`.
- **Components:** PostCard, ReelPoster, PostComposer, ConfirmModal, AvatarFrame, ProfileBackground, ProfileDecor, BirthdayPicker, AdSlot, VerifiedBadge.
- **Navigates to:** `/settings`, `/leaderboard`, `/connections`, `/people`, `/feed`, `/privacy`, `/reels`, `/post/[id]`, `/business`, `/business/[id]`.

### `/user/[name]` — Public profile (`app/user/[name].tsx`)
- **Purpose:** Anyone's profile with follow/friend/tip/subscribe/pay/message + admin controls.
- **Sections/UI:** Profile block; action buttons; admin controls; tabs (posts/replies/reposts/likes); tier picker; subscription sheet; tip sheet.
- **API:** `searchUsers`, `getPublicUser`, `listUserPosts`, `recordProfileView`, `getPaymentsConfig`, `getWalletBalance`, `getSubscriptionTiers`, `toggleLike`/`toggleRepost`/`toggleBookmark`, `listUserReplies`/`listUserReposts`/`listUserLikes`, `getOrCreateConversation`, `toggleFollow`, `unfriend`, `cancelFriendRequest`, `acceptFriend`, `sendFriendRequest`, `pokeUser`, `subscribeUser`, `unsubscribeUser`, `adminPatchUser`, `payFromWallet`, `tipUser`.
- **Components:** PostCard, VerifiedBadge, PresenceDot, UserBadges, FakePaymentSheet, AdSlot.
- **Navigates to:** `/leaderboard`, `/connections`, `/post/[id]`, `/profile`, `/pay/[id]`, `/chat/[id]`.

### `/[username]` — Vanity URL (`app/[username].tsx`)
- **Purpose:** Single-segment vanity handler that delegates to the user profile route.

---

## 5. Messaging, chat & calls

### `/messages` — Inbox (`app/(tabs)/messages.tsx`)
- **Purpose:** Conversations (DMs, marketplace, groups) with search and compose.
- **Sections/UI:** Floating top bar (new chat, search); encryption unlock banner; sections (direct/marketplace/group); new-DM modal; new-group modal (name + member chips); long-press delete/leave.
- **API:** `listConversations`, `searchUsers`, `getOrCreateConversation`, `createGroupChat`, `deleteConversation`.
- **Components:** RestrictionBanner, UnlockChatSheet. **Navigates to:** `/chat/[id]`.

### `/chat/[id]` — Thread (`app/chat/[id].tsx`)
- **Purpose:** 1:1 & group real-time encrypted chat with media, voice, forms, polls, tips, settings.
- **Sections/UI:** Header; message list (text/media/voice/file/place/post/contact/form/poll/tip bubbles); input bar + attachments; emoji/GIF pickers; voice recorder; search overlay; options (theme/disappear/clear); schedule-message modal; group rename; gallery; chat-summary modal.
- **API:** `listCustomEmojis`, `getPaymentsConfig`, `getWalletBalance`, `listConversations`, `listMessages`, `markConversationRead`, `setPresence`, `getPresence`, `getPost`, `reactToMessage`, `deleteMessage`, `pinMessage`, `summarizeConversation`, `editMessage`, `sendMessage` (text/gif/tip/file/contact/form/poll/media/place), `votePollMessage`, `listScheduledMessages`, `scheduleMessage`, `cancelScheduledMessage`, `transcribeVoiceMessage`, `setReadReceipts`, `scamCheckMessage`, `setConversationTheme`, `setDisappearing`, `patchGroupChat`, `clearConversation`, `ringCall`.
- **Components:** MediaGrid, RestrictionBanner, EmojiText, CustomEmojiSheet, VoiceMessage, RichText, LinkPreviewCard, QuoteCard, GifPickerSheet, ContactPickerSheet, FormPickerSheet, UnlockChatSheet, FakePaymentSheet.
- **Navigates to:** `/call/[id]`, `/encryption-key`.

### `/call/[id]` — Voice/video call (`app/call/[id].tsx`)
- **Purpose:** 1:1 LiveKit call. **Sections/UI:** Remote video fill; avatar when no video; local PiP; timer; mute/hang/camera controls. **API:** `callToken`.

### `/encryption-key` (`app/encryption-key.tsx`)
- **Purpose:** E2E key backup/restore with PIN (local crypto, `src/utils/e2e.ts`).

---

## 6. Map, places, directions & roadside

### `/` — Map (`app/(tabs)/index.tsx`)
- **Purpose:** Interactive map: search, place cards, hazard reports, reviews, controls.
- **Sections/UI:** MapboxWebView + search; place card sheet w/ reviews; FAB (locate, drop pin, hazard, roadside, layers); style picker; hazard markers; permission banner.
- **API:** `listPlaces`, `listRecents`, `listReviews`, `fsqMatch`, `upsertReview`, `addRecent`, `clearRecents`, `createPlace`, `deletePlace`, `listHazards`, `reportHazard`, `confirmHazard`, `dismissHazard`, `fsqSearch`.
- **Components:** MapboxWebView, SidebarMenuButton. **Navigates to:** `/directions`, `/place/[id]`, `/roadside`.

### `/directions` (`app/(tabs)/directions.tsx`)
- **Purpose:** Multi-stop routing, turn-by-turn voice nav, transit, roadside shortcuts.
- **Sections/UI:** Waypoint cards (swap/add/remove); profile chips (Drive/Walk/Cycle/Transit); alternate routes; toggles (tolls/motorway/ferry); nav banner w/ turn icons; speed-limit badge; map controls.
- **API:** `transitNearby`, `transitPlan`, `createEta`, `updateEta`, `stopEta`. **Navigates to:** `/wallet`, `/support`.

### `/eta/[shareId]` — ETA viewer (`app/eta/[shareId].tsx`)
- **Purpose:** Public live-location share via WebSocket (`/api/ws/eta/{shareId}`). **API:** `fetchPublicEta` + WS. **Navigates to:** `/login`.

### `/place/[id]` (`app/place/[id].tsx`)
- **Purpose:** Place/business page (Foursquare data, reviews, contact). **API:** `listReviews`, `listPlaces`, `fsqMatch`, `createPlace`, `deletePlace`, `upsertReview`. **Navigates to:** `/directions`.

### `/guide/[id]` (`app/guide/[id].tsx`)
- **Purpose:** Manage a saved guide (place collection) w/ public toggle + share. **API:** `listGuides`, `listPlaces`, `removePlaceFromGuide`, `addPlaceToGuide`, `patchGuide`.

### `/g/[slug]` — Public guide (`app/g/[slug].tsx`)
- **Purpose:** View + clone a shared guide. **API:** `getPublicGuide`, `clonePublicGuide`. **Navigates to:** `/login`.

### `/roadside` (`app/roadside.tsx`)
- **Purpose:** Request/provide roadside help (tow, lockout, battery, tire, gas); track, review, verify docs.
- **Sections/UI:** Tabs (request/nearby/helping/history); vehicle form; service select; location/destination; fuel; photo upload; before/after verification; quote; payment toggle; helper contacts; review/dispute modals; eligibility/verification gates.
- **API:** `roadsideActive`, `roadsideHelping`, `roadsideQuote`, `roadsideEligibility`, `roadsideVerification`, `roadsideHistory`, `roadsideNearby`, `checkRoadsidePhoto`, `checkRoadsideForm`, `createRoadside`, `editRoadside`, `acceptRoadside`, `verifyRoadside`, `addRoadsidePhotos`, `enrouteRoadside`, `arrivedRoadside`, `cancelRoadside`, `reviewRoadside`, `submitRoadsideVerification`.
- **Components:** CameraCapture. **Navigates to:** `/support`, `/account`, `/wallet`, `/chat/[id]`.

---

## 7. Communities, groups & circles

### `/groups` (`app/(tabs)/groups.tsx`)
- **Purpose:** Browse/create/join/leave groups. **API:** `listGroupsAll`, `createGroup`, `leaveGroup`, `joinGroup`, `deleteGroupNew`. **Navigates to:** `/group/[id]`.

### `/group/[id]` (`app/group/[id].tsx`)
- **Purpose:** Group hub — posts, events, media, rules, cover photo.
- **Sections/UI:** Cover (owner edit); banner (icon/name/members/join); tabs (discussion/events/media/about); pinned posts; feed; compose; event creation; rules editor; AdSlots.
- **API:** `getGroup`, `listGroupPosts`, `listGroupPins`, `groupEvents`, `leaveGroup`, `joinGroup`, `toggleLike`/`toggleRepost`/`toggleBookmark`/`toggleUnrepost`, `pinGroupPost`, `unpinGroupPost`, `createGroupEvent`, `rsvpGroupEvent`, `deleteGroupEvent`, `updateGroup`, `createPost`.
- **Components:** PostCard, PostComposer, AdSlot. **Navigates to:** `/group/[id]/members`, `/post/[id]`.

### `/group/[id]/members` (`app/group/[id]/members.tsx`)
- **Purpose:** Approve join requests, promote/demote/kick. **API:** `getGroup`, `listGroupMembers`, `listJoinRequests`, `promoteMember`, `demoteMember`, `kickMember`, `approveJoinRequest`, `rejectJoinRequest`.

### `/communities` (`app/communities.tsx`)
- **Purpose:** Your-feed / Discover communities, create, browse feed.
- **API:** `listCommunities`, `communitiesFeed`, `toggleLike`/`toggleDislike`/`toggleRepost`/`toggleBookmark`, `favoriteCommunity`, `unfavoriteCommunity`, `createCommunity`.
- **Components:** PostCard, CommentsSheet. **Navigates to:** `/c/[name]`.

### `/c/[name]` — Community (`app/c/[name].tsx`)
- **Purpose:** Reddit-style community: posts, threads, moderation, settings/rules/flairs.
- **Sections/UI:** Banner/icon/name/members/favorite/settings/join; description; rules/wiki cards; search; sort chips (hot/new/top/rising); flair filter; AdSlots; thread composer; settings editor.
- **API:** `getCommunity`, `communityPosts`, `toggleLike`/`toggleDislike`/`toggleRepost`/`toggleBookmark`, `leaveCommunity`, `joinCommunity`, `toggleJoin`, `favoriteCommunity`, `unfavoriteCommunity`, `createPost`, `updateCommunity`, `removeCommunityPost`.
- **Components:** PostCard, AdSlot, CommentsSheet. **Navigates to:** `/c/[name]/members`.

### `/c/[name]/members` (`app/c/[name]/members.tsx`)
- **Purpose:** Members + Top-karma tabs, mod actions. **API:** `getCommunity`, `communityMembers`, `communityTop`, `addCommunityMod`, `removeCommunityMod`, `removeCommunityMember`. **Navigates to:** `/[username]`, `/user/[name]`.

### `/circles` (`app/circles.tsx`)
- **Purpose:** Close-friends/audience circles for targeted posts. **API:** `listCircles`, `createCircle`, `circleMembers`, `searchUsers`, `updateCircle`, `deleteCircle`.

### `/favorites` — Library (`app/(tabs)/favorites.tsx`)
- **Purpose:** Saved places + guides w/ filters (All/Favorites/Pins). **API:** `listPlaces`, `listGuides`, `deletePlace`, `deleteGuide`, `createGuide`. **Navigates to:** map, `/guide/[id]`.

---

## 8. Marketplace & businesses

### `/marketplace` (`app/(tabs)/marketplace.tsx`)
- **Purpose:** Browse listings w/ search, category/condition/price/radius filters; create/edit.
- **API:** `listListings`, `listSavedListings`, `getListing`, `createListing`, `updateListing`, `myBusiness`, `likeListing`, `saveListing`, `unsaveListing`, `reportListing`, `startTrade`, `confirmTrade`, `contactSeller`, `deleteListing`.
- **Components:** ListingComments, VerifiedBadge, UserBadges, VerificationBadges, RestrictionBanner. **Navigates to:** `/listing/[id]`, `/my-marketplace`, `/business/[id]`, `/business`, `/chat/[id]`.

### `/my-marketplace` (`app/my-marketplace.tsx`)
- **Purpose:** Seller hub (personal/business profiles, listings/saved/reviews). **API:** `getSellerProfile`, `myBusiness`, `getBusiness`, `listSavedListings`, `listSellerReviews`, `listBusinessReviews`. **Navigates to:** `/marketplace`, `/business/[id]`, `/shop`, `/business`, `/listing/[id]`.

### `/my-listings` (`app/my-listings.tsx`)
- **Purpose:** Manage own listings (edit/sold/delete). **API:** `userListings`, `updateListing`, `deleteListing`. **Navigates to:** `/marketplace`, `/listing/[id]`, `/shop`, `/business`.

### `/listing/[id]` (`app/listing/[id].tsx`)
- **Purpose:** Listing detail (carousel, seller card, comments, trade verification).
- **API:** `getListing`, `likeListing`, `saveListing`, `unsaveListing`, `reportListing`, `updateListing`, `deleteListing`, `startTrade`, `confirmTrade`, `contactSeller`.
- **Components:** ListingComments, VerificationBadges, VerifiedBadge, UserBadges. **Navigates to:** `/chat/[id]`, `/seller/[id]`, `/business/[id]`, `/user/[name]`.

### `/seller/[id]` (`app/seller/[id].tsx`)
- **Purpose:** Seller storefront + reviews (write/verify). **API:** `getSellerProfile`, `listSellerReviews`, `addSellerReview`, `confirmTrade`. **Navigates to:** `/user/[name]`, `/listing/[id]`, `/shop`.

### `/business` (`app/business.tsx`)
- **Purpose:** Create/edit business storefront (branding, logo/banner, contact). **API:** `myBusiness`, `saveBusiness`, `deleteBusiness`, `updateMe`. **Navigates to:** `/business/[id]`.

### `/business/[id]` (`app/business/[id].tsx`)
- **Purpose:** Business storefront (listings, reviews). **API:** `getBusiness`, `listBusinessReviews`, `addBusinessReview`. **Navigates to:** `/business`, `/seller/[id]`, `/listing/[id]`.

### `/shop` (`app/shop.tsx`)
- **Purpose:** Customize personal storefront branding. **API:** `updateMe`.

---

## 9. Money, payments & wallet

### `/wallet` (`app/wallet.tsx`)
- **Purpose:** Balance, top-ups, payouts, earnings, transactions, payout frequency.
- **API:** `getWallet`, `getWalletBalance`, `getTopups`, `getSubscriptionTiers`, `getPaymentsConfig`, `getPayoutStatus`, `getPayouts`, `confirmTopup`, `syncTopups`, `runPayouts`, `exportWallet`, `updateMe`, `setCurrency`, `cancelTopup`, `cashoutToCard`, `stripeCardTopup`, `stripeTopup`.
- **Navigates to:** `/pay-qr`, `/money`, `/verify-payouts`, `/add-card`.

### `/money` (`app/money.tsx`)
- **Purpose:** Send/request money + transfer security question.
- **API:** `getMoneySecurity`, `listMoneyRequests`, `listMoneyTransfers`, `getWalletBalance`, `getPaymentsConfig`, `transferHistory`, `sendMoney`, `requestMoney`, `payMoneyRequest`, `acceptMoneyTransfer`, `declineMoneyTransfer`, `reverseMoneyTransfer`, `setMoneySecurity`, `declineMoneyRequest`, `cancelMoneyRequest`, `listFriends`, `searchUsers`.
- **Navigates to:** `/pay-scan`, `/pay-qr`, `/support`.

### `/pay/[id]` (`app/pay/[id].tsx`)
- **Purpose:** Send money to a user (QR-prefilled amount/note + security answer). **API:** `getPublicUser`, `getMoneySecurity`, `sendMoney`. **Navigates to:** `/money`.

### `/pay-qr` (`app/pay-qr.tsx`)
- **Purpose:** Show personal pay QR (amount/note, copy/share). **Components:** QrCode. **Navigates to:** `/pay-scan`.

### `/pay-scan` (`app/pay-scan.tsx`)
- **Purpose:** Scan/paste a pay link. **Components:** expo-camera CameraView. **Navigates to:** `/pay/[id]`.

### `/add-card` (`app/add-card.tsx`)
- **Purpose:** Add debit card for instant payouts (Stripe). **API:** `getPayoutStatus`, `addDebitCard`, `mountDebitCardField`. **Navigates to:** `/wallet`.

### `/add-bank` (`app/add-bank.tsx`)
- **Purpose:** Add bank account for standard payouts. **API:** `getPayoutStatus`, `addBankAccount`, `tokenizeBankAccount`. **Navigates to:** `/wallet`.

### `/verify-payouts` (`app/verify-payouts.tsx`)
- **Purpose:** Identity verification for payouts (name, DOB, address, ID#, ID upload). **API:** `getPayoutRequirements`, `submitVerification`, `uploadVerificationDocument`. **Components:** DatePickerField. **Navigates to:** `/wallet`.

---

## 10. Monetization & advertising

### `/monetize` (`app/monetize.tsx`)
- **Purpose:** Publisher network — register sites, view ad earnings, copy embed snippet. **API:** `getPubSites`, `createPubSite`, `deletePubSite`.

### `/advertise` (`app/advertise.tsx`)
- **Purpose:** Campaigns — promote posts, link ads, reel video ads, prepaid ad balance.
- **API:** `listUserPostsAll`, `getCampaigns`, `getAdAccount`, `getLinkAds`, `getReelAds`, `getPaymentsConfig`, `createLinkAd`, `deleteLinkAd`, `createReelAd`, `deleteReelAd`, `topupAdAccount`, `promotePost`.

---

## 11. Games, forms & documents

### `/games` (`app/games.tsx`)
- **Purpose:** Browse/upload games (Three.js or hosted URL) with SDK leaderboards. **API:** `listGames`, `createGame`. **Navigates to:** `/game/[id]`.

### `/game/[id]` (`app/game/[id].tsx`)
- **Purpose:** Fullscreen play + leaderboard modal. **API:** `gameLeaderboard`, `recordGamePlay`, `submitGameScore`. **Components:** GameWebView.

### `/forms` (`app/forms.tsx`)
- **Purpose:** List/create custom forms. **API:** `listForms`, `createForm`. **Navigates to:** `/forms/[id]`.

### `/forms/[id]` (`app/forms/[id].tsx`)
- **Purpose:** Form builder — Build / Share (embed+preview) / Responses (CSV export).
- **API:** `getForm`, `updateForm`, `deleteForm`, `listFormSubmissions`, `exportFormCsv`. **Components:** SignatureImage. **Navigates to:** `/f/[key]`.

### `/f/[key]` — Public form (`app/f/[key].tsx`)
- **Purpose:** Fill a public form (text/email/phone/date/select/radio/checkbox/rating/signature/photo/payment/consent/address). **API:** `publicForm`, `submitPublicForm`. **Components:** SignaturePad, DatePickerField.

### `/documents` (`app/documents.tsx`)
- **Purpose:** Verification hub (ID/email/phone/roadside status) + submit insurance/ownership docs for AI check. **API:** `roadsideVerification`, `submitRoadsideVerification`. **Navigates to:** `/account`, `/profile`, `/wallet`, `/privacy`, `/support`.

---

## 12. Developer / API platform

### `/developer` (`app/developer.tsx`)
- **Purpose:** Developer console — interactive API docs, keys, OAuth apps, webhooks, plan/usage.
- **API:** `listApiKeys`, `createApiKey`, `revokeApiKey`, `listOAuthApps`, `createOAuthApp`, `deleteOAuthApp`, `listWebhooks`, `createWebhook`, `testWebhook`, `deleteWebhook`, `listWebhookDeliveries`, `redeliverWebhook`, `listWebhookEvents`, `getApiPlan`, `getApiUsage`, `apiPlanCheckout`, `apiPlanActivate`, `buyUsage`, `activateUsage`.

### `/connected-apps` (`app/connected-apps.tsx`)
- **Purpose:** View/revoke OAuth apps with account access. **API:** `getConnections`, `revokeConnection`.

### `/oauth/authorize` (`app/oauth/authorize.tsx`)
- **Purpose:** OAuth consent screen (scopes, approve/deny). **API:** `getOAuthApp`, `oauthAuthorize`. Redirects back to the app via `window.location`/`Linking`.

---

## 13. Profile customization & settings

### `/settings` (`app/settings.tsx`)
- **Purpose:** Central hub — Account, Security, Your content, Creator tools, App, Legal, Admin; destructive (delete all posts / sign out).
- **API:** `supportUnreadCount`, `deletePostsBulk`. **Components:** FadeIn, PressableScale, ConfirmModal.
- **Navigates to:** `/profile`, `/account`, `/privacy`, `/notifications`, `/documents`, `/bookmarks`, `/favorites`, `/connections`, `/circles`, `/forms`, `/games`, `/monetize`, `/advertise`, `/developer`, `/connected-apps`, `/customize-nav`, `/customize-sidebar`, `/support`, `/legal/terms`, `/legal/privacy`, `/admin-settings`, `/login`.

### `/account` (`app/account.tsx`)
- **Purpose:** Email, password, phone, ID verification, 2FA.
- **API:** `sendEmailCode`, `verifyEmailCode`, `changeEmail`, `startIdentityVerification`, `identityStatus`, `changePassword`, `sendPhoneCode`, `verifyPhoneCode`, `setPhone`, `setTwofa`, `updateMe`.

### `/privacy` (`app/privacy.tsx`)
- **Purpose:** Privacy/visibility (private account, discoverability, DM policy, likes/comment/story visibility). **API:** `updateMe`. **Navigates to:** `/muted-words`, `/encryption-key`.

### `/customize-nav` (`app/customize-nav.tsx`)
- **Purpose:** Pick/reorder/remove bottom-tab shortcuts (3–5; Profile locked). Local persistence (`NavBarContext`).

### `/customize-sidebar` (`app/customize-sidebar.tsx`)
- **Purpose:** Pick/reorder/remove sidebar shortcuts (Feed + Settings locked). Local persistence (`SidebarMenuContext`).

### `/leaderboard` (`app/leaderboard.tsx`)
- **Purpose:** Activity-points leaderboard (rank, level, title, points). **API:** `pointsLeaderboard`. **Components:** AvatarFrame. **Navigates to:** `/[username]` / `/user/[name]`.

---

## 14. Support & legal

### `/support` (`app/support.tsx`)
- **Purpose:** User tickets + create new (7 categories), deep-link related items. **API:** `myTickets`, `createTicket`. **Navigates to:** `/support/[id]`, `/admin-support` (staff).

### `/support/[id]` (`app/support/[id].tsx`)
- **Purpose:** Ticket thread + status management + reply. **API:** `getTicket`, `replyTicket`, `setTicketStatus`.

### `/legal/[doc]` (`app/legal/[doc].tsx`)
- **Purpose:** Render ToS / Privacy (version-synced to backend). Static.

---

## 15. Auth & system routes

### `/login` (`app/login.tsx`)
- **Purpose:** Sign in / sign up / password reset (email & SMS) / phone OTP / 2FA / saved-account quick-login.
- **API:** `loginLocal`, `registerLocal`, `forgotPassword`, `forgotPasswordSms`, `resetPassword`, `resetPasswordCode`, `login2fa`, `loginPhoneStart`, `loginPhoneVerify`. **Navigates to:** home (first nav shortcut), `/legal/terms`, `/legal/privacy`.

### `/auth` (`app/auth.tsx`)
- **Purpose:** Post-Stripe-callback session refresh (if `session_id`), else route home/login. **API:** `refresh`.

### `/index` (`app/index.tsx`)
- **Purpose:** Root splash loader → user's customized home or `/login`.

### `/+not-found` (`app/+not-found.tsx`)
- **Purpose:** 404 fallback (single-segment paths go to `[username]` instead). **Navigates to:** `/`.

---

## 16. Web platform behavior (PC gate, service worker)

- **PC gate:** `src/components/MobileOnlyGate.tsx` — a non-touch (mouse) web client + server `mobile_only` flag → renders `src/components/DesktopBlockedScreen.tsx` ("open on your phone", QR to okayspace.ca, store badges) instead of the app. Native + phone browsers always pass; **fails open** on config error. Backend flag defaults **on** (`backend/routes/meta.py` `/public/app-config`; admin toggle `/admin/mobile-only`). Store-badge URLs are placeholder constants in `DesktopBlockedScreen.tsx`.
- **Service worker:** the app ships **no** SW; `public/sw.js` + `public/service-worker.js` are *self-destructing neutralizers* that kill the old PWA worker. The boot script in `app/+html.tsx` unregisters stale workers + clears caches with a loop-proof one-time reload (fixed the reload loop).
- **Web shims:** `WebNavGuard` (refresh/devtools), `WebPullToRefresh`, `webAlertShim.ts`, `webUpdate.ts` (build-token tracker, no auto-reload).

---

## 17. Admin suite (`app/admin-*.tsx`)

Entry point: **`/admin-settings`** (hub, grouped by Moderation / Money & growth / System / Staff).

### `/admin-users` (`app/admin-users.tsx`)
- **Purpose:** Search users; verify/ban/suspend/restrict; roles; wallet; transactions; badges.
- **API:** `adminListUsers`, `adminPatchUser`, `adminUnbanUser`, `adminSetRestrictions`, `adminSetWallet`, `adminListTransactions`, `adminAddTransaction`, `adminEditTransaction`, `adminDeleteTransaction`, `adminBanUser`, `adminSuspendUser`, `listBadges`, `getPublicUser`, `adminSetUserBadge`. **Navigates to:** `/admin-audit`.

### `/admin-payments` (`app/admin-payments.tsx`)
- **Purpose:** Test/live toggle; **mobile-only toggle** + force web update; revenue; fees/split; data resets.
- **API:** `adminGetTestPayments`, `adminSetTestPayments`, `adminGetFees`, `adminSetFees`, `adminGetRevenue`, `adminGetMobileOnly`, `adminSetMobileOnly`, `adminGetWebBuild`, `adminBumpWebBuild`, `adminResetMoney`, `adminResetAnalytics`.

### `/admin-revenue` (`app/admin-revenue.tsx`)
- **Purpose:** Ad revenue analytics (cut, spend, impressions, clicks, CTR, payouts, top earners/advertisers). **API:** `getAdRevenue`.

### `/admin-audit` (`app/admin-audit.tsx`)
- **Purpose:** Admin-action audit log. **API:** `adminAuditLog`.

### `/admin-bot` (`app/admin-bot.tsx`)
- **Purpose:** Simulate ad traffic on sponsored posts (views/clicks/likes/comments → earnings). **API:** `getBotPosts`, `runBot`. **Navigates to:** `/wallet`.

### `/admin-badges` (`app/admin-badges.tsx`)
- **Purpose:** Create/delete custom badges. **API:** `listBadges`, `adminCreateBadge`, `adminDeleteBadge`. **Components:** UserBadges.

### `/admin-integrations` (`app/admin-integrations.tsx`)
- **Purpose:** Integration status (Stripe, Mapbox, Cloudinary, Tenor, email, SMS…), live tests, env vars, fixes. **API:** `adminIntegrations`.

### `/admin-render` (`app/admin-render.tsx`)
- **Purpose:** Render hosting ops — deploy/restart/suspend/resume, env vars, deploy history.
- **API:** `renderServices`, `renderDeploys`, `renderEnvVars`, `renderTriggerDeploy`, `renderRestart`, `renderSuspend`, `renderResume`, `renderSetEnv`, `renderDeleteEnv`.

### `/admin-settings` (`app/admin-settings.tsx`)
- **Purpose:** Admin/staff tool hub. **Navigates to:** all `admin-*` screens.

### `/admin-support` (`app/admin-support.tsx`)
- **Purpose:** Staff ticket queue (filter by status). **API:** `adminTickets`. **Navigates to:** `/support/[id]`.

### `/admin-roadside` (`app/admin-roadside.tsx`)
- **Purpose:** Manual review of roadside verification docs (approve/reject). **API:** `adminRoadsideVerifications`, `decideRoadsideVerification`. **Navigates to:** `/admin-roadside-calls`.

### `/admin-roadside-calls` (`app/admin-roadside-calls.tsx`)
- **Purpose:** Create/list/manage roadside calls; search; bulk delete test data. **API:** `adminListRoadsideCalls`, `adminCreateRoadsideCall`, `adminDeleteRoadsideCall`, `adminEraseRoadsideCalls`.

---

# Part II — Internals (components, state, libs, API, backend)

## 18. Component reference (`src/components/`)

**Posts & feed**
- **PostCard** — the workhorse newsfeed card. Renders author avatar/name/badges, timestamp, repost/pinned banner, listing title, flair, text (via RichText), media (MediaGrid), embeds/inline images, link preview, poll, place, factcheck. Action row: reply, repost(+quote), heart with **emoji-reaction picker**, views (owner). Overflow menu + long-press → More. Handles **subscriber paywalls** for locked posts, optimistic reaction state, report/not-interested, share-to-chat, likers/reposters & viewers modals. Props: `post`, `viewerId`, `disableOpen`, and callbacks (`onLike/onDislike/onRepost/onQuote/onReply/onComments/onBookmark/onMore/onPollUpdated/onOpen`). Uses `reactToPost`, `reportPost`, `notInterested`, `postAnalytics`.
- **PostComposer** — full creation/edit/reply/quote modal. Text (≤500) with **@mention autocomplete** (`searchUsers`), media picker (≤4, Cloudinary/base64, 25 MB), camera, reel-link resolver (`resolveVideoLink`), **poll mode** (2+ options, 1h–7d), likes toggle, comment policy, **subscriber-tier** selector, privacy/circles audience, **thread mode** (≤9 self-replies), **drafts** (list/create/update/delete), group posting. Uses `createPost`, `editPost`, `createGroupPost`, draft APIs, `listCircles`.
- **CommentsSheet** — TikTok-style comments bottom sheet: nested replies, animated heart likes, edit/pin(owner)/delete, "read before reply" gate on link posts (20s or click-through), GIF picker. Uses `postThread`, `createPost`, `editPost`, `deletePost`, `toggleLike/Dislike`, `pinPost`.
- **PostPrivacySheet** — per-post likes on/off + comment policy; saves live via `editPostPrivacy`.
- **PollCard** — vote, result bars, countdown; `votePoll`.
- **QuoteCard** — compact quoted-post preview → `/post/[id]`.
- **MediaGrid** — 1/2/3/4+ responsive media layout with lightbox + inline/Reels video.
- **StoryTray** — horizontal story rail (own + others), create via picker → Cloudinary; `storiesTray`, `createStory`.
- **LikersModal** — who liked/reposted (`listPostLikers`/`listPostReposters`).
- **PostViewersModal** — who viewed (owner only; `getPostViewers`).
- **FactcheckSheet** — community notes: view/rate/add with sources; `listFactchecks`, `rateFactcheck`, `addFactcheck`.
- **PostSkeleton / Skeleton** — shimmer loading placeholders.
- **AdSlot** — native sponsored posts / link ads with impression+click tracking, hide/report; `getNextAd`, `adEvent`, `linkAdEvent`, `hideAd`, `reportAd`.

**Text & media helpers**
- **RichText** — auto-links #hashtags → `/hashtag/[tag]`, @mentions → `/user/[name]`, URLs → browser.
- **EmojiText** — substitutes `:shortcode:` custom emojis (falls back to RichText).
- **InlineMedia** — tappable inline image/GIF.
- **EmbedCard** — YouTube/Twitch/Vimeo iframe (web) / WebView (native).
- **LinkPreviewCard** — OG-style external link card.
- **ReelVideo** (+`.web`) — native expo-video / web `<video>` reel player with poster.
- **ReelPoster** — reel cover (custom thumb / branded / black).
- **VoiceMessage** — voice-note bubble (expo-audio) with play/progress/duration.

**Chat & sheets**
- **GifPickerSheet** (Tenor), **CustomEmojiSheet** (browse/upload custom emoji), **ContactPickerSheet** (share a user as contact), **FormPickerSheet** (share a form), **ShareToChatSheet** (send post to DMs/groups or native share), **UnlockChatSheet** (enter PIN to restore E2E key), **FakePaymentSheet** (card/wallet pay, test vs live Stripe, fee breakdown).

**Identity & trust**
- **VerifiedBadge** (blue check), **UserBadges** (custom badges, ≤4), **VerificationBadges** (ID/phone/email chips), **PresenceDot** (+`presenceLabel`), **ProfileDecor** (`AvatarFrame` gradient ring + `ProfileBackground` gradient), **UserRow** (list row with follow/friend buttons).

**Navigation & shells**
- **LiquidTabBar** — floating frosted bottom pill; scroll-hide; customizable; long-press → customize. **DesktopShell** — desktop 3-column (left rail + content + right rail trending/leaderboard). **LeftSidebar** — slide-in drawer (profile, shortcuts, notif badge, refresh/logout). **MobileFrame** — passthrough `<View flex:1>`. **EdgeSwipe** — edge drag back/forward (mobile). **ChatFab** — floating chat button (side-toggle). **MobileOnlyGate** / **DesktopBlockedScreen** — §16 PC gate. **WebNavGuard** / **WebPullToRefresh** — web shims.

**Gates & feedback**
- **UsernameGate** (force username), **PolicyGate** (force ToS), **RestrictionBanner** (posting/messaging/marketplace disabled → dispute), **AppErrorBoundary** (recoverable error screen), **ConfirmModal** (in-app confirm).

**Inputs & misc**
- **BirthdayPicker / DatePickerField** (column pickers → YYYY-MM-DD), **SignaturePad** (draw → SVG data URI) / **SignatureImage** (render), **CameraCapture** (photo modal → Cloudinary), **QrCode** (pure-JS QR with optional logo), **MapboxWebView** (imperative map: markers/route/flyTo/traffic/3D/hazards), **GameWebView** (Games SDK bridge), **ListingComments** (marketplace comment thread), **BouncyPressable / PressableScale** (spring press), **FadeIn** (mount animation), **PushManager** (`.native` push token; web no-op), **call/VideoTile** (`.native` LiveKit tile; web no-op).

---

## 19. State & contexts (`src/context/`)

- **AuthContext** (`useAuth`) — `loading`, `user`, `signOut()`, `applySessionToken()`, `refresh()`, `loginLocal()`, `registerLocal()`. Restores `SESSION_TOKEN_KEY` from secure storage → `me()`; 50s presence heartbeat (`presencePing`); parses OAuth-redirect/deep-link tokens; ensures E2E keypair after login. Calls `me`, `logout`, `loginLocal`, `registerLocal`, `unregisterPush`.
- **ConfirmContext** (`useConfirm`) — `confirm(options) → Promise<boolean>`; renders ConfirmModal.
- **NavBarContext** (`useNavBar`) — bottom-tab state: `ids`, `shortcuts`, `add/remove/move/reset/setIds`, `canAdd/canRemove/lockedIds`, plus `tabBarHidden`, `fabLift`, `fabHidden`. Persists `nav_bar_tabs_v1` in AsyncStorage; Profile locked; 3–4 tabs.
- **NavHistoryContext** (`useNavHistory`) — browser-style `goBack()/goForward()/canForward`; pathname stack over expo-router.
- **SidebarContext** (`useSidebar`) — desktop sidebar `open`/`setOpen` (memoized).
- **SidebarMenuContext** (`useSidebarMenu`) — sidebar items: `ids`, `items`, `add/remove/move/reset`, `canAdd/canRemove/lockedIds`. Persists `sidebar_menu_v1`; Feed + Settings locked; ≤5 items.

---

## 20. Hooks (`src/hooks/`)

- **useIconFonts** → `[loaded, error]` — loads icon fonts from CDN only under Expo Go.
- **useFloatingHeader** → `{topHidden, topBarH, setTopBarH, onScroll, barStyle, barPointerEvents}` — frosted top bar that hides on scroll-down.
- **useIsDesktop** → `boolean` — web ≥900px breakpoint; only flips on boolean change (avoids width-jitter re-render loops — the bug fixed earlier).
- **useKeyboardHeight** → `number` — web visualViewport keyboard overlap for fixed sheets (0 on native).

---

## 21. Libraries & utilities (`src/lib/`, `src/utils/`, `src/api/`)

**`src/lib/`**
- **ads** — `interleaveAds()`/`isAd()` weave ad markers into feeds. **avatars** — DiceBear deterministic avatars. **editProfileIntent** — in-memory "open editor" signal. **emojiData** — `EMOJI_CATEGORIES`. **glass** — frosted-glass style. **points** — `POINTS_TIERS`/`levelInfo()` (Newcomer→Mythic). **pricing** — Apple 30% fee gross-up (`withAppleFee`). **profileCustomize** — accents/themes/frames/backgrounds + link helpers. **savedAccounts** — Facebook-style saved profiles, 7-day re-auth. **socials** — `SOCIAL_PLATFORMS` + URL builders + `fmtBirthday`. **stripeEmbed** — inline (web) / hosted (native) Stripe: checkout, card pay, topups, debit card, bank, payouts. **webAlertShim** — fixes RN-Web `Alert.alert`. **webUpdate** — build-token tracker (no auto-reload).

**`src/utils/`**
- **e2e** — NaCl box E2E for DMs (X25519/XSalsa20-Poly1305) + passphrase key backup/restore. **embeds** — detect YouTube/Twitch/Vimeo + imgur/giphy. **livekitNative** — native audio setup (`.native`; web no-op). **nav** — `safeBack()` with fallback. **share** — canonical links + native share/clipboard. **thumbnail** — image/video pick + Cloudinary/base64. **storage/** — AsyncStorage (KV) + SecureStore (tokens) wrapper.

**`src/api/`**
- **cloudinary** — unsigned CDN uploads for large media. **gifs** — Tenor v2 search (`GIFS_ENABLED`). **mapbox** — geocode (forward/reverse), directions w/ steps, category search.

---

## 22. API surface by domain (`src/api/client.ts`)

Bearer-token auth auto-injected when a session token is present; all endpoints under `/api`; `BASE_URL` is environment-configurable. ~425 methods:

- **Auth:** me, logout, registerLocal, loginLocal, login2fa, setTwofa, loginPhoneStart/Verify, forgotPassword(+Sms), resetPassword(+Code), usernameAvailable, setUsername, changeEmail/Password, setPhone, send/verifyPhoneCode, send/verifyEmailCode, updateMe, acceptPolicies, getPolicies.
- **Users/Follows/Friends:** getPublicUser, searchUsers, recordProfileView, listFollowers/Following, toggleFollow, unfollowBulk, listFriends/FriendRequests, send/cancel/accept/rejectFriend, unfriend, pokeUser.
- **Posts/Feed:** createPost, editPost, editPostPrivacy, deletePost(+Bulk), getPost, listUserPosts(All)/Replies/Reposts/Likes, homeFeed, exploreFeed, toggleLike/Dislike, reactToPost, toggleRepost, toggleBookmark, listBookmarks, listPostLikers/Reposters, recordPostView, notInterested, pinPost, promotePost, drafts (list/create/update/delete).
- **Comments/Factchecks:** listReplies, postThread, add/rate/delete/listFactchecks.
- **Stories/Reels/Polls:** createStory, storiesTray, listUserStories, viewStory, listStoryViewers, deleteStory, replyToStory, reelsFeed, popularReels, votePoll.
- **Notifications/Search:** listNotifications, listActivity, unreadNotificationsCount, mark(All)NotificationRead, deleteNotification, trendingHashtags, popularPosts, hashtagPosts, hashtagCount.
- **Communities:** list/get/create/updateCommunity, add/removeCommunityMod, communityMembers/Top, removeCommunityMember/Post, pinCommunityPost, join/leave/favorite/unfavoriteCommunity, communityPosts, communitiesFeed.
- **Groups:** listGroupsAll, create/join/leave/deleteGroupNew, getGroup, listGroupPosts, createGroupPost, listGroupMembers, updateGroup, groupEvents, create/rsvp/deleteGroupEvent, listGroupPins, pin/unpinGroupPost, promote/demote/kickMember, listJoinRequests, approve/rejectJoinRequest.
- **Circles:** list/create/update/deleteCircle, circleMembers.
- **Messaging:** getOrCreateConversation, listConversations, delete/clearConversation, listMessages, sendMessage, markConversationRead, set/getPresence, edit/delete/pinMessage, listPinnedMessages, summarizeConversation, reactToMessage, votePollMessage, schedule/list/cancelScheduledMessage, transcribeVoiceMessage, setReadReceipts, scamCheckMessage, setConversationTheme, setDisappearing, create/patch/leaveGroupChat, list/create/deleteCustomEmoji.
- **Calls/Push:** callToken, ringCall, presencePing, register/unregisterPush.
- **Map/Places/Guides/Transit/ETA:** listPlaces, getPlace, create/deletePlace, listGuides, create/patch/deleteGuide, add/removePlaceFromGuide, getPublicGuide, clonePublicGuide, listReviews, upsertReview, deleteReview, fsqMatch, fsqSearch, listRecents, add/delete/clearRecents, listHazards, report/confirm/dismissHazard, transitNearby, transitPlan, createEta, updateEta, stopEta, fetchPublicEta.
- **Roadside:** roadsideQuote/Eligibility/Verification, submitRoadsideVerification, roadsideActive/Helping/Mine/Nearby, create/edit/get/acceptRoadside, enroute/arrivedRoadside, addRoadsidePhotos, verifyRoadside, cancelRoadside, roadsideHistory, review/disputeRoadside, checkRoadsideForm/Photo (+ admin variants).
- **Marketplace/Business:** listListings, listSavedListings, userListings, getListing, create/update/save/unsave/deleteListing, contactSeller, likeListing, reportListing, listingComments, add/edit/like/deleteListingComment, getSellerProfile, myBusiness, get/save/deleteBusiness, list/addBusinessReview, list/addSellerReview, start/confirmTrade.
- **Money/Wallet/Payments:** getWallet, getWalletBalance, listCurrencies, setCurrency, syncTopups, getTopups, cancelTopup, getActivity, exportWallet, getMoneySecurity/setMoneySecurity, sendMoney, listMoneyTransfers, accept/decline/reverseMoneyTransfer, transferHistory, requestMoney, listMoneyRequests, pay/decline/cancelMoneyRequest, create/confirmPayIntent, createCheckout, topupWallet, confirm(Topup/TopupIntent), createTopupIntent, payFromWallet, cashoutToCard, addDebitCard, addBankAccount, getPaymentsConfig, setupPayouts, getPayoutStatus/Requirements, submitVerification, uploadVerificationDocument, payoutAccountSession, start/identityStatus, getSubscriptionTiers, subscribe/unsubscribeUser, tipUser.
- **Ads/Monetization:** getNextAd, adEvent, linkAdEvent, create/get/deleteLinkAd, create/get/deleteReelAd, serveReelAd, reelAdEvent, create/get/deletePubSite, hideAd, reportAd, getCampaigns, getAdAccount, topupAdAccount, getAdRevenue, getBotPosts, runBot, getPayouts, runPayouts.
- **Games/Forms:** listGames, create/get/deleteGame, submitGameScore, gameLeaderboard, recordGamePlay, listForms, create/get/update/deleteForm, listFormSubmissions, exportFormCsv, publicForm, submitPublicForm.
- **Support/Points/Badges:** create/myTickets, getTicket, replyTicket, setTicketStatus, adminTickets, supportUnreadCount, pointsLeaderboard, listBadges, admin create/delete/setUserBadge.
- **Developer/OAuth/Webhooks/E2E:** list/create/revokeApiKey, getApiPlan, apiPlanCheckout/Activate, getApiUsage, buy/activateUsage, listWebhookEvents, list/create/test/deleteWebhook, listWebhookDeliveries, redeliverWebhook, create/list/delete/getOAuthApp, getConnections, revokeConnection, oauthAuthorize, upload/getUserE2EKey, upload/get/deleteE2EBackup.
- **Admin/Render/Meta:** adminListUsers, adminPatchUser, adminBan/Unban/Suspend/RemoveUser, adminSetRestrictions, adminSetWallet, admin add/list/edit/deleteTransaction, adminAuditLog, adminGet/SetTestPayments, adminResetMoney/Analytics, adminGetRevenue, adminGet/SetMobileOnly, adminGet/BumpWebBuild, adminGet/SetFees, adminIntegrations, render Services/Deploys/TriggerDeploy/Restart/Suspend/Resume/EnvVars/SetEnv/DeleteEnv, getPublicAppConfig.

---

## 23. Backend (`backend/`)

**Framework:** FastAPI (async). **Storage:** PostgreSQL with a JSONB document wrapper (`db.py`) presenting a Mongo/Motor-compatible API — each table has a single JSONB `doc` column + unique indexes. **API base:** `/api/v1` (stable) with `/api` legacy alias. **Auth:** `Authorization: Bearer <session_token | api_key>`. **Writes** accept an optional `Idempotency-Key` (replays the prior response on retry). **API keys** are read-only (blocked from non-GET). **CORS** open.

**Top-level files:** `server.py` (app setup, middleware, router registration, websockets, startup/shutdown), `core.py` (DB proxy, `get_current_user`, badges/moderation, `award_points`, helpers), `db.py` (Postgres JSONB wrapper), `models.py` (Pydantic models).

### Route files (`backend/routes/`)

- **auth.py** (`/auth`) — register, login, 2FA (`/login/2fa`), phone login (`/login/phone/start|verify`), logout, forgot/reset password (email + SMS), username availability/change (30-day cooldown), change email/password/phone, email/phone verification codes, `/auth/me` GET+PATCH, accept-policies, **API keys** (create/list/revoke), **E2E keys** (`/auth/keys`, `/users/{id}/key`, `/auth/keys/backup`), `/users/by-username/{username}`.
- **users.py** (`/admin`) — admin user management: patch (verified/role), list/search, ban/unban, suspend, restrictions (messaging/marketplace/posting), wallet balance get/adjust, transactions list/add, subscriptions, `/admin/audit`.
- **posts.py** (`/posts`) — create/edit/delete, privacy patch, get-with-replies, `feed` + `feed/trending`, user posts, like/unlike, bookmark, repost/unrepost, viewers (record + list), search, `hashtag/{tag}`, report, hide, emoji react/unreact, `/media/resolve-video`.
- **messaging.py** (`/conversations`) — get/create DM, create group, list, patch group (name/avatar/theme/receipts/disappearing), leave, add/remove members, soft-delete, messages (list/send/edit/delete), reactions, read receipts, typing (WS), custom emojis. Features: optional E2E, disappearing TTL, link previews, scheduled dispatch.
- **notifications.py** (`/notifications`) — list, `activity` timeline, unread count, mark read / read-all. Types: like/repost/reply/message/group_invite/friend_*/poke/money/tip/subscribe/factcheck; important ones mirrored to SMS if opted in.
- **eta.py** (`/eta`) — start/update/stop share, `/public/eta/{id}` (no auth), **WebSocket `/ws/eta/{id}`** live pub/sub.
- **places.py** (`/places`, `/recents`) — saved places CRUD; recent searches (auto-prune 20).
- **guides.py** (`/guides`) — guide CRUD, add/remove place, `/public/guides/{slug}`; publishing auto-posts a feed announcement.
- **reviews.py** (`/reviews`) — place reviews upsert/list/delete (1–5★).
- **circles.py** (`/circles`) — close-friends circles CRUD + members (≤50).
- **drafts.py** (`/drafts`) — post drafts CRUD (cap 50, auto-prune).
- **stories.py** (`/stories`) — create (image/video ≤15s), tray, by-user, view, viewers, reply (→DM), delete; earns points.
- **marketplace.py** (`/listings`) — listings CRUD + search (category/radius/price/sort), save/unsave, comments, **trades** (propose/confirm via code), reviews (verified-trade only), business storefronts; min account age 14 days.
- **groups.py** (`/groups`) — groups CRUD, members, join/leave + join-request approval, posts (+pin), events.
- **communities.py** (`/communities`) — Reddit-style: CRUD, `feed`, join/leave, favorite, members, posts (newest/top/hot), pin/remove (mod), mods add/remove, member removal, `top`; banned-keyword auto-moderation.
- **foursquare.py** (`/foursquare`) — place search + match (hours/phone/rating enrichment).
- **transit.py** (`/transit`) — nearby stops + route plan (TransitLand).
- **payments.py** (`/payments`) — Stripe config, Connect onboarding, payout status, cashout (7-day anti-fraud hold), debit-card update, checkout (destination charge), **webhook** (`session.completed` → credit wallet); admin test-mode.
- **payouts.py** (`/payouts`) — earnings/balance/history/schedule; admin run loop.
- **money.py** (`/money`) — P2P: security question get/set, send, transfers history + pending, accept/decline/cancel.
- **ads.py** (`/promoted`, `/admin/ad-revenue`) — serve next ad, log events, hide/report, admin revenue breakdown.
- **adnetwork.py** (`/pub/sites`, `/pub/ad`, `/pub/click`) — advertiser sites CRUD, ad creative fetch, click logging.
- **calls.py** (`/calls`) — LiveKit room token + ring notification.
- **push.py** (`/push`) — device register/unregister (ios/android/web).
- **support.py** (`/support`) — tickets create/list/get, reply, unread count.
- **forms.py** (`/forms`) — form builder CRUD, public submit, responses CSV export (webhooks triggered on submit).
- **factchecks.py** (`/posts/{id}/factchecks`) — community notes: create (source required), list, rate, delete; consensus auto-show.
- **hazards.py** (`/hazards`) — Waze-style report/list (radius), confirm/dismiss; consensus clustering.
- **games.py** (`/games`) — upload/list/get/delete, score submit, leaderboard; SDK at `/pub/games/sdk.js`.
- **embed.py** (`/pub`, no auth) — oEmbed cards for post/profile/listing/guide/community.
- **oauth.py** (`/oauth`) — "Login with OkaySpace" provider: apps CRUD, authorize (code grant), token exchange, `/oauth/me`, revoke, connections list/disconnect.
- **webhooks.py** (`/webhooks`) — event types, CRUD, test ping, delivery history; HMAC-SHA256 signed.
- **integrations.py** (`/admin/integrations`) — admin integration status/config.
- **roadside.py** (`/roadside`) — eligibility/photo check, quote, request (daily call number), verification, requests list, rate provider.
- **render_admin.py** (`/admin/render`) — Render ops: services, deploys (list/trigger), restart, suspend.
- **meta.py** (`/`, public) — `/public/app-config` (mobile-only gate + web-build token), `/version`, `/v1/info`, `/v1/changelog`.

### Background services (startup)
- **Keepalive loop** — pings `/health` every 10 min (prevents Render free-tier spindown).
- **OkayBots** — seeds `@OkayAI` / `@OkayFacts`, runs an Ollama reply loop.
- **Message scheduler** — dispatches scheduled messages.
- **Payout loop** — hourly best-effort auto-payouts above threshold.
- **Avatar backfill** — one-time default-avatar assignment.

### Error envelope
All non-2xx responses share: `{ "error": { "code", "message", "fields?" }, "detail": {...} }` with codes like `bad_request`, `unauthorized`, `payment_required`, `forbidden`, `not_found`, `conflict`, `validation_error`, `rate_limited`, `server_error`.

---

## Quick "where is it?" cheat-sheet

| Looking for… | Go to |
|---|---|
| A screen / route | `frontend/app/<name>.tsx` (folder = nested route) |
| Bottom-tab definitions | `src/context/NavBarContext.tsx` → `NAV_CATALOG` |
| Sidebar menu | `src/components/LeftSidebar.tsx` + `SidebarMenuContext` |
| Any backend call | `src/api/client.ts` (~425 methods) |
| Global app wiring / gates | `app/_layout.tsx` |
| Reusable UI | `src/components/` |
| Global state | `src/context/` |
| Backend endpoints | `backend/routes/` |
| Web shell / boot script | `app/+html.tsx` |
