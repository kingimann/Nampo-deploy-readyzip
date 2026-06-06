import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  ActivityIndicator, RefreshControl, Modal, KeyboardAvoidingView, Platform, ScrollView,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, Community, Post } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import PostCard from "@/src/components/PostCard";
import AdSlot from "@/src/components/AdSlot";
import { interleaveAds, isAd } from "@/src/lib/ads";
import CommentsSheet from "@/src/components/CommentsSheet";

const SORTS = [
  { key: "hot", label: "Hot" },
  { key: "new", label: "New" },
  { key: "top", label: "Top" },
];

export default function CommunityScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { name } = useLocalSearchParams<{ name: string }>();
  const [community, setCommunity] = useState<Community | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sort, setSort] = useState("hot");
  const [commentsPost, setCommentsPost] = useState<Post | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [draft, setDraft] = useState({ title: "", body: "" });
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    if (!name) return;
    try {
      const [c, p] = await Promise.all([api.getCommunity(name), api.communityPosts(name, sort)]);
      setCommunity(c); setPosts(p);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [name, sort]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const toggleJoin = async () => {
    if (!community) return;
    try {
      if (community.is_member) {
        await api.leaveCommunity(community.name);
        setCommunity({ ...community, is_member: false, member_count: Math.max(0, (community.member_count || 1) - 1) });
      } else {
        await api.joinCommunity(community.name);
        setCommunity({ ...community, is_member: true, member_count: (community.member_count || 0) + 1 });
      }
    } catch {}
  };

  const applyEngagement = (u: Post) =>
    setPosts((arr) => arr.map((p) => (p.id === u.id ? { ...p, liked_by_me: u.liked_by_me, likes_count: u.likes_count, disliked_by_me: u.disliked_by_me, dislikes_count: u.dislikes_count } : p)));
  const onLike = async (p: Post) => { try { applyEngagement(await api.toggleLike(p.id)); } catch {} };
  const onDislike = async (p: Post) => { try { applyEngagement(await api.toggleDislike(p.id)); } catch {} };
  const onRepost = async (p: Post) => { try { await api.toggleRepost(p.repost_of || p.id); } catch {} };
  const onBookmark = async (p: Post) => {
    setPosts((arr) => arr.map((x) => (x.id === p.id ? { ...x, bookmarked_by_me: !x.bookmarked_by_me } : x)));
    try { await api.toggleBookmark(p.id); } catch {}
  };

  const createThread = async () => {
    if (!community) return;
    const title = draft.title.trim();
    if (!title) return;
    setPosting(true);
    try {
      const p = await api.createPost({ community_id: community.id, title, text: draft.body.trim() });
      setPosts((arr) => [p, ...arr]);
      setDraft({ title: "", body: "" });
      setComposeOpen(false);
    } catch {} finally { setPosting(false); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="community-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="community-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{community ? `/${community.name}` : "Community"}</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={interleaveAds(posts)}
          keyExtractor={(i) => (isAd(i) ? `ad-${i.__ad}` : i.id)}
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + 90 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} />}
          ListHeaderComponent={
            community ? (
              <View>
                <View style={styles.banner}>
                  <View style={[styles.cIcon, { backgroundColor: (community.color || theme.primary) + "22" }]}>
                    <Ionicons name={(community.icon as any) || "people"} size={26} color={community.color || theme.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cTitle}>{community.title}</Text>
                    <Text style={styles.cMeta}>{community.member_count || 0} members · {community.post_count || 0} posts</Text>
                  </View>
                  <TouchableOpacity style={[styles.joinBtn, community.is_member && styles.joinBtnGhost]} onPress={toggleJoin} testID="community-join">
                    <Text style={[styles.joinText, community.is_member && { color: theme.textPrimary }]}>{community.is_member ? "Joined" : "Join"}</Text>
                  </TouchableOpacity>
                </View>
                {!!community.description && <Text style={styles.cDesc}>{community.description}</Text>}
                <View style={styles.sortRow}>
                  {SORTS.map((s) => (
                    <TouchableOpacity key={s.key} onPress={() => setSort(s.key)} style={[styles.sortChip, sort === s.key && styles.sortChipOn]} testID={`sort-${s.key}`}>
                      <Text style={[styles.sortText, sort === s.key && { color: theme.primary }]}>{s.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ) : null
          }
          ListEmptyComponent={<Text style={styles.empty}>No threads yet. Start the first one with the + button.</Text>}
          renderItem={({ item }) => (
            isAd(item) ? <AdSlot placement="community" index={item.__ad} /> : (
            <PostCard
              post={item}
              viewerId={user?.user_id}
              onLike={onLike}
              onDislike={onDislike}
              onRepost={onRepost}
              onBookmark={onBookmark}
              onComments={(p) => setCommentsPost(p)}
            />)
          )}
        />
      )}

      <TouchableOpacity
        style={[styles.fab, { bottom: insets.bottom + 16 }]}
        onPress={() => (community?.is_member ? setComposeOpen(true) : toggleJoin())}
        testID="new-thread-fab"
      >
        <Ionicons name={community?.is_member ? "create" : "add"} size={24} color="#fff" />
      </TouchableOpacity>

      <CommentsSheet visible={!!commentsPost} post={commentsPost} onClose={() => setCommentsPost(null)} />

      <Modal visible={composeOpen} transparent animationType="slide" onRequestClose={() => setComposeOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setComposeOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.handle} />
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.sheetTitle}>New thread in /{community?.name}</Text>
              <TextInput style={styles.titleInput} placeholder="Title" placeholderTextColor={theme.textMuted} value={draft.title} onChangeText={(t) => setDraft({ ...draft, title: t })} maxLength={200} testID="thread-title" />
              <TextInput style={[styles.bodyInput]} placeholder="Body (optional)" placeholderTextColor={theme.textMuted} value={draft.body} onChangeText={(t) => setDraft({ ...draft, body: t })} multiline maxLength={500} testID="thread-body" />
              <TouchableOpacity style={[styles.postBtn, (!draft.title.trim() || posting) && { opacity: 0.5 }]} onPress={createThread} disabled={!draft.title.trim() || posting} testID="thread-submit">
                {posting ? <ActivityIndicator color="#fff" /> : <Text style={styles.postBtnText}>Post thread</Text>}
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
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, color: theme.textPrimary, fontSize: 17, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  banner: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16 },
  cIcon: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
  cTitle: { color: theme.textPrimary, fontSize: 20, fontWeight: "800" },
  cMeta: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  joinBtn: { backgroundColor: theme.primary, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 9 },
  joinBtnGhost: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  joinText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  cDesc: { color: theme.textSecondary, fontSize: 14, paddingHorizontal: 16, marginBottom: 8, lineHeight: 19 },
  sortRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  sortChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  sortChipOn: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  sortText: { color: theme.textSecondary, fontSize: 13, fontWeight: "700" },
  empty: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingVertical: 50 },
  fab: { position: "absolute", right: 20, width: 58, height: 58, borderRadius: 29, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 14, elevation: 8 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#0E0E10", borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 12, paddingHorizontal: 20, maxHeight: "85%", borderTopWidth: 1, borderColor: theme.border },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 14 },
  sheetTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "800", marginBottom: 12 },
  titleInput: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: theme.textPrimary, fontSize: 16, fontWeight: "700", marginBottom: 10, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  bodyInput: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: theme.textPrimary, fontSize: 14, minHeight: 100, textAlignVertical: "top", ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  postBtn: { marginTop: 16, paddingVertical: 14, borderRadius: 14, backgroundColor: theme.primary, alignItems: "center" },
  postBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },
});
