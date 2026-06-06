import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, ActivityItem } from "@/src/api/client";
import { theme } from "@/src/theme";

const ICON: Record<string, { icon: string; color: string }> = {
  topup: { icon: "add-circle", color: "#16A34A" },
  cashout: { icon: "flash", color: "#0EA5E9" },
  received: { icon: "arrow-down-circle", color: "#16A34A" },
  sent: { icon: "arrow-up-circle", color: theme.textSecondary },
  subscription_paid: { icon: "star", color: theme.textSecondary },
  transfer: { icon: "swap-horizontal", color: theme.primary },
};
const STATUS_COLOR: Record<string, string> = {
  completed: "#16A34A", active: "#16A34A", paid: "#16A34A", instant: "#0EA5E9",
  processing: "#D97706", pending: "#D97706",
  failed: "#DC2626", reversed: "#DC2626", declined: "#DC2626", cancelled: "#9CA3AF",
};
function fmtWhen(iso: string) {
  try { return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  catch { return ""; }
}

export default function ActivityScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setItems((await api.getActivity()).activity); }
    catch {} finally { setLoading(false); setRefreshing(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="activity-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => { if (router.canGoBack()) safeBack(); else router.replace("/wallet"); }} style={styles.iconBtn} testID="activity-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>All activity</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} />}
          ListEmptyComponent={<Text style={styles.empty}>No activity yet. Top up, tip, or send money and it'll show here.</Text>}
          renderItem={({ item }) => {
            const ic = ICON[item.kind] || ICON.transfer;
            const out = item.direction === "out";
            const stColor = STATUS_COLOR[item.status] || theme.textMuted;
            const showStatus = !["completed", "active", "paid"].includes(item.status);
            return (
              <View style={styles.row}>
                <View style={[styles.rowIcon, { backgroundColor: theme.surfaceAlt }]}>
                  <Ionicons name={ic.icon as any} size={18} color={ic.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {item.subtitle ? item.subtitle : ""}{item.subtitle ? " · " : ""}{fmtWhen(item.created_at)}{item.message ? ` · ${item.message}` : ""}
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={[styles.amt, { color: out ? theme.textSecondary : "#16A34A" }]}>
                    {out ? "-" : "+"}${item.amount.toFixed(2)}
                  </Text>
                  {showStatus ? <Text style={[styles.status, { color: stColor }]}>{item.status}</Text> : null}
                </View>
              </View>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { color: theme.textMuted, fontSize: 14, textAlign: "center", marginTop: 40, paddingHorizontal: 30, lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  rowIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  rowTitle: { color: theme.textPrimary, fontSize: 14.5, fontWeight: "700" },
  rowMeta: { color: theme.textMuted, fontSize: 12.5, marginTop: 2 },
  amt: { fontSize: 15, fontWeight: "800" },
  status: { fontSize: 10.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.3, marginTop: 2 },
});
