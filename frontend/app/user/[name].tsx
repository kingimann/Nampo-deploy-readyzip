import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image, ActivityIndicator, RefreshControl, Linking, Modal,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { api, Post, PublicUser, FriendStatus, SubTier } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import PostCard from "@/src/components/PostCard";
import VerifiedBadge from "@/src/components/VerifiedBadge";
import FakePaymentSheet from "@/src/components/FakePaymentSheet";
import AdSlot from "@/src/components/AdSlot";
import { interleaveAds, isAd } from "@/src/lib/ads";
import { withAppleFee } from "@/src/lib/pricing";
import { stripeCheckout } from "@/src/lib/stripeEmbed";

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
  const [payEnabled, setPayEnabled] = useState(false);
  const [tiers, setTiers] = useState<SubTier[]>([]);
  const [tierOpen, setTierOpen] = useState(false);
  const [chosenTier, setChosenTier] = useState<SubTier | null>(null);
  const [pokeMsg, setPokeMsg] = useState(false);

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
      return;
    }
    setTierOpen(true);   // choose a tier
  };

  const chooseTier = async (tier: SubTier) => {
    if (!user) return;
    setTierOpen(false);
    setChosenTier(tier);
    // Real payments: route through Stripe Checkout; else fall back to the test sheet.
    if (payEnabled) {
      try {
        await stripeCheckout({ kind: "subscription", creator_id: user.user_id, amount: 0, extra: { tier: tier.id } });
        return;
      } catch {}
    }
    setSubOpen(true);
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
      if (foundId && foundId !== me?.user_id) api.recordProfileView(foundId).catch(() => {});
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
    try { setPayEnabled((await api.getPaymentsConfig()).enabled); } catch {}
    try { setTiers((await api.getSubscriptionTiers()).tiers); } catch {}
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
          data={interleaveAds(posts)}
          keyExtractor={(i) => (isAd(i) ? `ad-${i.__ad}` : i.id)}
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
              <View style={styles.socialRow}>
                <View style={styles.socialItem}>
                  <Text style={styles.socialNum}>{posts.length}</Text>
                  <Text style={styles.socialLabel}>Posts</Text>
                </View>
                <View style={styles.socialDivider} />
                <TouchableOpacity
                  style={styles.socialItem}
                  onPress={() => router.push({ pathname: "/connections", params: { userId: user.user_id, name: user.name, tab: "followers" } })}
                  testID="user-followers"
                >
                  <Text style={styles.socialNum}>{user.stats?.followers || 0}</Text>
                  <Text style={styles.socialLabel}>Followers</Text>
                </TouchableOpacity>
                <View style={styles.socialDivider} />
                <TouchableOpacity
                  style={styles.socialItem}
                  onPress={() => router.push({ pathname: "/connections", params: { userId: user.user_id, name: user.name, tab: "following" } })}
                  testID="user-following"
                >
                  <Text style={styles.socialNum}>{user.stats?.following || 0}</Text>
                  <Text style={styles.socialLabel}>Following</Text>
                </TouchableOpacity>
                <View style={styles.socialDivider} />
                <View style={styles.socialItem}>
                  <Text style={styles.socialNum}>{user.stats?.friends || 0}</Text>
                  <Text style={styles.socialLabel}>Friends</Text>
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
                  <TouchableOpacity
                    style={[styles.actionBtn, styles.actionBtnGhost]}
                    onPress={async () => {
                      try {
                        await api.pokeUser(user.user_id);
                        setUser((p) => (p ? { ...p, poked_me: false } : p));
                        setPokeMsg(true);
                        setTimeout(() => setPokeMsg(false), 1600);
                      } catch {}
                    }}
                    testID="profile-poke"
                  >
                    <Ionicons name="hand-left" size={15} color={theme.textPrimary} />
                    <Text style={[styles.actionBtnText, { color: theme.textPrimary }]} numberOfLines={1}>
                      {pokeMsg ? "Poked!" : user.poked_me ? "Poke back" : "Poke"}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.actionBtn, styles.actionBtnGhost]} onPress={() => setTipOpen(true)} testID="profile-tip">
                    <Ionicons name="cash-outline" size={15} color={theme.textPrimary} />
                    <Text style={[styles.actionBtnText, { color: theme.textPrimary }]}>Tip</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.actionBtn, styles.actionBtnGhost]} onPress={() => router.push({ pathname: "/pay/[id]", params: { id: user.user_id } })} testID="profile-pay">
                    <Ionicons name="qr-code-outline" size={15} color={theme.textPrimary} />
                    <Text style={[styles.actionBtnText, { color: theme.textPrimary }]}>Pay</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actionBtn, user.is_subscribed && styles.actionBtnGhost]}
                    onPress={onSubscribe}
                    testID="profile-subscribe"
                  >
                    <Ionicons name={user.is_subscribed ? "checkmark-circle" : "star"} size={15} color={user.is_subscribed ? theme.textPrimary : "#fff"} />
                    <Text style={[styles.actionBtnText, user.is_subscribed && { color: theme.textPrimary }]} numberOfLines={1}>
                      {user.is_subscribed ? "Subscribed" : "Subscribe"}
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
            isAd(item) ? <AdSlot placement="profile" host={user.user_id} index={item.__ad} /> : (
            <PostCard
              post={item} viewerId={me?.user_id}
              onLike={onLike} onRepost={onRepost} onReply={onReply} onBookmark={onBookmark}
            />)
          )}
        />
      )}

      {user && (
        <>
          <FakePaymentSheet
            visible={tipOpen}
            title={`Tip ${user.name}`}
            subtitle="Enter what the creator receives"
            amount={5}
            editableAmount
            appleFee
            allowNote
            cta="Send"
            successText={`Your tip was sent to ${user.name}.`}
            onCheckout={payEnabled ? async (amt) => {
              try { return (await api.createCheckout("tip", user.user_id, amt)).url; } catch { return null; }
            } : undefined}
            onClose={() => setTipOpen(false)}
            onPaid={async (amount, note) => { await api.tipUser(user.user_id, amount, note); }}
          />
          <FakePaymentSheet
            visible={subOpen}
            title={`${chosenTier?.name || ""} subscription to ${user.name}`}
            subtitle={`Monthly — ${user.name} receives $${(chosenTier?.price ?? 0).toFixed(2)}`}
            amount={chosenTier?.price ?? 4.99}
            appleFee
            cta="Subscribe"
            successText={`You're subscribed to ${user.name}!`}
            onClose={() => setSubOpen(false)}
            onPaid={async () => {
              await api.subscribeUser(user.user_id, chosenTier?.id || "plus");
              setUser((p) => (p ? { ...p, is_subscribed: true, subscriber_count: (p.subscriber_count || 0) + 1 } : p));
            }}
          />

          <Modal visible={tierOpen} transparent animationType="fade" onRequestClose={() => setTierOpen(false)}>
            <View style={styles.tierBackdrop}>
              <View style={styles.tierCard}>
                <Text style={styles.tierTitle}>Subscribe to {user.name}</Text>
                <Text style={styles.tierSub}>Choose a tier</Text>
                {tiers.map((t) => (
                  <TouchableOpacity key={t.id} style={styles.tierRow} onPress={() => chooseTier(t)} testID={`tier-${t.id}`}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.tierName}>{t.name}</Text>
                    </View>
                    <Text style={styles.tierPrice}>${withAppleFee(t.price).toFixed(2)}/mo</Text>
                    <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
                  </TouchableOpacity>
                ))}
                <TouchableOpacity onPress={() => setTierOpen(false)}><Text style={styles.tierCancel}>Cancel</Text></TouchableOpacity>
              </View>
            </View>
          </Modal>
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
  socialRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    alignSelf: "stretch", marginTop: 14,
    backgroundColor: theme.surfaceAlt, borderRadius: 14, borderWidth: 1, borderColor: theme.border,
    paddingVertical: 12,
  },
  socialItem: { flex: 1, alignItems: "center", gap: 2 },
  socialNum: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  socialLabel: { color: theme.textMuted, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  socialDivider: { width: 1, height: 28, backgroundColor: theme.border },
  statsRow: { flexDirection: "row", gap: 18, marginTop: 12 },
  statBox: { alignItems: "center" },
  statNum: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  statLabel: { color: theme.textMuted, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  actionRow: { flexDirection: "row", gap: 8, marginTop: 10, alignSelf: "stretch" },
  actionBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: theme.primary, paddingHorizontal: 10, height: 40, borderRadius: 12,
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
  tierBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center", justifyContent: "center", padding: 24,
  },
  tierCard: {
    width: "100%", maxWidth: 420, backgroundColor: theme.surface,
    borderRadius: 18, borderWidth: 1, borderColor: theme.border, padding: 18,
  },
  tierTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  tierSub: { color: theme.textMuted, fontSize: 13, marginTop: 2, marginBottom: 12 },
  tierRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: theme.surfaceAlt, borderRadius: 14, borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 14, paddingVertical: 14, marginBottom: 10,
  },
  tierName: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  tierPrice: { color: theme.primary, fontSize: 15, fontWeight: "800" },
  tierCancel: { color: theme.textMuted, fontSize: 14, fontWeight: "700", textAlign: "center", marginTop: 4, paddingVertical: 8 },
});
