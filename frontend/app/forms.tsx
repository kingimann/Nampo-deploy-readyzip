import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, FormDef } from "@/src/api/client";
import { theme } from "@/src/theme";

export default function FormsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [forms, setForms] = useState<FormDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try { setForms((await api.listForms()).forms); } catch {} finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const newForm = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const f = await api.createForm({
        title: "Untitled form",
        fields: [
          { type: "text", label: "Name", required: true },
          { type: "email", label: "Email", required: true },
          { type: "textarea", label: "Message", required: false },
        ],
      });
      router.push({ pathname: "/forms/[id]", params: { id: f.id } });
    } catch {} finally { setCreating(false); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="forms-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="forms-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Forms</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 96 }}>
          <Text style={styles.intro}>
            Build custom forms — contact, signup, feedback — use them around the app or embed them on any website.
          </Text>
          {forms.length === 0 ? (
            <View style={styles.empty}>
              <View style={styles.emptyIcon}><Ionicons name="document-text-outline" size={30} color={theme.textMuted} /></View>
              <Text style={styles.emptyTitle}>No forms yet</Text>
              <Text style={styles.emptySub}>Create your first form and start collecting responses.</Text>
            </View>
          ) : (
            forms.map((f) => (
              <TouchableOpacity
                key={f.id}
                style={styles.card}
                onPress={() => router.push({ pathname: "/forms/[id]", params: { id: f.id } })}
                testID={`form-${f.id}`}
              >
                <View style={styles.cardIcon}><Ionicons name="document-text" size={18} color={theme.primary} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle} numberOfLines={1}>{f.title}</Text>
                  <Text style={styles.cardMeta} numberOfLines={1}>
                    {f.fields.length} field{f.fields.length === 1 ? "" : "s"} · {f.submissions} response{f.submissions === 1 ? "" : "s"}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      )}

      <TouchableOpacity style={[styles.fab, { bottom: insets.bottom + 20 }]} onPress={newForm} disabled={creating} testID="forms-new">
        {creating ? <ActivityIndicator color="#fff" /> : <><Ionicons name="add" size={22} color="#fff" /><Text style={styles.fabText}>New form</Text></>}
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  intro: { color: theme.textSecondary, fontSize: 13.5, lineHeight: 20, marginBottom: 14 },
  empty: { alignItems: "center", paddingTop: 60, gap: 8 },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, alignItems: "center", justifyContent: "center", marginBottom: 6 },
  emptyTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  emptySub: { color: theme.textMuted, fontSize: 13.5, textAlign: "center", lineHeight: 19, paddingHorizontal: 30 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12, marginBottom: 10 },
  cardIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: theme.primary + "1f", alignItems: "center", justifyContent: "center" },
  cardTitle: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  cardMeta: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  fab: { position: "absolute", right: 18, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.primary, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 12, shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 10, elevation: 8 },
  fabText: { color: "#fff", fontWeight: "800", fontSize: 14 },
});
