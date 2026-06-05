import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { api, PublisherSite } from "@/src/api/client";
import { theme } from "@/src/theme";

const webInput = Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {};

function apiOrigin(): string {
  const env = (process.env.EXPO_PUBLIC_BACKEND_URL as string) || "";
  if (env) return env.replace(/\/$/, "");
  if (Platform.OS === "web" && typeof window !== "undefined") return window.location.origin;
  return "";
}

export default function MonetizeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [sites, setSites] = useState<PublisherSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setSites((await api.getPubSites()).sites); }
    catch {} finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const create = async () => {
    if (!name.trim()) { setMsg("Name your site."); return; }
    setBusy(true); setMsg(null);
    try { await api.createPubSite({ name: name.trim(), domain: domain.trim() || undefined }); setName(""); setDomain(""); await load(); }
    catch (e: any) { setMsg(String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setSites((arr) => arr.filter((s) => s.id !== id));
    try { await api.deletePubSite(id); } catch { load(); }
  };

  const snippet = (key: string) =>
    `<script async src="${apiOrigin()}/api/pub/embed.js?site=${key}" data-width="320" data-height="104"></script>`;

  const copy = async (key: string) => {
    try { await Clipboard.setStringAsync(snippet(key)); setCopied(key); setTimeout(() => setCopied(null), 1500); } catch {}
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="monetize-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="monetize-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Monetize your site</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
          <View style={styles.intro}>
            <Ionicons name="cash" size={18} color={theme.primary} />
            <Text style={styles.introText}>
              Show Nami ads on your website and earn a share of every view and click. Add a site, copy the snippet into your page, and you're live.
            </Text>
          </View>

          <Text style={styles.section}>Add a site</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Site name" placeholderTextColor={theme.textMuted} testID="site-name" />
          <TextInput style={styles.input} value={domain} onChangeText={setDomain} placeholder="example.com (optional)" placeholderTextColor={theme.textMuted} autoCapitalize="none" testID="site-domain" />
          {msg && <Text style={styles.err}>{msg}</Text>}
          <TouchableOpacity style={[styles.btn, busy && { opacity: 0.6 }]} onPress={create} disabled={busy} testID="site-create">
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Create site</Text>}
          </TouchableOpacity>

          <Text style={styles.section}>Your sites</Text>
          {sites.length === 0 ? (
            <Text style={styles.empty}>No sites yet. Add one above to get an embed snippet.</Text>
          ) : sites.map((s) => (
            <View key={s.id} style={styles.siteCard}>
              <View style={styles.siteHead}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.siteName} numberOfLines={1}>{s.name}</Text>
                  {!!s.domain && <Text style={styles.siteDomain} numberOfLines={1}>{s.domain}</Text>}
                </View>
                <TouchableOpacity onPress={() => remove(s.id)} testID={`site-del-${s.id}`}>
                  <Ionicons name="trash-outline" size={16} color={theme.textMuted} />
                </TouchableOpacity>
              </View>
              <View style={styles.statsRow}>
                <Stat label="Earned" value={`$${s.earned.toFixed(2)}`} />
                <Stat label="Views" value={String(s.impressions)} />
                <Stat label="Clicks" value={String(s.clicks)} />
                <Stat label="CTR" value={`${s.ctr}%`} />
              </View>
              <Text style={styles.snipLabel}>Embed snippet</Text>
              <View style={styles.snipBox}>
                <Text style={styles.snipText} selectable numberOfLines={3}>{snippet(s.site_key)}</Text>
              </View>
              <TouchableOpacity style={styles.copyBtn} onPress={() => copy(s.site_key)} testID={`site-copy-${s.id}`}>
                <Ionicons name={copied === s.site_key ? "checkmark" : "copy-outline"} size={15} color={theme.primary} />
                <Text style={styles.copyText}>{copied === s.site_key ? "Copied" : "Copy snippet"}</Text>
              </TouchableOpacity>
            </View>
          ))}

          <Text style={styles.footer}>Earnings require valid traffic — views/clicks from your own or related accounts don't count, and there are daily limits to keep it fair.</Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statNum}>{value}</Text>
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
  intro: { flexDirection: "row", alignItems: "flex-start", gap: 12, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 14 },
  introText: { flex: 1, color: theme.textSecondary, fontSize: 12.5, lineHeight: 18 },
  section: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 22, marginBottom: 10 },
  input: { backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, height: 48, color: theme.textPrimary, fontSize: 15, marginBottom: 10, ...webInput },
  err: { color: theme.error, fontSize: 13, marginBottom: 8 },
  btn: { backgroundColor: theme.primary, borderRadius: 14, height: 50, alignItems: "center", justifyContent: "center" },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  empty: { color: theme.textMuted, fontSize: 13, paddingVertical: 10 },
  siteCard: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 14, marginBottom: 12, gap: 10 },
  siteHead: { flexDirection: "row", alignItems: "center" },
  siteName: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  siteDomain: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
  statsRow: { flexDirection: "row", gap: 8 },
  stat: { flex: 1, backgroundColor: theme.surfaceAlt, borderRadius: 12, paddingVertical: 10, alignItems: "center", gap: 2 },
  statNum: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  statLabel: { color: theme.textMuted, fontSize: 10.5 },
  snipLabel: { color: theme.textMuted, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  snipBox: { backgroundColor: theme.bg, borderRadius: 10, borderWidth: 1, borderColor: theme.border, padding: 10 },
  snipText: { color: theme.textSecondary, fontSize: 11.5, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  copyBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.surfaceAlt, borderRadius: 10, borderWidth: 1, borderColor: theme.border, paddingVertical: 10 },
  copyText: { color: theme.primary, fontSize: 13, fontWeight: "800" },
  footer: { color: theme.textMuted, fontSize: 12, lineHeight: 18, marginTop: 18, textAlign: "center" },
});
