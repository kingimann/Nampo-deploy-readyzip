import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, Post } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import PostCard from "@/src/components/PostCard";

export default function HashtagScreen() {
  const { tag } = useLocalSearchParams<{ tag: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const cleanTag = (tag || "").replace(/^#/, "");

  const load = useCallback(async () => {
    if (!cleanTag) return;
    try {
      const r = await api.hashtagPosts(cleanTag);
      setPosts(r);
    } catch {} finally {
      setLoading(false); setRefreshing(false);
    }
  }, [cleanTag]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onLike = async (p: Post) => {
    setPosts((arr) => arr.map((x) => x.id !== p.id ? x : {
      ...x, liked_by_me: !x.liked_by_me,
      likes_count: x.likes_count + (x.liked_by_me ? -1 : 1),
    }));
    try { await api.toggleLike(p.id); } catch { load(); }
  };
  const onRepost = async (p: Post) => {
    try { await api.toggleRepost(p.repost_of || p.id); load(); } catch { load(); }
  };
  const onBookmark = async (p: Post) => {
    setPosts((arr) => arr.map((x) => x.id !== p.id ? x : {
      ...x, bookmarked_by_me: !x.bookmarked_by_me,
    }));
    try { await api.toggleBookmark(p.id); } catch { load(); }
  };
  const onReply = (p: Post) =>
    router.push({ pathname: "/post/[id]", params: { id: p.id } });
  const onPollUpdated = (updated: Post) =>
    setPosts((arr) => arr.map((x) => x.id === updated.id ? updated : x));

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="hashtag-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>#{cleanTag}</Text>
        <View style={{ width: 36 }} />
      </View>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 24, gap: 10 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="pricetag-outline" size={36} color={theme.textMuted} />
              <Text style={styles.emptyTitle}>No posts for #{cleanTag} yet</Text>
            </View>
          }
          renderItem={({ item }) => (
            <PostCard
              post={item} viewerId={user?.user_id}
              onLike={onLike} onRepost={onRepost} onReply={onReply}
              onBookmark={onBookmark} onPollUpdated={onPollUpdated}
            />
          )}
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
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { paddingTop: 80, alignItems: "center", gap: 10 },
  emptyTitle: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
});
