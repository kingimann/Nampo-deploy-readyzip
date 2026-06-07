import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, BotPost, BotResult } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

export default function AdminBotScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [posts, setPosts] = useState<BotPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [views, setViews] = useState("100");
  const [clicks, setClicks] = useState("10");
  const [likes, setLikes] = useState("20");
  const [comments, setComments] = useState("5");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BotResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const { posts } = await api.getBotPosts(); setPosts(posts); }
    catch (e: any) { setError(String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const num = (s: string) => Math.max(0, Math.floor(Number(s) || 0));

  const run = async () => {
    if (!selected) { setError("Pick a sponsored post first."); return; }
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await api.runBot({
        post_id: selected,
        views: num(views), clicks: num(clicks), likes: num(likes), comments: num(comments),
      });
      setResult(res);
      load();
    } catch (e: any) {
      setError(String(e?.message || e).replace(/^\d{3}:\s*/, "") || "Bot run failed.");
    } finally { setBusy(false); }
  };

  if (user && user.role !== "admin") {
    return (
      <SafeAreaView edges={["top"]} style={styles.root}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn}><Ionicons name="chevron-back" size={24} color={theme.textPrimary} /></TouchableOpacity>
          <Text style={styles.title}>Test Bot</Text><View style={{ width: 40 }} />
        </View>
        <View style={styles.center}><Text style={styles.empty}>Admins only.</Text></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="admin-bot-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="bot-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Test Bot</Text>
        <TouchableOpacity onPress={() => router.push("/wallet")} style={styles.iconBtn} testID="bot-wallet">
          <Ionicons name="wallet-outline" size={22} color={theme.textPrimary} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
          <View style={styles.intro}>
            <Ionicons name="flask" size={18} color={theme.primary} />
            <Text style={styles.introText}>
              Simulate views, clicks, likes and comments on a sponsored post to test the wallet and analytics. Counters move like real traffic — no actual likes or comments are posted. Earnings are credited to you so you can check the money flow.
            </Text>
          </View>

          <Text style={styles.section}>Pick a sponsored post</Text>
          {posts.length === 0 ? (
            <Text style={styles.empty}>No active sponsored posts. Promote a post first, then come back.</Text>
          ) : (
            posts.map((p) => {
              const on = selected === p.post_id;
              return (
                <TouchableOpacity
                  key={p.post_id}
                  style={[styles.postRow, on && styles.postRowOn]}
                  onPress={() => { setSelected(p.post_id); setResult(null); }}
                  testID={`bot-post-${p.post_id}`}
                >
                  <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={18} color={on ? theme.primary : theme.textMuted} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.postText} numberOfLines={2}>{p.text || "(media post)"}</Text>
                    <Text style={styles.postMeta}>by {p.owner_name} · {p.views} views · {p.clicks} clicks · ${p.spent.toFixed(2)} spent</Text>
                  </View>
                </TouchableOpacity>
              );
            })
          )}

          <Text style={styles.section}>How much traffic?</Text>
          <View style={styles.grid}>
            {[
              { label: "Views", v: views, set: setViews, icon: "eye-outline" },
              { label: "Clicks", v: clicks, set: setClicks, icon: "hand-left-outline" },
              { label: "Likes", v: likes, set: setLikes, icon: "heart-outline" },
              { label: "Comments", v: comments, set: setComments, icon: "chatbubble-outline" },
            ].map((f) => (
              <View key={f.label} style={styles.field}>
                <View style={styles.fieldLabelRow}>
                  <Ionicons name={f.icon as any} size={14} color={theme.textMuted} />
                  <Text style={styles.fieldLabel}>{f.label}</Text>
                </View>
                <TextInput
                  style={styles.input}
                  value={f.v}
                  onChangeText={(t) => f.set(t.replace(/[^0-9]/g, ""))}
                  keyboardType="number-pad"
                  testID={`bot-${f.label.toLowerCase()}`}
                />
              </View>
            ))}
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

          <TouchableOpacity style={[styles.runBtn, (busy || !selected) && { opacity: 0.6 }]} onPress={run} disabled={busy || !selected} testID="bot-run">
            {busy ? <ActivityIndicator color="#fff" /> : (
              <>
                <Ionicons name="rocket" size={16} color="#fff" />
                <Text style={styles.runBtnText}>Run bot</Text>
              </>
            )}
          </TouchableOpacity>

          {result && (
            <View style={styles.resultCard}>
              <View style={styles.resultHead}>
                <Ionicons name="checkmark-circle" size={18} color="#22C55E" />
                <Text style={styles.resultTitle}>Done — you earned ${result.earned.toFixed(2)}</Text>
              </View>
              <Text style={styles.resultSub}>
                Advertiser spend ${result.spend.toFixed(2)} (${result.debited_from_advertiser.toFixed(2)} drawn from their ad balance).
              </Text>
              <View style={styles.resultGrid}>
                <Stat label="Views" value={result.totals.views} />
                <Stat label="Clicks" value={result.totals.clicks} />
                <Stat label="Likes" value={result.totals.likes} />
                <Stat label="Comments" value={result.totals.comments} />
              </View>
              <TouchableOpacity style={styles.linkBtn} onPress={() => router.push("/wallet")}>
                <Text style={styles.linkText}>Check your wallet →</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statNum}>{value.toLocaleString()}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  intro: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 14 },
  introText: { flex: 1, color: theme.textSecondary, fontSize: 12.5, lineHeight: 18 },
  section: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 22, marginBottom: 10 },
  empty: { color: theme.textMuted, fontSize: 13, paddingVertical: 14 },
  postRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12, marginBottom: 8 },
  postRowOn: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  postText: { color: theme.textPrimary, fontSize: 14, fontWeight: "600" },
  postMeta: { color: theme.textMuted, fontSize: 11.5, marginTop: 3 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  field: { width: "47.5%", flexGrow: 1 },
  fieldLabelRow: { flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 6 },
  fieldLabel: { color: theme.textMuted, fontSize: 12, fontWeight: "700" },
  input: { backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, height: 48, color: theme.textPrimary, fontSize: 16, fontWeight: "700", ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  error: { color: theme.error, fontSize: 13, fontWeight: "600", marginTop: 14 },
  runBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: theme.primary, borderRadius: 14, height: 52, marginTop: 18 },
  runBtnText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  resultCard: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 16, marginTop: 18, gap: 10 },
  resultHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  resultTitle: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  resultSub: { color: theme.textSecondary, fontSize: 12.5, lineHeight: 18 },
  resultGrid: { flexDirection: "row", gap: 8 },
  stat: { flex: 1, backgroundColor: theme.surfaceAlt, borderRadius: 12, paddingVertical: 12, alignItems: "center", gap: 2 },
  statNum: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  statLabel: { color: theme.textMuted, fontSize: 11 },
  linkBtn: { paddingVertical: 6 },
  linkText: { color: theme.primary, fontSize: 14, fontWeight: "800" },
});
