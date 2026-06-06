import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, OAuthConnection } from "@/src/api/client";
import { theme } from "@/src/theme";

const SCOPE_LABELS: Record<string, string> = { profile: "profile", email: "email" };

export default function ConnectedAppsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<OAuthConnection[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try { setItems((await api.getConnections()).connections); } catch {} finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const revoke = (c: OAuthConnection) => {
    Alert.alert("Revoke access", `Remove ${c.name}'s access to your Nami account?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Revoke", style: "destructive", onPress: async () => { try { await api.revokeConnection(c.client_id); await load(); } catch {} } },
    ]);
  };

  const fmt = (iso?: string | null) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }); } catch { return ""; }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="connected-apps-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn} testID="connected-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Connected apps</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
          <Text style={styles.lede}>Apps you've signed into with your Nami account. Revoke any you no longer use.</Text>
          {items.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="shield-checkmark-outline" size={36} color={theme.textMuted} />
              <Text style={styles.emptyText}>No connected apps.</Text>
            </View>
          ) : items.map((c) => (
            <View key={c.client_id} style={styles.row}>
              <View style={styles.icon}><Ionicons name="log-in-outline" size={18} color={theme.primary} /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>{c.name}</Text>
                <Text style={styles.meta} numberOfLines={1}>
                  Access: {c.scope.split(" ").map((s) => SCOPE_LABELS[s] || s).join(", ")}{c.granted_at ? ` · since ${fmt(c.granted_at)}` : ""}
                </Text>
              </View>
              <TouchableOpacity style={styles.revokeBtn} onPress={() => revoke(c)} testID={`revoke-${c.client_id}`}>
                <Text style={styles.revokeText}>Revoke</Text>
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  backBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  lede: { color: theme.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 12 },
  empty: { alignItems: "center", paddingTop: 60, gap: 10 },
  emptyText: { color: theme.textMuted, fontSize: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 14, marginBottom: 10 },
  icon: { width: 40, height: 40, borderRadius: 12, backgroundColor: theme.surfaceAlt, alignItems: "center", justifyContent: "center" },
  name: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  meta: { color: theme.textMuted, fontSize: 12.5, marginTop: 2 },
  revokeBtn: { borderWidth: 1, borderColor: theme.error, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
  revokeText: { color: theme.error, fontSize: 13, fontWeight: "800" },
});
