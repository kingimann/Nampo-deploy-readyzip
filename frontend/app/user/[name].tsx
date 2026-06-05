import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image, ActivityIndicator,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { api, Post, PublicUser, FriendStatus } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import PostCard from "@/src/components/PostCard";

const friendBtnLabel = (s?: FriendStatus): string => {
  switch (s) {
    case "friends": return "Friends";
    case "request_sent": return "Requested";
    case "request_received": return "Accept";
    default: return "Add friend";
  }
};
const friendBtnIcon = (s?: FriendStatus): keyof typeof Ionicons.glyphMap => {
  switch (s) {
    case "friends": return "people";
    case "request_sent": return "time";
    case "request_received": return "checkmark";
    default: return "person-add";
  }
};
const friendBtnStyle = (s?: FriendStatus) => {
  if (s === "friends") return { backgroundColor: theme.surfaceAlt, borderColor: theme.border };
  if (s === "request_sent") return { backgroundColor: theme.surfaceAlt, borderColor: theme.border };
  return {};
};

export default function UserProfileScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user: me } = useAuth();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!name) return;
    try {
      // Resolve by name via search (first hit)
      const matches = await api.searchUsers(name);
      const found = matches.find((u) => u.name === name) || matches[0];
      if (!found) return;
      const [p] = await Promise.all([
        api.listUserPosts(found.user_id),
      ]);
      setUser(found);
      setPosts(p);
    } catch {} finally {
      setLoading(false);
    }
  }, [name]);

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

  const startDM = async () => {
    if (!user) return;
    try {
      const conv = await api.getOrCreateConversation(user.user_id);
      router.push({ pathname: "/chat/[id]", params: { id: conv.id, name: user.name } });
    } catch {}
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="user-profile-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>@{name}</Text>
        <View style={{ width: 36 }} />
      </View>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : !user ? (
        <View style={styles.center}><Text style={{ color: theme.textMuted }}>User not found.</Text></View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 24, gap: 10 }}
          ListHeaderComponent={
            <View style={styles.profileBlock}>
              <View style={styles.avatar}>
                {user.picture ? (
                  <Image source={{ uri: user.picture }} style={{ width: "100%", height: "100%" }} />
                ) : (
                  <Text style={styles.avatarInit}>{(user.name?.[0] || "?").toUpperCase()}</Text>
                )}
              </View>
              <Text style={styles.name}>{user.name}</Text>
              {!!user.bio && <Text style={styles.bio}>{user.bio}</Text>}
              <View style={styles.statsRow}>
                <View style={styles.statBox}>
                  <Text style={styles.statNum}>{user.stats?.places || 0}</Text>
                  <Text style={styles.statLabel}>Places</Text>
                </View>
                <View style={styles.statBox}>
                  <Text style={styles.statNum}>{user.stats?.guides || 0}</Text>
                  <Text style={styles.statLabel}>Guides</Text>
                </View>
                <View style={styles.statBox}>
                  <Text style={styles.statNum}>{user.stats?.reviews || 0}</Text>
                  <Text style={styles.statLabel}>Reviews</Text>
                </View>
              </View>
              {user.user_id !== me?.user_id && (
                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={[styles.actionBtn, user.is_following && styles.actionBtnGhost]}
                    onPress={async () => {
                      try {
                        const r = await api.toggleFollow(user.user_id);
                        setUser({ ...user, is_following: r.following });
                      } catch {}
                    }}
                    testID="profile-follow"
                  >
                    <Ionicons name={user.is_following ? "checkmark" : "person-add"} size={15} color={user.is_following ? theme.textPrimary : "#fff"} />
                    <Text style={[styles.actionBtnText, user.is_following && { color: theme.textPrimary }]}>
                      {user.is_following ? "Following" : "Follow"}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actionBtn, friendBtnStyle(user.friend_status)]}
                    onPress={async () => {
                      try {
                        if (user.friend_status === "friends") {
                          await api.unfriend(user.user_id);
                          setUser({ ...user, friend_status: "none" });
                        } else if (user.friend_status === "request_sent") {
                          await api.cancelFriendRequest(user.user_id);
                          setUser({ ...user, friend_status: "none" });
                        } else if (user.friend_status === "request_received") {
                          await api.acceptFriend(user.user_id);
                          setUser({ ...user, friend_status: "friends" });
                        } else {
                          const r = await api.sendFriendRequest(user.user_id);
                          setUser({ ...user, friend_status: r.status });
                        }
                      } catch {}
                    }}
                    testID="profile-friend"
                  >
                    <Ionicons name={friendBtnIcon(user.friend_status)} size={15} color="#fff" />
                    <Text style={styles.actionBtnText}>{friendBtnLabel(user.friend_status)}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.actionBtn, styles.actionBtnGhost]} onPress={startDM} testID="profile-dm">
                    <Ionicons name="chatbubble" size={15} color={theme.textPrimary} />
                    <Text style={[styles.actionBtnText, { color: theme.textPrimary }]}>Message</Text>
                  </TouchableOpacity>
                </View>
              )}
              <Text style={styles.postsLabel}>Posts</Text>
            </View>
          }
          ListEmptyComponent={
            <Text style={{ color: theme.textMuted, textAlign: "center", paddingVertical: 40 }}>No posts yet.</Text>
          }
          renderItem={({ item }) => (
            <PostCard
              post={item} viewerId={me?.user_id}
              onLike={onLike} onRepost={onRepost} onReply={onReply} onBookmark={onBookmark}
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
  profileBlock: {
    alignItems: "center", padding: 18, gap: 6,
    backgroundColor: theme.surface, borderRadius: 16,
    borderWidth: 1, borderColor: theme.border, marginBottom: 6,
  },
  avatar: {
    width: 80, height: 80, borderRadius: 40, overflow: "hidden",
    backgroundColor: theme.primary, alignItems: "center", justifyContent: "center",
  },
  avatarInit: { color: "#fff", fontSize: 32, fontWeight: "800" },
  name: { color: theme.textPrimary, fontSize: 20, fontWeight: "800", marginTop: 6 },
  bio: { color: theme.textSecondary, fontSize: 13, textAlign: "center", marginTop: 2, paddingHorizontal: 24 },
  statsRow: { flexDirection: "row", gap: 18, marginTop: 12 },
  statBox: { alignItems: "center" },
  statNum: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  statLabel: { color: theme.textMuted, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  actionRow: { flexDirection: "row", gap: 8, marginTop: 14, flexWrap: "wrap", justifyContent: "center" },
  actionBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: theme.primary, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999,
  },
  actionBtnGhost: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  actionBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  dmBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: theme.primary, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999,
    marginTop: 10,
  },
  dmBtnText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  postsLabel: {
    color: theme.textMuted, fontSize: 12, fontWeight: "800",
    textTransform: "uppercase", letterSpacing: 0.6,
    alignSelf: "flex-start", marginTop: 14,
  },
});
