import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, AdRevenue } from "@/src/api/client";
import { theme } from "@/src/theme";

export default function AdminRevenueScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<AdRevenue | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.getAdRevenue()); setErr(null); }
    catch (e: any) { setErr(String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const Stat = ({ label, value, icon }: { label: string; value: string; icon: any }) => (
    <View style={styles.statCard}>
      <Ionicons name={icon} size={18} color={theme.primary} />
      <Text style={styles.statNum}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="admin-revenue-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn} testID="admin-rev-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Ad revenue</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : err ? (
        <View style={styles.center}>
          <Text style={{ color: theme.textMuted, textAlign: "center", marginBottom: 14 }}>{err}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => { setLoading(true); load(); }} testID="admin-rev-retry">
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : data ? (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} />}
        >
          <View style={styles.totalCard}>
            <Text style={styles.totalLabel}>Platform cut</Text>
            <Text style={styles.totalValue}>${data.platform_cut.toFixed(2)}</Text>
            <Text style={styles.totalSub}>of ${data.total_ad_spend.toFixed(2)} total ad spend · ${data.paid_to_hosts.toFixed(2)} paid to creators</Text>
          </View>

          <View style={styles.statsRow}>
            <Stat label="ad spend" value={`$${data.total_ad_spend.toFixed(0)}`} icon="cash-outline" />
            <Stat label="impressions" value={data.total_impressions.toLocaleString()} icon="eye-outline" />
            <Stat label="clicks" value={data.total_clicks.toLocaleString()} icon="hand-left-outline" />
          </View>
          <View style={styles.statsRow}>
            <Stat label="CTR" value={`${data.ctr}%`} icon="trending-up-outline" />
            <Stat label="to creators" value={`$${data.paid_to_hosts.toFixed(0)}`} icon="people-outline" />
            <Stat label="active" value={String(data.active_campaigns)} icon="megaphone-outline" />
          </View>

          <Text style={styles.section}>Top earners</Text>
          {data.top_earners.length === 0 ? <Text style={styles.empty}>No earnings yet.</Text> :
            data.top_earners.map((r, i) => (
              <View key={i} style={styles.row}>
                <Text style={styles.rank}>{i + 1}</Text>
                <Text style={styles.rowName} numberOfLines={1}>{r.name}</Text>
                <Text style={styles.rowAmt}>${r.amount.toFixed(2)}</Text>
              </View>
            ))}

          <Text style={styles.section}>Top advertisers</Text>
          {data.top_advertisers.length === 0 ? <Text style={styles.empty}>No campaigns yet.</Text> :
            data.top_advertisers.map((r, i) => (
              <View key={i} style={styles.row}>
                <Text style={styles.rank}>{i + 1}</Text>
                <Text style={styles.rowName} numberOfLines={1}>{r.name}</Text>
                <Text style={styles.rowAmt}>${r.amount.toFixed(2)}</Text>
              </View>
            ))}
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  backBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  totalCard: { backgroundColor: theme.surface, borderRadius: 18, borderWidth: 1, borderColor: theme.border, padding: 20, alignItems: "center", gap: 4 },
  totalLabel: { color: theme.textMuted, fontSize: 13, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  totalValue: { color: theme.textPrimary, fontSize: 40, fontWeight: "900", letterSpacing: -1 },
  totalSub: { color: theme.textMuted, fontSize: 12, textAlign: "center", marginTop: 4 },
  statsRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  statCard: { flex: 1, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12, alignItems: "center", gap: 4 },
  statNum: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  statLabel: { color: theme.textMuted, fontSize: 11 },
  section: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 24, marginBottom: 8 },
  empty: { color: theme.textMuted, fontSize: 13 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  rank: { color: theme.textMuted, fontSize: 13, fontWeight: "800", width: 18 },
  rowName: { flex: 1, color: theme.textPrimary, fontSize: 14, fontWeight: "600" },
  rowAmt: { color: theme.primary, fontSize: 14, fontWeight: "800" },
  retryBtn: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingVertical: 11, paddingHorizontal: 22 },
  retryText: { color: theme.primary, fontWeight: "800", fontSize: 14 },
});
