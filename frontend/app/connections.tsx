import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Image,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, PublicUser } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { useConfirm } from "@/src/context/ConfirmContext";
import { theme } from "@/src/theme";
import UserRow from "@/src/components/UserRow";

type Tab = "followers" | "following";

export default function ConnectionsScreen() {
  const params = useLocalSearchParams<{ userId?: string; name?: string; tab?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user: me } = useAuth();
  const userId = params.userId || me?.user_id || "";
  const [tab, setTab] = useState<Tab>(params.tab === "following" ? "following" : "followers");
  const [list, setList] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const confirm = useConfirm();
  const isMe = !!me?.user_id && userId === me.user_id;
  const canManage = isMe && tab === "following";
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);

  const load = useCallback(async (t: Tab) => {
    if (!userId) return;
    setLoading(true);
    try {
      const r = t === "followers"
        ? await api.listFollowers(userId)
        : await api.listFollowing(userId);
      setList(r);
    } catch {} finally { setLoading(false); }
  }, [userId]);

  useEffect(() => { load(tab); }, [tab, load]);
  // Leave select mode when switching tabs.
  useEffect(() => { setSelectMode(false); setSelected(new Set()); }, [tab]);

  const toggleSel = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const unfollowSelected = async () => {
    const ids = [...selected];
    if (!ids.length || working) return;
    if (!(await confirm({ title: `Unfollow ${ids.length}?`, message: "You'll stop following the selected accounts.", confirmLabel: "Unfollow", destructive: true }))) return;
    setWorking(true);
    try {
      await api.unfollowBulk(ids);
      setList((l) => l.filter((u) => !selected.has(u.user_id)));
      setSelected(new Set()); setSelectMode(false);
    } catch {} finally { setWorking(false); }
  };

  const unfollowEveryone = async () => {
    if (working || !list.length) return;
    if (!(await confirm({ title: "Unfollow everyone?", message: `This unfollows all ${list.length} accounts you follow. It can't be undone.`, confirmLabel: "Unfollow all", destructive: true }))) return;
    setWorking(true);
    try { await api.unfollowBulk(); setList([]); setSelected(new Set()); setSelectMode(false); }
    catch {} finally { setWorking(false); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="connections-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{params.name || "Connections"}</Text>
        {canManage && list.length > 0 ? (
          <TouchableOpacity
            onPress={() => { setSelectMode((m) => !m); setSelected(new Set()); }}
            style={styles.manageBtn}
            testID="conn-manage"
          >
            <Text style={styles.manageText}>{selectMode ? "Cancel" : "Manage"}</Text>
          </TouchableOpacity>
        ) : <View style={{ width: 36 }} />}
      </View>

      <View style={styles.tabs}>
        {(["followers", "following"] as Tab[]).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tab, tab === t && styles.tabActive]}
            onPress={() => setTab(t)}
            testID={`tab-${t}`}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === "followers" ? "Followers" : "Following"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={(i) => i.user_id}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 8 }}
          renderItem={({ item }) => (
            selectMode ? (
              <TouchableOpacity
                style={styles.selRow}
                onPress={() => toggleSel(item.user_id)}
                testID={`conn-sel-${item.user_id}`}
              >
                {item.picture ? (
                  <Image source={{ uri: item.picture }} style={styles.selAvatar} />
                ) : (
                  <View style={[styles.selAvatar, styles.selAvatarFallback]}>
                    <Text style={styles.selInit}>{(item.name?.[0] || "?").toUpperCase()}</Text>
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.selName} numberOfLines={1}>{item.name}</Text>
                  {!!item.username && <Text style={styles.selHandle} numberOfLines={1}>@{item.username}</Text>}
                </View>
                <Ionicons
                  name={selected.has(item.user_id) ? "checkmark-circle" : "ellipse-outline"}
                  size={24}
                  color={selected.has(item.user_id) ? theme.primary : theme.textMuted}
                />
              </TouchableOpacity>
            ) : (
              <UserRow
                user={item}
                currentUserId={me?.user_id}
                onChanged={(u) => setList((prev) => prev.map((x) => (x.user_id === u.user_id ? u : x)))}
              />
            )
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="people-outline" size={42} color={theme.textMuted} />
              <Text style={styles.emptyText}>
                {tab === "followers" ? "No followers yet." : "Not following anyone yet."}
              </Text>
            </View>
          }
        />
      )}

      {canManage && selectMode && (
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 10 }]}>
          <TouchableOpacity
            onPress={() => setSelected((s) => (s.size === list.length ? new Set() : new Set(list.map((u) => u.user_id))))}
            style={styles.barBtn}
            testID="conn-select-all"
          >
            <Text style={styles.barBtnText}>{selected.size === list.length ? "None" : "All"}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={unfollowEveryone} style={styles.barBtn} testID="conn-unfollow-all">
            <Text style={[styles.barBtnText, { color: theme.error }]}>Unfollow everyone</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={unfollowSelected}
            disabled={!selected.size || working}
            style={[styles.barPrimary, (!selected.size || working) && { opacity: 0.5 }]}
            testID="conn-unfollow-selected"
          >
            {working ? <ActivityIndicator color="#fff" size="small" /> : (
              <Text style={styles.barPrimaryText}>Unfollow ({selected.size})</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "800", flex: 1, textAlign: "center" },
  tabs: {
    flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 12,
  },
  tab: {
    flex: 1, paddingVertical: 10, borderRadius: 999, alignItems: "center",
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
  },
  tabActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  tabText: { color: theme.textSecondary, fontWeight: "700", fontSize: 13 },
  tabTextActive: { color: "#fff" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center", gap: 12, paddingVertical: 60 },
  emptyText: { color: theme.textMuted, fontSize: 14, textAlign: "center", paddingHorizontal: 40 },
  manageBtn: { minWidth: 36, height: 36, paddingHorizontal: 8, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  manageText: { color: theme.primary, fontSize: 14, fontWeight: "800" },
  selRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11 },
  selAvatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: theme.surfaceAlt },
  selAvatarFallback: { alignItems: "center", justifyContent: "center" },
  selInit: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  selName: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  selHandle: { color: theme.textMuted, fontSize: 12.5, marginTop: 1 },
  bottomBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.border, backgroundColor: theme.bg },
  barBtn: { paddingVertical: 10, paddingHorizontal: 8 },
  barBtnText: { color: theme.textSecondary, fontSize: 13, fontWeight: "800" },
  barPrimary: { flex: 1, backgroundColor: theme.primary, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingVertical: 12 },
  barPrimaryText: { color: "#fff", fontSize: 15, fontWeight: "800" },
});
