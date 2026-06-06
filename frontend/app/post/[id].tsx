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
import PostComposer from "@/src/components/PostComposer";

export default function PostDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [parent, setParent] = useState<Post | null>(null);
  const [replies, setReplies] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [composeOpen, setComposeOpen] = useState(false);
  const [editing, setEditing] = useState<Post | null>(null);
  const [quoting, setQuoting] = useState<Post | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [p, r] = await Promise.all([api.getPost(id), api.listReplies(id)]);
      setParent(p); setReplies(r);
      // Record a unique view (silent failure ok).
      api.recordPostView(id).catch(() => {});
    } catch {} finally {
      setLoading(false); setRefreshing(false);
    }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const updateInList = (target: Post, modify: (q: Post) => Post) => {
    if (parent && parent.id === target.id) setParent((p) => p ? modify(p) : p);
    setReplies((arr) => arr.map((r) => r.id === target.id ? modify(r) : r));
  };

  // Replace a post's engagement fields with the server's authoritative values.
  const applyEngagement = (u: Post) => updateInList(u, (q) => ({
    ...q,
    liked_by_me: u.liked_by_me, likes_count: u.likes_count,
    disliked_by_me: u.disliked_by_me, dislikes_count: u.dislikes_count,
  }));

  const onLike = async (p: Post) => {
    updateInList(p, (q) => ({
      ...q, liked_by_me: !q.liked_by_me,
      likes_count: q.likes_count + (q.liked_by_me ? -1 : 1),
      disliked_by_me: q.liked_by_me ? q.disliked_by_me : false,
      dislikes_count: (q.dislikes_count || 0) - (!q.liked_by_me && q.disliked_by_me ? 1 : 0),
    }));
    try { applyEngagement(await api.toggleLike(p.id)); } catch { load(); }
  };
  const onDislike = async (p: Post) => {
    updateInList(p, (q) => {
      const nowDis = !q.disliked_by_me;
      return {
        ...q,
        disliked_by_me: nowDis,
        dislikes_count: (q.dislikes_count || 0) + (nowDis ? 1 : -1),
        liked_by_me: nowDis ? false : q.liked_by_me,
        likes_count: q.likes_count - (nowDis && q.liked_by_me ? 1 : 0),
      };
    });
    try { applyEngagement(await api.toggleDislike(p.id)); } catch { load(); }
  };
  const onRepost = async (p: Post) => {
    const target = p.repost_of || p.id;
    updateInList({ ...p, id: target } as Post, (q) => ({
      ...q, reposted_by_me: !q.reposted_by_me,
      reposts_count: (q.reposts_count || 0) + (q.reposted_by_me ? -1 : 1),
    }));
    try { await api.toggleRepost(target); } catch { load(); }
  };
  const onBookmark = async (p: Post) => {
    updateInList(p, (q) => ({
      ...q, bookmarked_by_me: !q.bookmarked_by_me,
      bookmarks_count: (q.bookmarks_count || 0) + (q.bookmarked_by_me ? -1 : 1),
    }));
    try { await api.toggleBookmark(p.id); } catch { load(); }
  };

  const onReply = () => { setEditing(null); setComposeOpen(true); };

  const onPosted = (newPost: Post) => {
    if (editing) {
      if (parent && parent.id === newPost.id) setParent(newPost);
      else setReplies((arr) => arr.map((r) => r.id === newPost.id ? newPost : r));
    } else {
      // New reply
      setReplies((arr) => [...arr, newPost]);
      if (parent) setParent({ ...parent, replies_count: (parent.replies_count || 0) + 1 });
    }
    setEditing(null);
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="post-detail-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn} testID="detail-back">
          <Ionicons name="chevron-back" size={22} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Post</Text>
        <View style={{ width: 36 }} />
      </View>

      {loading || !parent ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={replies}
          keyExtractor={(i) => i.id}
          ListHeaderComponent={
            <View style={{ gap: 10, marginBottom: 8 }}>
              <PostCard
                post={parent}
                viewerId={user?.user_id}
                disableOpen
                onLike={onLike}
                onDislike={onDislike}
                onRepost={onRepost}
                onReply={() => onReply()}
                onBookmark={onBookmark}
                onMore={(p) => {
                  if (p.user_id === user?.user_id) {
                    setEditing(p); setComposeOpen(true);
                  }
                }}
              />
              <Text style={styles.repliesLabel}>
                {replies.length === 0 ? "No replies yet — be the first!" : `${replies.length} repl${replies.length === 1 ? "y" : "ies"}`}
              </Text>
            </View>
          }
          contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 100, gap: 10 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={theme.primary}
            />
          }
          renderItem={({ item }) => (
            <PostCard
              post={item}
              viewerId={user?.user_id}
              onLike={onLike}
              onDislike={onDislike}
              onRepost={onRepost}
              onReply={() => onReply()}
              onBookmark={onBookmark}
            />
          )}
        />
      )}

      <TouchableOpacity
        style={[styles.fab, { bottom: insets.bottom + 24 }]}
        onPress={onReply}
        disabled={!parent}
        testID="detail-reply-fab"
      >
        <Ionicons name="chatbubble" size={22} color="#fff" />
        <Text style={styles.fabText}>Reply</Text>
      </TouchableOpacity>

      <PostComposer
        visible={composeOpen}
        onClose={() => { setComposeOpen(false); setEditing(null); setQuoting(null); }}
        onPosted={onPosted}
        replyTo={editing || quoting ? null : parent}
        editing={editing}
        quoting={quoting}
      />
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
  repliesLabel: {
    color: theme.textMuted, fontSize: 12, fontWeight: "700",
    paddingHorizontal: 4, paddingVertical: 6,
    textTransform: "uppercase", letterSpacing: 0.5,
  },
  fab: {
    position: "absolute", right: 18,
    paddingHorizontal: 18, paddingVertical: 12, borderRadius: 30,
    backgroundColor: theme.primary,
    flexDirection: "row", alignItems: "center", gap: 8,
    shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 10, elevation: 8,
  },
  fabText: { color: "#fff", fontWeight: "800", fontSize: 14 },
});
