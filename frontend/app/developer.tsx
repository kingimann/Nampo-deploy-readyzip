import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  ActivityIndicator, Platform, Alert, Linking,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import * as Clipboard from "expo-clipboard";
import { api, ApiKey, DevWebhook, OAuthApp, WebhookDelivery } from "@/src/api/client";
import { theme } from "@/src/theme";

const BASE = (process.env.EXPO_PUBLIC_BACKEND_URL as string) || "https://nampo-backend.onrender.com";
const API_BASE = `${BASE}/api/v1`;

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Endpoint = { method: Method; path: string; desc: string; body?: string; auth?: boolean };
type Group = { title: string; icon: keyof typeof import("@expo/vector-icons/build/Ionicons").default.glyphMap; endpoints: Endpoint[] };

const GROUPS: Group[] = [
  {
    title: "Forms", icon: "document-text",
    endpoints: [
      { method: "POST", path: "/forms", desc: "Create a form.", auth: true, body: `{"title","description","notify_email","fields":[{"type","label","required","options"}]}` },
      { method: "GET", path: "/forms", desc: "List your forms.", auth: true },
      { method: "GET", path: "/forms/{id}", desc: "Get a form definition.", auth: true },
      { method: "POST", path: "/forms/{id}", desc: "Update a form (title, fields, notify_email, …).", auth: true },
      { method: "DELETE", path: "/forms/{id}", desc: "Delete a form and its responses.", auth: true },
      { method: "GET", path: "/forms/{id}/submissions", desc: "List responses (paginated).", auth: true },
      { method: "GET", path: "/forms/{id}/submissions.csv", desc: "Download all responses as CSV.", auth: true },
      { method: "GET", path: "/pub/form?form=KEY", desc: "Public: get a form's fields (no auth).", auth: false },
      { method: "POST", path: "/pub/form-submit?form=KEY", desc: "Public: submit a form (no auth). Fires the form.submission webhook.", auth: false, body: `{"values":{...},"hp":""}` },
      { method: "GET", path: "/pub/form-embed.js?form=KEY", desc: "Public: <script> loader; theme via data-theme/accent/bg/radius/redirect/prefill.", auth: false },
      { method: "GET", path: "/pub/form-unit?form=KEY", desc: "Public: hosted form page. Params: theme, accent, bg, radius, hide_title, redirect, pf_<id>.", auth: false },
    ],
  },
  {
    title: "Authentication", icon: "key",
    endpoints: [
      { method: "POST", path: "/auth/register", desc: "Create an account. Returns a session_token + user.", body: `{"email","password","name","username"}` },
      { method: "POST", path: "/auth/login", desc: "Log in with email or username. Returns session_token + user.", body: `{"identifier","password"}` },
      { method: "GET", path: "/auth/me", desc: "Get the current authenticated user.", auth: true },
      { method: "PATCH", path: "/auth/me", desc: "Update profile (name, bio, picture, home/work, sub_price).", auth: true, body: `{"name","bio",...}` },
      { method: "POST", path: "/auth/logout", desc: "Invalidate the current session token.", auth: true },
    ],
  },
  {
    title: "Posts & Feed", icon: "newspaper",
    endpoints: [
      { method: "GET", path: "/posts/feed", desc: "Home feed of posts (paginated).", auth: true },
      { method: "POST", path: "/posts", desc: "Create a post. Supports text, media[], poll, parent_id (reply), quote_of, community_id.", auth: true, body: `{"text","media":[{"type","url"}]}` },
      { method: "GET", path: "/posts/{id}", desc: "Fetch a single post with its replies.", auth: true },
      { method: "DELETE", path: "/posts/{id}", desc: "Delete one of your posts.", auth: true },
      { method: "POST", path: "/posts/{id}/like", desc: "Toggle like (blocked when likes are disabled on the post).", auth: true },
      { method: "POST", path: "/posts/{id}/bookmark", desc: "Toggle bookmark on a post.", auth: true },
      { method: "POST", path: "/posts/{id}/repost", desc: "Toggle repost.", auth: true },
      { method: "POST", path: "/posts/{id}/promote", desc: "Promote a post (days, optional budget/cpc).", auth: true, body: `{"days":7}` },
      { method: "POST", path: "/posts/{id}/view", desc: "Record a unique view.", auth: true },
      { method: "GET", path: "/posts/{id}/viewers", desc: "Who viewed the post (author only).", auth: true },
      { method: "PATCH", path: "/posts/{id}/privacy", desc: "Per-post likes_disabled + comment_policy.", auth: true, body: `{"likes_disabled":false,"comment_policy":"everyone"}` },
      { method: "GET", path: "/hashtags/trending", desc: "Most-used hashtags in the last 30 days.", auth: true },
    ],
  },
  {
    title: "Users & Social", icon: "people",
    endpoints: [
      { method: "GET", path: "/users/search?q=", desc: "Search users by name or username.", auth: true },
      { method: "GET", path: "/users/{user_id}/posts", desc: "List a user's posts.", auth: true },
      { method: "POST", path: "/users/{user_id}/follow", desc: "Toggle follow on a user.", auth: true },
      { method: "POST", path: "/friends/request/{user_id}", desc: "Send a friend request.", auth: true },
      { method: "POST", path: "/friends/accept/{user_id}", desc: "Accept a friend request.", auth: true },
      { method: "POST", path: "/users/{user_id}/tip", desc: "Send a tip to a user.", auth: true, body: `{"amount","message"}` },
      { method: "POST", path: "/users/{user_id}/poke", desc: "Poke a user (Facebook-style).", auth: true },
      { method: "GET", path: "/subscription-tiers", desc: "The three fixed subscription tiers.", auth: true },
      { method: "POST", path: "/users/{user_id}/subscribe", desc: "Subscribe to a user (choose a tier).", auth: true, body: `{"tier":"plus"}` },
      { method: "GET", path: "/wallet", desc: "Your wallet: earnings, subscribers, and money sent.", auth: true },
    ],
  },
  {
    title: "Communities", icon: "chatbubbles",
    endpoints: [
      { method: "GET", path: "/communities", desc: "List/search communities.", auth: true },
      { method: "POST", path: "/communities", desc: "Create a community.", auth: true, body: `{"name","title","description"}` },
      { method: "GET", path: "/communities/{name}", desc: "Get a community by handle.", auth: true },
      { method: "POST", path: "/communities/{name}/join", desc: "Join a community.", auth: true },
      { method: "GET", path: "/communities/{name}/posts?sort=hot", desc: "List threads (hot | new | top).", auth: true },
    ],
  },
  {
    title: "Marketplace", icon: "pricetag",
    endpoints: [
      { method: "GET", path: "/listings", desc: "Browse listings (filter by category, location, radius).", auth: true },
      { method: "POST", path: "/listings", desc: "Create a listing.", auth: true, body: `{"title","price","category","photos":[]}` },
      { method: "GET", path: "/listings/{id}", desc: "Get a single listing.", auth: true },
      { method: "DELETE", path: "/listings/{id}", desc: "Remove your listing.", auth: true },
    ],
  },
  {
    title: "Messaging", icon: "send",
    endpoints: [
      { method: "GET", path: "/conversations", desc: "List your conversations.", auth: true },
      { method: "POST", path: "/conversations", desc: "Open/create a DM with a user.", auth: true, body: `{"recipient_user_id"}` },
      { method: "POST", path: "/conversations/groups", desc: "Create a group chat.", auth: true, body: `{"name","member_ids":[]}` },
      { method: "GET", path: "/conversations/{id}/messages", desc: "Fetch messages (each has delivered_at / read_at).", auth: true },
      { method: "POST", path: "/conversations/{id}/messages", desc: "Send a message (text, media, voice, place, post, gif, file, contact, tip).", auth: true, body: `{"type":"text","text"}` },
      { method: "POST", path: "/conversations/{id}/read", desc: "Mark the conversation read (read receipts).", auth: true },
      { method: "POST", path: "/conversations/{id}/presence", desc: "Heartbeat — am I here / typing (Snapchat-style).", auth: true, body: `{"typing":true}` },
      { method: "GET", path: "/conversations/{id}/presence", desc: "Peer state: { typing, active }.", auth: true },
      { method: "POST", path: "/auth/keys", desc: "Publish your E2E X25519 public key.", auth: true, body: `{"public_key"}` },
      { method: "GET", path: "/users/{id}/key", desc: "Fetch a peer's E2E public key.", auth: true },
    ],
  },
  {
    title: "Money (P2P)", icon: "swap-horizontal",
    endpoints: [
      { method: "GET", path: "/money/security", desc: "Whether your transfer security question is set.", auth: true },
      { method: "POST", path: "/money/security", desc: "Set the sender's security question + answer.", auth: true, body: `{"question","answer"}` },
      { method: "POST", path: "/money/send", desc: "Send money → pending transfer the recipient accepts.", auth: true, body: `{"to_user_id","amount","answer"}` },
      { method: "GET", path: "/money/transfers", desc: "Incoming (to accept) + outgoing transfers.", auth: true },
      { method: "POST", path: "/money/transfers/{id}/accept", desc: "Accept money sent to you (decline also available).", auth: true },
      { method: "POST", path: "/money/request", desc: "Request money from someone.", auth: true, body: `{"to_user_id","amount","note"}` },
      { method: "GET", path: "/money/requests", desc: "Incoming + outgoing money requests.", auth: true },
      { method: "POST", path: "/money/requests/{id}/pay", desc: "Pay a request (needs your security answer).", auth: true, body: `{"answer"}` },
    ],
  },
  {
    title: "Ads & Advertising", icon: "megaphone",
    endpoints: [
      { method: "GET", path: "/ads/next?placement=feed&slot=0", desc: "Next sponsored post for a slot.", auth: true },
      { method: "POST", path: "/ads/{id}/event", desc: "Record an impression or click.", auth: true, body: `{"type":"click","host_user_id"}` },
      { method: "GET", path: "/ads/campaigns", desc: "Analytics for your promoted posts.", auth: true },
      { method: "GET", path: "/ads/account", desc: "Prepaid ad-account balance + rates.", auth: true },
      { method: "POST", path: "/ads/account/topup", desc: "Add funds to your ad account.", auth: true, body: `{"amount":25}` },
      { method: "POST", path: "/ads/links", desc: "Advertise a link to your website.", auth: true, body: `{"url","headline","days":7}` },
      { method: "GET", path: "/ads/links", desc: "Your link ads + analytics.", auth: true },
    ],
  },
  {
    title: "Publisher Network", icon: "globe",
    endpoints: [
      { method: "POST", path: "/pub/sites", desc: "Register a site to show Nami ads & earn. Returns a site_key.", auth: true, body: `{"name","domain"}` },
      { method: "GET", path: "/pub/sites", desc: "Your publisher sites + earnings.", auth: true },
      { method: "DELETE", path: "/pub/sites/{id}", desc: "Remove a publisher site.", auth: true },
      { method: "GET", path: "/pub/embed.js?site=KEY", desc: "Drop-in <script> embed; style via data-theme/accent/radius/label/width/height.", auth: false },
      { method: "GET", path: "/pub/unit?site=KEY", desc: "Hosted ad unit. Params: theme, accent, radius, label.", auth: false },
      { method: "GET", path: "/pub/ad?site=KEY", desc: "Public JSON ad for custom integrations.", auth: false },
    ],
  },
  {
    title: "Webhooks", icon: "git-network",
    endpoints: [
      { method: "GET", path: "/webhooks/events", desc: "List subscribable event types + descriptions.", auth: false },
      { method: "GET", path: "/webhooks", desc: "Your registered webhooks.", auth: true },
      { method: "POST", path: "/webhooks", desc: "Register an endpoint (Pro+). Returns a signing secret once.", auth: true, body: `{"url","events":[]}` },
      { method: "POST", path: "/webhooks/{id}/test", desc: "Send a signed sample ping; returns your endpoint's status.", auth: true },
      { method: "GET", path: "/webhooks/{id}/deliveries", desc: "Recent delivery attempts (status, retries, errors).", auth: true },
      { method: "POST", path: "/webhooks/{id}/deliveries/{delivery_id}/redeliver", desc: "Re-send a past delivery's original payload.", auth: true },
      { method: "DELETE", path: "/webhooks/{id}", desc: "Delete a webhook.", auth: true },
    ],
  },
  {
    title: "Embed content", icon: "share-social",
    endpoints: [
      { method: "GET", path: "/pub/post/{id}", desc: "Public JSON for a post (public posts only).", auth: false },
      { method: "GET", path: "/pub/profile/{username}", desc: "Public JSON for a user profile.", auth: false },
      { method: "GET", path: "/pub/profile/{username}/posts", desc: "A user's public posts (cursor paginated: ?limit=&cursor=).", auth: false },
      { method: "GET", path: "/pub/listing/{id}", desc: "Public JSON for an active marketplace listing.", auth: false },
      { method: "GET", path: "/pub/guide/{slug}", desc: "Public JSON for a public guide (places + owner).", auth: false },
      { method: "GET", path: "/pub/community/{name}", desc: "Public JSON for a community (title, members).", auth: false },
      { method: "GET", path: "/pub/post-card?post=ID", desc: "Themeable iframe card for a post (theme/accent/radius).", auth: false },
      { method: "GET", path: "/pub/profile-card?profile=USER", desc: "Themeable iframe card for a profile.", auth: false },
      { method: "GET", path: "/pub/listing-card?listing=ID", desc: "Themeable iframe card for a listing.", auth: false },
      { method: "GET", path: "/pub/guide-card?guide=SLUG", desc: "Themeable iframe card for a guide.", auth: false },
      { method: "GET", path: "/pub/community-card?community=NAME", desc: "Themeable iframe card for a community.", auth: false },
      { method: "GET", path: "/pub/content-embed.js", desc: "<script> loader; data-post / -profile / -listing / -guide / -community + data-theme/accent/radius.", auth: false },
      { method: "GET", path: "/pub/oembed?url=URL", desc: "oEmbed provider — paste a Nami link into WordPress/Discourse to auto-embed.", auth: false },
    ],
  },
  {
    title: "Login with Nami (OAuth2)", icon: "log-in",
    endpoints: [
      { method: "GET", path: "/oauth/apps", desc: "List your OAuth client apps.", auth: true },
      { method: "POST", path: "/oauth/apps", desc: "Register an OAuth client.", auth: true, body: `{"name","redirect_uris":[]}` },
      { method: "GET", path: "/oauth/authorize", desc: "Authorization endpoint (code flow).", auth: true },
      { method: "POST", path: "/oauth/token", desc: "Exchange a code for an access token.", auth: false, body: `{"grant_type":"authorization_code","code"}` },
      { method: "GET", path: "/oauth/userinfo", desc: "Profile for a Login-with-Nami token.", auth: true },
    ],
  },
  {
    title: "Places & Directions", icon: "map",
    endpoints: [
      { method: "GET", path: "/places/search?q=", desc: "Search saved/known places.", auth: true },
      { method: "GET", path: "/places", desc: "List your saved places.", auth: true },
      { method: "POST", path: "/eta", desc: "Create a shareable live-ETA link.", auth: true, body: `{"destination_name","eta_minutes"}` },
      { method: "POST", path: "/eta/{id}/update", desc: "Push a live location update to an ETA share.", auth: true },
      { method: "GET", path: "/public/eta/{share_id}", desc: "Public ETA status (no auth).", auth: false },
    ],
  },
  {
    title: "Stories", icon: "ellipse",
    endpoints: [
      { method: "GET", path: "/stories/tray", desc: "Story tray (who has active stories).", auth: true },
      { method: "POST", path: "/stories", desc: "Post a 24h story.", auth: true, body: `{"media":{"type","url"}}` },
      { method: "POST", path: "/stories/{id}/view", desc: "Mark a story viewed.", auth: true },
    ],
  },
  {
    title: "Notifications", icon: "notifications",
    endpoints: [
      { method: "GET", path: "/notifications", desc: "Your notification feed.", auth: true },
      { method: "GET", path: "/notifications/unread", desc: "Unread count.", auth: true },
      { method: "POST", path: "/notifications/read-all", desc: "Mark all as read.", auth: true },
    ],
  },
  {
    title: "Payments", icon: "card",
    endpoints: [
      { method: "GET", path: "/payments/config", desc: "Whether real (Stripe) payments are enabled.", auth: true },
      { method: "POST", path: "/payments/payouts/setup", desc: "Start Stripe Connect payout onboarding.", auth: true },
      { method: "GET", path: "/payments/payouts/status", desc: "Your payout-account status.", auth: true },
      { method: "POST", path: "/payments/checkout", desc: "Create a checkout (tip / subscription / promote).", auth: true, body: `{"kind","creator_id","amount"}` },
    ],
  },
  {
    title: "Meta", icon: "information-circle",
    endpoints: [
      { method: "GET", path: "/version", desc: "API name + version.", auth: false },
      { method: "GET", path: "/v1/info", desc: "Machine-readable API overview & capabilities.", auth: false },
    ],
  },
];

type Lang = "curl" | "js" | "python" | "dart";
const SAMPLE: Record<Lang, (base: string) => string> = {
  curl: (b) => `curl ${b}/posts/feed \\\n  -H "Authorization: Bearer $NAMI_KEY"`,
  js: (b) => `const res = await fetch("${b}/posts/feed", {\n  headers: { Authorization: \`Bearer \${process.env.NAMI_KEY}\` },\n});\nconst feed = await res.json();`,
  python: (b) => `import requests\nr = requests.get(\n  "${b}/posts/feed",\n  headers={"Authorization": f"Bearer {NAMI_KEY}"},\n)\nfeed = r.json()`,
  dart: (b) => `import 'package:http/http.dart' as http;\nimport 'dart:convert';\n\nfinal res = await http.get(\n  Uri.parse("${b}/posts/feed"),\n  headers: {"Authorization": "Bearer $NAMI_KEY"},\n);\nfinal feed = jsonDecode(res.body);`,
};
const LANG_LABEL: Record<Lang, string> = { curl: "cURL", js: "JavaScript", python: "Python", dart: "Dart / Flutter" };

const METHOD_COLOR: Record<Method, string> = {
  GET: "#22C55E", POST: "#0EA5E9", PATCH: "#EAB308", DELETE: "#F15C6D",
};

// Drop-in embed examples for the "Embed & SDKs" section. Customizable via
// data-* attributes (web) or query params (anywhere, incl. a Flutter WebView).
const EMBED_SNIPPET = `<script async
  src="${BASE}/api/pub/form-embed.js?form=YOUR_FORM_KEY"
  data-theme="dark"
  data-accent="7C3AED"
  data-height="620"
  data-redirect="https://yoursite.com/thanks"
  data-prefill='{"email":"user@site.com"}'>
</script>`;
const FLUTTER_WEBVIEW = `// pubspec.yaml → webview_flutter: ^4.0.0
import 'package:webview_flutter/webview_flutter.dart';

final c = WebViewController()
  ..loadRequest(Uri.parse(
    "${BASE}/api/pub/form-unit?form=YOUR_FORM_KEY"
    "&theme=dark&accent=7C3AED"));

// in build(): WebViewWidget(controller: c)`;
const CONTENT_SNIPPET = `<!-- Embed a Nami post, profile, listing, guide, or community -->
<!-- swap data-post for data-profile / data-listing / data-guide / data-community -->
<script async src="${BASE}/api/pub/content-embed.js"
  data-post="POST_ID" data-theme="dark" data-accent="7C3AED"></script>`;
const WEBHOOK_VERIFY = `// Verify the X-Nami-Signature header (Node / Express)
import crypto from "crypto";

app.post("/hook", express.raw({ type: "*/*" }), (req, res) => {
  const sig = req.header("X-Nami-Signature") || "";           // "sha256=<hex>"
  const expected = "sha256=" + crypto
    .createHmac("sha256", process.env.NAMI_WEBHOOK_SECRET)
    .update(req.body)                                          // the RAW body
    .digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
    return res.status(401).end();
  const event = JSON.parse(req.body);                          // { event, data, created_at }
  res.sendStatus(200);
});`;
const EMBED_ATTRS: [string, string][] = [
  ["theme", "light (default) or dark"],
  ["accent", "button colour, 3/6-digit hex (no #)"],
  ["bg", "background colour, hex"],
  ["radius", "corner radius in px (0–28)"],
  ["hide_title", "1 to hide the title & description"],
  ["redirect", "URL to send users to after submit"],
  ["pf_<field_id>", "pre-fill a field (query param)"],
];

export default function DeveloperScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [openGroup, setOpenGroup] = useState<string | null>("Authentication");
  const [lang, setLang] = useState<Lang>("curl");
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof api.getApiPlan>> | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [writeScope, setWriteScope] = useState(true);
  const [webhooks, setWebhooks] = useState<DevWebhook[]>([]);
  const [whUrl, setWhUrl] = useState("");
  const [whBusy, setWhBusy] = useState(false);
  const [whTesting, setWhTesting] = useState<string | null>(null);
  const [whEvents, setWhEvents] = useState<{ event: string; description: string }[]>([]);
  const [whSelected, setWhSelected] = useState<string[]>([]);
  const [openLogs, setOpenLogs] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, WebhookDelivery[]>>({});
  const [logsBusy, setLogsBusy] = useState(false);
  const [redelivering, setRedelivering] = useState<string | null>(null);
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof api.getApiUsage>> | null>(null);
  const [buyingPack, setBuyingPack] = useState<string | null>(null);
  const [oauthApps, setOauthApps] = useState<OAuthApp[]>([]);
  const [appName, setAppName] = useState("");
  const [appUri, setAppUri] = useState("");
  const [appBusy, setAppBusy] = useState(false);
  const [freshApp, setFreshApp] = useState<{ client_id: string; client_secret: string } | null>(null);

  const active = !!plan?.current.active;
  const planFeatures = plan?.plans.find((p) => p.id === plan?.current.plan);

  const load = useCallback(async () => {
    try { setKeys((await api.listApiKeys()).keys); } catch {} finally { setLoading(false); }
    try { setPlan(await api.getApiPlan()); } catch {}
    try { setWebhooks((await api.listWebhooks()).webhooks); } catch {}
    try {
      const r = await api.listWebhookEvents();
      setWhEvents(r.event_info || (r.events || []).map((e) => ({ event: e, description: "" })));
    } catch {}
    try { setUsage(await api.getApiUsage()); } catch {}
    try { setOauthApps((await api.listOAuthApps()).apps); } catch {}
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const createOAuthApp = async () => {
    if (!appName.trim() || !appUri.trim()) return;
    setAppBusy(true);
    try {
      const res = await api.createOAuthApp(appName.trim(), [appUri.trim()]);
      setFreshApp(res);
      setAppName(""); setAppUri("");
      await load();
    } catch (e: any) {
      Alert.alert("Couldn't create app", errText(e));
    } finally { setAppBusy(false); }
  };
  const removeOAuthApp = (clientId: string) => {
    Alert.alert("Delete OAuth app", "Sites using it will stop being able to sign users in.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => { try { await api.deleteOAuthApp(clientId); await load(); } catch {} } },
    ]);
  };

  const buyPack = async (packId: string) => {
    setBuyingPack(packId);
    try {
      if (usage?.stripe_enabled) {
        const { url } = await api.buyUsage(packId);
        await Linking.openURL(url);
      } else {
        await api.activateUsage(packId);
        await load();
      }
    } catch (e: any) {
      Alert.alert("Couldn't buy pack", errText(e));
    } finally { setBuyingPack(null); }
  };

  const copy = async (text: string, what = "Copied") => {
    try { await Clipboard.setStringAsync(text); Alert.alert(what, "Copied to clipboard."); } catch {}
  };

  const buyPlan = async (planId: string) => {
    setBuying(planId);
    try {
      if (plan?.stripe_enabled) {
        const { url } = await api.apiPlanCheckout(planId);
        await Linking.openURL(url);
      } else {
        await api.apiPlanActivate(planId);   // test mode
        await load();
      }
    } catch (e: any) {
      Alert.alert("Couldn't start plan", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setBuying(null); }
  };

  const generate = async () => {
    setCreating(true);
    try {
      const scopes = writeScope && planFeatures?.write ? ["read", "write"] : ["read"];
      const res = await api.createApiKey(label.trim() || "API key", scopes);
      setFreshToken(res.token);
      setLabel("");
      await load();
    } catch (e: any) {
      Alert.alert("Couldn't create key", errText(e));
    } finally { setCreating(false); }
  };

  const addWebhook = async () => {
    if (!whUrl.trim()) return;
    setWhBusy(true);
    try {
      const w = await api.createWebhook(whUrl.trim(), whSelected.length ? whSelected : undefined);
      setFreshSecret(w.secret || null);
      setWhUrl(""); setWhSelected([]);
      await load();
    } catch (e: any) {
      Alert.alert("Couldn't add webhook", errText(e));
    } finally { setWhBusy(false); }
  };

  const toggleEvent = (e: string) =>
    setWhSelected((s) => (s.includes(e) ? s.filter((x) => x !== e) : [...s, e]));

  const loadLogs = async (id: string) => {
    try { const r = await api.listWebhookDeliveries(id); setLogs((m) => ({ ...m, [id]: r.deliveries })); } catch {}
  };

  const toggleLogs = async (id: string) => {
    if (openLogs === id) { setOpenLogs(null); return; }
    setOpenLogs(id);
    if (!logs[id]) { setLogsBusy(true); try { await loadLogs(id); } finally { setLogsBusy(false); } }
  };

  const redeliver = async (webhookId: string, deliveryId: string) => {
    setRedelivering(deliveryId);
    try {
      const r = await api.redeliverWebhook(webhookId, deliveryId);
      await loadLogs(webhookId);
      Alert.alert(r.ok ? "Re-sent" : "Re-send failed", r.ok ? `Your endpoint replied ${r.status}.` : r.status ? `Your endpoint replied ${r.status}.` : "Couldn't reach the endpoint.");
    } catch (e: any) {
      Alert.alert("Re-send failed", errText(e));
    } finally { setRedelivering(null); }
  };

  const removeWebhook = (id: string) => {
    Alert.alert("Delete webhook", "Stop sending events to this URL?", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => { try { await api.deleteWebhook(id); await load(); } catch {} } },
    ]);
  };

  const testWebhook = async (id: string) => {
    setWhTesting(id);
    try {
      const r = await api.testWebhook(id);
      Alert.alert(
        r.ok ? "Test delivered" : "Test failed",
        r.ok ? `Your endpoint replied ${r.status}. Check for the signed "ping" event.`
             : r.status ? `Your endpoint replied ${r.status}.` : `Couldn't reach the endpoint.${r.error ? `\n${r.error}` : ""}`,
      );
    } catch (e: any) {
      Alert.alert("Test failed", errText(e));
    } finally { setWhTesting(null); }
  };

  const revoke = (k: ApiKey) => {
    Alert.alert("Revoke key", `Revoke "${k.label}"? Apps using it will stop working.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Revoke", style: "destructive", onPress: async () => { try { await api.revokeApiKey(k.id); await load(); } catch {} } },
    ]);
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="developer-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn} testID="developer-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Developer API</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
        <Text style={styles.lede}>
          Build on top of Nami. The REST API uses JSON over HTTPS and bearer-token auth.
        </Text>
        <View style={styles.docLinks}>
          <TouchableOpacity style={styles.docLink} onPress={() => Linking.openURL(`${BASE}/docs`)} testID="open-swagger">
            <Ionicons name="book-outline" size={15} color={theme.primary} />
            <Text style={styles.docLinkText}>Interactive docs</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.docLink} onPress={() => Linking.openURL(`${BASE}/openapi.json`)} testID="open-openapi">
            <Ionicons name="code-download-outline" size={15} color={theme.primary} />
            <Text style={styles.docLinkText}>OpenAPI schema</Text>
          </TouchableOpacity>
        </View>

        {/* Base URL + auth */}
        <Text style={styles.groupTitle}>Base URL</Text>
        <TouchableOpacity style={styles.codeRow} onPress={() => copy(API_BASE, "Base URL")} activeOpacity={0.7}>
          <Text style={styles.code} selectable>{API_BASE}</Text>
          <Ionicons name="copy-outline" size={16} color={theme.textMuted} />
        </TouchableOpacity>
        <Text style={[styles.body, { marginTop: 8 }]}>
          Versioned and stable — build against <Text style={styles.codeInline}>/api/v1</Text>. The unversioned <Text style={styles.codeInline}>/api</Text> still works as a legacy alias.
        </Text>

        <Text style={styles.groupTitle}>Authentication</Text>
        <Text style={styles.body}>
          Send your API key (or a session token) as a bearer token on every request:
        </Text>
        <TouchableOpacity style={styles.codeRow} onPress={() => copy("Authorization: Bearer YOUR_API_KEY", "Header")} activeOpacity={0.7}>
          <Text style={styles.code} selectable>Authorization: Bearer YOUR_API_KEY</Text>
          <Ionicons name="copy-outline" size={16} color={theme.textMuted} />
        </TouchableOpacity>

        {/* Plan */}
        <Text style={styles.groupTitle}>Your plan</Text>
        {active ? (
          <View style={styles.planActive}>
            <Ionicons name="checkmark-circle" size={18} color={theme.primary} />
            <Text style={styles.planActiveText}>
              {plan?.current.name} active{plan?.current.until ? ` · renews ${fmtDate(plan.current.until)}` : ""}
            </Text>
          </View>
        ) : (
          <Text style={styles.body}>
            The Developer API is a paid add-on — higher tiers unlock more keys, write access, webhooks and rate limits.
            {plan && !plan.stripe_enabled ? " (Test mode — no real charge.)" : ""}
          </Text>
        )}
        <View style={styles.planRow}>
          {(plan?.plans || []).map((p) => {
            const isCurrent = active && plan?.current.plan === p.id;
            return (
              <View key={p.id} style={[styles.planCard, isCurrent && styles.planCardOn]}>
                <Text style={styles.planName}>{p.name}</Text>
                <Text style={styles.planPrice}>${p.price.toFixed(2)}<Text style={styles.planPer}>/mo</Text></Text>
                <Text style={styles.planFeat}>{p.max_keys} API keys</Text>
                <Text style={styles.planFeat}>{p.write ? "Read + write" : "Read-only"}</Text>
                <Text style={styles.planFeat}>{p.webhooks ? "Webhooks" : "No webhooks"}</Text>
                <Text style={styles.planFeat}>{p.rate_per_min.toLocaleString()} req/min</Text>
                <TouchableOpacity
                  style={[styles.planBtn, isCurrent && { backgroundColor: theme.surfaceAlt }]}
                  onPress={() => buyPlan(p.id)}
                  disabled={!!buying || isCurrent}
                  testID={`plan-${p.id}`}
                >
                  {buying === p.id ? <ActivityIndicator color="#fff" size="small" /> :
                    <Text style={[styles.planBtnText, isCurrent && { color: theme.textSecondary }]}>{isCurrent ? "Current" : active ? "Switch" : "Choose"}</Text>}
                </TouchableOpacity>
              </View>
            );
          })}
        </View>

        {/* Usage */}
        {active && usage && (
          <>
            <Text style={styles.groupTitle}>Usage this period</Text>
            <View style={styles.usageCard}>
              <View style={styles.usageHead}>
                <Text style={styles.usageNums}>{usage.used.toLocaleString()} / {usage.limit.toLocaleString()}</Text>
                <Text style={styles.usageReset}>{usage.resets_at ? `resets ${fmtDate(usage.resets_at)}` : ""}</Text>
              </View>
              <View style={styles.usageTrack}>
                <View style={[styles.usageFill, { width: `${Math.min(100, usage.limit ? (usage.used / usage.limit) * 100 : 0)}%` }, usage.used >= usage.limit && { backgroundColor: theme.error }]} />
              </View>
              {usage.extra_credits > 0 && <Text style={styles.usageExtra}>+{usage.extra_credits.toLocaleString()} pay-as-you-go credits included</Text>}
              <Text style={styles.body}>
                {usage.used >= usage.limit
                  ? "Quota reached — buy more requests to keep going, or wait for the reset."
                  : "Hit your quota? Buy a pay-as-you-go pack instead of waiting for the reset."}
              </Text>
              <View style={styles.packRow}>
                {usage.packs.map((pk) => (
                  <TouchableOpacity key={pk.id} style={styles.packCard} onPress={() => buyPack(pk.id)} disabled={!!buyingPack} testID={`pack-${pk.id}`}>
                    {buyingPack === pk.id ? <ActivityIndicator color={theme.primary} size="small" /> : (
                      <>
                        <Text style={styles.packName}>{pk.name}</Text>
                        <Text style={styles.packPrice}>${pk.price.toFixed(2)}</Text>
                      </>
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </>
        )}

        {/* API keys */}
        <Text style={styles.groupTitle}>Your API keys</Text>
        {!active ? (
          <Text style={styles.empty}>Subscribe to a plan above to create API keys.</Text>
        ) : (
        <>
        {freshToken && (
          <View style={styles.freshCard}>
            <Text style={styles.freshLabel}>New key — copy it now, it won't be shown again:</Text>
            <TouchableOpacity style={styles.freshTokenRow} onPress={() => copy(freshToken, "API key")} activeOpacity={0.7}>
              <Text style={styles.freshToken} selectable numberOfLines={1}>{freshToken}</Text>
              <Ionicons name="copy" size={16} color={theme.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setFreshToken(null)}><Text style={styles.dismiss}>Done</Text></TouchableOpacity>
          </View>
        )}
        <View style={styles.scopeRow}>
          <TouchableOpacity
            style={[styles.scopeChip, !writeScope && styles.scopeChipOn]}
            onPress={() => setWriteScope(false)}
            testID="scope-read"
          >
            <Ionicons name="eye-outline" size={14} color={!writeScope ? theme.primary : theme.textMuted} />
            <Text style={[styles.scopeText, !writeScope && { color: theme.primary }]}>Read-only</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.scopeChip, writeScope && styles.scopeChipOn, !planFeatures?.write && { opacity: 0.4 }]}
            onPress={() => planFeatures?.write && setWriteScope(true)}
            disabled={!planFeatures?.write}
            testID="scope-write"
          >
            <Ionicons name="create-outline" size={14} color={writeScope ? theme.primary : theme.textMuted} />
            <Text style={[styles.scopeText, writeScope && { color: theme.primary }]}>Read &amp; write</Text>
          </TouchableOpacity>
          {!planFeatures?.write && <Text style={styles.scopeHint}>Write needs Pro+</Text>}
        </View>
        <View style={styles.keyInputRow}>
          <TextInput
            style={styles.keyInput} placeholder="Key label (e.g. My bot)" placeholderTextColor={theme.textMuted}
            value={label} onChangeText={setLabel} maxLength={60} testID="api-key-label"
          />
          <TouchableOpacity style={[styles.genBtn, creating && { opacity: 0.6 }]} onPress={generate} disabled={creating} testID="api-key-generate">
            {creating ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.genBtnText}>Generate</Text>}
          </TouchableOpacity>
        </View>
        {loading ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 14 }} />
        ) : keys.length === 0 ? (
          <Text style={styles.empty}>No API keys yet. Generate one to start building.</Text>
        ) : (
          keys.map((k) => (
            <View key={k.id} style={styles.keyRow}>
              <View style={styles.keyIcon}><Ionicons name="key" size={15} color={theme.primary} /></View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={styles.keyLabel} numberOfLines={1}>{k.label}</Text>
                  <Text style={styles.scopeBadge}>{(k.scopes || []).includes("write") ? "read+write" : "read"}</Text>
                </View>
                <Text style={styles.keyMeta}>
                  {k.key_prefix}··· · {fmtDate(k.created_at)}{k.last_used_at ? ` · used ${fmtDate(k.last_used_at)}` : " · never used"}
                </Text>
              </View>
              <TouchableOpacity onPress={() => revoke(k)} hitSlop={8} testID={`api-key-revoke-${k.id}`}>
                <Ionicons name="trash-outline" size={18} color={theme.error} />
              </TouchableOpacity>
            </View>
          ))
        )}
        </>
        )}

        {/* Webhooks */}
        <Text style={styles.groupTitle}>Webhooks</Text>
        {!planFeatures?.webhooks ? (
          <Text style={styles.empty}>
            {active ? "Webhooks require the Pro plan or higher." : "Subscribe to Pro+ to receive event webhooks."}
          </Text>
        ) : (
          <>
            <Text style={styles.body}>We POST signed events (follows, messages, tips, form submissions, …) to your URL with up to 3 retries, and keep a delivery log. Always verify the `X-Nami-Signature` header — it's `sha256=` followed by the HMAC-SHA256 (hex) of the raw request body, keyed with your signing secret:</Text>
            <TouchableOpacity style={styles.codeBlock} onPress={() => copy(WEBHOOK_VERIFY, "Verification")} activeOpacity={0.7}>
              <Text style={styles.codeBlockText} selectable>{WEBHOOK_VERIFY}</Text>
            </TouchableOpacity>
            {freshSecret && (
              <View style={styles.freshCard}>
                <Text style={styles.freshLabel}>Signing secret — copy it now, shown once:</Text>
                <TouchableOpacity style={styles.freshTokenRow} onPress={() => copy(freshSecret, "Webhook secret")} activeOpacity={0.7}>
                  <Text style={styles.freshToken} selectable numberOfLines={1}>{freshSecret}</Text>
                  <Ionicons name="copy" size={16} color={theme.primary} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setFreshSecret(null)}><Text style={styles.dismiss}>Done</Text></TouchableOpacity>
              </View>
            )}
            {whEvents.length > 0 && (
              <>
                <Text style={[styles.body, { marginBottom: 6 }]}>Choose events to subscribe to (none = all {whEvents.length}):</Text>
                <View style={styles.eventWrap}>
                  {whEvents.map((e) => {
                    const on = whSelected.includes(e.event);
                    return (
                      <TouchableOpacity key={e.event} style={[styles.eventChip, on && styles.eventChipOn]} onPress={() => toggleEvent(e.event)} testID={`wh-ev-${e.event}`}>
                        <Text style={[styles.eventChipText, on && { color: theme.primary }]}>{e.event}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </>
            )}
            <View style={[styles.keyInputRow, { marginTop: 10 }]}>
              <TextInput
                style={styles.keyInput} placeholder="https://your-server.com/hook" placeholderTextColor={theme.textMuted}
                value={whUrl} onChangeText={setWhUrl} autoCapitalize="none" autoCorrect={false} testID="webhook-url"
              />
              <TouchableOpacity style={[styles.genBtn, whBusy && { opacity: 0.6 }]} onPress={addWebhook} disabled={whBusy} testID="webhook-add">
                {whBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.genBtnText}>Add</Text>}
              </TouchableOpacity>
            </View>
            {webhooks.length === 0 ? (
              <Text style={styles.empty}>No webhooks yet.</Text>
            ) : webhooks.map((w) => (
              <View key={w.id}>
                <View style={styles.keyRow}>
                  <View style={styles.keyIcon}><Ionicons name="git-network-outline" size={15} color={theme.primary} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.keyLabel} numberOfLines={1}>{w.url}</Text>
                    <Text style={styles.keyMeta}>{(w.events || []).length} events · {fmtDate(w.created_at)}</Text>
                  </View>
                  <TouchableOpacity onPress={() => toggleLogs(w.id)} hitSlop={8} style={styles.whTestBtn} testID={`webhook-logs-${w.id}`}>
                    <Text style={styles.whTestText}>{openLogs === w.id ? "Hide" : "Logs"}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => testWebhook(w.id)} disabled={whTesting === w.id} hitSlop={8} style={styles.whTestBtn} testID={`webhook-test-${w.id}`}>
                    {whTesting === w.id ? <ActivityIndicator color={theme.primary} size="small" /> : <Text style={styles.whTestText}>Test</Text>}
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => removeWebhook(w.id)} hitSlop={8} testID={`webhook-del-${w.id}`}>
                    <Ionicons name="trash-outline" size={18} color={theme.error} />
                  </TouchableOpacity>
                </View>
                {openLogs === w.id && (
                  <View style={styles.logsBox}>
                    {logsBusy && !logs[w.id] ? (
                      <ActivityIndicator color={theme.primary} size="small" />
                    ) : (logs[w.id] || []).length === 0 ? (
                      <Text style={styles.empty}>No deliveries yet. Use Test to send a ping.</Text>
                    ) : (logs[w.id] || []).map((d) => (
                      <View key={d.id} style={styles.logRow}>
                        <View style={[styles.logDot, { backgroundColor: d.ok ? theme.success : theme.error }]} />
                        <Text style={styles.logEvent} numberOfLines={1}>{d.event}</Text>
                        <Text style={styles.logMeta}>{d.status || "—"}{d.attempts > 1 ? ` ·${d.attempts}x` : ""} · {fmtDate(d.created_at)}</Text>
                        <TouchableOpacity onPress={() => redeliver(w.id, d.id)} disabled={redelivering === d.id} hitSlop={6} testID={`wh-redeliver-${d.id}`}>
                          {redelivering === d.id ? <ActivityIndicator color={theme.primary} size="small" /> : <Ionicons name="refresh" size={15} color={theme.primary} />}
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            ))}
          </>
        )}

        {/* Login with Nami (OAuth apps) */}
        <Text style={styles.groupTitle}>Login with Nami</Text>
        <Text style={styles.body}>
          Let other sites add a "Sign in with Nami" button. Register an app to get a client ID + secret, then use the OAuth2 authorization-code flow.
        </Text>
        {freshApp && (
          <View style={styles.freshCard}>
            <Text style={styles.freshLabel}>Client ID</Text>
            <TouchableOpacity style={styles.freshTokenRow} onPress={() => copy(freshApp.client_id, "Client ID")} activeOpacity={0.7}>
              <Text style={styles.freshToken} selectable numberOfLines={1}>{freshApp.client_id}</Text>
              <Ionicons name="copy" size={16} color={theme.primary} />
            </TouchableOpacity>
            <Text style={styles.freshLabel}>Client secret — copy it now, shown once:</Text>
            <TouchableOpacity style={styles.freshTokenRow} onPress={() => copy(freshApp.client_secret, "Client secret")} activeOpacity={0.7}>
              <Text style={styles.freshToken} selectable numberOfLines={1}>{freshApp.client_secret}</Text>
              <Ionicons name="copy" size={16} color={theme.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setFreshApp(null)}><Text style={styles.dismiss}>Done</Text></TouchableOpacity>
          </View>
        )}
        <TextInput
          style={[styles.keyInput, { marginBottom: 8 }]} placeholder="App name" placeholderTextColor={theme.textMuted}
          value={appName} onChangeText={setAppName} maxLength={80} testID="oauth-app-name"
        />
        <View style={styles.keyInputRow}>
          <TextInput
            style={styles.keyInput} placeholder="https://yoursite.com/callback" placeholderTextColor={theme.textMuted}
            value={appUri} onChangeText={setAppUri} autoCapitalize="none" autoCorrect={false} testID="oauth-app-uri"
          />
          <TouchableOpacity style={[styles.genBtn, appBusy && { opacity: 0.6 }]} onPress={createOAuthApp} disabled={appBusy} testID="oauth-app-create">
            {appBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.genBtnText}>Create</Text>}
          </TouchableOpacity>
        </View>
        {oauthApps.length === 0 ? (
          <Text style={styles.empty}>No OAuth apps yet.</Text>
        ) : oauthApps.map((a) => (
          <View key={a.client_id} style={styles.keyRow}>
            <View style={styles.keyIcon}><Ionicons name="log-in-outline" size={15} color={theme.primary} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.keyLabel} numberOfLines={1}>{a.name}</Text>
              <Text style={styles.keyMeta} numberOfLines={1}>{a.client_id}</Text>
            </View>
            <TouchableOpacity onPress={() => removeOAuthApp(a.client_id)} hitSlop={8} testID={`oauth-del-${a.client_id}`}>
              <Ionicons name="trash-outline" size={18} color={theme.error} />
            </TouchableOpacity>
          </View>
        ))}

        {/* Quickstart */}
        <Text style={styles.groupTitle}>Quickstart</Text>
        <View style={styles.langRow}>
          {(["curl", "js", "python", "dart"] as Lang[]).map((l) => (
            <TouchableOpacity key={l} onPress={() => setLang(l)} style={[styles.langTab, lang === l && styles.langTabOn]} testID={`lang-${l}`}>
              <Text style={[styles.langText, lang === l && { color: theme.primary }]}>{LANG_LABEL[l]}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(SAMPLE[lang](API_BASE), "Example")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{SAMPLE[lang](API_BASE)}</Text>
        </TouchableOpacity>

        {/* Embed & SDKs */}
        <Text style={styles.groupTitle}>Embed & customize</Text>
        <Text style={styles.body}>
          Drop a Nami form into any website or app and theme it to match your brand — no auth, no backend. Paste the snippet and tweak the <Text style={styles.codeInline}>data-*</Text> attributes:
        </Text>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(EMBED_SNIPPET, "Embed snippet")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{EMBED_SNIPPET}</Text>
        </TouchableOpacity>
        <View style={[styles.convCard, { marginTop: 10 }]}>
          {EMBED_ATTRS.map(([k, v]) => (
            <Text key={k} style={styles.convItem}><Text style={styles.convKey}>{k} </Text>{v}</Text>
          ))}
        </View>
        <Text style={[styles.body, { marginTop: 12 }]}>
          The same knobs work as query params on <Text style={styles.codeInline}>/pub/form-unit</Text>, so you can embed the form in a native app — e.g. a Flutter <Text style={styles.codeInline}>WebView</Text>:
        </Text>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(FLUTTER_WEBVIEW, "Flutter snippet")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{FLUTTER_WEBVIEW}</Text>
        </TouchableOpacity>

        <Text style={[styles.body, { marginTop: 12 }]}>
          You can also embed Nami <Text style={styles.codeInline}>content</Text> — posts and profiles — as themeable cards, or rely on <Text style={styles.codeInline}>oEmbed</Text> so a pasted Nami link auto-expands in WordPress, Discourse, Notion and other oEmbed-aware tools:
        </Text>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(CONTENT_SNIPPET, "Content embed")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{CONTENT_SNIPPET}</Text>
        </TouchableOpacity>
        <Text style={[styles.body, { marginTop: 8 }]}>
          oEmbed endpoint: <Text style={styles.codeInline}>{`${BASE}/api/pub/oembed?url=<nami link>`}</Text> — only public content is served (no subscriber-only posts, no banned users).
        </Text>

        <Text style={[styles.groupTitle, { marginTop: 22 }]}>SDKs & client generation</Text>
        <Text style={styles.body}>
          Nami is a plain JSON+HTTPS API, so it works from any language — Dart/Flutter, Swift, Kotlin, Go, Rust and more. For a fully-typed client, generate one from the OpenAPI schema:
        </Text>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(`# Dart/Flutter client from the OpenAPI schema\ndart pub global activate openapi_generator_cli\nopenapi-generator generate \\\n  -i ${BASE}/openapi.json \\\n  -g dart-dio -o ./nami_client`, "Codegen")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{`# Dart/Flutter client from the OpenAPI schema\ndart pub global activate openapi_generator_cli\nopenapi-generator generate \\\n  -i ${BASE}/openapi.json \\\n  -g dart-dio -o ./nami_client`}</Text>
        </TouchableOpacity>
        <Text style={[styles.body, { marginTop: 8 }]}>
          Swap <Text style={styles.codeInline}>-g dart-dio</Text> for <Text style={styles.codeInline}>swift5</Text>, <Text style={styles.codeInline}>kotlin</Text>, <Text style={styles.codeInline}>go</Text>, <Text style={styles.codeInline}>typescript-fetch</Text>, etc. CORS is open, so browser and mobile apps can call the API directly.
        </Text>

        {/* Conventions */}
        <Text style={styles.groupTitle}>Conventions</Text>
        <View style={styles.convCard}>
          <Text style={styles.convItem}><Text style={styles.convKey}>Format </Text>JSON request & response bodies; `Content-Type: application/json`.</Text>
          <Text style={styles.convItem}><Text style={styles.convKey}>Versioning </Text>The stable base is `/api/v1`. The unversioned `/api` is kept as a legacy alias so existing keys keep working.</Text>
          <Text style={styles.convItem}><Text style={styles.convKey}>Pagination </Text>List endpoints accept `?limit=` and `?offset=`. Some also support cursor paging — pass the returned `next_cursor` as `?cursor=` (null = end).</Text>
          <Text style={styles.convItem}><Text style={styles.convKey}>Idempotency </Text>Send an `Idempotency-Key` header (any unique value) on writes (POST/PUT/PATCH/DELETE). Retries with the same key replay the first response (header `Idempotent-Replay: true`) — safe against double-submits.</Text>
          <Text style={styles.convItem}><Text style={styles.convKey}>Errors </Text>Every non-2xx reply uses one shape: `{"{"}"error":{"{"}"code","message"{"}"}{"}"}` (also mirrored under `detail`). e.g. 401 unauthorized, 403 forbidden, 404 not_found, 413 payload_too_large, 422 validation_error, 429 rate_limited.</Text>
          <Text style={styles.convItem}><Text style={styles.convKey}>Rate limits </Text>Fair-use; heavy automated traffic may be throttled (429).</Text>
        </View>

        {/* Endpoint reference */}
        <Text style={styles.groupTitle}>Endpoint reference</Text>
        {GROUPS.map((g) => {
          const open = openGroup === g.title;
          return (
            <View key={g.title} style={styles.refGroup}>
              <TouchableOpacity style={styles.refHeader} onPress={() => setOpenGroup(open ? null : g.title)} activeOpacity={0.7}>
                <Ionicons name={g.icon} size={17} color={theme.primary} />
                <Text style={styles.refTitle}>{g.title}</Text>
                <Text style={styles.refCount}>{g.endpoints.length}</Text>
                <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={theme.textMuted} />
              </TouchableOpacity>
              {open && g.endpoints.map((e, i) => (
                <View key={i} style={styles.epRow}>
                  <View style={styles.epLine}>
                    <Text style={[styles.method, { color: METHOD_COLOR[e.method], borderColor: METHOD_COLOR[e.method] + "66" }]}>{e.method}</Text>
                    <Text style={styles.epPath} selectable>{e.path}</Text>
                    {e.auth === false && <Text style={styles.publicTag}>public</Text>}
                  </View>
                  <Text style={styles.epDesc}>{e.desc}</Text>
                  {!!e.body && <Text style={styles.epBody} selectable>body {e.body}</Text>}
                </View>
              ))}
            </View>
          );
        })}

        <Text style={styles.footer}>
          Keep your API keys and signing secrets safe — treat them like passwords. Heavy automated traffic may be rate-limited (429).
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function errText(e: any): string {
  return String(e?.message || e || "Something went wrong").replace(/^\d{3}:\s*/, "");
}
function fmtDate(iso: string) {
  try { return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }); } catch { return ""; }
}

const styles = StyleSheet.create({
  docLinks: { flexDirection: "row", gap: 10, marginTop: 12 },
  docLink: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  docLinkText: { color: theme.primary, fontSize: 13, fontWeight: "700" },
  langRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  langTab: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  langTabOn: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  langText: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "700" },
  convCard: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, padding: 14, gap: 9 },
  convItem: { color: theme.textSecondary, fontSize: 13, lineHeight: 19 },
  convKey: { color: theme.textPrimary, fontWeight: "800" },
  planActive: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(0,168,132,0.10)", borderWidth: 1, borderColor: theme.primary, borderRadius: 12, padding: 12, marginBottom: 10 },
  planActiveText: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  planRow: { flexDirection: "row", gap: 10, marginTop: 6 },
  planCard: { flex: 1, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, padding: 12, gap: 3 },
  planCardOn: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  planName: { color: theme.textPrimary, fontSize: 14, fontWeight: "800" },
  planPrice: { color: theme.textPrimary, fontSize: 18, fontWeight: "900", marginBottom: 4 },
  planPer: { color: theme.textMuted, fontSize: 11, fontWeight: "700" },
  planFeat: { color: theme.textSecondary, fontSize: 11.5 },
  planBtn: { backgroundColor: theme.primary, borderRadius: 10, paddingVertical: 9, alignItems: "center", marginTop: 8 },
  planBtnText: { color: "#fff", fontWeight: "800", fontSize: 12.5 },
  scopeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  scopeChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  scopeChipOn: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  scopeText: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "700" },
  scopeHint: { color: theme.textMuted, fontSize: 11 },
  scopeBadge: { color: theme.textMuted, fontSize: 10, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.3, borderWidth: 1, borderColor: theme.border, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1 },
  usageCard: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, padding: 14, gap: 8 },
  usageHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  usageNums: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  usageReset: { color: theme.textMuted, fontSize: 12 },
  usageTrack: { height: 8, borderRadius: 4, backgroundColor: theme.surfaceAlt, overflow: "hidden" },
  usageFill: { height: 8, borderRadius: 4, backgroundColor: theme.primary },
  usageExtra: { color: theme.primary, fontSize: 12, fontWeight: "600" },
  packRow: { flexDirection: "row", gap: 8 },
  packCard: { flex: 1, backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, borderRadius: 10, paddingVertical: 10, alignItems: "center", gap: 2 },
  packName: { color: theme.textPrimary, fontSize: 12, fontWeight: "700" },
  packPrice: { color: theme.primary, fontSize: 14, fontWeight: "800" },
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  backBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },

  lede: { color: theme.textSecondary, fontSize: 14, lineHeight: 20, marginTop: 4 },
  groupTitle: { color: theme.textMuted, fontSize: 13, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 26, marginBottom: 10 },
  body: { color: theme.textSecondary, fontSize: 13.5, lineHeight: 19, marginBottom: 8 },

  codeRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  code: { flex: 1, color: theme.textPrimary, fontSize: 13, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  codeInline: { color: theme.textPrimary, fontSize: 12.5, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  codeBlock: { backgroundColor: "#0E0E10", borderWidth: 1, borderColor: theme.border, borderRadius: 12, padding: 14 },
  codeBlockText: { color: "#9FE7C8", fontSize: 12.5, lineHeight: 19, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },

  freshCard: { backgroundColor: "rgba(0,168,132,0.10)", borderWidth: 1, borderColor: theme.primary, borderRadius: 14, padding: 14, marginBottom: 12, gap: 8 },
  freshLabel: { color: theme.textSecondary, fontSize: 12.5 },
  freshTokenRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.surfaceAlt, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  freshToken: { flex: 1, color: theme.textPrimary, fontSize: 12.5, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  dismiss: { color: theme.primary, fontSize: 13, fontWeight: "700", alignSelf: "flex-end" },

  keyInputRow: { flexDirection: "row", gap: 10 },
  keyInput: { flex: 1, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, height: 46, color: theme.textPrimary, fontSize: 14, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  genBtn: { backgroundColor: theme.primary, borderRadius: 12, paddingHorizontal: 20, height: 46, alignItems: "center", justifyContent: "center" },
  genBtnText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  empty: { color: theme.textMuted, fontSize: 13, marginTop: 12 },
  keyRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  whTestBtn: { borderWidth: 1, borderColor: theme.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, minWidth: 52, alignItems: "center", justifyContent: "center" },
  whTestText: { color: theme.primary, fontSize: 12.5, fontWeight: "800" },
  eventWrap: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  eventChip: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5 },
  eventChipOn: { borderColor: theme.primary, backgroundColor: "rgba(0,168,132,0.10)" },
  eventChipText: { color: theme.textSecondary, fontSize: 11.5, fontWeight: "700", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  logsBox: { backgroundColor: theme.surfaceAlt, borderRadius: 10, padding: 10, marginTop: -2, marginBottom: 8, gap: 6 },
  logRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  logDot: { width: 7, height: 7, borderRadius: 4 },
  logEvent: { flex: 1, color: theme.textPrimary, fontSize: 12.5, fontWeight: "700", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  logMeta: { color: theme.textMuted, fontSize: 11.5 },
  keyIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: theme.surfaceAlt, alignItems: "center", justifyContent: "center" },
  keyLabel: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  keyMeta: { color: theme.textMuted, fontSize: 12, marginTop: 1, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },

  refGroup: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, marginBottom: 10, overflow: "hidden" },
  refHeader: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 14 },
  refTitle: { flex: 1, color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  refCount: { color: theme.textMuted, fontSize: 12, fontWeight: "700" },
  epRow: { paddingHorizontal: 14, paddingVertical: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border, gap: 4 },
  epLine: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  method: { fontSize: 10.5, fontWeight: "900", letterSpacing: 0.5, borderWidth: 1, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, overflow: "hidden" },
  epPath: { color: theme.textPrimary, fontSize: 13, fontWeight: "600", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", flexShrink: 1 },
  publicTag: { color: theme.textMuted, fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4, borderWidth: 1, borderColor: theme.border, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1 },
  epDesc: { color: theme.textSecondary, fontSize: 13, lineHeight: 18 },
  epBody: { color: theme.textMuted, fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  footer: { color: theme.textMuted, fontSize: 12, lineHeight: 18, marginTop: 24 },
});
