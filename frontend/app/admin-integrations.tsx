import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Linking, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, Integration } from "@/src/api/client";
import { theme } from "@/src/theme";

// Frontend-only SDKs are configured via EXPO_PUBLIC_* and checked right here in
// the client (the backend never sees these keys).
type ClientSdk = { name: string; category: string; env: string[]; summary: string; fix: string; docs: string; configured: boolean };
const CLIENT_SDKS: ClientSdk[] = [
  {
    name: "Mapbox (maps & directions)", category: "Maps", env: ["EXPO_PUBLIC_MAPBOX_TOKEN"],
    summary: "Renders every map and powers search + turn-by-turn directions.",
    fix: "Set EXPO_PUBLIC_MAPBOX_TOKEN to your Mapbox access token and rebuild the web/app bundle.",
    docs: "https://account.mapbox.com/access-tokens/",
    configured: !!process.env.EXPO_PUBLIC_MAPBOX_TOKEN,
  },
  {
    name: "Cloudinary (media uploads)", category: "Media",
    env: ["EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME", "EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET"],
    summary: "Hosts uploaded photos/videos for posts, listings, and avatars.",
    fix: "Set EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME and an unsigned EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET.",
    docs: "https://console.cloudinary.com/",
    configured: !!process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME && !!process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET,
  },
  {
    name: "Tenor (GIF search)", category: "Media", env: ["EXPO_PUBLIC_TENOR_KEY"],
    summary: "GIF picker in the composer and chat.",
    fix: "Set EXPO_PUBLIC_TENOR_KEY (free key from Google Tenor).",
    docs: "https://developers.google.com/tenor/guides/quickstart",
    configured: !!process.env.EXPO_PUBLIC_TENOR_KEY,
  },
];

function statusMeta(status: string, configured: boolean): { label: string; color: string; icon: keyof typeof Ionicons.glyphMap } {
  switch (status) {
    case "operational": return { label: "Working", color: "#22C55E", icon: "checkmark-circle" };
    case "configured": return { label: "Configured", color: "#22C55E", icon: "checkmark-circle-outline" };
    case "error": return { label: "Error", color: theme.error, icon: "close-circle" };
    case "not_configured": return { label: "Needs setup", color: theme.error, icon: "alert-circle" };
    default: return { label: "Off (optional)", color: theme.textMuted, icon: "remove-circle-outline" };
  }
}

export default function AdminIntegrationsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (live: boolean) => {
    setErr(null);
    if (live) setTesting(true); else setLoading(true);
    try {
      const r = await api.adminIntegrations(live);
      setItems(r.integrations);
    } catch (e: any) {
      setErr(String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally {
      setLoading(false); setTesting(false);
    }
  }, []);
  useFocusEffect(useCallback(() => { load(false); }, [load]));

  // Merge backend + client-checked SDKs, grouped by category.
  const clientAsIntegration: Integration[] = CLIENT_SDKS.map((s) => ({
    key: s.name, name: s.name, category: s.category, required: false, env: s.env,
    summary: s.summary, fix: s.fix, docs: s.docs, configured: s.configured, can_test: false,
    status: s.configured ? "configured" : "not_configured", detail: s.configured ? "Configured (client)." : "Not configured.",
  }));
  const all = [...items, ...clientAsIntegration];
  const categories = Array.from(new Set(all.map((i) => i.category)));
  const okCount = all.filter((i) => i.status === "operational" || i.status === "configured").length;

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="admin-integrations-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="integrations-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Integrations & SDKs</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryText}>{okCount}/{all.length} configured</Text>
            <TouchableOpacity style={[styles.testBtn, testing && { opacity: 0.5 }]} onPress={() => load(true)} disabled={testing} testID="run-live-tests">
              {testing ? <ActivityIndicator color="#fff" size="small" /> : (
                <>
                  <Ionicons name="pulse" size={15} color="#fff" />
                  <Text style={styles.testBtnText}>Run live tests</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
          {!!err && <Text style={styles.err}>{err}</Text>}
          <Text style={styles.note}>
            “Run live tests” calls each backend service to confirm the credentials actually work. Client SDKs (Mapbox, Cloudinary, Tenor) are checked in this app build.
          </Text>

          {categories.map((cat) => (
            <View key={cat}>
              <Text style={styles.section}>{cat}</Text>
              {all.filter((i) => i.category === cat).map((it) => {
                const m = statusMeta(it.status, it.configured);
                const needsAction = it.status === "not_configured" || it.status === "error";
                return (
                  <View key={it.key} style={styles.card} testID={`integration-${it.key}`}>
                    <View style={styles.cardTop}>
                      <Text style={styles.intName}>{it.name}{it.required ? " *" : ""}</Text>
                      <View style={[styles.pill, { backgroundColor: m.color + "22", borderColor: m.color }]}>
                        <Ionicons name={m.icon} size={13} color={m.color} />
                        <Text style={[styles.pillText, { color: m.color }]}>{m.label}</Text>
                      </View>
                    </View>
                    <Text style={styles.intSummary}>{it.summary}</Text>
                    {it.tested && !!it.detail && (
                      <Text style={[styles.intDetail, { color: it.status === "operational" ? "#22C55E" : theme.error }]}>{it.detail}</Text>
                    )}
                    <View style={styles.envRow}>
                      {it.env.map((e) => (
                        <View key={e} style={styles.envChip}><Text style={styles.envText}>{e}</Text></View>
                      ))}
                    </View>
                    {needsAction && (
                      <View style={styles.fixBox}>
                        <Ionicons name="construct-outline" size={14} color={theme.warning} />
                        <Text style={styles.fixText}>{it.fix}</Text>
                      </View>
                    )}
                    {!!it.docs && (
                      <TouchableOpacity onPress={() => Linking.openURL(it.docs)} testID={`docs-${it.key}`}>
                        <Text style={styles.docsLink}>Open docs ↗</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
            </View>
          ))}
          <Text style={styles.footnote}>* required for the app to run. Everything else is optional and degrades gracefully when unset.</Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  summaryRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  summaryText: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  testBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: theme.primary, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9,
  },
  testBtnText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  note: { color: theme.textMuted, fontSize: 12, lineHeight: 17, marginBottom: 8 },
  err: { color: theme.error, fontSize: 13, marginBottom: 8 },
  section: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 16, marginBottom: 8 },
  card: {
    backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border,
    padding: 14, marginBottom: 10, gap: 8,
  },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  intName: { color: theme.textPrimary, fontSize: 15, fontWeight: "800", flex: 1 },
  pill: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4 },
  pillText: { fontSize: 11.5, fontWeight: "800" },
  intSummary: { color: theme.textSecondary, fontSize: 13, lineHeight: 18 },
  intDetail: { fontSize: 12, fontWeight: "600" },
  envRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  envChip: { backgroundColor: theme.surfaceAlt, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  envText: { color: theme.textSecondary, fontSize: 11, fontWeight: "600", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  fixBox: {
    flexDirection: "row", alignItems: "flex-start", gap: 8,
    backgroundColor: "rgba(246,196,85,0.12)", borderRadius: 10, padding: 10,
    borderWidth: 1, borderColor: "rgba(246,196,85,0.3)",
  },
  fixText: { flex: 1, color: theme.textPrimary, fontSize: 12.5, lineHeight: 18 },
  docsLink: { color: theme.primary, fontSize: 12.5, fontWeight: "700" },
  footnote: { color: theme.textMuted, fontSize: 11.5, marginTop: 14, lineHeight: 16 },
});
