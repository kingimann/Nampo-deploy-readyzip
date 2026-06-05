import React, { useCallback, useRef, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl, Modal, Alert, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { api, Post } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import PostCard from "@/src/components/PostCard";
import PostComposer from "@/src/components/PostComposer";
import StoryTray from "@/src/components/StoryTray";
import CommentsSheet from "@/src/components/CommentsSheet";

type Tab = "home" | "explore";

export default function FeedScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>("explore");
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Composer state
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<Post | null>(null);
  const [editing, setEditing] = useState<Post | null>(null);
  const [quoting, setQuoting] = useState<Post | null>(null);
  const [actionPost, setActionPost] = useState<Post | null>(null);
  const [commentsPost, setCommentsPost] = useState<Post | null>(null);
  const viewedRef = useRef<Set<string>>(new Set());

  const onViewable = useRef(({ viewableItems }: any) => {
    for (const v of viewableItems || []) {
      const p = v?.item as Post | undefined;
      if (!p?.id) continue;
      const targetId = p.repost_of || p.id;
      if (viewedRef.current.has(targetId)) continue;
      viewedRef.current.add(targetId);
      api.recordPostView(targetId).catch(() => {});
    }
  }).current;

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = tab === "home" ? await api.homeFeed() : await api.exploreFeed();
      setPosts(data);
    } catch {} finally {
      setLoading(false); setRefreshing(false);
    }
  }, [tab]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onLike = async (post: Post) => {
    setPosts((arr) => arr.map((p) => {
      const upd = (q: Post): Post => ({
        ...q,
        liked_by_me: !q.liked_by_me,
        likes_count: q.likes_count + (q.liked_by_me ? -1 : 1),
      });
      if (p.id === post.id) return upd(p);
      if (p.reposted_post && p.reposted_post.id === post.id)
        return { ...p, reposted_post: upd(p.reposted_post) };
      return p;
    }));
    try { await api.toggleLike(post.id); } catch { load(); }
  };

  const onRepost = async (post: Post) => {
    const target = post.repost_of || post.id;
    setPosts((arr) => arr.map((p) => {
      const upd = (q: Post): Post => ({
        ...q,
        reposted_by_me: !q.reposted_by_me,
        reposts_count: (q.reposts_count || 0) + (q.reposted_by_me ? -1 : 1),
      });
      let next = p;
      if (p.id === target) next = upd(next);
      if (next.reposted_post && next.reposted_post.id === target)
        next = { ...next, reposted_post: upd(next.reposted_post) };
      return next;
    }));
    try { await api.toggleRepost(target); } catch { load(); }
  };

  const onBookmark = async (post: Post) => {
    setPosts((arr) => arr.map((p) => {
      const upd = (q: Post): Post => ({
        ...q,
        bookmarked_by_me: !q.bookmarked_by_me,
        bookmarks_count: (q.bookmarks_count || 0) + (q.bookmarked_by_me ? -1 : 1),
      });
      if (p.id === post.id) return upd(p);
      if (p.reposted_post && p.reposted_post.id === post.id)
        return { ...p, reposted_post: upd(p.reposted_post) };
      return p;
    }));
    try { await api.toggleBookmark(post.id); } catch { load(); }
  };

  const onReply = (post: Post) => {
    setEditing(null); setQuoting(null); setReplyTo(post); setComposeOpen(true);
  };

  const onQuote = (post: Post) => {
    setEditing(null); setReplyTo(null); setQuoting(post); setComposeOpen(true);
  };

  const onPollUpdated = (updated: Post) => {
    setPosts((arr) => arr.map((p) => {
      if (p.id === updated.id) return updated;
      if (p.reposted_post && p.reposted_post.id === updated.id)
        return { ...p, reposted_post: updated };
      return p;
    }));
  };

  const onMore = (post: Post) => {
    if (post.user_id !== user?.user_id) return;
    setActionPost(post);
  };

  const onCommented = (postId: string) => {
    setPosts((arr) => arr.map((p) => {
      const bump = (q: Post): Post => ({ ...q, replies_count: (q.replies_count || 0) + 1 });
      if (p.id === postId) return bump(p);
      if (p.reposted_post && p.reposted_post.id === postId)
        return { ...p, reposted_post: bump(p.reposted_post) };
      return p;
    }));
  };

  const doDelete = async (p: Post) => {
    setPosts((arr) => arr.filter((x) => x.id !== p.id));
    try { await api.deletePost(p.id); } catch { load(); }
  };

  const onPosted = (newPost: Post) => {
    // Edit case: replace in place
    if (editing) {
      setPosts((arr) => arr.map((p) => p.id === newPost.id ? newPost : p));
    } else if (!replyTo) {
      // New top-level post: prepend
      setPosts((arr) => [newPost, ...arr]);
    } else {
      // Reply: bump reply count on the parent
      setPosts((arr) => arr.map((p) => {
        const bump = (q: Post): Post => ({ ...q, replies_count: (q.replies_count || 0) + 1 });
        if (p.id === replyTo.id) return bump(p);
        if (p.reposted_post && p.reposted_post.id === replyTo.id)
          return { ...p, reposted_post: bump(p.reposted_post) };
        return p;
      }));
    }
    setReplyTo(null); setEditing(null);
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="feed-screen">
      <View style={styles.header}>
        <SidebarMenuButton />
        <View style={styles.brandRow}>
          <Text style={styles.title}>Feed</Text>
        </View>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.segmentWrap}>
        <View style={styles.segment}>
          {(["explore", "home"] as Tab[]).map((k) => {
            const a = k === tab;
            return (
              <TouchableOpacity
                key={k}
                onPress={() => setTab(k)}
                style={[styles.segmentItem, a && styles.segmentItemActive]}
                activeOpacity={0.85}
                testID={`feed-tab-${k}`}
              >
                <Text style={[styles.segmentText, { color: a ? theme.textPrimary : theme.textMuted }]}>
                  {k === "explore" ? "Explore" : "Following"}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(i) => i.id}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60, minimumViewTime: 600 }}
          contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 6, paddingBottom: insets.bottom + 100, gap: 12 }}
          ItemSeparatorComponent={() => <View style={{ height: 2 }} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={theme.primary}
            />
          }
          ListHeaderComponent={
            <View>
              <StoryTray />
              <TouchableOpacity
                style={styles.composeStub}
                onPress={() => { setEditing(null); setReplyTo(null); setComposeOpen(true); }}
                activeOpacity={0.85}
                testID="open-composer-stub"
              >
                <View style={styles.stubAvatar}>
                  <Text style={styles.stubAvatarInit}>{(user?.name?.[0] || "?").toUpperCase()}</Text>
                </View>
                <Text style={styles.stubText}>What's on your mind?</Text>
                <View style={styles.stubIconRow}>
                  <Ionicons name="image-outline" size={20} color={theme.primary} />
                </View>
              </TouchableOpacity>
            </View>
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Ionicons name="newspaper-outline" size={32} color={theme.textMuted} />
              </View>
              <Text style={styles.emptyTitle}>No posts yet</Text>
              <Text style={styles.emptySub}>
                {tab === "home"
                  ? "Follow people to see their posts here."
                  : "Be the first to share something."}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <PostCard
              post={item}
              viewerId={user?.user_id}
              onLike={onLike}
              onRepost={onRepost}
              onQuote={onQuote}
              onReply={onReply}
              onComments={(p) => setCommentsPost(p)}
              onBookmark={onBookmark}
              onMore={onMore}
              onPollUpdated={onPollUpdated}
            />
          )}
        />
      )}

      <CommentsSheet
        visible={!!commentsPost}
        post={commentsPost}
        onClose={() => setCommentsPost(null)}
        onCommented={(postId) => onCommented(postId)}
      />

      <TouchableOpacity
        style={[styles.fab, { bottom: 20 }]}
        onPress={() => { setEditing(null); setReplyTo(null); setComposeOpen(true); }}
        testID="open-composer"
        activeOpacity={0.9}
      >
        <Ionicons name="create" size={22} color="#fff" />
      </TouchableOpacity>

      <PostComposer
        visible={composeOpen}
        onClose={() => { setComposeOpen(false); setReplyTo(null); setEditing(null); setQuoting(null); }}
        onPosted={onPosted}
        replyTo={replyTo}
        editing={editing}
        quoting={quoting}
      />

      {/* Owner long-press menu */}
      <Modal
        visible={!!actionPost}
        transparent
        animationType="fade"
        onRequestClose={() => setActionPost(null)}
      >
        <TouchableOpacity
          style={styles.actionBackdrop}
          activeOpacity={1}
          onPress={() => setActionPost(null)}
        >
          <View style={[styles.actionSheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.actionLabel}>Your post</Text>
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => {
                const p = actionPost!; setActionPost(null);
                setEditing(p); setReplyTo(null); setComposeOpen(true);
              }}
              testID="post-action-edit"
            >
              <Ionicons name="create-outline" size={18} color={theme.primary} />
              <Text style={styles.actionBtnText}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, { marginTop: 6 }]}
              onPress={() => {
                const p = actionPost!; setActionPost(null);
                const confirm = () => doDelete(p);
                if (Platform.OS === "web") {
                  // eslint-disable-next-line no-alert
                  if (window.confirm("Delete this post?")) confirm();
                } else {
                  Alert.alert("Delete post?", "This cannot be undone.", [
                    { text: "Cancel", style: "cancel" },
                    { text: "Delete", style: "destructive", onPress: confirm },
                  ]);
                }
              }}
              testID="post-action-delete"
            >
              <Ionicons name="trash-outline" size={18} color={theme.error} />
              <Text style={[styles.actionBtnText, { color: theme.error }]}>Delete</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, { marginTop: 6 }]}
              onPress={() => setActionPost(null)}
            >
              <Text style={styles.actionBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 14, paddingTop: 8, paddingBottom: 10,
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: theme.textPrimary, fontSize: 22, fontWeight: "800", letterSpacing: -0.4 },

  segmentWrap: { paddingHorizontal: 14, paddingBottom: 10 },
  segment: {
    flexDirection: "row",
    backgroundColor: theme.surface,
    borderRadius: 12,
    padding: 4,
    borderWidth: 1, borderColor: theme.border,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 9,
    alignItems: "center", justifyContent: "center",
  },
  segmentItemActive: {
    backgroundColor: theme.surfaceAlt,
  },
  segmentText: { fontSize: 13.5, fontWeight: "700", letterSpacing: 0.1 },

  composeStub: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface, borderRadius: 999,
    borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 14, paddingVertical: 12,
    marginBottom: 4,
  },
  stubAvatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
  },
  stubAvatarInit: { color: "#fff", fontWeight: "800", fontSize: 14 },
  stubText: { flex: 1, color: theme.textMuted, fontSize: 14 },
  stubIconRow: { flexDirection: "row", gap: 6 },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { paddingTop: 60, alignItems: "center", gap: 10 },
  emptyIcon: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  emptyTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "700" },
  emptySub: { color: theme.textSecondary, fontSize: 13, textAlign: "center", maxWidth: 280 },

  fab: {
    position: "absolute", right: 18,
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },

  actionBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end",
  },
  actionSheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingTop: 16, paddingHorizontal: 20,
    borderTopWidth: 1, borderColor: theme.border,
  },
  actionLabel: {
    color: theme.textMuted, fontSize: 11, fontWeight: "800",
    textTransform: "uppercase", letterSpacing: 0.6,
    textAlign: "center", marginBottom: 14,
  },
  actionBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
    backgroundColor: theme.surfaceAlt, borderRadius: 14,
    borderWidth: 1, borderColor: theme.border,
    paddingVertical: 14, paddingHorizontal: 16,
  },
  actionBtnText: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
});
