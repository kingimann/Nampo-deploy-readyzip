import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  ActivityIndicator, Platform, Alert, Linking,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { api, ApiKey } from "@/src/api/client";
import { theme } from "@/src/theme";

const BASE = (process.env.EXPO_PUBLIC_BACKEND_URL as string) || "https://nampo-backend.onrender.com";
const API_BASE = `${BASE}/api`;

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Endpoint = { method: Method; path: string; desc: string; body?: string; auth?: boolean };
type Group = { title: string; icon: keyof typeof import("@expo/vector-icons/build/Ionicons").default.glyphMap; endpoints: Endpoint[] };

const GROUPS: Group[] = [
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
      { method: "POST", path: "/posts/{id}/like", desc: "Toggle like on a post.", auth: true },
      { method: "POST", path: "/posts/{id}/bookmark", desc: "Toggle bookmark on a post.", auth: true },
      { method: "POST", path: "/posts/{id}/repost", desc: "Toggle repost.", auth: true },
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
      { method: "POST", path: "/users/{user_id}/subscribe", desc: "Subscribe to a user.", auth: true },
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
      { method: "GET", path: "/conversations/{id}/messages", desc: "Fetch messages in a conversation.", auth: true },
      { method: "POST", path: "/conversations/{id}/messages", desc: "Send a message (text, media, voice, place, post, gif, file).", auth: true, body: `{"type":"text","text"}` },
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

type Lang = "curl" | "js" | "python";
const SAMPLE: Record<Lang, (base: string) => string> = {
  curl: (b) => `curl ${b}/posts/feed \\\n  -H "Authorization: Bearer $NAMI_KEY"`,
  js: (b) => `const res = await fetch("${b}/posts/feed", {\n  headers: { Authorization: \`Bearer \${process.env.NAMI_KEY}\` },\n});\nconst feed = await res.json();`,
  python: (b) => `import requests\nr = requests.get(\n  "${b}/posts/feed",\n  headers={"Authorization": f"Bearer {NAMI_KEY}"},\n)\nfeed = r.json()`,
};

const METHOD_COLOR: Record<Method, string> = {
  GET: "#22C55E", POST: "#0EA5E9", PATCH: "#EAB308", DELETE: "#F15C6D",
};

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
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof api.getApiUsage>> | null>(null);
  const [buyingPack, setBuyingPack] = useState<string | null>(null);

  const active = !!plan?.current.active;
  const planFeatures = plan?.plans.find((p) => p.id === plan?.current.plan);

  const load = useCallback(async () => {
    try { setKeys((await api.listApiKeys()).keys); } catch {} finally { setLoading(false); }
    try { setPlan(await api.getApiPlan()); } catch {}
    try { setWebhooks((await api.listWebhooks()).webhooks); } catch {}
    try { setUsage(await api.getApiUsage()); } catch {}
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

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
      const w = await api.createWebhook(whUrl.trim());
      setFreshSecret(w.secret || null);
      setWhUrl("");
      await load();
    } catch (e: any) {
      Alert.alert("Couldn't add webhook", errText(e));
    } finally { setWhBusy(false); }
  };

  const removeWebhook = (id: string) => {
    Alert.alert("Delete webhook", "Stop sending events to this URL?", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => { try { await api.deleteWebhook(id); await load(); } catch {} } },
    ]);
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
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="developer-back">
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
            <Text style={styles.body}>We POST signed events (follows, messages, tips, …) to your URL. Verify the `X-Nami-Signature` header with your signing secret.</Text>
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
            <View style={styles.keyInputRow}>
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
              <View key={w.id} style={styles.keyRow}>
                <View style={styles.keyIcon}><Ionicons name="git-network-outline" size={15} color={theme.primary} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.keyLabel} numberOfLines={1}>{w.url}</Text>
                  <Text style={styles.keyMeta}>{(w.events || []).length} events · {fmtDate(w.created_at)}</Text>
                </View>
                <TouchableOpacity onPress={() => removeWebhook(w.id)} hitSlop={8} testID={`webhook-del-${w.id}`}>
                  <Ionicons name="trash-outline" size={18} color={theme.error} />
                </TouchableOpacity>
              </View>
            ))}
          </>
        )}

        {/* Quickstart */}
        <Text style={styles.groupTitle}>Quickstart</Text>
        <View style={styles.langRow}>
          {(["curl", "js", "python"] as Lang[]).map((l) => (
            <TouchableOpacity key={l} onPress={() => setLang(l)} style={[styles.langTab, lang === l && styles.langTabOn]} testID={`lang-${l}`}>
              <Text style={[styles.langText, lang === l && { color: theme.primary }]}>{l === "js" ? "JavaScript" : l === "python" ? "Python" : "cURL"}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(SAMPLE[lang](API_BASE), "Example")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{SAMPLE[lang](API_BASE)}</Text>
        </TouchableOpacity>

        {/* Conventions */}
        <Text style={styles.groupTitle}>Conventions</Text>
        <View style={styles.convCard}>
          <Text style={styles.convItem}><Text style={styles.convKey}>Format </Text>JSON request & response bodies; `Content-Type: application/json`.</Text>
          <Text style={styles.convItem}><Text style={styles.convKey}>Pagination </Text>List endpoints accept `?limit=` and `?offset=` where supported.</Text>
          <Text style={styles.convItem}><Text style={styles.convKey}>Errors </Text>Non-2xx responses return `{"{"}"detail": "message"{"}"}`. 401 = bad/missing token, 403 = not allowed, 404 = not found, 413 = too large, 429 = rate-limited.</Text>
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
          Rate limits and signed webhooks are coming. Keep your API keys secret — treat them like passwords.
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
