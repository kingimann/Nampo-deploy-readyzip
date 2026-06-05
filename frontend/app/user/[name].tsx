import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image, ActivityIndicator, RefreshControl,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { api, Post, PublicUser, FriendStatus } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import PostCard from "@/src/components/PostCard";
import VerifiedBadge from "@/src/components/VerifiedBadge";
import FakePaymentSheet from "@/src/components/FakePaymentSheet";
import { withAppleFee, appleFeeNote, isApplePlatform } from "@/src/lib/pricing";

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
  const [refreshing, setRefreshing] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/feed");
  };

  const onSubscribe = async () => {
    if (!user) return;
    if (user.is_subscribed) {
      try {
        await api.unsubscribeUser(user.user_id);
        setUser((p) => (p ? { ...p, is_subscribed: false, subscriber_count: Math.max(0, (p.subscriber_count || 1) - 1) } : p));
      } catch {}
    } else {
      setSubOpen(true);
    }
  };

  const load = useCallback(async () => {
    if (!name) return;
    try {
      // Resolve name → id via search, then fetch the FULL relationship-aware
      // profile (is_following / friend_status / is_subscribed / stats). Search
      // results alone omit those, which is why follow/add-friend looked broken.
      const matches = await api.searchUsers(name);
      let foundId = (matches.find((u) => u.name === name) || matches[0])?.user_id;
      const fallback = matches.find((u) => u.name === name) || matches[0] || null;
      // /users/search excludes the current user, so resolve self directly.
      if (!foundId && me && (me.name === name || me.username === name)) foundId = me.user_id;
      if (!foundId) return;
      const [full, p] = await Promise.all([
        api.getPublicUser(foundId).catch(() => fallback),
        api.listUserPosts(foundId),
      ]);
      if (full) setUser(full);
      setPosts(p);
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [name, me]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = () => { setRefreshing(true); load(); };

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

  // Admin-only: toggle verification / change a user's site role.
  const doAdmin = async (patch: { verified?: boolean; role?: string }) => {
    if (!user) return;
    try {
      const u = await api.adminPatchUser(user.user_id, patch);
      setUser((prev) => (prev ? { ...prev, verified: u.verified, role: u.role } : prev));
    } catch {}
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="user-profile-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={goBack} style={styles.backBtn} hitSlop={10} testID="user-back">
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
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} colors={[theme.primary]} />
          }
          ListHeaderComponent={
            <View style={styles.profileBlock}>
              <View style={styles.avatar}>
                {user.picture ? (
                  <Image source={{ uri: user.picture }} style={{ width: "100%", height: "100%" }} />
                ) : (
                  <Text style={styles.avatarInit}>{(user.name?.[0] || "?").toUpperCase()}</Text>
                )}
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
                <Text style={styles.name}>{user.name}</Text>
                {user.verified && <VerifiedBadge size={18} />}
              </View>
              {!!user.role && user.role !== "user" && (
                <Text style={styles.roleTag}>{user.role === "admin" ? "ADMIN" : "MODERATOR"}</Text>
              )}
              {!!user.bio && <Text style={styles.bio}>{user.bio}</Text>}
              <View style={styles.statsRow}>
                <View style={styles.statBox}>
                  <Text style={styles.statNum}>{posts.length}</Text>
                  <Text style={styles.statLabel}>Posts</Text>
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
              {user.user_id !== me?.user_id && (
                <View style={styles.actionRow}>
                  <TouchableOpacity style={[styles.actionBtn, styles.actionBtnGhost]} onPress={() => setTipOpen(true)} testID="profile-tip">
                    <Ionicons name="cash-outline" size={15} color={theme.textPrimary} />
                    <Text style={[styles.actionBtnText, { color: theme.textPrimary }]}>Tip</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actionBtn, user.is_subscribed && styles.actionBtnGhost]}
                    onPress={onSubscribe}
                    testID="profile-subscribe"
                  >
                    <Ionicons name={user.is_subscribed ? "checkmark-circle" : "star"} size={15} color={user.is_subscribed ? theme.textPrimary : "#fff"} />
                    <Text style={[styles.actionBtnText, user.is_subscribed && { color: theme.textPrimary }]}>
                      {user.is_subscribed ? "Subscribed" : `Subscribe · $${withAppleFee(user.sub_price ?? 0).toFixed(2)}/mo`}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
              {me?.role === "admin" && user.user_id !== me?.user_id && (
                <View style={styles.adminRow}>
                  <TouchableOpacity style={styles.adminBtn} onPress={() => doAdmin({ verified: !user.verified })} testID="admin-verify">
                    <Ionicons name="checkmark-circle" size={14} color="#1D9BF0" />
                    <Text style={styles.adminBtnText}>{user.verified ? "Unverify" : "Verify"}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.adminBtn} onPress={() => doAdmin({ role: user.role === "mod" ? "user" : "mod" })} testID="admin-mod">
                    <Ionicons name="shield-half-outline" size={14} color={theme.primary} />
                    <Text style={styles.adminBtnText}>{user.role === "mod" ? "Remove mod" : "Make mod"}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.adminBtn} onPress={() => doAdmin({ role: user.role === "admin" ? "user" : "admin" })} testID="admin-admin">
                    <Ionicons name="shield-checkmark-outline" size={14} color={theme.primary} />
                    <Text style={styles.adminBtnText}>{user.role === "admin" ? "Remove admin" : "Make admin"}</Text>
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

      {user && (
        <>
          <FakePaymentSheet
            visible={tipOpen}
            title={`Tip ${user.name}`}
            subtitle={isApplePlatform ? `Amount the creator receives — buyer pays ${appleFeeNote}` : "100% goes to the creator"}
            amount={5}
            editableAmount
            allowNote
            cta="Send"
            successText={`Your tip was sent to ${user.name}.`}
            onClose={() => setTipOpen(false)}
            onPaid={async (amount, note) => { await api.tipUser(user.user_id, amount, note); }}
          />
          <FakePaymentSheet
            visible={subOpen}
            title={`Subscribe to ${user.name}`}
            subtitle={isApplePlatform ? `Monthly — ${user.name} receives $${(user.sub_price ?? 4.99).toFixed(2)} (${appleFeeNote})` : "Monthly subscription — funds go to the creator"}
            amount={withAppleFee(user.sub_price ?? 4.99)}
            cta="Subscribe"
            successText={`You're subscribed to ${user.name}!`}
            onClose={() => setSubOpen(false)}
            onPaid={async () => {
              await api.subscribeUser(user.user_id);
              setUser((p) => (p ? { ...p, is_subscribed: true, subscriber_count: (p.subscriber_count || 0) + 1 } : p));
            }}
          />
        </>
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
  roleTag: {
    color: theme.primary, fontSize: 10.5, fontWeight: "900", letterSpacing: 1,
    marginTop: 2,
  },
  adminRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8, marginTop: 12 },
  adminBtn: {
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7,
  },
  adminBtnText: { color: theme.textPrimary, fontSize: 12, fontWeight: "700" },
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
