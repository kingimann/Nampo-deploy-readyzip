import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  RefreshControl, Image, Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import * as ImagePicker from "@/src/platform/image-picker";
import { assetToUri } from "@/src/utils/thumbnail";
import { api, Group, Post } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import AdSlot from "@/src/components/AdSlot";
import { interleaveAds, isAd } from "@/src/lib/ads";
import PostCard from "@/src/components/PostCard";
import PostComposer from "@/src/components/PostComposer";

export default function GroupDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [group, setGroup] = useState<Group | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [pins, setPins] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<Post | null>(null);
  const [editing, setEditing] = useState<Post | null>(null);
  const [coverUploading, setCoverUploading] = useState(false);

  const isOwner = !!group && group.owner_id === user?.user_id;

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [g, p] = await Promise.all([
        api.getGroup(id),
        api.listGroupPosts(id).catch(() => []),
      ]);
      setGroup(g);
      setPosts(p);
      // pins require membership; if not member, will 403 — ignore.
      if (g.is_member) {
        api.listGroupPins(id).then(setPins).catch(() => setPins([]));
      }
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const toggleMembership = async () => {
    if (!group) return;
    try {
      const upd = group.is_member ? await api.leaveGroup(group.id) : await api.joinGroup(group.id);
      setGroup(upd);
      if (upd.is_member) load();
    } catch {}
  };

  const onLike = async (p: Post) => {
    const upd = (arr: Post[]) => arr.map((x) => x.id !== p.id ? x : {
      ...x, liked_by_me: !x.liked_by_me,
      likes_count: x.likes_count + (x.liked_by_me ? -1 : 1),
    });
    setPosts(upd); setPins(upd);
    try { await api.toggleLike(p.id); } catch { load(); }
  };
  const onRepost = async (p: Post) => {
    try { await api.toggleRepost(p.repost_of || p.id); load(); } catch { load(); }
  };
  const onBookmark = async (p: Post) => {
    const upd = (arr: Post[]) => arr.map((x) => x.id !== p.id ? x : { ...x, bookmarked_by_me: !x.bookmarked_by_me });
    setPosts(upd); setPins(upd);
    try { await api.toggleBookmark(p.id); } catch { load(); }
  };
  const onReply = (p: Post) => router.push({ pathname: "/post/[id]", params: { id: p.id } });

  const togglePin = async (p: Post) => {
    if (!group) return;
    const isPinned = (group.pinned_post_ids || []).includes(p.id);
    try {
      const upd = isPinned
        ? await api.unpinGroupPost(group.id, p.id)
        : await api.pinGroupPost(group.id, p.id);
      setGroup(upd);
      const fresh = await api.listGroupPins(group.id).catch(() => []);
      setPins(fresh);
    } catch (e: any) {
      Alert.alert("Pin failed", e?.message || "Try again");
    }
  };

  const onMore = (p: Post) => {
    const mine = p.user_id === user?.user_id;
    const isPinned = !!group && (group.pinned_post_ids || []).includes(p.id);
    const opts: { label: string; destructive?: boolean; onPress: () => void }[] = [];
    if (isOwner) {
      opts.push({
        label: isPinned ? "Unpin from group" : `Pin to group${(group?.pinned_post_ids?.length ?? 0) >= 3 && !isPinned ? " (replaces oldest)" : ""}`,
        onPress: () => togglePin(p),
      });
    }
    if (mine) {
      opts.push({ label: "Edit post", onPress: () => { setEditing(p); setReplyTo(null); setComposeOpen(true); } });
    }
    if (opts.length === 0) return;
    Alert.alert("Post options", undefined, [
      ...opts.map((o) => ({ text: o.label, onPress: o.onPress, style: (o.destructive ? "destructive" : "default") as any })),
      { text: "Cancel", style: "cancel" as any },
    ]);
  };

  const onPosted = (p: Post) => {
    if (editing) {
      const upd = (arr: Post[]) => arr.map((x) => x.id === p.id ? p : x);
      setPosts(upd); setPins(upd);
    } else {
      setPosts((arr) => [p, ...arr]);
    }
    setEditing(null); setReplyTo(null);
  };

  const pickCover = async () => {
    if (!group || !isOwner) return;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Photos access needed", "Allow access to set a cover photo.");
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"] as any,
        allowsEditing: true,
        aspect: [16, 9],
        quality: 0.7,
        base64: true,
      });
      if (res.canceled || !res.assets?.[0]) return;
      setCoverUploading(true);
      // Cloudinary URL when configured, else base64.
      const dataUri = await assetToUri(res.assets[0], "image");
      if (!dataUri) { setCoverUploading(false); return; }
      const upd = await api.updateGroup(group.id, { cover_image: dataUri });
      setGroup(upd);
    } catch (e: any) {
      Alert.alert("Upload failed", e?.message || "Try a smaller image.");
    } finally {
      setCoverUploading(false);
    }
  };

  const clearCover = async () => {
    if (!group || !isOwner) return;
    Alert.alert("Remove cover photo?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          try {
            const upd = await api.updateGroup(group.id, { cover_image: "" });
            setGroup(upd);
          } catch {}
        },
      },
    ]);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.root}>
        <ActivityIndicator color={theme.primary} style={{ marginTop: 60 }} />
      </SafeAreaView>
    );
  }
  if (!group) {
    return (
      <SafeAreaView style={styles.root}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.center}>
          <Text style={{ color: theme.textMuted }}>Group not found.</Text>
          <TouchableOpacity onPress={() => safeBack()} style={styles.backLink}>
            <Text style={{ color: theme.primary, fontWeight: "700" }}>Go back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const memberCountText = `${group.member_count} ${group.member_count === 1 ? "member" : "members"}`;

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="group-detail-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn} testID="group-back">
          <Ionicons name="chevron-back" size={22} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{group.name}</Text>
        <View style={{ width: 36 }} />
      </View>

      <FlatList
        data={interleaveAds(posts)}
        keyExtractor={(i) => (isAd(i) ? `ad-${i.__ad}` : i.id)}
        contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} />
        }
        ListHeaderComponent={
          <View>
            {/* Cover photo */}
            <View style={styles.coverWrap}>
              {group.cover_image ? (
                <Image source={{ uri: group.cover_image }} style={styles.coverImg} />
              ) : (
                <View style={[styles.coverImg, { backgroundColor: `${group.color}25` }]} />
              )}
              <View style={styles.coverOverlay} />
              {isOwner && (
                <View style={styles.coverActions}>
                  <TouchableOpacity
                    style={styles.coverBtn}
                    onPress={pickCover}
                    disabled={coverUploading}
                    testID="upload-cover-btn"
                  >
                    {coverUploading ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <>
                        <Ionicons name="camera" size={14} color="#fff" />
                        <Text style={styles.coverBtnText}>{group.cover_image ? "Change cover" : "Add cover"}</Text>
                      </>
                    )}
                  </TouchableOpacity>
                  {!!group.cover_image && (
                    <TouchableOpacity style={styles.coverIconBtn} onPress={clearCover} testID="clear-cover-btn">
                      <Ionicons name="trash" size={14} color="#fff" />
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </View>

            {/* Banner */}
            <View style={styles.bannerBlock}>
              <View style={styles.bannerRow}>
                <View style={[styles.bannerIcon, { backgroundColor: `${group.color}25`, borderColor: group.color }]}>
                  <Ionicons name="people" size={32} color={group.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.bannerTitle}>{group.name}</Text>
                  <Text style={styles.bannerMeta}>{memberCountText} · {isOwner ? "You're the owner" : group.is_member ? "Joined" : "Public group"}</Text>
                </View>
              </View>
              {!!group.description && <Text style={styles.bannerDesc}>{group.description}</Text>}
            {!isOwner && (
              <TouchableOpacity
                onPress={toggleMembership}
                style={[
                  styles.joinBtn,
                  group.is_member && { backgroundColor: theme.surface, borderColor: theme.border },
                  group.membership_pending && !group.is_member && { backgroundColor: theme.surfaceAlt, borderColor: theme.border },
                ]}
                testID="group-toggle-member"
                disabled={!!group.membership_pending && !group.is_member}
              >
                <Ionicons
                  name={
                    group.is_member ? "checkmark-circle" :
                    group.membership_pending ? "time-outline" :
                    group.is_private ? "lock-closed" : "add-circle"
                  }
                  size={18}
                  color={group.is_member || group.membership_pending ? theme.textPrimary : "#fff"}
                />
                <Text style={[
                  styles.joinText,
                  (group.is_member || group.membership_pending) && { color: theme.textPrimary },
                ]}>
                  {group.is_member ? "Joined" :
                   group.membership_pending ? "Request pending" :
                   group.is_private ? "Request to join" : "Join group"}
                </Text>
              </TouchableOpacity>
            )}
            {(group.is_member || isOwner) && (
              <TouchableOpacity
                style={styles.manageBtn}
                onPress={() => router.push(`/group/${group.id}/members` as any)}
                testID="group-manage-members"
                activeOpacity={0.85}
              >
                <Ionicons name="people" size={18} color={theme.textPrimary} />
                <Text style={styles.manageBtnText}>
                  Members{(group.pending_request_count ?? 0) > 0 && (group.my_role === "owner" || group.my_role === "admin")
                    ? `  · ${group.pending_request_count} pending`
                    : ""}
                </Text>
                <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
              </TouchableOpacity>
            )}
              {group.is_member && (
                <TouchableOpacity
                  style={styles.composerStub}
                  onPress={() => { setReplyTo(null); setEditing(null); setComposeOpen(true); }}
                  activeOpacity={0.85}
                  testID="group-compose-stub"
                >
                  <View style={styles.avatar}>
                    {user?.picture
                      ? <Image source={{ uri: user.picture }} style={styles.avatarImg} />
                      : <Text style={styles.avatarInit}>{(user?.name?.[0] || "?").toUpperCase()}</Text>}
                  </View>
                  <Text style={styles.composerStubText}>Write something to {group.name}…</Text>
                  <Ionicons name="image" size={20} color={theme.textMuted} />
                </TouchableOpacity>
              )}
            </View>

            {/* Pinned posts */}
            {pins.length > 0 && (
              <View style={styles.pinSection} testID="pinned-section">
                <View style={styles.pinHeader}>
                  <Ionicons name="pin" size={14} color={theme.primary} />
                  <Text style={styles.pinHeaderText}>Pinned {pins.length > 1 ? "posts" : "post"}</Text>
                </View>
                <View style={{ gap: 10, paddingHorizontal: 12 }}>
                  {pins.map((p) => (
                    <View key={`pin_${p.id}`} style={styles.pinnedCard}>
                      <PostCard
                        post={p}
                        viewerId={user?.user_id}
                        onLike={onLike}
                        onRepost={onRepost}
                        onReply={onReply}
                        onBookmark={onBookmark}
                        onMore={onMore}
                      />
                    </View>
                  ))}
                </View>
              </View>
            )}

            {posts.length > 0 && (
              <View style={styles.feedHeader}>
                <Text style={styles.feedHeaderText}>Group feed</Text>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name={group.is_member ? "newspaper-outline" : "lock-closed-outline"} size={36} color={theme.textMuted} />
            <Text style={styles.emptyTitle}>
              {group.is_member ? "No posts yet" : "Join to see posts"}
            </Text>
            <Text style={styles.emptySub}>
              {group.is_member ? "Be the first to post in this group!" : "Members can read and post in this group."}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          if (isAd(item)) return (
            <View style={{ paddingHorizontal: 12, marginBottom: 10 }}><AdSlot placement="group" index={item.__ad} /></View>
          );
          const pinnedSet = new Set(group.pinned_post_ids || []);
          if (pinnedSet.has(item.id)) return null; // de-dupe pinned posts from main feed
          return (
            <View style={{ paddingHorizontal: 12, marginBottom: 10 }}>
              <PostCard
                post={item}
                viewerId={user?.user_id}
                onLike={onLike}
                onRepost={onRepost}
                onReply={onReply}
                onBookmark={onBookmark}
                onMore={onMore}
              />
            </View>
          );
        }}
      />

      {group.is_member && (
        <TouchableOpacity
          style={[styles.fab, { bottom: insets.bottom + 24 }]}
          onPress={() => { setReplyTo(null); setEditing(null); setComposeOpen(true); }}
          testID="group-compose-fab"
        >
          <Ionicons name="create" size={22} color="#fff" />
        </TouchableOpacity>
      )}

      <PostComposer
        visible={composeOpen}
        onClose={() => { setComposeOpen(false); setEditing(null); setReplyTo(null); }}
        onPosted={onPosted}
        replyTo={replyTo}
        editing={editing}
        groupId={group.id}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  backLink: { marginTop: 10, padding: 10 },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  headerTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800", flex: 1, textAlign: "center" },

  coverWrap: { width: "100%", height: 180, position: "relative", backgroundColor: theme.surface },
  coverImg: { width: "100%", height: "100%" },
  coverOverlay: {
    position: "absolute", left: 0, right: 0, bottom: 0, top: 0,
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  coverActions: {
    position: "absolute", right: 14, bottom: 14, flexDirection: "row", gap: 8,
  },
  coverBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: "rgba(0,0,0,0.65)", borderRadius: 999,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.25)",
  },
  coverBtnText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  coverIconBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: "rgba(0,0,0,0.65)",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.25)",
    alignItems: "center", justifyContent: "center",
  },

  bannerBlock: { padding: 14, gap: 12 },
  bannerRow: { flexDirection: "row", gap: 14, alignItems: "center" },
  bannerIcon: {
    width: 56, height: 56, borderRadius: 16, borderWidth: 1,
    alignItems: "center", justifyContent: "center",
  },
  bannerTitle: { color: theme.textPrimary, fontSize: 20, fontWeight: "800", letterSpacing: -0.3 },
  bannerMeta: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  bannerDesc: { color: theme.textSecondary, fontSize: 13, lineHeight: 18 },

  joinBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: theme.primary, paddingVertical: 12, borderRadius: 14,
    borderWidth: 1, borderColor: theme.primary,
  },
  joinText: { color: "#fff", fontWeight: "700", fontSize: 14 },

  manageBtn: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: theme.surface, borderRadius: 14,
    borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  manageBtnText: { color: theme.textPrimary, fontSize: 14, fontWeight: "700", flex: 1 },

  composerStub: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface, borderRadius: 999,
    borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  avatar: {
    width: 38, height: 38, borderRadius: 19, overflow: "hidden",
    backgroundColor: theme.primary, alignItems: "center", justifyContent: "center",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontSize: 16, fontWeight: "700" },
  composerStubText: { flex: 1, color: theme.textMuted, fontSize: 14 },

  pinSection: {
    paddingTop: 8, paddingBottom: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border,
    backgroundColor: "rgba(59,130,246,0.04)",
  },
  pinHeader: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 16, paddingVertical: 8,
  },
  pinHeaderText: { color: theme.primary, fontSize: 12, fontWeight: "800", letterSpacing: 0.4, textTransform: "uppercase" },
  pinnedCard: {
    borderLeftWidth: 3, borderLeftColor: theme.primary,
    borderRadius: 12, overflow: "hidden",
  },

  feedHeader: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  feedHeaderText: { color: theme.textMuted, fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },

  empty: { paddingTop: 60, alignItems: "center", gap: 8, paddingHorizontal: 30 },
  emptyTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "700" },
  emptySub: { color: theme.textSecondary, fontSize: 13, textAlign: "center", maxWidth: 260 },

  fab: {
    position: "absolute", right: 20,
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 14, elevation: 8,
  },
});
