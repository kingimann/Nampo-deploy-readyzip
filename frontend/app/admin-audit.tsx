import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, AdminAuditEntry } from "@/src/api/client";
import { theme } from "@/src/theme";

function icon(action: string): { name: any; color: string } {
  if (action.startsWith("banned")) return { name: "ban", color: theme.error };
  if (action.startsWith("suspended")) return { name: "time", color: "#F59E0B" };
  if (action.startsWith("lifted")) return { name: "play-circle", color: "#22C55E" };
  if (action.startsWith("removed")) return { name: "trash", color: theme.error };
  if (action.includes("verified")) return { name: "checkmark-circle", color: "#1D9BF0" };
  if (action.startsWith("set role")) return { name: "shield-half", color: theme.primary };
  return { name: "ellipse", color: theme.textMuted };
}

function ago(iso: string) {
  try {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
    return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
  } catch { return ""; }
}

export default function AdminAuditScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [entries, setEntries] = useState<AdminAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setEntries((await api.adminAuditLog()).entries); }
    catch {} finally { setLoading(false); setRefreshing(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="admin-audit-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="audit-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Admin · Activity log</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(e) => e.id}
          contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} />}
          ListEmptyComponent={<Text style={styles.empty}>No admin actions yet.</Text>}
          renderItem={({ item }) => {
            const ic = icon(item.action);
            return (
              <View style={styles.row}>
                <View style={[styles.dot, { backgroundColor: ic.color + "22" }]}>
                  <Ionicons name={ic.name} size={16} color={ic.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.text}>
                    <Text style={styles.bold}>{item.admin_name}</Text> {item.action}{" "}
                    <Text style={styles.bold}>{item.target_name}</Text>
                  </Text>
                  {!!item.detail && <Text style={styles.detail} numberOfLines={2}>“{item.detail}”</Text>}
                </View>
                <Text style={styles.time}>{ago(item.created_at)}</Text>
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
  empty: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingVertical: 40 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  dot: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  text: { color: theme.textSecondary, fontSize: 13.5, lineHeight: 19 },
  bold: { color: theme.textPrimary, fontWeight: "700" },
  detail: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  time: { color: theme.textMuted, fontSize: 11.5, fontWeight: "600" },
});
