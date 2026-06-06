import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, SupportTicket } from "@/src/api/client";
import { theme } from "@/src/theme";
import { statusMeta, fmtAgo } from "@/app/support";

const FILTERS = [
  { k: "open", label: "Open" },
  { k: "", label: "All" },
  { k: "resolved", label: "Resolved" },
  { k: "closed", label: "Closed" },
];

export default function AdminSupportScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("open");

  const load = useCallback(async () => {
    setLoading(true);
    try { setTickets(await api.adminTickets(filter || undefined)); } catch {} finally { setLoading(false); }
  }, [filter]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="admin-support-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack("/settings")} style={styles.iconBtn} testID="admin-support-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Support inbox</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterRow} contentContainerStyle={{ gap: 8, paddingHorizontal: 14, paddingVertical: 10 }}>
        {FILTERS.map((f) => {
          const on = filter === f.k;
          return (
            <TouchableOpacity key={f.label} onPress={() => setFilter(f.k)} style={[styles.chip, on && styles.chipOn]} testID={`filter-${f.label}`}>
              <Text style={[styles.chipText, on && { color: "#fff" }]}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 30 }}>
          {tickets.length === 0 ? (
            <View style={styles.empty}><Ionicons name="checkmark-done-outline" size={38} color={theme.textMuted} /><Text style={styles.emptyText}>Nothing here.</Text></View>
          ) : tickets.map((t) => {
            const m = statusMeta(t.status);
            return (
              <TouchableOpacity key={t.id} style={styles.ticket} onPress={() => router.push({ pathname: "/support/[id]", params: { id: t.id } })} testID={`admin-ticket-${t.id}`}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.subject} numberOfLines={1}>{t.subject}</Text>
                  <Text style={styles.meta} numberOfLines={1}>{t.user?.name || "User"} · {t.category} · {fmtAgo(t.last_message_at)}</Text>
                </View>
                <View style={[styles.pill, { backgroundColor: m.color + "22", borderColor: m.color }]}>
                  <Text style={[styles.pillText, { color: m.color }]}>{m.label}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  filterRow: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  chip: { backgroundColor: theme.surface, borderRadius: 999, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, paddingVertical: 7 },
  chipOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  chipText: { color: theme.textSecondary, fontSize: 13, fontWeight: "700" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center", paddingVertical: 50, gap: 10 },
  emptyText: { color: theme.textMuted, fontSize: 14 },
  ticket: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 13, marginBottom: 10 },
  subject: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  meta: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  pill: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 4 },
  pillText: { fontSize: 11, fontWeight: "800" },
});
