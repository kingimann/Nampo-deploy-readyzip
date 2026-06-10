import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image, ActivityIndicator, RefreshControl,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, LeaderboardEntry } from "@/src/api/client";
import { theme } from "@/src/theme";
import { AvatarFrame } from "@/src/components/ProfileDecor";

function compact(n: number): string {
  if (!n || n < 1000) return String(n || 0);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

const MEDAL = ["#FFD700", "#C0C0C0", "#CD7F32"]; // gold / silver / bronze

export default function LeaderboardScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [leaders, setLeaders] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setLeaders((await api.pointsLeaderboard()).leaders); }
    catch {}
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openUser = (e: LeaderboardEntry) => {
    if (e.username) router.push({ pathname: "/[username]", params: { username: e.username } });
    else if (e.name) router.push({ pathname: "/user/[name]", params: { name: e.name } });
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="leaderboard-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn} hitSlop={10} testID="leaderboard-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Leaderboard</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={leaders}
          keyExtractor={(e) => e.user_id}
          contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 24, gap: 8 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} colors={[theme.primary]} />}
          ListEmptyComponent={<Text style={styles.empty}>No scores yet — be the first to earn points!</Text>}
          ListHeaderComponent={<Text style={styles.sub}>Top members by activity points. Earn points by posting, sharing stories, messaging, and connecting.</Text>}
          renderItem={({ item }) => {
            const medal = item.rank <= 3 ? MEDAL[item.rank - 1] : null;
            return (
              <TouchableOpacity
                style={[styles.row, item.is_me && styles.rowMe]}
                activeOpacity={0.85}
                onPress={() => openUser(item)}
                testID={`leader-${item.rank}`}
              >
                <View style={styles.rankWrap}>
                  {medal ? <Ionicons name="trophy" size={18} color={medal} />
                    : <Text style={styles.rankNum}>{item.rank}</Text>}
                </View>
                <AvatarFrame frame={item.avatar_frame} size={42} ring={2}>
                  <Image source={{ uri: item.picture || undefined }} style={styles.avatar} />
                </AvatarFrame>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.name}{item.is_me ? " (you)" : ""}
                  </Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    Lv {item.level} · {item.level_title}
                  </Text>
                </View>
                <View style={styles.ptsWrap}>
                  <Ionicons name="flame" size={14} color={theme.primary} />
                  <Text style={styles.pts}>{compact(item.points)}</Text>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 10 },
  backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  sub: { color: theme.textMuted, fontSize: 12.5, lineHeight: 18, marginBottom: 10, paddingHorizontal: 2 },
  empty: { color: theme.textMuted, fontSize: 13, textAlign: "center", marginTop: 40 },
  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface, borderRadius: 16,
    borderWidth: 1, borderColor: theme.border, padding: 12,
  },
  rowMe: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  rankWrap: { width: 26, alignItems: "center" },
  rankNum: { color: theme.textMuted, fontSize: 15, fontWeight: "800" },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: theme.surfaceAlt },
  name: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  meta: { color: theme.textMuted, fontSize: 12.5, marginTop: 2 },
  ptsWrap: { flexDirection: "row", alignItems: "center", gap: 4 },
  pts: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
});
