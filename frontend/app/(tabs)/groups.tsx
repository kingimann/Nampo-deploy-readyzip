import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  ActivityIndicator, RefreshControl, Modal, KeyboardAvoidingView, Platform, Animated,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { api, Group } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import { GLASS } from "@/src/lib/glass";
import { useFloatingHeader } from "@/src/hooks/useFloatingHeader";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";

const COLORS = ["#3B82F6", "#22C55E", "#EAB308", "#A855F7", "#EF4444", "#06B6D4"];

export default function GroupsScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const fh = useFloatingHeader();
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [draft, setDraft] = useState({ name: "", description: "", color: COLORS[0], is_private: false });
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    try { setGroups(await api.listGroupsAll()); }
    catch {}
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (!draft.name.trim()) return;
    setPosting(true);
    try {
      const g = await api.createGroup({
        name: draft.name.trim(),
        description: draft.description.trim(),
        color: draft.color,
        is_private: draft.is_private,
      });
      setGroups((arr) => [g, ...arr]);
      setDraft({ name: "", description: "", color: COLORS[0], is_private: false });
      setComposeOpen(false);
    } catch {} finally { setPosting(false); }
  };

  const toggleMembership = async (g: Group) => {
    try {
      const updated = g.is_member ? await api.leaveGroup(g.id) : await api.joinGroup(g.id);
      setGroups((arr) => arr.map((x) => x.id === updated.id ? updated : x));
    } catch {}
  };

  const remove = async (g: Group) => {
    setGroups((arr) => arr.filter((x) => x.id !== g.id));
    try { await api.deleteGroupNew(g.id); } catch { load(); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="groups-screen">
      <Animated.View
        onLayout={(e) => fh.setTopBarH(e.nativeEvent.layout.height)}
        pointerEvents={fh.barPointerEvents}
        style={[styles.topBar, GLASS, fh.barStyle(insets.top)]}
      >
        <View style={styles.header}>
          <SidebarMenuButton />
          <Text style={styles.title}>Groups</Text>
          <View style={{ width: 40 }} />
        </View>
      </Animated.View>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={groups}
          keyExtractor={(i) => i.id}
          onScroll={fh.onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: fh.topBarH + 12, paddingBottom: insets.bottom + 100, gap: 10 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} progressViewOffset={fh.topBarH} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="people-outline" size={40} color={theme.textMuted} />
              <Text style={styles.emptyTitle}>No groups yet</Text>
              <Text style={styles.emptySub}>Be the first to create one!</Text>
            </View>
          }
          renderItem={({ item }) => {
            const mine = item.owner_id === user?.user_id;
            const openGroup = () => router.push(`/group/${item.id}` as any);
            return (
              <TouchableOpacity
                style={styles.card}
                onPress={openGroup}
                activeOpacity={item.is_member || mine ? 0.85 : 1}
                disabled={!item.is_member && !mine}
                testID={`group-${item.id}`}
              >
                <View style={[styles.icon, { backgroundColor: `${item.color}25`, borderColor: item.color }]}>
                  <Ionicons name="people" size={22} color={item.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                  {!!item.description && <Text style={styles.desc} numberOfLines={2}>{item.description}</Text>}
                  <Text style={styles.meta}>{item.member_count} {item.member_count === 1 ? "member" : "members"}</Text>
                </View>
                {mine ? (
                  <TouchableOpacity onPress={() => remove(item)} testID={`group-del-${item.id}`} style={styles.delBtn}>
                    <Ionicons name="trash" size={16} color={theme.error} />
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    onPress={() => toggleMembership(item)}
                    style={[styles.joinBtn, item.is_member && { backgroundColor: theme.surface, borderColor: theme.border }]}
                    testID={`group-join-${item.id}`}
                  >
                    <Text style={[styles.joinText, item.is_member && { color: theme.textPrimary }]}>
                      {item.is_member ? "Leave" : "Join"}
                    </Text>
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
            );
          }}
        />
      )}

      <TouchableOpacity
        style={[styles.fab, { bottom: insets.bottom + 70 }]}
        onPress={() => setComposeOpen(true)}
        testID="new-group-fab"
      >
        <Ionicons name="add" size={26} color="#fff" />
      </TouchableOpacity>

      <Modal visible={composeOpen} transparent animationType="slide" onRequestClose={() => setComposeOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setComposeOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>New group</Text>
            <Text style={styles.label}>Name</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Hiking buddies"
              placeholderTextColor={theme.textMuted}
              value={draft.name}
              onChangeText={(t) => setDraft({ ...draft, name: t })}
              maxLength={80}
              autoFocus
              testID="group-name-input"
            />
            <Text style={styles.label}>Description (optional)</Text>
            <TextInput
              style={[styles.input, { minHeight: 70, textAlignVertical: "top" }]}
              placeholder="What's this group about?"
              placeholderTextColor={theme.textMuted}
              value={draft.description}
              onChangeText={(t) => setDraft({ ...draft, description: t })}
              multiline
              maxLength={500}
            />
            <Text style={styles.label}>Color</Text>
            <View style={styles.colorRow}>
              {COLORS.map((c) => (
                <TouchableOpacity
                  key={c}
                  onPress={() => setDraft({ ...draft, color: c })}
                  style={[styles.colorChip, { backgroundColor: c }, draft.color === c && styles.colorChipActive]}
                  testID={`group-color-${c}`}
                />
              ))}
            </View>

            <TouchableOpacity
              style={styles.privacyRow}
              onPress={() => setDraft({ ...draft, is_private: !draft.is_private })}
              activeOpacity={0.85}
              testID="group-private-toggle"
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.privacyTitle}>{draft.is_private ? "Private group" : "Public group"}</Text>
                <Text style={styles.privacySub}>
                  {draft.is_private
                    ? "People must request to join. Only members see posts."
                    : "Anyone can join and see posts."}
                </Text>
              </View>
              <View style={[styles.toggleTrack, draft.is_private && { backgroundColor: theme.primary }]}>
                <View style={[styles.toggleThumb, draft.is_private && { transform: [{ translateX: 18 }] }]} />
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.postBtn, (!draft.name.trim() || posting) && { opacity: 0.5 }]}
              onPress={submit}
              disabled={!draft.name.trim() || posting}
              testID="group-submit"
            >
              {posting ? <ActivityIndicator color="#fff" /> : <Text style={styles.postBtnText}>Create group</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  topBar: {
    position: "absolute", top: 6, left: 8, right: 8,
    borderRadius: 24, paddingTop: 2, zIndex: 40,
    shadowColor: "#000", shadowOpacity: 0.32, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 10,
  },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  title: { color: theme.textPrimary, fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { paddingTop: 80, alignItems: "center", gap: 10 },
  emptyTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "700" },
  emptySub: { color: theme.textSecondary, fontSize: 13 },
  card: {
    flexDirection: "row", gap: 12, alignItems: "center",
    backgroundColor: theme.surface, borderRadius: 16,
    borderWidth: 1, borderColor: theme.border, padding: 14,
  },
  icon: {
    width: 48, height: 48, borderRadius: 14, borderWidth: 1,
    alignItems: "center", justifyContent: "center",
  },
  name: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  desc: { color: theme.textSecondary, fontSize: 12, marginTop: 2 },
  meta: { color: theme.textMuted, fontSize: 11, marginTop: 4 },
  joinBtn: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12,
    backgroundColor: theme.primary, borderWidth: 1, borderColor: theme.primary,
  },
  joinText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  delBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: "rgba(239,68,68,0.1)",
    alignItems: "center", justifyContent: "center",
  },
  fab: {
    position: "absolute", right: 20,
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 14, elevation: 8,
  },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#0E0E10",
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingTop: 12, paddingHorizontal: 20,
    borderTopWidth: 1, borderColor: theme.border,
  },
  sheetHandle: {
    alignSelf: "center", width: 40, height: 4, borderRadius: 2,
    backgroundColor: theme.borderStrong, marginBottom: 16,
  },
  sheetTitle: { color: theme.textPrimary, fontSize: 20, fontWeight: "800", marginBottom: 12 },
  label: { color: theme.textSecondary, fontSize: 12, fontWeight: "700", marginTop: 12, marginBottom: 6 },
  input: {
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    color: theme.textPrimary, fontSize: 14,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  colorRow: { flexDirection: "row", gap: 12, marginTop: 4 },
  colorChip: { width: 36, height: 36, borderRadius: 18, borderWidth: 3, borderColor: "transparent" },
  colorChipActive: { borderColor: "#fff" },
  postBtn: {
    marginTop: 20, paddingVertical: 14, borderRadius: 14,
    backgroundColor: theme.primary, alignItems: "center",
  },
  postBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },

  privacyRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface,
    borderRadius: 14, borderWidth: 1, borderColor: theme.border,
    padding: 14, marginTop: 8, marginBottom: 8,
  },
  privacyTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  privacySub: { color: theme.textMuted, fontSize: 12, marginTop: 4, lineHeight: 16 },
  toggleTrack: {
    width: 44, height: 26, borderRadius: 13,
    backgroundColor: theme.surfaceAlt,
    padding: 3, justifyContent: "center",
  },
  toggleThumb: {
    width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff",
  },
});
