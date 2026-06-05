import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  ActivityIndicator, RefreshControl, Modal, KeyboardAvoidingView, Platform, ScrollView,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { api, Community } from "@/src/api/client";
import { theme } from "@/src/theme";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";

export default function CommunitiesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<Community[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [q, setQ] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState({ name: "", title: "", description: "" });
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setItems(await api.listCommunities(q || undefined)); }
    catch {} finally { setLoading(false); setRefreshing(false); }
  }, [q]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const create = async () => {
    const name = draft.name.trim().toLowerCase();
    if (!name) return;
    setCreating(true); setErr(null);
    try {
      const c = await api.createCommunity({ name, title: draft.title.trim() || name, description: draft.description.trim() });
      setCreateOpen(false);
      setDraft({ name: "", title: "", description: "" });
      router.push({ pathname: "/c/[name]", params: { name: c.name } });
    } catch (e: any) {
      setErr(e?.message || "Couldn't create community");
    } finally { setCreating(false); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="communities-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <SidebarMenuButton />
        <Text style={styles.title}>Communities</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={styles.searchPill}>
        <Ionicons name="search" size={17} color={theme.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search communities"
          placeholderTextColor={theme.textMuted}
          value={q}
          onChangeText={setQ}
          onSubmitEditing={load}
          returnKeyType="search"
          testID="communities-search"
        />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1, padding: 16, paddingBottom: insets.bottom + 90, gap: 12 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="chatbubbles-outline" size={40} color={theme.textMuted} />
              <Text style={styles.emptyTitle}>No communities yet</Text>
              <Text style={styles.emptySub}>Create the first one with the + button.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.row} onPress={() => router.push({ pathname: "/c/[name]", params: { name: item.name } })} testID={`community-${item.name}`}>
              <View style={[styles.icon, { backgroundColor: (item.color || theme.primary) + "22" }]}>
                <Ionicons name={(item.icon as any) || "people"} size={22} color={item.color || theme.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
                <Text style={styles.rowMeta} numberOfLines={1}>/{item.name} · {item.member_count || 0} members · {item.post_count || 0} posts</Text>
                {!!item.description && <Text style={styles.rowDesc} numberOfLines={2}>{item.description}</Text>}
              </View>
              {item.is_member && <View style={styles.joinedDot}><Ionicons name="checkmark" size={13} color="#fff" /></View>}
            </TouchableOpacity>
          )}
        />
      )}

      <TouchableOpacity style={[styles.fab, { bottom: insets.bottom + 16 }]} onPress={() => { setErr(null); setCreateOpen(true); }} testID="new-community-fab">
        <Ionicons name="add" size={26} color="#fff" />
      </TouchableOpacity>

      <Modal visible={createOpen} transparent animationType="slide" onRequestClose={() => setCreateOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setCreateOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.handle} />
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.sheetTitle}>Create a community</Text>
              {!!err && <Text style={styles.err}>{err}</Text>}
              <Text style={styles.label}>Name (the /handle)</Text>
              <View style={styles.nameWrap}>
                <Text style={styles.slash}>/</Text>
                <TextInput style={styles.nameInput} placeholder="gaming" placeholderTextColor={theme.textMuted} value={draft.name} onChangeText={(t) => setDraft({ ...draft, name: t.toLowerCase().replace(/[^a-z0-9_]/g, "") })} autoCapitalize="none" maxLength={30} testID="community-name" />
              </View>
              <Text style={styles.label}>Display title</Text>
              <TextInput style={styles.input} placeholder="Gaming" placeholderTextColor={theme.textMuted} value={draft.title} onChangeText={(t) => setDraft({ ...draft, title: t })} maxLength={60} testID="community-title" />
              <Text style={styles.label}>Description (optional)</Text>
              <TextInput style={[styles.input, { minHeight: 70, textAlignVertical: "top" }]} placeholder="What's this community about?" placeholderTextColor={theme.textMuted} value={draft.description} onChangeText={(t) => setDraft({ ...draft, description: t })} multiline maxLength={500} testID="community-desc" />
              <TouchableOpacity style={[styles.createBtn, (!draft.name.trim() || creating) && { opacity: 0.5 }]} onPress={create} disabled={!draft.name.trim() || creating} testID="community-create">
                {creating ? <ActivityIndicator color="#fff" /> : <Text style={styles.createBtnText}>Create community</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  title: { color: theme.textPrimary, fontSize: 24, fontWeight: "800", letterSpacing: -0.4 },
  searchPill: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginBottom: 6, height: 44, backgroundColor: theme.surface, borderRadius: 14, paddingHorizontal: 14, borderWidth: 1, borderColor: theme.border },
  searchInput: { flex: 1, color: theme.textPrimary, fontSize: 15, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 14 },
  icon: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
  rowTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  rowMeta: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
  rowDesc: { color: theme.textSecondary, fontSize: 13, marginTop: 4 },
  joinedDot: { width: 22, height: 22, borderRadius: 11, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center", paddingTop: 70, gap: 8 },
  emptyTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "700" },
  emptySub: { color: theme.textSecondary, fontSize: 13 },
  fab: { position: "absolute", right: 20, width: 60, height: 60, borderRadius: 30, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 14, elevation: 8 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#0E0E10", borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 12, paddingHorizontal: 20, maxHeight: "85%", borderTopWidth: 1, borderColor: theme.border },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 14 },
  sheetTitle: { color: theme.textPrimary, fontSize: 20, fontWeight: "800", marginBottom: 8 },
  err: { color: theme.error, fontSize: 13, marginBottom: 6 },
  label: { color: theme.textSecondary, fontSize: 12, fontWeight: "700", marginTop: 12, marginBottom: 6 },
  nameWrap: { flexDirection: "row", alignItems: "center", backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, height: 48 },
  slash: { color: theme.textMuted, fontSize: 17, fontWeight: "800" },
  nameInput: { flex: 1, color: theme.textPrimary, fontSize: 15, paddingHorizontal: 4, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  input: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: theme.textPrimary, fontSize: 14, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  createBtn: { marginTop: 20, paddingVertical: 14, borderRadius: 14, backgroundColor: theme.primary, alignItems: "center" },
  createBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },
});
