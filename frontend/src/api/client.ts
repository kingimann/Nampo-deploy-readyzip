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
  presencePing: () => request<{ ok: boolean }>("/presence/ping", { method: "POST" }),
  listBadges: () => request<Badge[]>("/badges"),
  adminCreateBadge: (body: { label: string; icon: string; color?: string }) =>
    request<Badge>("/admin/badges", { method: "POST", body: JSON.stringify(body) }),
  adminDeleteBadge: (badgeId: string) =>
    request<{ ok: boolean }>(`/admin/badges/${badgeId}`, { method: "DELETE" }),
  adminSetUserBadge: (userId: string, badge_id: string, action: "add" | "remove") =>
    request<{ ok: boolean }>(`/admin/users/${userId}/badge`, { method: "POST", body: JSON.stringify({ badge_id, action }) }),
  adminIntegrations: (live = false, only?: string) =>
    request<IntegrationsReport>(`/admin/integrations${only ? `?only=${encodeURIComponent(only)}` : live ? "?live=1" : ""}`),
  // Render deployment admin (admin-only; needs RENDER_API_KEY on the backend)
  renderServices: () =>
    request<{ configured: boolean; services: RenderService[]; self_id?: string }>("/admin/render/services"),
  renderDeploys: (sid: string) =>
    request<{ deploys: RenderDeployRec[] }>(`/admin/render/services/${sid}/deploys`),
  renderTriggerDeploy: (sid: string, clear_cache = false) =>
    request<{ ok: boolean; deploy_id?: string; status?: string }>(`/admin/render/services/${sid}/deploys`, { method: "POST", body: JSON.stringify({ clear_cache }) }),
  renderRestart: (sid: string) =>
    request<{ ok: boolean }>(`/admin/render/services/${sid}/restart`, { method: "POST" }),
  renderSuspend: (sid: string) =>
    request<{ ok: boolean }>(`/admin/render/services/${sid}/suspend`, { method: "POST" }),
  renderResume: (sid: string) =>
    request<{ ok: boolean }>(`/admin/render/services/${sid}/resume`, { method: "POST" }),
  renderEnvVars: (sid: string) =>
    request<{ env_vars: RenderEnvVar[] }>(`/admin/render/services/${sid}/env-vars`),
  renderSetEnv: (sid: string, key: string, value: string) =>
    request<{ ok: boolean; key: string }>(`/admin/render/services/${sid}/env-vars/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ value }) }),
  renderDeleteEnv: (sid: string, key: string) =>
    request<{ ok: boolean }>(`/admin/render/services/${sid}/env-vars/${encodeURIComponent(key)}`, { method: "DELETE" }),
  updateMe: (p: ProfilePatch) =>
    request<User>("/auth/me", { method: "PATCH", body: JSON.stringify(p) }),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  registerLocal: (body: { email: string; password: string; name: string; username: string }) =>
    request<{ session_token: string; user: User }>("/auth/register", { method: "POST", body: JSON.stringify(body) }),
  loginLocal: (body: { identifier: string; password: string }) =>
    request<LoginResponse>("/auth/login", { method: "POST", body: JSON.stringify(body) }),
  // Finish a two-factor login with the texted code.
  login2fa: (identifier: string, code: string) =>
    request<{ session_token: string; user: User }>("/auth/login/2fa", { method: "POST", body: JSON.stringify({ identifier, code }) }),
  // Turn SMS two-factor on/off (enable needs a verified phone; disable needs password).
  setTwofa: (enabled: boolean, password?: string) =>
    request<User>("/auth/2fa", { method: "POST", body: JSON.stringify({ enabled, password }) }),
  // Phone OTP login (existing accounts with a verified phone).
  loginPhoneStart: (phone: string) =>
    request<{ exists: boolean; sent?: boolean; masked_phone?: string; dev_code?: string }>("/auth/login/phone/start", { method: "POST", body: JSON.stringify({ phone }) }),
  loginPhoneVerify: (phone: string, code: string) =>
    request<{ session_token: string; user: User }>("/auth/login/phone/verify", { method: "POST", body: JSON.stringify({ phone, code }) }),
  forgotPassword: (email: string) =>
    request<{ ok: boolean; sent: boolean; email_configured: boolean }>("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) }),
  // Reset code via SMS to the account's verified phone.
  forgotPasswordSms: (identifier: string) =>
    request<{ ok: boolean; sent: boolean; sms_configured: boolean; masked_phone?: string | null; dev_code?: string }>("/auth/forgot-password/sms", { method: "POST", body: JSON.stringify({ identifier }) }),
  resetPassword: (email: string, code: string, new_password: string) =>
    request<{ ok: boolean; message?: string }>("/auth/reset-password", { method: "POST", body: JSON.stringify({ email, code, new_password }) }),
  // Reset with a code, identifying the account by email, username, or phone.
  resetPasswordCode: (identifier: string, code: string, new_password: string) =>
    request<{ ok: boolean; message?: string }>("/auth/reset-password/code", { method: "POST", body: JSON.stringify({ identifier, code, new_password }) }),
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
  sendPhoneCode: (phone: string) =>
    request<{ ok: boolean; sent: boolean; dev_code?: string; note?: string }>("/auth/phone/send-code", { method: "POST", body: JSON.stringify({ phone }) }),
  verifyPhoneCode: (code: string) =>
    request<User>("/auth/phone/verify", { method: "POST", body: JSON.stringify({ code }) }),
  sendEmailCode: () =>
    request<{ ok: boolean; sent: boolean; dev_code?: string; note?: string }>("/auth/email/send-code", { method: "POST" }),
  verifyEmailCode: (code: string) =>
    request<User>("/auth/email/verify", { method: "POST", body: JSON.stringify({ code }) }),
  startIdentityVerification: () =>
    request<{ url?: string; client_secret?: string; id?: string; already_verified?: boolean }>("/payments/identity/start", { method: "POST" }),
  identityStatus: () =>
    request<{ status: string; id_verified: boolean }>("/payments/identity/status"),
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
  listWebhookEvents: () =>
    request<{ events: string[]; event_info?: { event: string; description: string }[] }>("/webhooks/events"),
  listWebhooks: () => request<{ webhooks: DevWebhook[] }>("/webhooks"),
  createWebhook: (url: string, events?: string[]) =>
    request<DevWebhook>("/webhooks", { method: "POST", body: JSON.stringify({ url, events }) }),
  testWebhook: (id: string) =>
    request<{ ok: boolean; status: number; error?: string }>(`/webhooks/${id}/test`, { method: "POST" }),
  listWebhookDeliveries: (id: string) =>
    request<{ deliveries: WebhookDelivery[] }>(`/webhooks/${id}/deliveries`),
  redeliverWebhook: (id: string, deliveryId: string) =>
    request<{ ok: boolean; status: number; attempts: number }>(`/webhooks/${id}/deliveries/${deliveryId}/redeliver`, { method: "POST" }),
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
  resolveVideoLink: (url: string) =>
    request<{ url: string; thumbnail?: string | null; embed?: string | null }>("/media/resolve-video", { method: "POST", body: JSON.stringify({ url }) }),
  reelsFeed: (focus?: string, scope?: "explore" | "following") => {
    const qs = new URLSearchParams();
    if (focus) qs.set("focus", focus);
    if (scope) qs.set("scope", scope);
    const s = qs.toString();
    return request<Post[]>(`/feed/reels${s ? `?${s}` : ""}`);
  },
  listUserPostsAll: (uid: string) => request<Post[]>(`/posts/user/${uid}/all`),

  searchUsers: (q: string) => request<PublicUser[]>(`/users/search?q=${encodeURIComponent(q)}`),
  getPublicUser: (id: string) => request<PublicUser>(`/users/${id}/public`),
  adminPatchUser: (userId: string, body: { verified?: boolean; role?: string }) =>
    request<PublicUser>(`/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify(body) }),
  adminListUsers: (q = "", limit = 50, offset = 0) =>
    request<{ users: AdminUser[]; total: number }>(`/admin/users?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`),
  adminBanUser: (userId: string, reason = "") =>
    request<{ ok: boolean }>(`/admin/users/${userId}/ban`, { method: "POST", body: JSON.stringify({ reason }) }),
  adminUnbanUser: (userId: string) =>
    request<{ ok: boolean }>(`/admin/users/${userId}/unban`, { method: "POST" }),
  adminSuspendUser: (userId: string, days: number, reason = "") =>
    request<{ ok: boolean; until: string }>(`/admin/users/${userId}/suspend`, { method: "POST", body: JSON.stringify({ days, reason }) }),
  adminSetRestrictions: (userId: string, body: { messaging_disabled?: boolean; marketplace_disabled?: boolean; posting_disabled?: boolean }) =>
    request<AdminUser>(`/admin/users/${userId}/restrictions`, { method: "POST", body: JSON.stringify(body) }),
  adminRemoveUser: (userId: string) =>
    request<{ ok: boolean }>(`/admin/users/${userId}`, { method: "DELETE" }),
  adminSetWallet: (userId: string, balance: number) =>
    request<{ ok: boolean; balance: number }>(`/admin/users/${userId}/wallet`, { method: "POST", body: JSON.stringify({ balance }) }),
  adminAddTransaction: (userId: string, body: { kind: "topup" | "received" | "sent" | "cashout"; amount: number; note?: string; counterparty?: string; adjust_balance?: boolean; created_at?: string }) =>
    request<{ ok: boolean; id: string; balance: number }>(`/admin/users/${userId}/transaction`, { method: "POST", body: JSON.stringify(body) }),
  adminListTransactions: (userId: string) =>
    request<{ transactions: AdminTxn[] }>(`/admin/users/${userId}/transactions`),
  adminEditTransaction: (userId: string, body: { ref: string; amount?: number; note?: string; counterparty?: string; created_at?: string; adjust_balance?: boolean }) =>
    request<{ ok: boolean; balance: number }>(`/admin/users/${userId}/transaction`, { method: "PATCH", body: JSON.stringify(body) }),
  adminDeleteTransaction: (userId: string, ref: string, adjust_balance: boolean) =>
    request<{ ok: boolean; balance: number }>(`/admin/users/${userId}/transaction?ref=${encodeURIComponent(ref)}&adjust_balance=${adjust_balance}`, { method: "DELETE" }),
  adminAuditLog: () => request<{ entries: AdminAuditEntry[] }>("/admin/audit"),
  adminGetTestPayments: () => request<{ test_payments: boolean; stripe_configured: boolean }>("/admin/test-payments"),
  adminSetTestPayments: (enabled: boolean) =>
    request<{ test_payments: boolean }>("/admin/test-payments", { method: "POST", body: JSON.stringify({ enabled }) }),
  adminResetMoney: () => request<{ ok: boolean }>("/admin/reset/money", { method: "POST" }),
  adminResetAnalytics: () => request<{ ok: boolean }>("/admin/reset/analytics", { method: "POST" }),
  adminGetRevenue: () => request<{ total: number; count: number; by_source: Record<string, number>; platform_fee_percent: number; transaction_fee_cents: number }>("/admin/revenue"),
  getPublicAppConfig: () => request<{ mobile_only: boolean }>("/public/app-config"),
  adminGetMobileOnly: () => request<{ mobile_only: boolean }>("/admin/mobile-only"),
  adminSetMobileOnly: (enabled: boolean) => request<{ mobile_only: boolean }>("/admin/mobile-only", { method: "POST", body: JSON.stringify({ enabled }) }),
  adminGetFees: () => request<{ platform_fee_percent: number; creator_share_percent: number; transaction_fee_cents: number }>("/admin/fees"),
  adminSetFees: (body: { platform_fee_percent?: number; transaction_fee_cents?: number }) =>
    request<{ platform_fee_percent: number; creator_share_percent: number; transaction_fee_cents: number }>("/admin/fees", { method: "POST", body: JSON.stringify(body) }),
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
  // Reel video ads (sponsored full-screen videos in the reels feed)
  createReelAd: (body: { video_url: string; thumbnail?: string | null; headline: string; url?: string; cta?: string; duration?: number; days?: number; cpc?: number }) =>
    request<ReelAd>("/ads/reels", { method: "POST", body: JSON.stringify(body) }),
  getReelAds: () => request<{ ads: ReelAd[] }>("/ads/reels"),
  deleteReelAd: (id: string) => request<{ ok: boolean }>(`/ads/reels/${id}`, { method: "DELETE" }),
  serveReelAd: () => request<{ ad: ReelAd | null }>("/ads/reels/serve"),
  reelAdEvent: (id: string, type: "impression" | "click") =>
    request<{ ok: boolean }>(`/ads/reels/${id}/event`, { method: "POST", body: JSON.stringify({ type }) }),
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
  getPaymentsConfig: () => request<{ enabled: boolean; platform_fee_percent: number; transaction_fee_cents?: number; cashout_min?: number; cashout_fee?: number }>("/payments/config"),
  setupPayouts: () => request<{ url: string }>("/payments/payouts/setup", { method: "POST" }),
  getPayoutStatus: () =>
    request<{
      enabled: boolean; connected: boolean; payouts_enabled: boolean; charges_enabled?: boolean; details_submitted: boolean;
      id_verified?: boolean; hold_until?: string | null;
      has_external_account?: boolean; has_debit_card?: boolean; account_id?: string; account_currency?: string; country?: string;
      debit_card?: { brand?: string; last4?: string } | null; bank_account?: { bank?: string; last4?: string } | null;
      capabilities?: { transfers?: string; card_payments?: string };
      requirements_due?: string[]; requirements_eventually?: string[]; requirements_pending?: string[]; disabled_reason?: string | null;
      platform?: { charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean; requirements_due: string[]; disabled_reason?: string | null } | null;
    }>("/payments/payouts/status"),
  createCheckout: (
    kind: "tip" | "subscription" | "promote",
    creator_id: string,
    amount: number,
    extra?: { post_id?: string; days?: number; conversation_id?: string; note?: string; tier?: string; budget?: number; cpc?: number; embedded?: boolean },
  ) =>
    request<{ url?: string; id: string; client_secret?: string; embedded?: boolean }>("/payments/checkout", {
      method: "POST", body: JSON.stringify({ kind, creator_id, amount, ...(extra || {}) }),
    }),
  payoutAccountSession: () =>
    request<{ client_secret: string; publishable_key: string; components?: string[] }>("/payments/payouts/account-session", { method: "POST" }),
  cashoutToCard: (amount?: number) =>
    request<{ ok: boolean; amount: number; gross?: number; fee?: number; balance: number; currency?: string; local_amount?: number }>("/payments/payouts/cashout", { method: "POST", body: JSON.stringify(amount != null ? { amount } : {}) }),
  addDebitCard: (token: string) =>
    request<{ ok: boolean; has_debit_card: boolean; brand?: string; last4?: string }>("/payments/payouts/debit-card", { method: "POST", body: JSON.stringify({ token }) }),
  addBankAccount: (token: string) =>
    request<{ ok: boolean; has_bank_account: boolean; bank?: string; last4?: string }>("/payments/payouts/bank-account", { method: "POST", body: JSON.stringify({ token }) }),
  getPayoutRequirements: () =>
    request<{
      country?: string; default_currency?: string; payouts_enabled: boolean; details_submitted: boolean;
      currently_due: string[]; needs_document: boolean; tos_accepted: boolean;
      prefill: { first_name?: string; last_name?: string; email?: string; phone?: string; line1?: string; line2?: string; city?: string; state?: string; postal_code?: string; dob_day?: number; dob_month?: number; dob_year?: number };
    }>("/payments/payouts/requirements"),
  submitVerification: (body: Record<string, any>) =>
    request<{ ok: boolean; payouts_enabled: boolean; details_submitted: boolean; currently_due: string[]; needs_document: boolean }>("/payments/payouts/verification", { method: "POST", body: JSON.stringify(body) }),
  uploadVerificationDocument: (front: string, back?: string) =>
    request<{ ok: boolean; payouts_enabled: boolean; needs_document: boolean }>("/payments/payouts/verification-document", { method: "POST", body: JSON.stringify({ front, back }) }),
  createPayIntent: (
    kind: "tip" | "subscription" | "promote",
    creator_id: string,
    amount: number,
    extra?: { post_id?: string; days?: number; conversation_id?: string; note?: string; tier?: string; budget?: number; cpc?: number },
  ) =>
    request<{ client_secret?: string; intent_id?: string; subscription_id?: string; kind: string; publishable_key?: string }>("/payments/pay-intent", {
      method: "POST", body: JSON.stringify({ kind, creator_id, amount, ...(extra || {}) }),
    }),
  confirmPayIntent: (body: { intent_id?: string; subscription_id?: string }) =>
    request<{ ok: boolean; paid: boolean; already?: boolean }>("/payments/pay-intent/confirm", { method: "POST", body: JSON.stringify(body) }),

  listPlaces: () => request<Place[]>("/places"),
  getPlace: (id: string) => request<Place>(`/places/${id}`),
  createPlace: (place: PlaceCreate) =>
    request<Place>("/places", { method: "POST", body: JSON.stringify(place) }),
  deletePlace: (id: string) =>
    request<{ ok: boolean }>(`/places/${id}`, { method: "DELETE" }),

  // ── Custom forms ──────────────────────────────────────────────────────────
  listForms: () => request<{ forms: FormDef[] }>("/forms"),
  createForm: (body: FormCreate) =>
    request<FormDef>("/forms", { method: "POST", body: JSON.stringify(body) }),
  getForm: (id: string) => request<FormDef>(`/forms/${id}`),
  updateForm: (id: string, body: FormCreate) =>
    request<FormDef>(`/forms/${id}`, { method: "POST", body: JSON.stringify(body) }),
  deleteForm: (id: string) =>
    request<{ ok: boolean }>(`/forms/${id}`, { method: "DELETE" }),
  listFormSubmissions: (id: string) =>
    request<{ submissions: FormSubmission[]; total: number; fields: FormField[] }>(`/forms/${id}/submissions`),
  // Raw CSV of all responses (auth required). Returns the file text so the
  // caller can trigger a browser download / share sheet.
  exportFormCsv: async (id: string): Promise<string> => {
    const token = await getToken();
    const res = await fetch(`${BASE_URL}/api/forms/${id}/submissions.csv`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`${res.status}: couldn't export responses`);
    return res.text();
  },
  // Public (no auth needed) — used by the in-app form renderer.
  publicForm: (key: string) =>
    request<{ id: string; title: string; description?: string | null; submit_label?: string; fields: FormField[] }>(`/pub/form?form=${encodeURIComponent(key)}`),
  submitPublicForm: (key: string, values: Record<string, any>) =>
    request<{ ok: boolean }>(`/pub/form-submit?form=${encodeURIComponent(key)}`, { method: "POST", body: JSON.stringify({ values }) }),

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
  // Nearby places matching a query (e.g. all "McDonald's" near you), nearest first.
  fsqSearch: (query: string, lng: number, lat: number, radius = 8000) =>
    request<{ configured: boolean; results: FsqSearchResult[] }>(
      `/foursquare/search?query=${encodeURIComponent(query)}&lng=${lng}&lat=${lat}&radius=${radius}`,
    ),

  getOrCreateConversation: (recipient_user_id: string) =>
    request<ConversationView>("/conversations", {
      method: "POST", body: JSON.stringify({ recipient_user_id }),
    }),
  listConversations: () => request<ConversationView[]>("/conversations"),

  // ── Roadside assistance ──────────────────────────────────────────────────
  roadsideQuote: () => request<RoadsideQuote>("/roadside/quote"),
  roadsideEligibility: () => request<RoadsideEligibility>("/roadside/eligibility"),
  roadsideVerification: () => request<RoadsideVerificationStatus>("/roadside/verification"),
  submitRoadsideVerification: (body: {
    insurance_photo: string; ownership_photo: string;
    vehicle_year?: string; vehicle_make?: string; vehicle_model?: string; note?: string;
  }) => request<{ status: string; verified: boolean; reason?: string | null }>("/roadside/verification", { method: "POST", body: JSON.stringify(body) }),
  adminRoadsideVerifications: (status = "pending") =>
    request<RoadsideAdminVerification[]>(`/admin/roadside/verifications?status=${encodeURIComponent(status)}`),
  decideRoadsideVerification: (id: string, approve: boolean, reason?: string) =>
    request<{ ok: boolean; status: string }>(`/admin/roadside/verifications/${id}/decision`, { method: "POST", body: JSON.stringify({ approve, reason }) }),
  roadsideActive: () => request<RoadsideRequest | null>("/roadside/active"),
  roadsideHelping: () => request<RoadsideRequest | null>("/roadside/helping"),
  roadsideMine: () => request<RoadsideRequest[]>("/roadside/mine"),
  roadsideNearby: (p: { lat: number; lng: number; radius_km?: number }) => {
    const qs = new URLSearchParams({ lat: String(p.lat), lng: String(p.lng) });
    if (p.radius_km != null) qs.set("radius_km", String(p.radius_km));
    return request<RoadsideRequest[]>(`/roadside/nearby?${qs.toString()}`);
  },
  createRoadside: (body: RoadsideCreate) =>
    request<RoadsideRequest>("/roadside/requests", { method: "POST", body: JSON.stringify(body) }),
  editRoadside: (id: string, body: RoadsideCreate) =>
    request<RoadsideRequest>(`/roadside/requests/${id}/edit`, { method: "POST", body: JSON.stringify(body) }),
  getRoadside: (id: string) => request<RoadsideRequest>(`/roadside/requests/${id}`),
  acceptRoadside: (id: string) =>
    request<RoadsideRequest>(`/roadside/requests/${id}/accept`, { method: "POST" }),
  enrouteRoadside: (id: string) =>
    request<RoadsideRequest>(`/roadside/requests/${id}/enroute`, { method: "POST" }),
  arrivedRoadside: (id: string, lng: number, lat: number) =>
    request<RoadsideRequest>(`/roadside/requests/${id}/arrived`, { method: "POST", body: JSON.stringify({ longitude: lng, latitude: lat }) }),
  addRoadsidePhotos: (id: string, phase: "before" | "after", photos: string[]) =>
    request<RoadsideRequest>(`/roadside/requests/${id}/photos`, { method: "POST", body: JSON.stringify({ phase, photos }) }),
  verifyRoadside: (id: string, photos: string[]) =>
    request<RoadsideRequest>(`/roadside/requests/${id}/verify`, { method: "POST", body: JSON.stringify({ photos }) }),
  cancelRoadside: (id: string) =>
    request<RoadsideRequest>(`/roadside/requests/${id}/cancel`, { method: "POST" }),
  roadsideHistory: () => request<RoadsideRequest[]>("/roadside/history"),
  reviewRoadside: (id: string, rating: number, text?: string) =>
    request<RoadsideRequest>(`/roadside/requests/${id}/review`, { method: "POST", body: JSON.stringify({ rating, text }) }),
  disputeRoadside: (id: string) =>
    request<RoadsideRequest>(`/roadside/requests/${id}/dispute`, { method: "POST" }),
  checkRoadsideForm: (body: {
    service?: string; has_location?: boolean; place_name?: string; dest_name?: string;
    fuel_type?: string; fuel_amount?: string;
    vehicle_year?: string; vehicle_make?: string; vehicle_model?: string;
    vehicle_color?: string; vehicle_plate?: string; note?: string;
  }) => request<RoadsideCheckResult>("/roadside/check", { method: "POST", body: JSON.stringify(body) }),
  // Verify a just-taken roadside photo shows the vehicle / the problem.
  checkRoadsidePhoto: (photo: string) =>
    request<{ ok: boolean; reason?: string }>("/roadside/check-photo", {
      method: "POST", body: JSON.stringify({ photo }),
    }),
  // Voice calls (LiveKit). token → join the room; ring → notify the other side.
  callToken: (conversationId: string) =>
    request<{ token: string; url: string; room: string; identity: string }>(
      `/calls/${conversationId}/token`, { method: "POST" }),
  ringCall: (conversationId: string) =>
    request<{ ok: boolean; room: string }>(`/calls/${conversationId}/ring`, { method: "POST" }),
  // Device push tokens (used to ring calls in the background).
  registerPush: (token: string, platform: string, kind = "expo") =>
    request<{ ok: boolean }>("/push/register", { method: "POST", body: JSON.stringify({ token, platform, kind }) }),
  unregisterPush: (token: string) =>
    request<{ ok: boolean }>("/push/register", { method: "DELETE", body: JSON.stringify({ token }) }),

  // Support & disputes
  createTicket: (body: { category: string; subject: string; message: string; related_type?: string; related_id?: string }) =>
    request<SupportTicket>("/support/tickets", { method: "POST", body: JSON.stringify(body) }),
  myTickets: () => request<SupportTicket[]>("/support/tickets"),
  getTicket: (id: string) => request<SupportTicket>(`/support/tickets/${id}`),
  replyTicket: (id: string, text: string) =>
    request<SupportTicket>(`/support/tickets/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
  setTicketStatus: (id: string, status: string) =>
    request<SupportTicket>(`/support/tickets/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }),
  adminTickets: (status?: string) =>
    request<SupportTicket[]>(`/admin/support/tickets${status ? `?status=${status}` : ""}`),
  supportUnreadCount: () => request<{ count: number }>("/support/unread-count"),

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
  clearConversation: (conv_id: string) =>
    request<{ ok: boolean }>(`/conversations/${conv_id}/clear`, { method: "POST" }),
  setConversationTheme: (conv_id: string, theme: string) =>
    request<ConversationView>(`/conversations/${conv_id}/theme`, {
      method: "POST", body: JSON.stringify({ theme }),
    }),
  setDisappearing: (conv_id: string, seconds: number) =>
    request<ConversationView>(`/conversations/${conv_id}/disappearing`, {
      method: "POST", body: JSON.stringify({ seconds }),
    }),

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
  listActivity: () => request<NetworkActivity[]>("/notifications/activity"),
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

  // Public transit — nearby stops + next departures (TransitLand). When a
  // destination is given, only routes that reach it are returned.
  transitNearby: (
    lat: number,
    lon: number,
    opts: { radius?: number; destLat?: number; destLon?: number } = {},
  ) => {
    const p = new URLSearchParams({ lat: String(lat), lon: String(lon) });
    p.set("radius", String(opts.radius ?? 800));
    if (opts.destLat != null && opts.destLon != null) {
      p.set("dest_lat", String(opts.destLat));
      p.set("dest_lon", String(opts.destLon));
    }
    return request<TransitNearby>(`/transit/nearby?${p.toString()}`);
  },
  // How to reach a destination on a given route (where to get off + the walk).
  transitPlan: (routeId: string, destLat: number, destLon: number, boardLat?: number, boardLon?: number) => {
    const p = new URLSearchParams({ route_id: routeId, dest_lat: String(destLat), dest_lon: String(destLon) });
    if (boardLat != null && boardLon != null) { p.set("board_lat", String(boardLat)); p.set("board_lon", String(boardLon)); }
    return request<TransitPlan>(`/transit/plan?${p.toString()}`);
  },

  // Posts / Feed / Follows
  createPost: (body: PostCreate) =>
    request<Post>("/posts", { method: "POST", body: JSON.stringify(body) }),
  editPost: (
    id: string,
    body: {
      text?: string;
      media?: PostMedia[];
      place_name?: string | null;
      place_longitude?: number | null;
      place_latitude?: number | null;
      comment_policy?: string;
      tagged_user_ids?: string[];
    },
  ) => request<Post>(`/posts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  editPostPrivacy: (id: string, body: { likes_disabled?: boolean; comment_policy?: string; min_sub_tier?: number }) =>
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
  // React to a post with any emoji (toggles off if it's already your reaction).
  reactToPost: (id: string, emoji: string) =>
    request<Post>(`/posts/${id}/react`, { method: "POST", body: JSON.stringify({ emoji }) }),
  // Detailed analytics for one of your posts (author/mod/admin only).
  postAnalytics: (id: string) =>
    request<PostAnalytics>(`/posts/${id}/analytics`),
  // "Not interested" — hide this post and feed fewer like it.
  notInterested: (id: string) =>
    request<{ ok: boolean }>(`/posts/${id}/not-interested`, { method: "POST" }),
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
  trendingHashtags: () => request<{ hashtags: { tag: string; count: number }[] }>("/hashtags/trending"),
  popularPosts: () => request<Post[]>("/posts/popular"),
  popularReels: () => request<Post[]>("/reels/popular"),
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
    request<{ ok: boolean; amount: number; status?: string }>("/money/send", { method: "POST", body: JSON.stringify(body) }),
  listMoneyTransfers: () => request<{ incoming: MoneyRequest[]; outgoing: MoneyRequest[] }>("/money/transfers"),
  acceptMoneyTransfer: (id: string) =>
    request<{ ok: boolean; amount: number }>(`/money/transfers/${id}/accept`, { method: "POST" }),
  declineMoneyTransfer: (id: string) =>
    request<{ ok: boolean }>(`/money/transfers/${id}/decline`, { method: "POST" }),
  reverseMoneyTransfer: (id: string) =>
    request<{ ok: boolean }>(`/money/transfers/${id}/reverse`, { method: "POST" }),
  transferHistory: () => request<{ transfers: MoneyRequest[] }>("/money/transfers/history"),
  requestMoney: (body: { to_user_id: string; amount: number; note?: string }) =>
    request<MoneyRequest>("/money/request", { method: "POST", body: JSON.stringify(body) }),
  listMoneyRequests: () => request<{ incoming: MoneyRequest[]; outgoing: MoneyRequest[] }>("/money/requests"),
  payMoneyRequest: (rid: string, answer: string) =>
    request<{ ok: boolean; amount: number }>(`/money/requests/${rid}/pay`, { method: "POST", body: JSON.stringify({ answer }) }),
  declineMoneyRequest: (rid: string) =>
    request<{ ok: boolean }>(`/money/requests/${rid}/decline`, { method: "POST" }),
  cancelMoneyRequest: (rid: string) =>
    request<{ ok: boolean }>(`/money/requests/${rid}/cancel`, { method: "POST" }),
  // Wallet balance + display currency
  getWalletBalance: () => request<WalletBalance>("/wallet/balance"),
  listCurrencies: () => request<{ currencies: Record<string, CurrencyInfo> }>("/currencies"),
  setCurrency: (currency: string) =>
    request<WalletBalance>("/wallet/currency", { method: "POST", body: JSON.stringify({ currency }) }),
  topupWallet: (amount: number, embedded?: boolean) =>
    request<{ url?: string; id?: string; client_secret?: string; embedded?: boolean; ok?: boolean; simulated?: boolean; balance?: number; display?: number; symbol?: string; currency?: string }>(
      "/wallet/topup", { method: "POST", body: JSON.stringify({ amount, embedded: !!embedded }) }),
  confirmTopup: (session_id: string) =>
    request<{ ok: boolean; paid?: boolean; credited?: boolean; balance: number; display: number; symbol: string; currency: string }>(
      "/wallet/topup/confirm", { method: "POST", body: JSON.stringify({ session_id }) }),
  payFromWallet: (body: { kind: "tip" | "subscription"; creator_id: string; amount?: number; tier?: string; note?: string; conversation_id?: string }) =>
    request<{ ok: boolean; amount: number; balance: number }>("/payments/pay-wallet", { method: "POST", body: JSON.stringify(body) }),
  createTopupIntent: (amount: number) =>
    request<{ client_secret: string; publishable_key: string; intent_id: string }>("/wallet/topup/intent", { method: "POST", body: JSON.stringify({ amount }) }),
  confirmTopupIntent: (intent_id: string) =>
    request<{ ok: boolean; paid?: boolean; credited?: boolean; status?: string; balance: number }>("/wallet/topup/confirm-intent", { method: "POST", body: JSON.stringify({ intent_id }) }),
  syncTopups: () =>
    request<{ credited: number; count: number; balance: number; display: number; symbol: string; currency: string }>(
      "/wallet/topup/sync", { method: "POST" }),
  getTopups: () => request<{ topups: Topup[] }>("/wallet/topups"),
  cancelTopup: (id: string) =>
    request<{ ok: boolean; status: string; credited?: boolean }>(`/wallet/topup/${id}/cancel`, { method: "POST" }),
  getActivity: () => request<{ activity: ActivityItem[] }>("/wallet/activity"),
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
  userListings: (userId: string) => request<Listing[]>(`/listings/user/${userId}`),
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
  likeListing: (id: string) =>
    request<Listing>(`/listings/${id}/like`, { method: "POST" }),
  reportListing: (id: string, reason: string) =>
    request<{ ok: boolean }>(`/listings/${id}/report`, { method: "POST", body: JSON.stringify({ reason }) }),
  listingComments: (id: string) =>
    request<ListingComment[]>(`/listings/${id}/comments`),
  addListingComment: (id: string, text: string, parent_id?: string) =>
    request<ListingComment>(`/listings/${id}/comments`, { method: "POST", body: JSON.stringify({ text, parent_id }) }),
  editListingComment: (id: string, commentId: string, text: string) =>
    request<ListingComment>(`/listings/${id}/comments/${commentId}`, { method: "PATCH", body: JSON.stringify({ text }) }),
  likeListingComment: (id: string, commentId: string) =>
    request<ListingComment>(`/listings/${id}/comments/${commentId}/like`, { method: "POST" }),
  deleteListingComment: (id: string, commentId: string) =>
    request<{ ok: boolean }>(`/listings/${id}/comments/${commentId}`, { method: "DELETE" }),
  getSellerProfile: (userId: string) =>
    request<SellerProfile>(`/marketplace/users/${userId}`),
  listSellerReviews: (userId: string) =>
    request<MarketplaceReview[]>(`/marketplace/users/${userId}/reviews`),
  addSellerReview: (userId: string, ratings: Record<string, number>, text: string) =>
    request<MarketplaceReview>(`/marketplace/users/${userId}/reviews`, {
      method: "POST", body: JSON.stringify({ ratings, text }),
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
  contact_email?: string | null;
  contact_phone?: string | null;
  distance_km?: number | null;
  status: string;
  flag_reasons?: string[] | null;
  views_count?: number;
  saved_count?: number;
  saved_by_me?: boolean;
  likes_count?: number;
  liked_by_me?: boolean;
  comments_count?: number;
  created_at: string;
};
export type ListingComment = {
  id: string; listing_id: string; author: PostAuthor; text: string;
  parent_id?: string | null; likes_count?: number; liked_by_me?: boolean;
  replies_count?: number; edited_at?: string | null;
  mine?: boolean; created_at: string;
};
export type ListingCreate = {
  title: string; price?: number; currency?: string; category?: string;
  condition?: string;
  description?: string; photo_base64?: string; photos?: string[];
  longitude?: number; latitude?: number; locality?: string;
  negotiable?: boolean; quantity?: number; brand?: string; delivery?: string;
  contact_email?: string; contact_phone?: string;
};
export type MarketplaceReview = {
  id: string; subject_user_id: string;
  reviewer: PostAuthor;
  rating: number; ratings?: Record<string, number>; verified?: boolean; role?: "seller" | "buyer"; text?: string | null; created_at: string;
};
export type SellerProfile = {
  user: PublicUser;
  rating: number; review_count: number; category_ratings?: Record<string, number>;
  seller_rating?: number; seller_review_count?: number;
  buyer_rating?: number; buyer_review_count?: number;
  listing_count: number;
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
  email_verified?: boolean;
  id_verified?: boolean;
  twofa_enabled?: boolean;
  sms_notifications?: boolean;
  bio?: string;
  location?: string | null;
  pronouns?: string | null;
  birthday?: string | null;
  socials?: Record<string, string> | null;
  home_name?: string | null;
  home_longitude?: number | null;
  home_latitude?: number | null;
  work_name?: string | null;
  work_longitude?: number | null;
  work_latitude?: number | null;
  verified?: boolean;
  role?: string; // user | mod | admin
  messaging_disabled?: boolean;     // admin-imposed restrictions
  marketplace_disabled?: boolean;
  posting_disabled?: boolean;
  sub_price?: number;
  payout_frequency?: string; // biweekly | monthly
  payout_threshold?: number;
  default_comment_policy?: string; // everyone | followers | friends | nobody
  default_likes_disabled?: boolean;
  needs_policy_agreement?: boolean;
};
export type ProfilePatch = {
  name?: string; bio?: string; picture?: string;
  location?: string | null; pronouns?: string | null; birthday?: string | null;
  socials?: Record<string, string>;
  home_name?: string | null; home_longitude?: number | null; home_latitude?: number | null;
  work_name?: string | null; work_longitude?: number | null; work_latitude?: number | null;
  sub_price?: number;
  payout_frequency?: string;
  payout_threshold?: number;
  default_comment_policy?: string;
  default_likes_disabled?: boolean;
  sms_notifications?: boolean;
};
// /auth/login returns either a session (success) or a two-factor challenge.
export type TwofaChallenge = {
  twofa_required: true;
  identifier: string;
  masked_phone: string;
  sent: boolean;
  dev_code?: string;
  note?: string;
};
export type LoginResponse = { session_token: string; user: User } | TwofaChallenge;
export type Integration = {
  key: string;
  name: string;
  category: string;
  required: boolean;
  env: string[];
  env_detail?: { name: string; set: boolean }[];
  summary: string;
  fix: string;
  docs: string;
  configured: boolean;
  can_test: boolean;
  status: "operational" | "configured" | "not_configured" | "optional_off" | "error";
  detail: string;
  tested?: boolean;
  latency_ms?: number;
};
export type IntegrationsReport = {
  integrations: Integration[];
  summary: { total: number; configured: number; needs_setup: number; operational?: number; errors?: number };
  live: boolean;
  only?: string | null;
};
export type RenderService = {
  id: string; name: string; type: string; suspended: boolean;
  auto_deploy?: string; branch?: string; repo?: string;
  url?: string | null; dashboard_url?: string; updated_at?: string;
};
export type RenderDeployRec = {
  id: string; status: string; created_at?: string; finished_at?: string;
  commit_message?: string; commit_id?: string;
};
export type RenderEnvVar = { key: string; value: string };
export type SubTier = { id: string; name: string; price: number };
export type WalletTxn = { id: string; kind: string; amount: number; from_user_id: string; from_name: string; source?: string; message?: string; created_at: string };
export type WalletSummary = {
  currency: string; balance?: number; total_earned: number; tips_total: number; subs_total: number;
  tips_count: number; active_subscribers: number; sub_price: number; recent: WalletTxn[];
  total_spent: number; tips_sent_total: number; subs_sent_total: number;
  subscriptions_count: number; sent: WalletTxn[];
  ads_total?: number;
};
export type CurrencyInfo = { symbol: string; name: string; rate: number };
export type ActivityItem = {
  id: string;
  kind: "topup" | "cashout" | "received" | "sent" | "subscription_paid" | "transfer";
  direction: "in" | "out";
  amount: number;
  status: string;
  title: string;
  subtitle?: string;
  message?: string;
  created_at: string;
};
export type Topup = {
  id: string; amount: number;
  status: "processing" | "completed" | "failed" | "cancelled";
  source: "stripe" | "test"; created_at: string; completed_at?: string | null;
};
export type WalletBalance = {
  currency: string; symbol: string; name: string; rate: number;
  balance: number; display: number; currencies?: Record<string, CurrencyInfo>;
};
export type Payout = { id: string; amount: number; status: string; created_at: string };
export type PayoutInfo = { balance: number; total_paid_out: number; frequency: string; frequency_locked_until?: string | null; threshold_locked_until?: string | null; threshold?: number; next_payout?: string | null; history: Payout[] };
export type Ad = { post_id: string | null; text: string; image?: string | null; author_name: string; reason?: string | null; author_picture?: string | null };
export type AdCampaign = { post_id: string; text: string; impressions: number; clicks: number; ctr: number; budget: number; spent: number; cpc: number; promoted_until?: string | null; active: boolean };
export type LinkAdServe = { id: string; url: string; headline: string; description?: string | null; image?: string | null; owner_id?: string };
export type LinkAd = { id: string; url: string; headline: string; description?: string | null; image?: string | null; cpc: number; impressions: number; clicks: number; ctr: number; spent: number; promoted_until?: string | null; active: boolean };
export type ReelAd = { id: string; owner_id?: string; owner_name: string; video_url: string; thumbnail?: string | null; headline: string; url?: string | null; cta: string; duration: number; cpc: number; impressions: number; clicks: number; ctr?: number; spent: number; promoted_until?: string | null; active: boolean };
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
export type WebhookDelivery = { id: string; event: string; ok: boolean; status: number; attempts: number; error?: string | null; created_at: string };
export type OveragePack = { id: string; name: string; requests: number; price: number };
export type ApiUsage = { plan?: string | null; used: number; quota: number; extra_credits: number; limit: number; resets_at?: string | null; packs: OveragePack[]; stripe_enabled: boolean };
export type FriendStatus = "none" | "request_sent" | "request_received" | "friends";
export type AdminUser = {
  user_id: string; name: string; username?: string | null; email?: string | null;
  picture?: string | null; role: string; verified: boolean; banned: boolean;
  suspended: boolean; suspended_until?: string | null;
  messaging_disabled?: boolean; marketplace_disabled?: boolean; posting_disabled?: boolean;
  created_at?: string;
};
export type AdminAuditEntry = {
  id: string; admin_id: string; admin_name: string; action: string;
  target_id?: string | null; target_name?: string | null; detail?: string; created_at: string;
};
export type AdminTxn = {
  ref: string; kind: "topup" | "received" | "sent" | "cashout"; in: boolean;
  amount: number; counterparty: string; note: string; created_at: string;
};
export type MoneyRequest = {
  id: string; from_user_id: string; to_user_id: string; amount: number; note: string;
  status: "pending" | "paid" | "accepted" | "declined" | "cancelled" | "reversed"; direction: "incoming" | "outgoing";
  other_user: { user_id: string; name: string; username?: string | null; picture?: string | null; verified?: boolean };
  created_at?: string; claimable_at?: string | null; resolved_at?: string | null;
};
export type PublicUser = {
  user_id: string;
  name: string;
  username?: string | null;
  picture?: string | null;
  bio?: string;
  location?: string | null;
  pronouns?: string | null;
  birthday?: string | null;
  socials?: Record<string, string> | null;
  verified?: boolean;
  phone_verified?: boolean;
  email_verified?: boolean;
  id_verified?: boolean;
  role?: string;
  online?: boolean;
  last_seen?: string | null;
  badges?: Badge[];
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
export type FormFieldType = "text" | "email" | "phone" | "number" | "textarea" | "select" | "checkbox" | "radio" | "date" | "time" | "url" | "address" | "password" | "rating" | "heading" | "signature" | "photo" | "consent" | "payment";
export type FormField = {
  id?: string; type: FormFieldType; label: string; required?: boolean;
  placeholder?: string | null; options?: string[] | null; text?: string | null;
  amount?: number | null; amount_open?: boolean | null; currency?: string | null;
};
export type FormDef = {
  id: string; owner_id?: string; form_key: string; title: string;
  description?: string | null; submit_label?: string; notify_email?: string | null; ai_validate?: boolean; fields: FormField[];
  submissions: number; created_at?: string;
};
export type FormCreate = { title: string; description?: string; submit_label?: string; notify_email?: string | null; ai_validate?: boolean; fields: FormField[] };
export type FormSubmission = { id: string; form_id: string; values: Record<string, string>; ip?: string; submitted_at: string };
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
export type FsqSearchResult = {
  fsq_id: string;
  name: string;
  address?: string | null;
  category?: string | null;
  latitude: number;
  longitude: number;
  distance?: number | null;
  rating?: number | null;
  price?: number | null;
};
export type MsgType = "text" | "place" | "media" | "voice" | "post" | "gif" | "file" | "contact" | "tip" | "form";
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
  form_id?: string | null; form_key?: string | null; form_title?: string | null;
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
  expires_at?: string | null;
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
  form_id?: string;
  reply_to?: string;
};
export type ConversationView = {
  id: string;
  kind: "dm" | "group";
  name?: string | null;
  avatar?: string | null;
  theme?: string | null;
  disappearing_seconds?: number;
  other_user?: PublicUser | null;
  members?: PublicUser[];
  owner_id?: string | null;
  listing_id?: string | null;     // set when the DM started from a marketplace listing
  listing_title?: string | null;
  last_message?: Message | null;
  last_message_at?: string | null;
  unread_count?: number;
  created_at: string;
};

export type SupportMessage = { id: string; sender_id: string; is_staff: boolean; text: string; created_at: string };
export type SupportTicket = {
  id: string;
  user_id: string;
  category: string;
  subject: string;
  status: string; // open | awaiting_staff | awaiting_user | resolved | closed
  related_type?: string | null;
  related_id?: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  unread_for_user: boolean;
  user?: PublicUser | null;
  messages?: SupportMessage[];
};

export type RoadsideCheckResult = { ok: boolean; issues: { field: string; message: string }[]; block?: boolean; source?: string };
export type RoadsideService = "tow" | "lockout" | "battery" | "tire" | "gas";
export type RoadsideStatus = "open" | "accepted" | "completed" | "cancelled";
export type RoadsideParty = {
  user_id: string;
  name: string;
  picture?: string | null;
  phone?: string | null;
};
export type RoadsideRequest = {
  id: string;
  requester_id: string;
  requester?: RoadsideParty | null;
  helper_id?: string | null;
  helper?: RoadsideParty | null;
  service: RoadsideService;
  status: RoadsideStatus;
  en_route?: boolean;
  arrived?: boolean;
  longitude: number;
  latitude: number;
  place_name?: string | null;
  vehicle?: string | null;
  vehicle_year?: string | null;
  vehicle_make?: string | null;
  vehicle_model?: string | null;
  vehicle_color?: string | null;
  vehicle_plate?: string | null;
  dest_name?: string | null;
  dest_longitude?: number | null;
  dest_latitude?: number | null;
  fuel_type?: string | null;
  fuel_amount?: string | null;
  fuel_cost?: number;
  photos?: string[];
  before_photos?: string[];
  after_photos?: string[];
  note?: string | null;
  payment_method?: "wallet" | "cash";
  price?: number;
  tax?: number;
  total?: number;
  held?: boolean;
  settled?: boolean;
  refunded?: boolean;
  requester_verified?: boolean;
  helper_verified?: boolean;
  disputed?: boolean;
  distance_km?: number | null;
  mine?: boolean;
  helping?: boolean;
  can_review?: boolean | null;
  can_dispute?: boolean | null;
  my_review?: { rating: number; text?: string | null } | null;
  their_review?: { rating: number; text?: string | null } | null;
  created_at: string;
  accepted_at?: string | null;
  completed_at?: string | null;
};
export type RoadsideCreate = {
  service: RoadsideService;
  longitude: number;
  latitude: number;
  place_name?: string;
  vehicle_year?: string;
  vehicle_make?: string;
  vehicle_model?: string;
  vehicle_color?: string;
  vehicle_plate?: string;
  dest_name?: string;
  dest_longitude?: number;
  dest_latitude?: number;
  fuel_type?: string;
  fuel_amount?: string;
  photos?: string[];
  note?: string;
  payment_method?: "wallet" | "cash";
};
export type RoadsideQuote = {
  base: number;
  tax: number;
  total: number;
  tax_rate: number;
  wallet_balance: number;
};
export type RoadsideRequirement = { key: string; label: string; met: boolean };
export type RoadsideEligibility = {
  eligible: boolean;
  requirements: RoadsideRequirement[];
  missing: string[];
  min_age_days: number;
};
export type RoadsideVerificationStatus = {
  verified: boolean;
  status: "none" | "pending" | "approved" | "rejected";
  reason?: string | null;
  eligibility: RoadsideEligibility;
};
export type RoadsideAdminVerification = {
  id: string;
  user_id: string;
  user: { name: string; picture?: string | null; email?: string | null };
  status: string;
  vehicle?: string | null;
  note?: string | null;
  insurance_photo?: string | null;
  ownership_photo?: string | null;
  created_at: string;
};

export type Notification = {
  id: string;
  user_id: string;
  type: "like" | "repost" | "reply" | "tag" | "message" | "group_invite" | "group_message" | "follow" | "poke"
    | "call" | "support" | "roadside" | "moderation"
    | "money_request" | "money_received" | "money_request_paid" | "money_request_declined"
    | "money_accepted" | "money_declined";
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

export type NetworkActivity = {
  id: string;
  actor_id: string;
  actor_name: string;
  actor_picture?: string | null;
  type: "like" | "comment" | "repost";
  post_id?: string | null;
  target_kind: "post" | "video";
  text?: string | null;
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

export type TransitDeparture = {
  stop_name: string;
  stop_distance?: number | null; // meters from the user to the stop
  stop_id?: string | null;
  board_lat?: number | null;
  board_lon?: number | null;
  route: string;
  route_long?: string;
  route_id?: string | null;
  kind: string; // bus | subway | rail | tram | ferry | …
  headsign?: string;
  time_label?: string; // "HH:MM"
  minutes: number | null;
  realtime: boolean;
  delay?: number | null; // real-time delay vs schedule, seconds (+late / -early)
  iso?: string | null;
};
export type TransitStop = {
  name: string;
  onestop_id: string;
  distance?: number | null;
};
export type TransitNearby = {
  configured: boolean;
  stops: TransitStop[];
  departures: TransitDeparture[];
  filtered?: boolean; // true when results were limited to routes toward the destination
  error?: string;
};
export type TransitPlan = {
  configured: boolean;
  found?: boolean;
  alight?: { name: string; lat: number; lon: number; walk_to_dest_m: number } | null;
  ride_meters?: number | null;
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
export type Badge = { id: string; label?: string; icon: string; color?: string };
export type PostAuthor = { user_id: string; name: string; username?: string | null; picture?: string | null; verified?: boolean; badges?: Badge[]; id_verified?: boolean; phone_verified?: boolean; email_verified?: boolean };
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
export type TaggedUser = {
  user_id: string;
  name: string;
  username?: string | null;
  picture?: string | null;
};
export type Post = {
  id: string; user_id: string; author: PostAuthor; text: string;
  parent_id?: string | null;
  repost_of?: string | null;
  quote_of?: string | null;
  reposted_post?: Post | null;
  quoted_post?: Post | null;
  place_name?: string | null; place_longitude?: number | null; place_latitude?: number | null;
  media?: PostMedia[];
  tagged_users?: TaggedUser[];
  link_preview?: LinkPreview | null;
  poll?: Poll | null;
  hashtags?: string[];
  likes_count: number; dislikes_count?: number; replies_count: number; reposts_count?: number;
  reactions?: { emoji: string; count: number }[];
  reactions_total?: number;
  my_reaction?: string | null;
  quotes_count?: number;
  // note: PostAnalytics type is declared after the Post type below

  bookmarks_count?: number;
  views_count?: number;
  likes_disabled?: boolean;
  comment_policy?: string;
  min_sub_tier?: number;   // 0 = public; 1-3 = subscribers-only
  locked?: boolean;        // gated content the viewer hasn't unlocked
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
export type PostAnalytics = {
  post_id: string;
  created_at?: string;
  impressions: number;
  unique_viewers: number;
  clicks: number;
  reactions_total: number;
  reactions: { emoji: string; count: number }[];
  comments: number;
  reposts: number;
  quotes: number;
  bookmarks: number;
  interactions: number;
  engagement_rate: number; // interactions / impressions
  promoted: boolean;
  ad?: { impressions: number; clicks: number; spent: number; budget?: number | null; cpc?: number | null } | null;
};
export type PostCreate = {
  text?: string; parent_id?: string;
  quote_of?: string;
  place_name?: string; place_longitude?: number; place_latitude?: number;
  media?: PostMedia[];
  poll?: PollCreate;
  community_id?: string; title?: string;
  likes_disabled?: boolean;
  comment_policy?: string;
  min_sub_tier?: number;   // 0 = public; 1-3 = subscribers-only
  tagged_user_ids?: string[];
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
