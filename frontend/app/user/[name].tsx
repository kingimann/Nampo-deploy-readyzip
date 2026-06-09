import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image, ActivityIndicator, RefreshControl, Linking, Modal,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { shareLink, profilePath } from "@/src/utils/share";
import { api, Post, PublicUser, FriendStatus, SubTier } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import { SOCIAL_BY_KEY, socialUrl, fmtBirthday } from "@/src/lib/socials";
import { resolveAccent, accentGradient, normalizeLinkUrl, prettyLinkLabel } from "@/src/lib/profileCustomize";
import { levelInfo } from "@/src/lib/points";
import { AvatarFrame, ProfileBackground } from "@/src/components/ProfileDecor";
import PostCard from "@/src/components/PostCard";
import VerifiedBadge from "@/src/components/VerifiedBadge";
import PresenceDot, { presenceLabel } from "@/src/components/PresenceDot";
import UserBadges from "@/src/components/UserBadges";
import FakePaymentSheet from "@/src/components/FakePaymentSheet";
import AdSlot from "@/src/components/AdSlot";
import { interleaveAds, isAd } from "@/src/lib/ads";
import { withAppleFee } from "@/src/lib/pricing";
import { stripeCardPay } from "@/src/lib/stripeEmbed";

function compactCount(n: number): string {
  if (!n || n < 1000) return String(n || 0);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

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
  // This screen backs both /user/<name> and the vanity /<username> route, so it
  // accepts either param. The vanity username takes precedence when present.
  const { name: nameParam, username, subscribe } = useLocalSearchParams<{ name?: string; username?: string; subscribe?: string }>();
  const name = (username || nameParam || "") as string;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user: me } = useAuth();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [ptab, setPtab] = useState<"posts" | "replies" | "reposts" | "likes">("posts");
  const [replies, setReplies] = useState<Post[] | null>(null);
  const [reposts, setReposts] = useState<Post[] | null>(null);
  const [likes, setLikes] = useState<Post[] | null>(null);
  const [tabLoading, setTabLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [payEnabled, setPayEnabled] = useState(false);
  const [walletBal, setWalletBal] = useState<number | null>(null);
  const [tiers, setTiers] = useState<SubTier[]>([]);
  const [tierOpen, setTierOpen] = useState(false);
  const [chosenTier, setChosenTier] = useState<SubTier | null>(null);
  const [pokeMsg, setPokeMsg] = useState(false);

  const goBack = () => {
    if (router.canGoBack()) safeBack();
    else router.replace("/feed");
  };

  const [linkCopied, setLinkCopied] = useState(false);
  useEffect(() => { if (!linkCopied) return; const t = setTimeout(() => setLinkCopied(false), 1800); return () => clearTimeout(t); }, [linkCopied]);
  const onShareProfile = async () => {
    const path = user ? profilePath(user) : `/${name}`;
    const r = await shareLink(path, { title: user?.name ? `${user.name} on OkaySpace` : "Profile on OkaySpace" });
    if (r === "copied") setLinkCopied(true);
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

  // Opened from a paywall ("Subscribe" on gated content): jump straight to the
  // tier picker once the profile loads, if not already subscribed.
  const autoSubRef = useRef(false);
  useEffect(() => {
    if (subscribe === "1" && user && !user.is_subscribed && user.user_id !== me?.user_id && !autoSubRef.current) {
      autoSubRef.current = true;
      setTierOpen(true);
    }
  }, [subscribe, user, me?.user_id]);

  const chooseTier = async (tier: SubTier) => {
    if (!user) return;
    setTierOpen(false);
    setChosenTier(tier);
    // Real payments: route through Stripe Checkout; else fall back to the test sheet.
    if (payEnabled) {
      try {
        await stripeCardPay({ kind: "subscription", creator_id: user.user_id, amount: 0, extra: { tier: tier.id } });
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
      // Prefer an exact username match (vanity URLs), then exact name, then first.
      const exact = matches.find((u) => u.username === name) || matches.find((u) => u.name === name);
      let foundId = (exact || matches[0])?.user_id;
      const fallback = exact || matches[0] || null;
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
    try { setWalletBal((await api.getWalletBalance()).balance); } catch {}
    try { setTiers((await api.getSubscriptionTiers()).tiers); } catch {}
  }, [name, me]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = () => { setRefreshing(true); load(); };

  const patchPost = (id: string, fn: (p: Post) => Post) => {
    const m = (arr: Post[]) => arr.map((x) => (x.id === id ? fn(x) : x));
    setPosts(m);
    setReplies((a) => (a ? m(a) : a));
    setReposts((a) => (a ? m(a) : a));
    setLikes((a) => (a ? m(a) : a));
  };
  const switchTab = useCallback(async (t: "posts" | "replies" | "reposts" | "likes") => {
    setPtab(t);
    const uid = user?.user_id;
    if (!uid) return;
    const need = (t === "replies" && replies == null) || (t === "reposts" && reposts == null) || (t === "likes" && likes == null);
    if (!need) return;
    setTabLoading(true);
    try {
      if (t === "replies") setReplies(await api.listUserReplies(uid));
      else if (t === "reposts") setReposts(await api.listUserReposts(uid));
      else if (t === "likes") setLikes(await api.listUserLikes(uid));
    } catch {
      if (t === "replies") setReplies([]); else if (t === "reposts") setReposts([]); else if (t === "likes") setLikes([]);
    } finally { setTabLoading(false); }
  }, [user?.user_id, replies, reposts, likes]);

  const onLike = async (p: Post) => {
    patchPost(p.id, (x) => ({ ...x, liked_by_me: !x.liked_by_me, likes_count: x.likes_count + (x.liked_by_me ? -1 : 1) }));
    try { await api.toggleLike(p.id); } catch { load(); }
  };
  const onRepost = async (p: Post) => {
    try { await api.toggleRepost(p.repost_of || p.id); setReposts(null); load(); } catch { load(); }
  };
  const onBookmark = async (p: Post) => {
    patchPost(p.id, (x) => ({ ...x, bookmarked_by_me: !x.bookmarked_by_me }));
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

  const accent = resolveAccent(user?.accent_color);

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="user-profile-screen">
      <ProfileBackground background={user?.profile_background} />
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={goBack} style={styles.backBtn} hitSlop={10} testID="user-back">
          <Ionicons name="chevron-back" size={22} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>@{name}</Text>
        <TouchableOpacity onPress={onShareProfile} style={styles.backBtn} hitSlop={10} testID="user-share">
          <Ionicons name="share-outline" size={20} color={theme.textPrimary} />
        </TouchableOpacity>
      </View>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : !user ? (
        <View style={styles.center}><Text style={{ color: theme.textMuted }}>User not found.</Text></View>
      ) : (
        <FlatList
          data={ptab === "posts" ? interleaveAds(posts) : ptab === "replies" ? (replies || []) : ptab === "reposts" ? (reposts || []) : (likes || [])}
          keyExtractor={(i) => (isAd(i) ? `ad-${i.__ad}` : i.id)}
          contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 24, gap: 10 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} colors={[theme.primary]} />
          }
          ListHeaderComponent={
            <View style={styles.profileBlock}>
              {user.cover_photo ? (
                <Image source={{ uri: user.cover_photo }} style={styles.cover} resizeMode="cover" />
              ) : (
                <LinearGradient colors={accentGradient(user.accent_color)} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.cover} />
              )}
              <AvatarFrame frame={user.avatar_frame} size={80} ring={3} style={{ marginTop: -42 }}>
                <View style={styles.avatarWrap}>
                  <View style={styles.avatar}>
                    {user.picture ? (
                      <Image source={{ uri: user.picture }} style={{ width: "100%", height: "100%" }} />
                    ) : (
                      <Text style={styles.avatarInit}>{(user.name?.[0] || "?").toUpperCase()}</Text>
                    )}
                  </View>
                  <PresenceDot online={user.online} size={18} borderColor={theme.bg} style={{ right: 3, bottom: 3 }} />
                </View>
              </AvatarFrame>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
                <Text style={styles.name}>{user.name}</Text>
                {user.verified && <VerifiedBadge size={18} />}
                <UserBadges badges={user.badges} size={18} />
              </View>
              <Text style={[styles.presence, user.online && { color: "#22C55E" }]}>{presenceLabel(user.online, user.last_seen)}</Text>
              {!!user.role && user.role !== "user" && (
                <Text style={styles.roleTag}>{user.role === "admin" ? "ADMIN" : "MODERATOR"}</Text>
              )}
              {user.show_points !== false && (
                <TouchableOpacity
                  style={[styles.scorePill, { borderColor: accent + "55" }]}
                  activeOpacity={0.85}
                  onPress={() => router.push("/leaderboard")}
                  testID="user-score"
                >
                  <Ionicons name="flame" size={14} color={accent} />
                  <Text style={[styles.scoreText, { color: accent }]}>{compactCount(user.points || 0)}</Text>
                  <View style={[styles.levelBadge, { backgroundColor: accent }]}>
                    <Text style={styles.levelBadgeText}>Lv {user.level || levelInfo(user.points || 0).level}</Text>
                  </View>
                  <Text style={styles.scoreLabel} numberOfLines={1}>{user.level_title || levelInfo(user.points || 0).title}</Text>
                </TouchableOpacity>
              )}
              {!!user.status && (
                <View style={[styles.statusPillP, { borderColor: accent + "55" }]}>
                  <Text style={styles.statusPillText} numberOfLines={1}>{user.status}</Text>
                </View>
              )}
              {!!user.headline && <Text style={styles.headline} numberOfLines={2}>{user.headline}</Text>}
              {!!user.bio && <Text style={styles.bio}>{user.bio}</Text>}

              {(!!user.pronouns || !!user.location || !!user.birthday) && (
                <View style={styles.detailsWrap}>
                  {!!user.pronouns && (
                    <View style={styles.detailRow}>
                      <Ionicons name="person-circle-outline" size={14} color={theme.textMuted} />
                      <Text style={styles.detailText} numberOfLines={1}>{user.pronouns}</Text>
                    </View>
                  )}
                  {!!user.location && (
                    <View style={styles.detailRow}>
                      <Ionicons name="location-outline" size={14} color={theme.textMuted} />
                      <Text style={styles.detailText} numberOfLines={1}>{user.location}</Text>
                    </View>
                  )}
                  {!!fmtBirthday(user.birthday) && (
                    <View style={styles.detailRow}>
                      <Ionicons name="gift-outline" size={14} color={theme.textMuted} />
                      <Text style={styles.detailText} numberOfLines={1}>{fmtBirthday(user.birthday)}</Text>
                    </View>
                  )}
                </View>
              )}

              {!!user.socials && Object.keys(user.socials).length > 0 && (
                <View style={styles.socialLinks}>
                  {Object.entries(user.socials).map(([key, val]) => {
                    const p = SOCIAL_BY_KEY[key];
                    if (!p || !val) return null;
                    return (
                      <TouchableOpacity key={key} style={styles.socialLinkBtn} onPress={() => Linking.openURL(socialUrl(key, val)).catch(() => {})} testID={`user-social-${key}`}>
                        <Ionicons name={p.icon as any} size={20} color={theme.textPrimary} />
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}

              {!!user.interests?.length && (
                <View style={styles.interestWrap}>
                  {user.interests.map((t) => (
                    <View key={t} style={[styles.interestChip, { borderColor: accent + "55" }]}>
                      <Text style={[styles.interestText, { color: accent }]}>{t}</Text>
                    </View>
                  ))}
                </View>
              )}

              {!!user.featured_links?.length && (
                <View style={styles.linksWrap}>
                  {user.featured_links.map((l, i) => (
                    <TouchableOpacity
                      key={`${l.url}-${i}`}
                      style={styles.linkRow}
                      activeOpacity={0.7}
                      onPress={() => Linking.openURL(normalizeLinkUrl(l.url)).catch(() => {})}
                      testID={`user-link-${i}`}
                    >
                      <Ionicons name="link" size={15} color={accent} />
                      <Text style={styles.linkLabel} numberOfLines={1}>{l.label || prettyLinkLabel(l.url)}</Text>
                      <Ionicons name="open-outline" size={14} color={theme.textMuted} />
                    </TouchableOpacity>
                  ))}
                </View>
              )}

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
              {user.user_id === me?.user_id && (
                // Owner view (reached via the vanity URL okayspace.ca/<username>):
                // offer Edit profile, which opens the full editor (the /profile tab).
                <View style={styles.actionRow}>
                  <TouchableOpacity style={[styles.actionBtn, styles.actionBtnGhost]} onPress={() => router.push("/profile")} testID="profile-edit-self">
                    <Ionicons name="create-outline" size={15} color={theme.textPrimary} />
                    <Text style={[styles.actionBtnText, { color: theme.textPrimary }]}>Edit profile</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.actionBtn, styles.actionBtnGhost]} onPress={onShareProfile} testID="profile-share-self">
                    <Ionicons name="share-outline" size={15} color={theme.textPrimary} />
                    <Text style={[styles.actionBtnText, { color: theme.textPrimary }]}>Share</Text>
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
              <View style={styles.ptabs}>
                {(([["posts", "Posts"], ["replies", "Replies"], ["reposts", "Reposts"], ["likes", "Likes"]]) as const).map(([key, label]) => {
                  const active = ptab === key;
                  return (
                    <TouchableOpacity key={key} style={[styles.ptab, active && styles.ptabActive]} onPress={() => switchTab(key)} testID={`uprofile-tab-${key}`}>
                      <Text style={[styles.ptabText, { color: active ? theme.primary : theme.textMuted }]} numberOfLines={1}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          }
          ListEmptyComponent={
            tabLoading
              ? <ActivityIndicator color={theme.primary} style={{ marginTop: 24 }} />
              : <Text style={{ color: theme.textMuted, textAlign: "center", paddingVertical: 40 }}>
                  {ptab === "replies" ? "No replies yet." : ptab === "reposts" ? "No reposts yet." : ptab === "likes" ? "No liked posts yet." : "No posts yet."}
                </Text>
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
            live={payEnabled}
            onCheckout={payEnabled ? (amt, note) =>
              stripeCardPay({ kind: "tip", creator_id: user.user_id, amount: amt, extra: { note } }) : undefined}
            onWalletFallback={(amt, note) =>
              router.push(`/pay/${user.user_id}?amount=${amt}&note=${encodeURIComponent(note || "")}`)}
            walletBalance={walletBal ?? undefined}
            onPayWallet={async (amt, note) => { await api.payFromWallet({ kind: "tip", creator_id: user.user_id, amount: amt, note }); }}
            onTopUp={() => router.push("/wallet")}
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
            live={payEnabled}
            onCheckout={payEnabled ? () =>
              stripeCardPay({ kind: "subscription", creator_id: user.user_id, amount: 0, extra: { tier: chosenTier?.id || "plus" } }) : undefined}
            walletBalance={walletBal ?? undefined}
            onPayWallet={async () => {
              await api.payFromWallet({ kind: "subscription", creator_id: user.user_id, tier: chosenTier?.id || "plus" });
              setUser((p) => (p ? { ...p, is_subscribed: true, subscriber_count: (p.subscriber_count || 0) + 1 } : p));
            }}
            onTopUp={() => router.push("/wallet")}
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
      {linkCopied && (
        <View style={styles.copiedPill} pointerEvents="none">
          <Ionicons name="checkmark-circle" size={14} color="#fff" />
          <Text style={styles.copiedText}>Link copied</Text>
        </View>
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
  copiedPill: { position: "absolute", alignSelf: "center", bottom: 40, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(0,0,0,0.85)", borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  copiedText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  profileBlock: {
    alignItems: "center", padding: 18, gap: 6,
    backgroundColor: theme.surface, borderRadius: 16,
    borderWidth: 1, borderColor: theme.border, marginBottom: 6,
    overflow: "hidden",
  },
  cover: {
    height: 92, alignSelf: "stretch",
    marginTop: -18, marginHorizontal: -18, marginBottom: 0,
  },
  headline: { color: theme.textSecondary, fontSize: 13.5, fontWeight: "600", textAlign: "center", marginTop: 2, paddingHorizontal: 20 },
  scorePill: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8, borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: theme.surfaceAlt, maxWidth: "90%" },
  scoreText: { fontSize: 14, fontWeight: "800" },
  scoreLabel: { color: theme.textSecondary, fontSize: 12, fontWeight: "700", flexShrink: 1 },
  levelBadge: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  levelBadgeText: { color: "#fff", fontSize: 11, fontWeight: "800" },
  statusPillP: { marginTop: 8, borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: theme.surfaceAlt, maxWidth: "90%" },
  statusPillText: { color: theme.textPrimary, fontSize: 13, fontWeight: "600" },
  interestWrap: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 7, marginTop: 10 },
  interestChip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 5 },
  interestText: { fontSize: 12.5, fontWeight: "700" },
  linksWrap: { alignSelf: "stretch", gap: 8, marginTop: 12 },
  linkRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
  },
  linkLabel: { flex: 1, color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  avatarWrap: { width: 80, height: 80 },
  avatar: {
    width: 80, height: 80, borderRadius: 40, overflow: "hidden",
    backgroundColor: theme.primary, alignItems: "center", justifyContent: "center",
  },
  avatarInit: { color: "#fff", fontSize: 32, fontWeight: "800" },
  presence: { color: theme.textMuted, fontSize: 12.5, fontWeight: "600", marginTop: 3 },
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
  detailsWrap: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 12, marginTop: 10, paddingHorizontal: 16 },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 5, maxWidth: "100%" },
  detailText: { color: theme.textMuted, fontSize: 12.5, fontWeight: "600", flexShrink: 1 },
  detailLink: { color: theme.primary },
  socialLinks: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10, marginTop: 10 },
  socialLinkBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, alignItems: "center", justifyContent: "center" },
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
  ptabs: {
    flexDirection: "row", gap: 2, marginTop: 16, alignSelf: "stretch",
    backgroundColor: theme.surface, borderRadius: 14, padding: 4,
    borderWidth: 1, borderColor: theme.border,
  },
  ptab: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 9, borderRadius: 10 },
  ptabActive: { backgroundColor: theme.surfaceAlt },
  ptabText: { fontSize: 12.5, fontWeight: "700" },
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
