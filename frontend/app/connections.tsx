import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, PublicUser } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
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

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="connections-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{params.name || "Connections"}</Text>
        <View style={{ width: 36 }} />
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
            <UserRow
              user={item}
              currentUserId={me?.user_id}
              onChanged={(u) => setList((prev) => prev.map((x) => (x.user_id === u.user_id ? u : x)))}
            />
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
});
