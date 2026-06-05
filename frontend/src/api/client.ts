import { storage } from "@/src/utils/storage";

// Base URL of the backend.
// - Native: must be set (EXPO_PUBLIC_BACKEND_URL) — there's no same-origin.
// - Web (local dev): leave it empty so the Metro proxy serves /api on the same
//   origin (no CORS needed).
// - Web (production static build, e.g. Render Static Site): set it so the build
//   calls the API cross-origin. The backend allows CORS, so this just works.
const BASE_URL: string = (process.env.EXPO_PUBLIC_BACKEND_URL as string) || "";
export const SESSION_TOKEN_KEY = "session_token";

async function getToken(): Promise<string | null> {
  return (await storage.secureGet<string>(SESSION_TOKEN_KEY, "")) || null;
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((opts.headers as Record<string, string>) || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = `${BASE_URL}/api${path}`;
  let res: Response;
  try {
    res = await fetch(url, { ...opts, headers });
  } catch (e: any) {
    // Network/DNS/CORS failure before we even got a response.
    throw new Error(
      BASE_URL
        ? `Can't reach the server (${BASE_URL}). ${e?.message || e}`
        : `Can't reach the server — the app has no backend URL configured (EXPO_PUBLIC_BACKEND_URL is not set for this build).`,
    );
  }
  const respBody = await res.text();
  if (!res.ok) {
    // Surface FastAPI's { detail } when present. `detail` may be a string or a
    // structured object like { code, message } — prefer its message.
    let msg: any = respBody;
    try {
      const d = JSON.parse(respBody)?.detail;
      msg = d == null ? respBody : (typeof d === "object" ? (d.message || JSON.stringify(d)) : d);
    } catch {}
    throw new Error(`${res.status}: ${msg}`);
  }
  if (!respBody) return undefined as T; // some endpoints reply 200 with no body
  try {
    return JSON.parse(respBody) as T;
  } catch {
    throw new Error(
      !BASE_URL
        ? "Got HTML instead of data: EXPO_PUBLIC_BACKEND_URL isn't set for this web build, so the app is calling itself instead of the API."
        : `Unexpected non-JSON response from ${url}.`,
    );
  }
}

export const api = {
  me: () => request<User>("/auth/me"),
  updateMe: (p: ProfilePatch) =>
    request<User>("/auth/me", { method: "PATCH", body: JSON.stringify(p) }),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  registerLocal: (body: { email: string; password: string; name: string; username: string }) =>
    request<{ session_token: string; user: User }>("/auth/register", { method: "POST", body: JSON.stringify(body) }),
  loginLocal: (body: { identifier: string; password: string }) =>
    request<{ session_token: string; user: User }>("/auth/login", { method: "POST", body: JSON.stringify(body) }),
  usernameAvailable: (u: string) =>
    request<{ available: boolean; reason?: string }>(`/auth/username-available?u=${encodeURIComponent(u)}`),
  setUsername: (username: string) =>
    request<User>("/auth/username", { method: "POST", body: JSON.stringify({ username }) }),
  changeEmail: (current_password: string, new_email: string) =>
    request<User>("/auth/me/email", { method: "PATCH", body: JSON.stringify({ current_password, new_email }) }),
  changePassword: (current_password: string, new_password: string) =>
    request<{ ok: boolean }>("/auth/me/password", { method: "PATCH", body: JSON.stringify({ current_password, new_password }) }),
  setPhone: (phone: string) =>
    request<User>("/auth/me/phone", { method: "PATCH", body: JSON.stringify({ phone }) }),
  listApiKeys: () => request<{ keys: ApiKey[] }>("/auth/api-keys"),
  createApiKey: (label: string, scopes?: string[]) =>
    request<{ id: string; label: string; scopes: string[]; token: string; created_at: string }>(
      "/auth/api-keys", { method: "POST", body: JSON.stringify({ label, scopes }) }),
  // Tiered API plans
  getApiPlan: () => request<{
    plans: ApiPlan[]; stripe_enabled: boolean;
    current: { plan?: string | null; name?: string | null; active: boolean; until?: string | null };
  }>("/payments/api-plan"),
  apiPlanCheckout: (plan: string) =>
    request<{ url: string }>("/payments/api-plan/checkout", { method: "POST", body: JSON.stringify({ plan }) }),
  apiPlanActivate: (plan: string) =>
    request<{ ok: boolean; plan: string }>("/payments/api-plan/activate", { method: "POST", body: JSON.stringify({ plan }) }),
  // Usage metering + pay-as-you-go
  getApiUsage: () => request<ApiUsage>("/payments/api-usage"),
  buyUsage: (pack: string) =>
    request<{ url: string }>("/payments/api-usage/buy", { method: "POST", body: JSON.stringify({ pack }) }),
  activateUsage: (pack: string) =>
    request<{ ok: boolean; added: number }>("/payments/api-usage/activate", { method: "POST", body: JSON.stringify({ pack }) }),
  // Developer webhooks
  listWebhookEvents: () => request<{ events: string[] }>("/webhooks/events"),
  listWebhooks: () => request<{ webhooks: DevWebhook[] }>("/webhooks"),
  createWebhook: (url: string, events?: string[]) =>
    request<DevWebhook>("/webhooks", { method: "POST", body: JSON.stringify({ url, events }) }),
  deleteWebhook: (id: string) =>
    request<{ deleted: boolean }>(`/webhooks/${id}`, { method: "DELETE" }),
  revokeApiKey: (id: string) =>
    request<{ revoked: boolean }>(`/auth/api-keys/${id}`, { method: "DELETE" }),
  // "Login with Nami" OAuth apps
  createOAuthApp: (name: string, redirect_uris: string[]) =>
    request<{ client_id: string; client_secret: string; name: string; redirect_uris: string[] }>(
      "/oauth/apps", { method: "POST", body: JSON.stringify({ name, redirect_uris }) }),
  listOAuthApps: () => request<{ apps: OAuthApp[] }>("/oauth/apps"),
  deleteOAuthApp: (clientId: string) =>
    request<{ deleted: boolean }>(`/oauth/apps/${clientId}`, { method: "DELETE" }),
  getOAuthApp: (clientId: string) => request<OAuthApp>(`/oauth/app/${clientId}`),
  getConnections: () => request<{ connections: OAuthConnection[] }>("/oauth/connections"),
  revokeConnection: (clientId: string) =>
    request<{ revoked: boolean }>(`/oauth/connections/${clientId}`, { method: "DELETE" }),
  oauthAuthorize: (body: { client_id: string; redirect_uri: string; scope?: string; state?: string; approve: boolean }) =>
    request<{ redirect_url: string }>("/oauth/authorize", { method: "POST", body: JSON.stringify(body) }),
  getPolicies: () => request<{ tos_version: string; privacy_version: string; effective_date: string }>("/policies"),
  acceptPolicies: () => request<User>("/auth/accept-policies", { method: "POST" }),
  uploadE2EKey: (public_key: string) =>
    request<{ ok: boolean }>("/auth/keys", { method: "POST", body: JSON.stringify({ public_key }) }),
  getUserE2EKey: (user_id: string) =>
    request<{ public_key: string | null }>(`/users/${user_id}/key`),
  uploadE2EBackup: (blob: string) =>
    request<{ ok: boolean }>("/auth/keys/backup", { method: "POST", body: JSON.stringify({ blob }) }),
  getE2EBackup: () => request<{ has_backup: boolean; blob: string | null }>("/auth/keys/backup"),
  deleteE2EBackup: () => request<{ ok: boolean }>("/auth/keys/backup", { method: "DELETE" }),
  recordPostView: (id: string) =>
    request<{ viewed: boolean }>(`/posts/${id}/view`, { method: "POST" }),
  reelsFeed: (focus?: string) =>
    request<Post[]>(`/feed/reels${focus ? `?focus=${encodeURIComponent(focus)}` : ""}`),
  listUserPostsAll: (uid: string) => request<Post[]>(`/posts/user/${uid}/all`),

  searchUsers: (q: string) => request<PublicUser[]>(`/users/search?q=${encodeURIComponent(q)}`),
  getPublicUser: (id: string) => request<PublicUser>(`/users/${id}/public`),
  adminPatchUser: (userId: string, body: { verified?: boolean; role?: string }) =>
    request<PublicUser>(`/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify(body) }),
  tipUser: (userId: string, amount: number, message?: string) =>
    request<{ id: string }>(`/users/${userId}/tip`, { method: "POST", body: JSON.stringify({ amount, message: message || "" }) }),
  getSubscriptionTiers: () => request<{ tiers: SubTier[] }>("/subscription-tiers"),
  subscribeUser: (userId: string, tier = "plus") =>
    request<{ subscribed: boolean }>(`/users/${userId}/subscribe`, { method: "POST", body: JSON.stringify({ tier }) }),
  unsubscribeUser: (userId: string) =>
    request<{ subscribed: boolean }>(`/users/${userId}/subscribe`, { method: "DELETE" }),
  getWallet: () => request<WalletSummary>("/wallet"),
  // Ads + creator ad revenue
  getNextAd: (placement: string, slot?: number) =>
    request<{ post: Post | null; house?: boolean; reason?: string | null; cta?: string; type?: "post" | "link"; link?: LinkAdServe }>(`/ads/next?placement=${encodeURIComponent(placement)}${slot != null ? `&slot=${slot}` : ""}`),
  adEvent: (postId: string, type: "impression" | "click", host_user_id?: string) =>
    request<{ ok: boolean }>(`/ads/${postId}/event`, { method: "POST", body: JSON.stringify({ type, host_user_id }) }),
  linkAdEvent: (adId: string, type: "impression" | "click", host_user_id?: string) =>
    request<{ ok: boolean }>(`/ads/links/${adId}/event`, { method: "POST", body: JSON.stringify({ type, host_user_id }) }),
  createLinkAd: (body: { url: string; headline: string; description?: string; image?: string; days?: number; cpc?: number }) =>
    request<{ id: string }>("/ads/links", { method: "POST", body: JSON.stringify(body) }),
  getLinkAds: () => request<{ ads: LinkAd[] }>("/ads/links"),
  deleteLinkAd: (id: string) => request<{ ok: boolean }>(`/ads/links/${id}`, { method: "DELETE" }),
  // Publisher network — embed Nami ads on your own site and earn.
  createPubSite: (body: { name: string; domain?: string }) =>
    request<PublisherSite>("/pub/sites", { method: "POST", body: JSON.stringify(body) }),
  getPubSites: () => request<{ sites: PublisherSite[] }>("/pub/sites"),
  deletePubSite: (id: string) => request<{ ok: boolean }>(`/pub/sites/${id}`, { method: "DELETE" }),
  hideAd: (postId: string) => request<{ hidden: boolean }>(`/ads/${postId}/hide`, { method: "POST" }),
  reportAd: (postId: string) => request<{ reported: boolean }>(`/ads/${postId}/report`, { method: "POST" }),
  recordProfileView: (userId: string) =>
    request<{ ok: boolean; views?: number }>(`/users/${userId}/view`, { method: "POST" }),
  // Payments (Stripe Connect) — inert until the server has STRIPE_SECRET_KEY set.
  getPaymentsConfig: () => request<{ enabled: boolean; platform_fee_percent: number }>("/payments/config"),
  setupPayouts: () => request<{ url: string }>("/payments/payouts/setup", { method: "POST" }),
  getPayoutStatus: () =>
    request<{ enabled: boolean; connected: boolean; payouts_enabled: boolean; charges_enabled?: boolean; details_submitted: boolean }>("/payments/payouts/status"),
  createCheckout: (
    kind: "tip" | "subscription" | "promote",
    creator_id: string,
    amount: number,
    extra?: { post_id?: string; days?: number; conversation_id?: string; note?: string; tier?: string },
  ) =>
    request<{ url: string; id: string }>("/payments/checkout", {
      method: "POST", body: JSON.stringify({ kind, creator_id, amount, ...(extra || {}) }),
    }),

  listPlaces: () => request<Place[]>("/places"),
  getPlace: (id: string) => request<Place>(`/places/${id}`),
  createPlace: (place: PlaceCreate) =>
    request<Place>("/places", { method: "POST", body: JSON.stringify(place) }),
  deletePlace: (id: string) =>
    request<{ ok: boolean }>(`/places/${id}`, { method: "DELETE" }),

  listRecents: () => request<Recent[]>("/recents"),
  addRecent: (r: RecentCreate) =>
    request<Recent>("/recents", { method: "POST", body: JSON.stringify(r) }),
  deleteRecent: (id: string) =>
    request<{ ok: boolean }>(`/recents/${id}`, { method: "DELETE" }),
  clearRecents: () => request<{ ok: boolean }>("/recents", { method: "DELETE" }),

  listGuides: () => request<Guide[]>("/guides"),
  createGuide: (g: GuideCreate) =>
    request<Guide>("/guides", { method: "POST", body: JSON.stringify(g) }),
  patchGuide: (id: string, patch: GuidePatch) =>
    request<Guide>(`/guides/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteGuide: (id: string) =>
    request<{ ok: boolean }>(`/guides/${id}`, { method: "DELETE" }),
  addPlaceToGuide: (gid: string, pid: string) =>
    request<Guide>(`/guides/${gid}/places/${pid}`, { method: "POST" }),
  removePlaceFromGuide: (gid: string, pid: string) =>
    request<Guide>(`/guides/${gid}/places/${pid}`, { method: "DELETE" }),

  getPublicGuide: (slug: string) => request<PublicGuide>(`/public/guides/${slug}`),
  clonePublicGuide: (slug: string) =>
    request<Guide>(`/public/guides/${slug}/clone`, { method: "POST" }),

  listReviews: (place_key: string) =>
    request<Review[]>(`/reviews?place_key=${encodeURIComponent(place_key)}`),
  upsertReview: (r: ReviewCreate) =>
    request<Review>("/reviews", { method: "POST", body: JSON.stringify(r) }),
  deleteReview: (id: string) =>
    request<{ ok: boolean }>(`/reviews/${id}`, { method: "DELETE" }),

  fsqMatch: (name: string, lng: number, lat: number) =>
    request<FsqProfile | null>(
      `/foursquare/match?name=${encodeURIComponent(name)}&lng=${lng}&lat=${lat}`,
    ),

  getOrCreateConversation: (recipient_user_id: string) =>
    request<ConversationView>("/conversations", {
      method: "POST", body: JSON.stringify({ recipient_user_id }),
    }),
  listConversations: () => request<ConversationView[]>("/conversations"),
  listMessages: (conv_id: string) =>
    request<Message[]>(`/conversations/${conv_id}/messages`),
  sendMessage: (conv_id: string, body: MessageCreate) =>
    request<Message>(`/conversations/${conv_id}/messages`, {
      method: "POST", body: JSON.stringify(body),
    }),
  markConversationRead: (conv_id: string) =>
    request<{ ok: boolean }>(`/conversations/${conv_id}/read`, { method: "POST" }),
  setPresence: (conv_id: string, typing: boolean) =>
    request<{ ok: boolean }>(`/conversations/${conv_id}/presence`, { method: "POST", body: JSON.stringify({ typing }) }),
  getPresence: (conv_id: string) =>
    request<{ typing: boolean; active: boolean; typing_ids: string[]; active_ids: string[] }>(`/conversations/${conv_id}/presence`),
  editMessage: (conv_id: string, msg_id: string, text: string) =>
    request<Message>(`/conversations/${conv_id}/messages/${msg_id}`, {
      method: "PATCH", body: JSON.stringify({ text }),
    }),
  deleteMessage: (conv_id: string, msg_id: string) =>
    request<{ ok: boolean }>(`/conversations/${conv_id}/messages/${msg_id}`, {
      method: "DELETE",
    }),
  reactToMessage: (conv_id: string, msg_id: string, emoji: string) =>
    request<Message>(`/conversations/${conv_id}/messages/${msg_id}/react`, {
      method: "POST", body: JSON.stringify({ emoji }),
    }),
  // Custom emojis (global registry, used as :shortcode: in chat).
  listCustomEmojis: () => request<CustomEmoji[]>("/emojis"),
  createCustomEmoji: (shortcode: string, image_base64: string) =>
    request<CustomEmoji>("/emojis", { method: "POST", body: JSON.stringify({ shortcode, image_base64 }) }),
  deleteCustomEmoji: (id: string) =>
    request<{ ok: boolean }>(`/emojis/${id}`, { method: "DELETE" }),
  deleteConversation: (conv_id: string) =>
    request<{ ok: boolean }>(`/conversations/${conv_id}`, { method: "DELETE" }),

  // Group chats
  createGroupChat: (body: { name: string; member_ids: string[]; avatar?: string }) =>
    request<ConversationView>("/conversations/groups", {
      method: "POST", body: JSON.stringify(body),
    }),
  patchGroupChat: (
    conv_id: string,
    body: { name?: string; avatar?: string; add_member_ids?: string[]; remove_member_ids?: string[] },
  ) =>
    request<ConversationView>(`/conversations/${conv_id}`, {
      method: "PATCH", body: JSON.stringify(body),
    }),
  leaveGroupChat: (conv_id: string) =>
    request<{ ok: boolean }>(`/conversations/${conv_id}/leave`, { method: "POST" }),

  // Notifications
  listNotifications: () => request<Notification[]>("/notifications"),
  unreadNotificationsCount: () =>
    request<{ count: number }>("/notifications/unread"),
  markNotificationRead: (id: string) =>
    request<{ ok: boolean }>(`/notifications/${id}/read`, { method: "POST" }),
  markAllNotificationsRead: () =>
    request<{ ok: boolean }>("/notifications/read-all", { method: "POST" }),
  deleteNotification: (id: string) =>
    request<{ ok: boolean }>(`/notifications/${id}`, { method: "DELETE" }),

  // ETA sharing
  createEta: (body: EtaShareCreate) =>
    request<EtaShare>("/eta", { method: "POST", body: JSON.stringify(body) }),
  updateEta: (share_id: string, body: EtaUpdateBody) =>
    request<EtaShare>(`/eta/${share_id}/update`, { method: "POST", body: JSON.stringify(body) }),
  stopEta: (share_id: string) =>
    request<EtaShare>(`/eta/${share_id}/stop`, { method: "POST" }),

  // Posts / Feed / Follows
  createPost: (body: PostCreate) =>
    request<Post>("/posts", { method: "POST", body: JSON.stringify(body) }),
  editPost: (id: string, body: { text?: string; media?: PostMedia[] }) =>
    request<Post>(`/posts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  editPostPrivacy: (id: string, body: { likes_disabled?: boolean; comment_policy?: string }) =>
    request<Post>(`/posts/${id}/privacy`, { method: "PATCH", body: JSON.stringify(body) }),
  reportPost: (id: string, reason?: string) =>
    request<{ ok: boolean }>(`/posts/${id}/report`, {
      method: "POST", body: JSON.stringify({ reason: reason || "other" }),
    }),
  deletePost: (id: string) =>
    request<{ ok: boolean }>(`/posts/${id}`, { method: "DELETE" }),
  getPost: (id: string) => request<Post>(`/posts/${id}`),
  getPostViewers: (id: string) => request<PostViewers>(`/posts/${id}/viewers`),
  listReplies: (id: string) => request<Post[]>(`/posts/${id}/replies`),
  postThread: (id: string) => request<Post[]>(`/posts/${id}/thread`),
  // Communities (forum)
  listCommunities: (q?: string) => request<Community[]>(`/communities${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  getCommunity: (name: string) => request<Community>(`/communities/${name}`),
  createCommunity: (body: { name: string; title?: string; description?: string; color?: string; icon?: string }) =>
    request<Community>("/communities", { method: "POST", body: JSON.stringify(body) }),
  joinCommunity: (name: string) => request<{ joined: boolean }>(`/communities/${name}/join`, { method: "POST" }),
  leaveCommunity: (name: string) => request<{ joined: boolean }>(`/communities/${name}/join`, { method: "DELETE" }),
  communityPosts: (name: string, sort = "hot") => request<Post[]>(`/communities/${name}/posts?sort=${sort}`),
  listUserPosts: (uid: string) => request<Post[]>(`/posts/user/${uid}`),
  homeFeed: () => request<Post[]>("/feed/home"),
  exploreFeed: () => request<Post[]>("/feed/explore"),
  toggleLike: (id: string) =>
    request<Post>(`/posts/${id}/like`, { method: "POST" }),
  toggleDislike: (id: string) =>
    request<Post>(`/posts/${id}/dislike`, { method: "POST" }),
  promotePost: (id: string, days = 7, opts?: { budget?: number; cpc?: number }) =>
    request<Post>(`/posts/${id}/promote`, { method: "POST", body: JSON.stringify({ days, ...(opts || {}) }) }),
  getCampaigns: () => request<{ campaigns: AdCampaign[] }>("/ads/campaigns"),
  getAdAccount: () => request<AdAccount>("/ads/account"),
  topupAdAccount: (amount: number) =>
    request<{ ok?: boolean; credited?: number; balance?: number; stripe: boolean; url?: string; id?: string }>(
      "/ads/account/topup", { method: "POST", body: JSON.stringify({ amount }) }),
  getAdRevenue: () => request<AdRevenue>("/admin/ad-revenue"),
  getBotPosts: () => request<{ posts: BotPost[] }>("/admin/bot/posts"),
  runBot: (body: { post_id: string; views?: number; clicks?: number; likes?: number; comments?: number; earner_id?: string }) =>
    request<BotResult>("/admin/bot/run", { method: "POST", body: JSON.stringify(body) }),
  exportWallet: () => request<{ filename: string; csv: string }>("/wallet/export"),
  getPayouts: () => request<PayoutInfo>("/payouts"),
  runPayouts: () => request<{ payouts_created: number; total_paid: number }>("/payouts/run", { method: "POST" }),
  pinPost: (id: string) =>
    request<Post>(`/posts/${id}/pin`, { method: "POST" }),
  toggleRepost: (id: string) =>
    request<Post>(`/posts/${id}/repost`, { method: "POST" }),
  toggleBookmark: (id: string) =>
    request<Post>(`/posts/${id}/bookmark`, { method: "POST" }),
  listBookmarks: () => request<Post[]>("/bookmarks"),
  listPostLikers: (id: string) => request<PublicUser[]>(`/posts/${id}/likers`),
  listPostReposters: (id: string) => request<PublicUser[]>(`/posts/${id}/reposters`),
  votePoll: (id: string, option_id: string) =>
    request<Post>(`/posts/${id}/vote`, {
      method: "POST", body: JSON.stringify({ option_id }),
    }),
  hashtagPosts: (tag: string) =>
    request<Post[]>(`/hashtags/${encodeURIComponent(tag.replace(/^#/, ""))}`),
  hashtagCount: (tag: string) =>
    request<{ tag: string; count: number }>(
      `/hashtags/${encodeURIComponent(tag.replace(/^#/, ""))}/count`),
  toggleFollow: (uid: string) =>
    request<{ following: boolean }>(`/users/${uid}/follow`, { method: "POST" }),
  pokeUser: (uid: string) =>
    request<{ ok: boolean; already?: boolean }>(`/users/${uid}/poke`, { method: "POST" }),
  // ── Money: send / request, gated by the sender's security question ──
  getMoneySecurity: () => request<{ is_set: boolean; question?: string | null }>("/money/security"),
  setMoneySecurity: (body: { question: string; answer: string; current_answer?: string }) =>
    request<{ ok: boolean; question: string }>("/money/security", { method: "POST", body: JSON.stringify(body) }),
  sendMoney: (body: { to_user_id: string; amount: number; note?: string; answer: string }) =>
    request<{ ok: boolean; amount: number }>("/money/send", { method: "POST", body: JSON.stringify(body) }),
  requestMoney: (body: { to_user_id: string; amount: number; note?: string }) =>
    request<MoneyRequest>("/money/request", { method: "POST", body: JSON.stringify(body) }),
  listMoneyRequests: () => request<{ incoming: MoneyRequest[]; outgoing: MoneyRequest[] }>("/money/requests"),
  payMoneyRequest: (rid: string, answer: string) =>
    request<{ ok: boolean; amount: number }>(`/money/requests/${rid}/pay`, { method: "POST", body: JSON.stringify({ answer }) }),
  declineMoneyRequest: (rid: string) =>
    request<{ ok: boolean }>(`/money/requests/${rid}/decline`, { method: "POST" }),
  cancelMoneyRequest: (rid: string) =>
    request<{ ok: boolean }>(`/money/requests/${rid}/cancel`, { method: "POST" }),
  listFollowers: (uid: string) => request<PublicUser[]>(`/users/${uid}/followers`),
  listFollowing: (uid: string) => request<PublicUser[]>(`/users/${uid}/following`),
  sendFriendRequest: (uid: string) =>
    request<{ status: "request_sent" | "friends" }>(`/friends/request/${uid}`, { method: "POST" }),
  cancelFriendRequest: (uid: string) =>
    request<{ status: "none" }>(`/friends/request/${uid}`, { method: "DELETE" }),
  acceptFriend: (uid: string) =>
    request<{ status: "friends" }>(`/friends/accept/${uid}`, { method: "POST" }),
  rejectFriend: (uid: string) =>
    request<{ status: "rejected" }>(`/friends/reject/${uid}`, { method: "POST" }),
  unfriend: (uid: string) =>
    request<{ removed: boolean }>(`/friends/${uid}`, { method: "DELETE" }),
  listFriends: () => request<PublicUser[]>(`/friends`),
  listFriendRequests: () => request<PublicUser[]>(`/friends/requests`),

  // Marketplace
  listListings: (params?: { category?: string; q?: string; condition?: string; min_price?: number; max_price?: number; sort?: string; lat?: number; lng?: number; radius_km?: number }) => {
    const qs = new URLSearchParams();
    if (params?.category) qs.set("category", params.category);
    if (params?.q) qs.set("q", params.q);
    if (params?.condition) qs.set("condition", params.condition);
    if (params?.min_price != null) qs.set("min_price", String(params.min_price));
    if (params?.max_price != null) qs.set("max_price", String(params.max_price));
    if (params?.sort) qs.set("sort", params.sort);
    if (params?.lat != null) qs.set("lat", String(params.lat));
    if (params?.lng != null) qs.set("lng", String(params.lng));
    if (params?.radius_km != null) qs.set("radius_km", String(params.radius_km));
    return request<Listing[]>(`/listings${qs.toString() ? "?" + qs.toString() : ""}`);
  },
  listSavedListings: () => request<Listing[]>("/listings/saved"),
  getListing: (id: string) => request<Listing>(`/listings/${id}`),
  createListing: (body: ListingCreate) =>
    request<Listing>("/listings", { method: "POST", body: JSON.stringify(body) }),
  updateListing: (id: string, body: Partial<ListingCreate> & { status?: string }) =>
    request<Listing>(`/listings/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  saveListing: (id: string) =>
    request<{ ok: boolean; saved: boolean }>(`/listings/${id}/save`, { method: "POST" }),
  unsaveListing: (id: string) =>
    request<{ ok: boolean; saved: boolean }>(`/listings/${id}/save`, { method: "DELETE" }),
  deleteListing: (id: string) =>
    request<{ ok: boolean }>(`/listings/${id}`, { method: "DELETE" }),
  contactSeller: (id: string) =>
    request<ConversationView>(`/listings/${id}/contact`, { method: "POST" }),
  getSellerProfile: (userId: string) =>
    request<SellerProfile>(`/marketplace/users/${userId}`),
  listSellerReviews: (userId: string) =>
    request<MarketplaceReview[]>(`/marketplace/users/${userId}/reviews`),
  addSellerReview: (userId: string, rating: number, text: string) =>
    request<MarketplaceReview>(`/marketplace/users/${userId}/reviews`, {
      method: "POST", body: JSON.stringify({ rating, text }),
    }),
  startTrade: (listingId: string) =>
    request<{ code: string; status: string }>(`/listings/${listingId}/trade/start`, { method: "POST" }),
  confirmTrade: (code: string) =>
    request<{ status: string; partner_name?: string }>(`/trades/confirm`, {
      method: "POST", body: JSON.stringify({ code }),
    }),

  // Groups
  listGroupsAll: () => request<Group[]>("/groups"),
  createGroup: (body: { name: string; description?: string; color?: string; is_private?: boolean }) =>
    request<Group>("/groups", { method: "POST", body: JSON.stringify(body) }),
  joinGroup: (id: string) =>
    request<Group>(`/groups/${id}/join`, { method: "POST" }),
  leaveGroup: (id: string) =>
    request<Group>(`/groups/${id}/leave`, { method: "POST" }),
  deleteGroupNew: (id: string) =>
    request<{ ok: boolean }>(`/groups/${id}`, { method: "DELETE" }),
  getGroup: (id: string) => request<Group>(`/groups/${id}`),
  listGroupPosts: (id: string) => request<Post[]>(`/groups/${id}/posts`),
  createGroupPost: (id: string, body: PostCreate) =>
    request<Post>(`/groups/${id}/posts`, { method: "POST", body: JSON.stringify(body) }),
  listGroupMembers: (id: string) =>
    request<{ user_id: string; name: string; username?: string | null; picture?: string | null; role: string; joined_at: string }[]>(`/groups/${id}/members`),
  updateGroup: (id: string, body: { name?: string; description?: string; color?: string; cover_image?: string | null; is_private?: boolean }) =>
    request<Group>(`/groups/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  listGroupPins: (id: string) => request<Post[]>(`/groups/${id}/pins`),
  pinGroupPost: (id: string, postId: string) =>
    request<Group>(`/groups/${id}/pins/${postId}`, { method: "POST" }),
  unpinGroupPost: (id: string, postId: string) =>
    request<Group>(`/groups/${id}/pins/${postId}`, { method: "DELETE" }),
  promoteMember: (groupId: string, userId: string) =>
    request<Group>(`/groups/${groupId}/members/${userId}/promote`, { method: "POST" }),
  demoteMember: (groupId: string, userId: string) =>
    request<Group>(`/groups/${groupId}/members/${userId}/demote`, { method: "POST" }),
  kickMember: (groupId: string, userId: string) =>
    request<Group>(`/groups/${groupId}/members/${userId}`, { method: "DELETE" }),
  listJoinRequests: (id: string) =>
    request<{ user_id: string; name: string; username?: string | null; picture?: string | null; created_at: string }[]>(`/groups/${id}/requests`),
  approveJoinRequest: (groupId: string, userId: string) =>
    request<Group>(`/groups/${groupId}/requests/${userId}/approve`, { method: "POST" }),
  rejectJoinRequest: (groupId: string, userId: string) =>
    request<Group>(`/groups/${groupId}/requests/${userId}/reject`, { method: "POST" }),

  // ── Stories ──
  createStory: (body: { media: { type: "image" | "video"; base64: string; duration_ms?: number }; caption?: string }) =>
    request<Story>(`/stories`, { method: "POST", body: JSON.stringify(body) }),
  storiesTray: () => request<StoryTrayItem[]>(`/stories/tray`),
  listUserStories: (userId: string) => request<Story[]>(`/stories/user/${userId}`),
  viewStory: (id: string) => request<{ viewed: boolean }>(`/stories/${id}/view`, { method: "POST" }),
  listStoryViewers: (id: string) => request<StoryViewer[]>(`/stories/${id}/viewers`),
  deleteStory: (id: string) => request<{ ok: boolean }>(`/stories/${id}`, { method: "DELETE" }),
  replyToStory: (id: string, text: string) =>
    request<{ ok: boolean; conversation_id: string }>(`/stories/${id}/reply`, { method: "POST", body: JSON.stringify({ text }) }),
};

export type Story = {
  id: string; user_id: string; user_name: string; user_picture?: string | null;
  user_username?: string | null;
  type: "image" | "video"; media_base64: string;
  caption?: string; duration_ms?: number | null;
  view_count: number; viewed_by_me: boolean;
  created_at: string; expires_at: string;
};
export type StoryTrayItem = {
  user_id: string; user_name: string; user_picture?: string | null;
  user_username?: string | null;
  has_unviewed: boolean; story_count: number; latest_at: string;
};
export type StoryViewer = {
  user_id: string; name: string; username?: string | null;
  picture?: string | null; viewed_at: string;
};

export type Group = {
  id: string; name: string; description?: string; color: string;
  cover_image?: string | null;
  is_private?: boolean;
  owner_id: string; member_count: number; is_member: boolean;
  membership_pending?: boolean;
  my_role?: "owner" | "admin" | "member";
  pending_request_count?: number;
  pinned_post_ids?: string[];
  created_at: string;
};

export type Listing = {
  id: string; user_id: string;
  seller: PostAuthor;
  title: string; price: number; currency: string; category: string;
  condition?: string | null;
  description?: string | null;
  photo_base64?: string | null;
  photos?: string[];
  longitude?: number | null; latitude?: number | null; locality?: string | null;
  negotiable?: boolean;
  quantity?: number;
  brand?: string | null;
  delivery?: string | null;
  distance_km?: number | null;
  status: string;
  views_count?: number;
  saved_count?: number;
  saved_by_me?: boolean;
  created_at: string;
};
export type ListingCreate = {
  title: string; price?: number; currency?: string; category?: string;
  condition?: string;
  description?: string; photo_base64?: string; photos?: string[];
  longitude?: number; latitude?: number; locality?: string;
  negotiable?: boolean; quantity?: number; brand?: string; delivery?: string;
};
export type MarketplaceReview = {
  id: string; subject_user_id: string;
  reviewer: PostAuthor;
  rating: number; text?: string | null; created_at: string;
};
export type SellerProfile = {
  user: PublicUser;
  rating: number; review_count: number; listing_count: number;
  listings: Listing[]; reviewed_by_me: boolean; can_review?: boolean;
};

export async function fetchPublicEta(share_id: string): Promise<EtaShare | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/public/eta/${share_id}`);
    if (!res.ok) return null;
    return (await res.json()) as EtaShare;
  } catch {
    return null;
  }
}

export type User = {
  user_id: string;
  email: string;
  name: string;
  username?: string | null;
  picture?: string | null;
  phone?: string | null;
  phone_verified?: boolean;
  bio?: string;
  home_name?: string | null;
  home_longitude?: number | null;
  home_latitude?: number | null;
  work_name?: string | null;
  work_longitude?: number | null;
  work_latitude?: number | null;
  verified?: boolean;
  role?: string; // user | mod | admin
  sub_price?: number;
  payout_frequency?: string; // biweekly | monthly
  payout_threshold?: number;
  default_comment_policy?: string; // everyone | followers | friends | nobody
  default_likes_disabled?: boolean;
  needs_policy_agreement?: boolean;
};
export type ProfilePatch = {
  name?: string; bio?: string; picture?: string;
  home_name?: string | null; home_longitude?: number | null; home_latitude?: number | null;
  work_name?: string | null; work_longitude?: number | null; work_latitude?: number | null;
  sub_price?: number;
  payout_frequency?: string;
  payout_threshold?: number;
  default_comment_policy?: string;
  default_likes_disabled?: boolean;
};
export type SubTier = { id: string; name: string; price: number };
export type WalletTxn = { id: string; kind: string; amount: number; from_user_id: string; from_name: string; source?: string; created_at: string };
export type WalletSummary = {
  currency: string; total_earned: number; tips_total: number; subs_total: number;
  tips_count: number; active_subscribers: number; sub_price: number; recent: WalletTxn[];
  total_spent: number; tips_sent_total: number; subs_sent_total: number;
  subscriptions_count: number; sent: WalletTxn[];
  ads_total?: number;
};
export type Payout = { id: string; amount: number; status: string; created_at: string };
export type PayoutInfo = { balance: number; total_paid_out: number; frequency: string; next_payout?: string | null; history: Payout[] };
export type Ad = { post_id: string | null; text: string; image?: string | null; author_name: string; reason?: string | null; author_picture?: string | null };
export type AdCampaign = { post_id: string; text: string; impressions: number; clicks: number; ctr: number; budget: number; spent: number; cpc: number; promoted_until?: string | null; active: boolean };
export type LinkAdServe = { id: string; url: string; headline: string; description?: string | null; image?: string | null; owner_id?: string };
export type LinkAd = { id: string; url: string; headline: string; description?: string | null; image?: string | null; cpc: number; impressions: number; clicks: number; ctr: number; spent: number; promoted_until?: string | null; active: boolean };
export type PublisherSite = { id: string; name: string; domain?: string | null; site_key: string; impressions: number; clicks: number; ctr: number; earned: number; created_at?: string };
export type BotPost = { post_id: string; text: string; owner_name: string; views: number; likes: number; comments: number; impressions: number; clicks: number; spent: number };
export type BotResult = { ok: boolean; earned: number; earner_id: string; spend: number; debited_from_advertiser: number; totals: { views: number; likes: number; comments: number; impressions: number; clicks: number; spent: number } };
export type AdAccount = {
  balance: number; funded: boolean; paused: boolean;
  active_campaigns: number; lifetime_spend: number; stripe_enabled: boolean;
  rates: { view: number; click: number; comment: number };
  recent_topups: { amount: number; source: string; created_at?: string }[];
};
export type AdRevenue = {
  total_ad_spend: number; paid_to_hosts: number; platform_cut: number;
  total_impressions: number; total_clicks: number; ctr: number; active_campaigns: number;
  top_earners: { name: string; amount: number }[];
  top_advertisers: { name: string; amount: number }[];
};
export type ApiKey = { id: string; label: string; scopes?: string[]; key_prefix: string; created_at: string; last_used_at?: string | null };
export type OAuthApp = { client_id: string; name: string; redirect_uris: string[]; created_at?: string };
export type OAuthConnection = { client_id: string; name: string; scope: string; granted_at?: string | null; tokens: number };
export type ApiPlan = { id: string; name: string; price: number; level: number; max_keys: number; write: boolean; webhooks: boolean; rate_per_min: number };
export type DevWebhook = { id: string; url: string; events: string[]; active: boolean; created_at: string; secret_prefix?: string; secret?: string };
export type OveragePack = { id: string; name: string; requests: number; price: number };
export type ApiUsage = { plan?: string | null; used: number; quota: number; extra_credits: number; limit: number; resets_at?: string | null; packs: OveragePack[]; stripe_enabled: boolean };
export type FriendStatus = "none" | "request_sent" | "request_received" | "friends";
export type MoneyRequest = {
  id: string; from_user_id: string; to_user_id: string; amount: number; note: string;
  status: "pending" | "paid" | "declined" | "cancelled"; direction: "incoming" | "outgoing";
  other_user: { user_id: string; name: string; username?: string | null; picture?: string | null; verified?: boolean };
  created_at?: string;
};
export type PublicUser = {
  user_id: string;
  name: string;
  username?: string | null;
  picture?: string | null;
  bio?: string;
  verified?: boolean;
  role?: string;
  sub_price?: number;
  is_subscribed?: boolean;
  subscriber_count?: number;
  stats?: { places?: number; guides?: number; reviews?: number; followers?: number; following?: number; friends?: number };
  is_following?: boolean;
  is_followed_by?: boolean;
  friend_status?: FriendStatus;
  poked_me?: boolean;
};
export type Place = {
  id: string; user_id: string; title: string; notes?: string;
  longitude: number; latitude: number; address?: string; category: string; created_at: string;
};
export type PlaceCreate = {
  title: string; notes?: string; longitude: number; latitude: number; address?: string; category?: string;
};
export type Recent = {
  id: string; user_id: string; name: string; full_address?: string;
  longitude: number; latitude: number; created_at: string;
};
export type RecentCreate = { name: string; full_address?: string; longitude: number; latitude: number };
export type Guide = {
  id: string; user_id: string; name: string; color: string; icon: string;
  place_ids: string[]; is_public: boolean; slug?: string | null; created_at: string;
};
export type GuideCreate = { name: string; color?: string; icon?: string };
export type GuidePatch = { name?: string; color?: string; is_public?: boolean };
export type PublicGuide = {
  id: string; slug: string; name: string; color: string; icon: string;
  owner: PublicUser; places: Place[]; created_at: string;
};
export type Review = {
  id: string; user_id: string; user_name: string; user_picture?: string | null;
  place_key: string; place_name: string; longitude: number; latitude: number;
  rating: number; text?: string; created_at: string;
};
export type ReviewCreate = {
  place_key: string; place_name: string; longitude: number; latitude: number;
  rating: number; text?: string;
};

export type FsqProfile = {
  fsq_id: string;
  name: string;
  address?: string | null;
  locality?: string | null;
  category?: string | null;
  rating?: number | null;
  price?: number | null;
  phone?: string | null;
  website?: string | null;
  hours_display?: string | null;
  open_now?: boolean | null;
  photo?: string | null;
  distance?: number | null;
};
export type MsgType = "text" | "place" | "media" | "voice" | "post" | "gif" | "file" | "contact" | "tip";
export type Message = {
  id: string; conversation_id: string; sender_id: string;
  type: MsgType; text?: string;
  amount?: number | null;
  place_name?: string; place_address?: string;
  place_longitude?: number; place_latitude?: number;
  media?: PostMedia[];
  audio_base64?: string | null;
  audio_duration_ms?: number | null;
  post_id?: string | null;
  gif_url?: string | null;
  file_base64?: string | null; file_name?: string | null; file_size?: number | null; file_mime?: string | null;
  contact_user_id?: string | null; contact_name?: string | null; contact_picture?: string | null;
  link_preview?: LinkPreview | null;
  deleted?: boolean;
  reactions?: Record<string, string> | null;  // { user_id: emoji }
  reply_to_id?: string | null;
  edit_history?: { text: string; edited_at?: string | null }[];
  edited_at?: string | null;
  read_at?: string | null;
  delivered_at?: string | null;
  read_by?: string[];
  delivered_by?: string[];
  created_at: string;
};
export type CustomEmoji = { id: string; shortcode: string; image_base64: string; owner_id: string; created_at: string };
export type MessageCreate = {
  type: MsgType; text?: string;
  amount?: number;
  place_name?: string; place_address?: string;
  place_longitude?: number; place_latitude?: number;
  media?: PostMedia[];
  audio_base64?: string;
  audio_duration_ms?: number;
  post_id?: string;
  gif_url?: string;
  file_base64?: string; file_name?: string; file_size?: number; file_mime?: string;
  contact_user_id?: string; contact_name?: string; contact_picture?: string;
  reply_to?: string;
};
export type ConversationView = {
  id: string;
  kind: "dm" | "group";
  name?: string | null;
  avatar?: string | null;
  other_user?: PublicUser | null;
  members?: PublicUser[];
  owner_id?: string | null;
  last_message?: Message | null;
  last_message_at?: string | null;
  unread_count?: number;
  created_at: string;
};

export type Notification = {
  id: string;
  user_id: string;
  type: "like" | "repost" | "reply" | "message" | "group_invite" | "group_message" | "follow" | "poke"
    | "money_request" | "money_received" | "money_request_paid" | "money_request_declined";
  actor_id?: string | null;
  actor_name?: string | null;
  actor_picture?: string | null;
  post_id?: string | null;
  conversation_id?: string | null;
  group_id?: string | null;
  message?: string | null;
  read: boolean;
  created_at: string;
};

export type EtaShareCreate = {
  name?: string;
  destination_name?: string;
  destination_longitude: number;
  destination_latitude: number;
  initial_longitude: number;
  initial_latitude: number;
  eta_minutes?: number;
  ttl_minutes?: number;
};
export type EtaShare = {
  id: string;
  share_id: string;
  user_id: string;
  name?: string;
  destination_name?: string;
  destination_longitude: number;
  destination_latitude: number;
  current_longitude: number;
  current_latitude: number;
  eta_minutes?: number | null;
  active: boolean;
  expires_at: string;
  updated_at: string;
  created_at: string;
};
export type EtaUpdateBody = {
  current_longitude: number;
  current_latitude: number;
  eta_minutes?: number;
};

export type LinkPreview = {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  site_name?: string | null;
};
export type PollOption = { id: string; text: string; votes: number };
export type Poll = {
  options: PollOption[];
  total_votes: number;
  voted_option_id?: string | null;
  ends_at: string;
  closed: boolean;
};
export type PollCreate = { options: string[]; duration_hours: number };
export type PostAuthor = { user_id: string; name: string; username?: string | null; picture?: string | null; verified?: boolean };
export type PostMedia = {
  type: "image" | "video";
  base64?: string;
  url?: string | null;
  thumbnail?: string | null;
  width?: number | null;
  height?: number | null;
};

/** The source URI for a media item — prefers the CDN url, falls back to inline base64. */
export const mediaUri = (m?: { url?: string | null; base64?: string | null } | null): string =>
  (m?.url || m?.base64 || "") as string;
export type Post = {
  id: string; user_id: string; author: PostAuthor; text: string;
  parent_id?: string | null;
  repost_of?: string | null;
  quote_of?: string | null;
  reposted_post?: Post | null;
  quoted_post?: Post | null;
  place_name?: string | null; place_longitude?: number | null; place_latitude?: number | null;
  media?: PostMedia[];
  link_preview?: LinkPreview | null;
  poll?: Poll | null;
  hashtags?: string[];
  likes_count: number; dislikes_count?: number; replies_count: number; reposts_count?: number;
  quotes_count?: number;
  bookmarks_count?: number;
  views_count?: number;
  likes_disabled?: boolean;
  comment_policy?: string;
  can_comment?: boolean;
  liked_by_me: boolean; disliked_by_me?: boolean; reposted_by_me?: boolean; bookmarked_by_me?: boolean;
  promoted?: boolean; promoted_until?: string | null;
  pinned?: boolean;
  community_id?: string | null; community_name?: string | null; title?: string | null;
  edited_at?: string | null;
  created_at: string;
};
export type PostViewer = { user_id: string; name: string; username?: string | null; picture?: string | null; verified?: boolean; viewed_at?: string };
export type PostViewers = { count: number; unique: number; viewers: PostViewer[] };
export type PostCreate = {
  text?: string; parent_id?: string;
  quote_of?: string;
  place_name?: string; place_longitude?: number; place_latitude?: number;
  media?: PostMedia[];
  poll?: PollCreate;
  community_id?: string; title?: string;
  likes_disabled?: boolean;
  comment_policy?: string;
};

export type Community = {
  id: string; name: string; title: string; description?: string;
  color?: string; icon?: string; owner_id: string;
  member_count?: number; post_count?: number;
  is_member?: boolean; role?: string | null; created_at: string;
};

export const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN as string;

export function buildPlaceKey(name: string, lng: number, lat: number): string {
  return `${name.trim().toLowerCase()}|${lng.toFixed(5)}|${lat.toFixed(5)}`;
}
