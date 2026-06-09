import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, Image, TouchableOpacity, ActivityIndicator,
  Modal, TextInput, KeyboardAvoidingView, Platform, ScrollView, Alert, RefreshControl, Linking, Animated,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import * as ImagePicker from "expo-image-picker";
import { assetToUri } from "@/src/utils/thumbnail";
import { useFocusEffect, useRouter } from "expo-router";
import { useAuth } from "@/src/context/AuthContext";
import { api, Post, mediaUri, FeaturedLink } from "@/src/api/client";
import { theme } from "@/src/theme";
import { GLASS } from "@/src/lib/glass";
import {
  ACCENT_COLORS, resolveAccent, isValidHex, accentGradient,
  normalizeLinkUrl, prettyLinkLabel,
  AVATAR_FRAMES, PROFILE_BACKGROUNDS, frameColors, backgroundColors,
} from "@/src/lib/profileCustomize";
import { AvatarFrame, ProfileBackground } from "@/src/components/ProfileDecor";
import { consumeEditProfileIntent } from "@/src/lib/editProfileIntent";
import { useFloatingHeader } from "@/src/hooks/useFloatingHeader";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";
import PostCard from "@/src/components/PostCard";
import ConfirmModal from "@/src/components/ConfirmModal";
import ReelPoster from "@/src/components/ReelPoster";
import BirthdayPicker from "@/src/components/BirthdayPicker";
import { SOCIAL_PLATFORMS, SOCIAL_BY_KEY, socialUrl, fmtBirthday } from "@/src/lib/socials";
import AdSlot from "@/src/components/AdSlot";
import { interleaveAds, isAd } from "@/src/lib/ads";
import { DEFAULT_AVATARS } from "@/src/lib/avatars";

const DEFAULT_AVATAR =
  "https://images.unsplash.com/photo-1544005313-94ddf0286df2?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NTYxOTJ8MHwxfHNlYXJjaHwxfHxwb3J0cmFpdCUyMHBlcnNvbnxlbnwwfHx8fDE3ODA1NTgzMjh8MA&ixlib=rb-4.1.0&q=85";

// Abbreviate engagement counts X-style: 1200 -> "1.2K", 3_400_000 -> "3.4M".
function compactCount(n: number): string {
  if (!n || n < 1000) return String(n || 0);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

const policyLabel = (p?: string): string =>
  ({ everyone: "Everyone", followers: "Followers", friends: "Friends", nobody: "No one" }[p || "everyone"] || "Everyone");

export default function ProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const fh = useFloatingHeader();
  const { user, refresh } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState({ places: 0, guides: 0, reviews: 0 });
  const [social, setSocial] = useState({ followers: 0, following: 0, friends: 0 });
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editBio, setEditBio] = useState("");
  const [editUsername, setEditUsername] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [editPronouns, setEditPronouns] = useState("");
  const [editBirthday, setEditBirthday] = useState("");
  const [editSocials, setEditSocials] = useState<Record<string, string>>({});
  const [editHeadline, setEditHeadline] = useState("");
  const [editAccent, setEditAccent] = useState("");
  const [editInterests, setEditInterests] = useState<string[]>([]);
  const [interestInput, setInterestInput] = useState("");
  const [editLinks, setEditLinks] = useState<FeaturedLink[]>([]);
  const [editFrame, setEditFrame] = useState("none");
  const [editBg, setEditBg] = useState("default");
  const [usernameCheck, setUsernameCheck] = useState<{ checking: boolean; available: boolean | null }>({ checking: false, available: null });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [editTab, setEditTab] = useState<"basics" | "look" | "about" | "links">("basics");
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [myPosts, setMyPosts] = useState<Post[]>([]);
  const [replies, setReplies] = useState<Post[] | null>(null);
  const [reposts, setReposts] = useState<Post[] | null>(null);
  const [likes, setLikes] = useState<Post[] | null>(null);
  const [tabLoading, setTabLoading] = useState(false);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [profileTab, setProfileTab] = useState<"posts" | "replies" | "reposts" | "media" | "likes">("posts");

  const loadPosts = useCallback(async () => {
    if (!user) return;
    try {
      const list = await api.listUserPostsAll(user.user_id);
      setMyPosts(list);
    } catch {} finally { setLoadingPosts(false); }
  }, [user]);

  // Lazily load a tab's content the first time it's opened.
  const switchTab = useCallback(async (t: "posts" | "replies" | "reposts" | "media" | "likes") => {
    setProfileTab(t);
    if (!user) return;
    const need = (t === "replies" && replies == null) || (t === "reposts" && reposts == null) || (t === "likes" && likes == null);
    if (!need) return;
    setTabLoading(true);
    try {
      if (t === "replies") setReplies(await api.listUserReplies(user.user_id));
      else if (t === "reposts") setReposts(await api.listUserReposts(user.user_id));
      else if (t === "likes") setLikes(await api.listUserLikes(user.user_id));
    } catch {
      if (t === "replies") setReplies([]); else if (t === "reposts") setReposts([]); else if (t === "likes") setLikes([]);
    } finally { setTabLoading(false); }
  }, [user, replies, reposts, likes]);

  // Apply an optimistic engagement change / removal across every tab list.
  const patchPost = (id: string, fn: (p: Post) => Post) => {
    const m = (arr: Post[]) => arr.map((x) => (x.id === id ? fn(x) : x));
    setMyPosts(m);
    setReplies((a) => (a ? m(a) : a));
    setReposts((a) => (a ? m(a) : a));
    setLikes((a) => (a ? m(a) : a));
  };
  const removePostEverywhere = (id: string) => {
    const f = (arr: Post[]) => arr.filter((x) => x.id !== id);
    setMyPosts(f);
    setReplies((a) => (a ? f(a) : a));
    setReposts((a) => (a ? f(a) : a));
    setLikes((a) => (a ? f(a) : a));
  };

  useFocusEffect(useCallback(() => { loadPosts(); }, [loadPosts]));

  const onLike = async (p: Post) => {
    patchPost(p.id, (x) => ({ ...x, liked_by_me: !x.liked_by_me, likes_count: x.likes_count + (x.liked_by_me ? -1 : 1) }));
    try { await api.toggleLike(p.id); } catch { loadPosts(); }
  };
  const onDislike = async (p: Post) => {
    patchPost(p.id, (x) => {
      const nowDis = !x.disliked_by_me;
      return {
        ...x,
        disliked_by_me: nowDis,
        dislikes_count: (x.dislikes_count || 0) + (nowDis ? 1 : -1),
        liked_by_me: nowDis ? false : x.liked_by_me,
        likes_count: x.likes_count - (nowDis && x.liked_by_me ? 1 : 0),
      };
    });
    try { await api.toggleDislike(p.id); } catch { loadPosts(); }
  };
  const onRepost = async (p: Post) => {
    try { await api.toggleRepost(p.repost_of || p.id); setReposts(null); loadPosts(); } catch { loadPosts(); }
  };
  const onBookmark = async (p: Post) => {
    patchPost(p.id, (x) => ({ ...x, bookmarked_by_me: !x.bookmarked_by_me }));
    try { await api.toggleBookmark(p.id); } catch { loadPosts(); }
  };
  const onReply = (p: Post) => router.push({ pathname: "/post/[id]", params: { id: p.id } });

  // Delete your own posts straight from your profile (long-press a post or use
  // its ••• menu → confirm).
  const [confirmDel, setConfirmDel] = useState<Post | null>(null);
  const onMore = (p: Post) => { if (p.user_id === user?.user_id) setConfirmDel(p); };
  const doDelete = async (p: Post) => {
    removePostEverywhere(p.id);
    try { await api.deletePost(p.id); } catch { loadPosts(); }
  };

  const changeAvatar = () => { if (!uploadingAvatar) setAvatarPickerOpen(true); };

  const pickDefaultAvatar = async (url: string) => {
    setAvatarPickerOpen(false);
    setUploadingAvatar(true);
    try {
      await api.updateMe({ picture: url });
      await refresh();
    } catch (e: any) {
      Alert.alert("Couldn't update avatar", e?.message || String(e));
    } finally { setUploadingAvatar(false); }
  };

  const uploadPhoto = async () => {
    setAvatarPickerOpen(false);
    if (uploadingAvatar) return;
    if (Platform.OS !== "web") {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"] as any,
      allowsEditing: true, aspect: [1, 1],
      quality: 0.7, base64: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    setUploadingAvatar(true);
    try {
      // Cloudinary URL when configured, else base64 — keeps avatars off the DB.
      const picture = await assetToUri(result.assets[0], "image");
      if (!picture) { setUploadingAvatar(false); return; }
      await api.updateMe({ picture });
      await refresh();
    } catch (e: any) {
      Alert.alert("Couldn't update avatar", e?.message || String(e));
    } finally { setUploadingAvatar(false); }
  };

  const changeCover = async () => {
    if (uploadingCover) return;
    if (Platform.OS !== "web") {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"] as any,
      allowsEditing: true, aspect: [3, 1],
      quality: 0.7, base64: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    setUploadingCover(true);
    try {
      const cover = await assetToUri(result.assets[0], "image");
      if (!cover) { setUploadingCover(false); return; }
      await api.updateMe({ cover_photo: cover });
      await refresh();
    } catch (e: any) {
      Alert.alert("Couldn't update cover", e?.message || String(e));
    } finally { setUploadingCover(false); }
  };

  const removeCover = async () => {
    setUploadingCover(true);
    try {
      await api.updateMe({ cover_photo: "" });
      await refresh();
    } catch (e: any) {
      Alert.alert("Couldn't remove cover", e?.message || String(e));
    } finally { setUploadingCover(false); }
  };

  const loadStats = useCallback(async () => {
    if (!user) return;
    try {
      const u = await api.getPublicUser(user.user_id);
      setStats({
        places: u.stats?.places || 0,
        guides: u.stats?.guides || 0,
        reviews: u.stats?.reviews || 0,
      });
      setSocial({
        followers: u.stats?.followers || 0,
        following: u.stats?.following || 0,
        friends: u.stats?.friends || 0,
      });
    } catch {}
  }, [user]);

  useFocusEffect(useCallback(() => { loadStats(); }, [loadStats]));

  const openEdit = () => {
    setEditName(user?.name || "");
    setEditBio(user?.bio || "");
    setEditUsername(user?.username || "");
    setEditLocation(user?.location || "");
    setEditPronouns(user?.pronouns || "");
    setEditBirthday(user?.birthday || "");
    setEditSocials({ ...(user?.socials || {}) });
    setEditHeadline(user?.headline || "");
    setEditAccent(user?.accent_color || "");
    setEditInterests([...(user?.interests || [])]);
    setInterestInput("");
    setEditLinks((user?.featured_links || []).map((l) => ({ ...l })));
    setEditFrame(user?.avatar_frame || "none");
    setEditBg(user?.profile_background || "default");
    setUsernameCheck({ checking: false, available: true });
    setSaveError("");
    setEditTab("basics");
    setEditOpen(true);
  };

  const addInterest = () => {
    const t = interestInput.trim().slice(0, 30);
    if (!t) return;
    setEditInterests((arr) => {
      if (arr.length >= 12 || arr.some((x) => x.toLowerCase() === t.toLowerCase())) return arr;
      return [...arr, t];
    });
    setInterestInput("");
  };
  const removeInterest = (t: string) => setEditInterests((arr) => arr.filter((x) => x !== t));

  const addLink = () => setEditLinks((arr) => (arr.length >= 5 ? arr : [...arr, { label: "", url: "" }]));
  const updateLink = (i: number, key: keyof FeaturedLink, val: string) =>
    setEditLinks((arr) => arr.map((l, idx) => (idx === i ? { ...l, [key]: val } : l)));
  const removeLink = (i: number) => setEditLinks((arr) => arr.filter((_, idx) => idx !== i));

  // Open the editor only when the user explicitly asked (Settings → Edit
  // profile), via a one-shot in-memory intent. Uses focus (not mount) because
  // the profile is a tab that stays mounted, and is deliberately NOT driven by
  // a URL param, so the editor can't pop back up on a refresh or remount.
  useFocusEffect(
    useCallback(() => {
      if (user && consumeEditProfileIntent()) openEdit();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.user_id]),
  );

  // Tidy up any stale ?edit=1 left in the URL from a previous build (inert now).
  useEffect(() => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const u = new URL(window.location.href);
      if (u.searchParams.has("edit")) {
        u.searchParams.delete("edit");
        window.history.replaceState({}, "", u.toString());
      }
    }
  }, []);

  // Live username availability check
  useEffect(() => {
    if (!editOpen) return;
    const u = editUsername.trim().toLowerCase();
    if (!u || u === (user?.username || "")) {
      setUsernameCheck({ checking: false, available: true });
      return;
    }
    if (!/^[a-z0-9_]{3,20}$/.test(u)) {
      setUsernameCheck({ checking: false, available: false });
      return;
    }
    setUsernameCheck({ checking: true, available: null });
    const t = setTimeout(async () => {
      try {
        const r = await api.usernameAvailable(u);
        setUsernameCheck({ checking: false, available: !!r.available });
      } catch { setUsernameCheck({ checking: false, available: null }); }
    }, 300);
    return () => clearTimeout(t);
  }, [editUsername, editOpen, user?.username]);

  const saveEdit = async () => {
    setSaving(true);
    setSaveError("");
    try {
      const u = editUsername.trim().toLowerCase();
      const usernameChanged = !!u && u !== (user?.username || "");
      if (usernameChanged) {
        if (!/^[a-z0-9_]{3,20}$/.test(u)) {
          throw new Error("Username must be 3-20 chars, a-z, 0-9, _");
        }
        if (usernameCheck.available === false) {
          throw new Error("That username is taken");
        }
      }
      // Keep only links that have a real URL; normalize the scheme.
      const links = editLinks
        .map((l) => ({ label: l.label.trim().slice(0, 40), url: normalizeLinkUrl(l.url) }))
        .filter((l) => /^https?:\/\//i.test(l.url))
        .slice(0, 5);
      // Save the profile fields FIRST, then the username. (Username is a
      // separate endpoint; doing it last means a username failure can't leave
      // the rest unsaved, and a retry still re-applies the username.)
      await api.updateMe({
        name: editName, bio: editBio,
        location: editLocation, pronouns: editPronouns, birthday: editBirthday,
        socials: editSocials,
        headline: editHeadline,
        accent_color: editAccent && isValidHex(editAccent) ? editAccent : "",
        interests: editInterests,
        featured_links: links,
        avatar_frame: editFrame,
        profile_background: editBg,
      });
      if (usernameChanged) await api.setUsername(u);
      await refresh();
      setEditOpen(false);
    } catch (e: any) {
      // Show the error inline — Alert.alert is a no-op on web, so without this
      // a failed save (e.g. username taken) would look like nothing happened.
      setSaveError(e?.message || "Couldn't save. Please try again.");
      Alert.alert("Couldn't save", e?.message || String(e));
    } finally { setSaving(false); }
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await Promise.all([loadPosts(), loadStats()]); }
    finally { setRefreshing(false); }
  }, [loadPosts, loadStats]);

  const accent = resolveAccent(user?.accent_color);

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="profile-screen">
      <ProfileBackground background={user?.profile_background} style={{ left: -20, right: -20 }} />
      <Animated.View
        onLayout={(e) => fh.setTopBarH(e.nativeEvent.layout.height)}
        pointerEvents={fh.barPointerEvents}
        style={[styles.topBar, GLASS, fh.barStyle(insets.top)]}
      >
        <View style={styles.header}>
          <SidebarMenuButton />
          <Text style={styles.title}>Profile</Text>
          <TouchableOpacity onPress={() => router.push("/settings")} style={styles.headerIconBtn} testID="open-settings-btn">
            <Ionicons name="settings-outline" size={22} color={theme.textPrimary} />
          </TouchableOpacity>
        </View>
      </Animated.View>

      <ScrollView
        onScroll={fh.onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingTop: fh.topBarH + 8, paddingBottom: insets.bottom + 100 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} progressViewOffset={fh.topBarH} onRefresh={onRefresh} tintColor={theme.primary} colors={[theme.primary]} />
        }
      >
        <View style={styles.hero}>
          <TouchableOpacity activeOpacity={0.9} onPress={changeCover} testID="change-cover-btn">
            {user?.cover_photo ? (
              <Image source={{ uri: user.cover_photo }} style={styles.cover} resizeMode="cover" />
            ) : (
              <LinearGradient
                colors={accentGradient(user?.accent_color)}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.cover}
              />
            )}
            <View style={styles.coverBadge}>
              {uploadingCover
                ? <ActivityIndicator color="#fff" size="small" />
                : <Ionicons name="camera" size={14} color="#fff" />}
            </View>
            {!!user?.cover_photo && !uploadingCover && (
              <TouchableOpacity style={styles.coverRemove} onPress={removeCover} testID="remove-cover-btn">
                <Ionicons name="close" size={14} color="#fff" />
              </TouchableOpacity>
            )}
          </TouchableOpacity>
          <View style={styles.heroBody}>
            <AvatarFrame frame={user?.avatar_frame} size={104} ring={3}>
              <TouchableOpacity onPress={changeAvatar} activeOpacity={0.85} style={styles.avatarWrap} testID="change-avatar-btn">
                <Image
                  source={{ uri: user?.picture || DEFAULT_AVATAR }}
                  style={styles.avatar}
                />
                <View style={styles.avatarBadge}>
                  {uploadingAvatar
                    ? <ActivityIndicator color="#fff" size="small" />
                    : <Ionicons name="camera" size={14} color="#fff" />}
                </View>
              </TouchableOpacity>
            </AvatarFrame>

            <Text style={styles.name} numberOfLines={1}>{user?.name || "Explorer"}</Text>
            {!!user?.username && (
              <Text style={[styles.handle, { color: accent }]} numberOfLines={1}>@{user.username}</Text>
            )}
            {!!user?.headline && <Text style={styles.headline} numberOfLines={2}>{user.headline}</Text>}
            {!!user?.bio && <Text style={styles.bio}>{user.bio}</Text>}

            {(!!user?.pronouns || !!user?.location || !!user?.birthday) && (
              <View style={styles.detailsWrap}>
                {!!user?.pronouns && (
                  <View style={styles.detailRow}>
                    <Ionicons name="person-circle-outline" size={14} color={theme.textMuted} />
                    <Text style={styles.detailText} numberOfLines={1}>{user.pronouns}</Text>
                  </View>
                )}
                {!!user?.location && (
                  <View style={styles.detailRow}>
                    <Ionicons name="location-outline" size={14} color={theme.textMuted} />
                    <Text style={styles.detailText} numberOfLines={1}>{user.location}</Text>
                  </View>
                )}
                {!!fmtBirthday(user?.birthday) && (
                  <View style={styles.detailRow}>
                    <Ionicons name="gift-outline" size={14} color={theme.textMuted} />
                    <Text style={styles.detailText} numberOfLines={1}>{fmtBirthday(user?.birthday)}</Text>
                  </View>
                )}
              </View>
            )}

            {!!user?.socials && Object.keys(user.socials).length > 0 && (
              <View style={styles.socialLinks}>
                {Object.entries(user.socials).map(([key, val]) => {
                  const p = SOCIAL_BY_KEY[key];
                  if (!p || !val) return null;
                  return (
                    <TouchableOpacity key={key} style={styles.socialLinkBtn} onPress={() => Linking.openURL(socialUrl(key, val)).catch(() => {})} testID={`profile-social-${key}`}>
                      <Ionicons name={p.icon as any} size={20} color={theme.textPrimary} />
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {!!user?.interests?.length && (
              <View style={styles.interestWrap}>
                {user.interests.map((t) => (
                  <View key={t} style={[styles.interestChip, { borderColor: accent + "55" }]}>
                    <Text style={[styles.interestText, { color: accent }]}>{t}</Text>
                  </View>
                ))}
              </View>
            )}

            {!!user?.featured_links?.length && (
              <View style={styles.linksWrap}>
                {user.featured_links.map((l, i) => (
                  <TouchableOpacity
                    key={`${l.url}-${i}`}
                    style={styles.linkRow}
                    activeOpacity={0.7}
                    onPress={() => Linking.openURL(normalizeLinkUrl(l.url)).catch(() => {})}
                    testID={`profile-link-${i}`}
                  >
                    <Ionicons name="link" size={15} color={accent} />
                    <Text style={styles.linkLabel} numberOfLines={1}>{l.label || prettyLinkLabel(l.url)}</Text>
                    <Ionicons name="open-outline" size={14} color={theme.textMuted} />
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {!!user?.email && (
              <View style={styles.emailRow}>
                <Text style={styles.email} numberOfLines={1}>{user.email}</Text>
                <View style={styles.onlyYou}>
                  <Ionicons name="lock-closed" size={9} color={theme.textMuted} />
                  <Text style={styles.onlyYouText}>Only you</Text>
                </View>
              </View>
            )}

            <View style={styles.socialBar}>
              <View style={styles.socialItem}>
                <Text style={styles.socialNum}>{myPosts.length}</Text>
                <Text style={styles.socialLabel}>Posts</Text>
              </View>
              <View style={styles.socialDivider} />
              <TouchableOpacity
                style={styles.socialItem}
                onPress={() => router.push({ pathname: "/connections", params: { userId: user?.user_id || "", name: user?.name || "You", tab: "followers" } })}
                testID="stat-followers"
              >
                <Text style={styles.socialNum}>{social.followers}</Text>
                <Text style={styles.socialLabel}>Followers</Text>
              </TouchableOpacity>
              <View style={styles.socialDivider} />
              <TouchableOpacity
                style={styles.socialItem}
                onPress={() => router.push({ pathname: "/connections", params: { userId: user?.user_id || "", name: user?.name || "You", tab: "following" } })}
                testID="stat-following"
              >
                <Text style={styles.socialNum}>{social.following}</Text>
                <Text style={styles.socialLabel}>Following</Text>
              </TouchableOpacity>
              <View style={styles.socialDivider} />
              <TouchableOpacity
                style={styles.socialItem}
                onPress={() => router.push("/people")}
                testID="stat-friends"
              >
                <Text style={styles.socialNum}>{social.friends}</Text>
                <Text style={styles.socialLabel}>Friends</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* What others can see — visibility summary, tap to manage privacy. */}
        <TouchableOpacity style={styles.visCard} activeOpacity={0.9} onPress={() => router.push("/privacy")} testID="profile-visibility">
          <View style={styles.visHead}>
            <Ionicons name={user?.is_private ? "lock-closed" : "earth"} size={16} color={theme.primary} />
            <Text style={styles.visTitle}>{user?.is_private ? "Private account" : "Public account"}</Text>
            <View style={{ flex: 1 }} />
            <Text style={styles.visManage}>Manage</Text>
            <Ionicons name="chevron-forward" size={14} color={theme.textMuted} />
          </View>
          <Text style={styles.visDesc}>
            {user?.is_private
              ? "Only followers you approve can see your posts. Your name, @username and bio stay public."
              : "Anyone can see your posts, name, @username and bio, and follow you."}
          </Text>
          <View style={styles.visRows}>
            {([
              ["Appears in search", user?.searchable === false ? "No" : "Yes"],
              ["Active / online status", user?.hide_online ? "Hidden" : "Visible"],
              ["Who can message you", policyLabel(user?.message_policy)],
              ["Who can comment on posts", policyLabel(user?.default_comment_policy)],
            ] as const).map(([label, value]) => (
              <View key={label} style={styles.visRow}>
                <Text style={styles.visRowLabel}>{label}</Text>
                <Text style={styles.visRowValue}>{value}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.visPrivate}>
            <Ionicons name="lock-closed" size={11} color={theme.textMuted} />{" "}
            Only you can see your email{user?.phone ? ", phone number" : ""}, and saved home/work places.
          </Text>
        </TouchableOpacity>

        <View style={styles.profileTabs}>
          {(([["posts", "Posts"], ["replies", "Replies"], ["reposts", "Reposts"], ["media", "Media"], ["likes", "Likes"]]) as const).map(([key, label]) => {
            const active = profileTab === key;
            return (
              <TouchableOpacity
                key={key}
                style={[styles.profileTab, active && styles.profileTabActive]}
                onPress={() => switchTab(key)}
                testID={`profile-tab-${key}`}
              >
                <Text style={[styles.profileTabText, { color: active ? theme.primary : theme.textMuted }]} numberOfLines={1}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {((loadingPosts && (profileTab === "posts" || profileTab === "media")) || tabLoading) ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 12 }} />
        ) : profileTab === "media" ? (
          (() => {
            const mediaItems = myPosts.flatMap((p) => (p.media || []).map((m) => ({
              m, postId: p.id,
              replies: p.replies_count || 0,
              likes: (p.reactions_total ?? p.likes_count) || 0,
            })));
            if (mediaItems.length === 0) {
              return (
                <View style={styles.postsEmpty}>
                  <Ionicons name="images-outline" size={28} color={theme.textMuted} />
                  <Text style={styles.postsEmptyText}>No photos or videos yet.</Text>
                </View>
              );
            }
            return (
              <View style={styles.mediaGrid}>
                {mediaItems.map(({ m, postId, replies, likes }, i) => (
                  <TouchableOpacity
                    key={`${postId}-${i}`}
                    style={styles.mediaTile}
                    activeOpacity={0.85}
                    onPress={() => m.type === "video"
                      ? router.push({ pathname: "/reels", params: { focus: postId } })
                      : router.push({ pathname: "/post/[id]", params: { id: postId } })}
                    testID={`profile-media-${i}`}
                  >
                    {m.type === "video" ? (
                      <>
                        <ReelPoster uri={m.thumbnail} compact />
                        <View style={[StyleSheet.absoluteFill, styles.mediaVideo]}>
                          <Ionicons name="play" size={22} color="#fff" />
                        </View>
                      </>
                    ) : (
                      <Image source={{ uri: mediaUri(m) }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                    )}
                    {/* X-style engagement overlay: replies + likes on each tile */}
                    <View style={styles.mediaStats} pointerEvents="none">
                      <View style={styles.mediaStat}>
                        <Ionicons name="chatbubble-outline" size={12} color="#fff" />
                        <Text style={styles.mediaStatText}>{compactCount(replies)}</Text>
                      </View>
                      <View style={styles.mediaStat}>
                        <Ionicons name="heart" size={12} color="#fff" />
                        <Text style={styles.mediaStatText}>{compactCount(likes)}</Text>
                      </View>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            );
          })()
        ) : (() => {
          const activeList = profileTab === "replies" ? (replies || []) : profileTab === "reposts" ? (reposts || []) : profileTab === "likes" ? (likes || []) : myPosts;
          if (activeList.length === 0) {
            const msg = profileTab === "replies" ? "No replies yet." : profileTab === "reposts" ? "No reposts yet." : profileTab === "likes" ? "No liked posts yet." : "No posts yet. Share something on the feed!";
            const icon = profileTab === "likes" ? "heart-outline" : profileTab === "reposts" ? "repeat" : profileTab === "replies" ? "chatbubble-outline" : "newspaper-outline";
            return (
              <View style={styles.postsEmpty}>
                <Ionicons name={icon as any} size={28} color={theme.textMuted} />
                <Text style={styles.postsEmptyText}>{msg}</Text>
              </View>
            );
          }
          const items: any[] = profileTab === "posts" ? interleaveAds(activeList) : activeList;
          return (
            <View style={{ gap: 10 }}>
              {items.map((item) =>
                isAd(item) ? (
                  <AdSlot key={`ad-${item.__ad}`} placement="profile" index={item.__ad} />
                ) : (
                  <PostCard
                    key={item.id}
                    post={item}
                    viewerId={user?.user_id}
                    onLike={onLike}
                    onDislike={onDislike}
                    onRepost={onRepost}
                    onReply={onReply}
                    onBookmark={onBookmark}
                    onMore={onMore}
                  />
                ),
              )}
            </View>
          );
        })()}
      </ScrollView>

      <ConfirmModal
        visible={!!confirmDel}
        title="Delete post?"
        message="This permanently removes the post. This can't be undone."
        confirmLabel="Delete"
        destructive
        onCancel={() => setConfirmDel(null)}
        onConfirm={() => { const p = confirmDel; setConfirmDel(null); if (p) doDelete(p); }}
      />

      <Modal visible={avatarPickerOpen} transparent animationType="slide" onRequestClose={() => setAvatarPickerOpen(false)}>
        <View style={styles.modalBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setAvatarPickerOpen(false)} />
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.sheetHandle} />
            <Text style={[styles.modalTitle, { marginBottom: 2 }]}>Profile picture</Text>
            <Text style={styles.avPickerSub}>Pick a default avatar or upload your own.</Text>
            <View style={styles.avGrid}>
              {DEFAULT_AVATARS.map((url) => {
                const selected = user?.picture === url;
                return (
                  <TouchableOpacity key={url} onPress={() => pickDefaultAvatar(url)} style={[styles.avCell, selected && styles.avCellOn]} testID={`avatar-${url}`}>
                    <Image source={{ uri: url }} style={styles.avImg} />
                    {selected ? (
                      <View style={styles.avCheck}><Ionicons name="checkmark" size={14} color="#fff" /></View>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity style={styles.avUploadBtn} onPress={uploadPhoto} testID="avatar-upload">
              <Ionicons name="image-outline" size={18} color="#fff" />
              <Text style={styles.avUploadText}>Upload a photo</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={editOpen} transparent animationType="slide" onRequestClose={() => setEditOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setEditOpen(false)} />
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 24, maxHeight: "88%" }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.modalTitle}>Edit profile</Text>

            {/* Section tabs — keep the editor short and easy to navigate. */}
            <View style={styles.editTabs}>
              {([
                ["basics", "Basics", "person-outline"],
                ["look", "Look", "color-palette-outline"],
                ["about", "About", "information-circle-outline"],
                ["links", "Links", "link-outline"],
              ] as const).map(([key, label, icon]) => {
                const on = editTab === key;
                return (
                  <TouchableOpacity
                    key={key}
                    style={[styles.editTab, on && styles.editTabOn]}
                    onPress={() => setEditTab(key)}
                    testID={`edit-tab-${key}`}
                  >
                    <Ionicons name={icon as any} size={16} color={on ? theme.primary : theme.textMuted} />
                    <Text style={[styles.editTabText, on && { color: theme.primary }]} numberOfLines={1}>{label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <ScrollView style={{ flexShrink: 1 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {editTab === "basics" && (<>
            <Text style={styles.label}>Name</Text>
            <TextInput
              style={styles.input}
              value={editName}
              onChangeText={setEditName}
              placeholder="Your name"
              placeholderTextColor={theme.textMuted}
              maxLength={80}
              testID="edit-name"
            />
            <Text style={styles.label}>Username</Text>
            <View style={[styles.input, { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 0 }]}>
              <Text style={{ color: theme.textMuted, fontSize: 15, fontWeight: "700" }}>@</Text>
              <TextInput
                style={{ flex: 1, color: theme.textPrimary, fontSize: 15, paddingVertical: 12, ...(Platform.OS === "web" ? { outlineStyle: "none" } as object : {}) }}
                value={editUsername}
                onChangeText={(t) => setEditUsername(t.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20))}
                placeholder="username"
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                testID="edit-username"
              />
              {usernameCheck.checking
                ? <ActivityIndicator size="small" color={theme.primary} />
                : usernameCheck.available === true ? <Ionicons name="checkmark-circle" size={18} color="#22C55E" />
                : usernameCheck.available === false ? <Ionicons name="close-circle" size={18} color="#EF4444" />
                : null}
            </View>
            <Text style={styles.helper}>3-20 chars · a-z, 0-9, _</Text>
            <Text style={styles.label}>Bio</Text>
            <TextInput
              style={[styles.input, { height: 100, textAlignVertical: "top" }]}
              value={editBio}
              onChangeText={setEditBio}
              placeholder="A short bio (280 chars max)"
              placeholderTextColor={theme.textMuted}
              multiline
              maxLength={280}
              testID="edit-bio"
            />
            <Text style={styles.helper}>{editBio.length}/280</Text>

            <Text style={styles.label}>Headline</Text>
            <TextInput
              style={styles.input}
              value={editHeadline}
              onChangeText={setEditHeadline}
              placeholder="A short tagline, e.g. Designer · Coffee addict"
              placeholderTextColor={theme.textMuted}
              maxLength={60}
              testID="edit-headline"
            />
            <Text style={styles.helper}>{editHeadline.length}/60</Text>
            </>)}

            {editTab === "look" && (<>
            <Text style={styles.label}>Accent color</Text>
            <View style={styles.swatchRow}>
              {ACCENT_COLORS.map((c) => {
                const on = (editAccent || "").toLowerCase() === c.toLowerCase();
                return (
                  <TouchableOpacity
                    key={c}
                    style={[styles.swatchWrap, on && styles.swatchWrapOn]}
                    onPress={() => setEditAccent(c)}
                    testID={`accent-${c}`}
                  >
                    <View style={[styles.swatch, { backgroundColor: c }]}>
                      {on ? <Ionicons name="checkmark" size={17} color="#fff" style={styles.checkShadow} /> : null}
                    </View>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={[styles.swatchWrap, !editAccent && styles.swatchWrapOn]}
                onPress={() => setEditAccent("")}
                testID="accent-clear"
              >
                <View style={[styles.swatch, styles.swatchClear]}>
                  <Ionicons name="refresh" size={15} color={theme.textMuted} />
                </View>
              </TouchableOpacity>
            </View>
            <View style={[styles.input, { flexDirection: "row", alignItems: "center", gap: 8 }]}>
              <View style={[styles.hexPreview, { backgroundColor: resolveAccent(editAccent) }]} />
              <TextInput
                style={{ flex: 1, color: theme.textPrimary, fontSize: 14, ...(Platform.OS === "web" ? { outlineStyle: "none" } as object : {}) }}
                value={editAccent}
                onChangeText={(t) => setEditAccent(t.startsWith("#") || t === "" ? t : `#${t}`)}
                placeholder="#7C3AED (custom hex)"
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={7}
                testID="edit-accent-hex"
              />
              {editAccent !== "" && !isValidHex(editAccent) ? (
                <Ionicons name="alert-circle" size={16} color="#EF4444" />
              ) : null}
            </View>

            <Text style={styles.label}>Avatar frame</Text>
            <Text style={styles.helper2}>A decorative ring around your profile picture.</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingVertical: 2 }}>
              {AVATAR_FRAMES.map((f) => {
                const on = editFrame === f.key;
                const cols = frameColors(f.key);
                return (
                  <TouchableOpacity key={f.key} style={[styles.pickItem, on && styles.pickItemOn]} onPress={() => setEditFrame(f.key)} testID={`frame-${f.key}`}>
                    <View>
                      {cols.length >= 2 ? (
                        <AvatarFrame frame={f.key} size={42} ring={3}>
                          <View style={styles.framePreviewInner} />
                        </AvatarFrame>
                      ) : (
                        <View style={styles.framePreviewNone}>
                          <Ionicons name="ban-outline" size={18} color={theme.textMuted} />
                        </View>
                      )}
                      {on ? (
                        <View style={styles.checkBadge}><Ionicons name="checkmark" size={12} color="#fff" /></View>
                      ) : null}
                    </View>
                    <Text style={[styles.frameLabel, on && { color: theme.primary, fontWeight: "800" }]}>{f.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <Text style={styles.label}>Profile background</Text>
            <Text style={styles.helper2}>A themed backdrop shown behind your whole profile.</Text>
            <View style={styles.bgGrid}>
              {PROFILE_BACKGROUNDS.map((b) => {
                const on = editBg === b.key;
                const cols = backgroundColors(b.key);
                return (
                  <TouchableOpacity key={b.key} style={[styles.pickItem, on && styles.pickItemOn]} onPress={() => setEditBg(b.key)} testID={`bg-${b.key}`}>
                    <View>
                      {cols.length >= 2 ? (
                        <LinearGradient colors={cols as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.bgCell} />
                      ) : (
                        <View style={[styles.bgCell, { backgroundColor: theme.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
                          <Ionicons name="square-outline" size={16} color={theme.textMuted} />
                        </View>
                      )}
                      {on ? (
                        <View style={styles.checkBadge}><Ionicons name="checkmark" size={12} color="#fff" /></View>
                      ) : null}
                    </View>
                    <Text style={[styles.frameLabel, on && { color: theme.primary, fontWeight: "800" }]}>{b.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            </>)}

            {editTab === "about" && (<>
            <Text style={styles.label}>Pronouns</Text>
            <TextInput
              style={styles.input}
              value={editPronouns}
              onChangeText={setEditPronouns}
              placeholder="she/her · he/him · they/them"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              maxLength={40}
              testID="edit-pronouns"
            />

            <Text style={styles.label}>Location</Text>
            <TextInput
              style={styles.input}
              value={editLocation}
              onChangeText={setEditLocation}
              placeholder="City, Country"
              placeholderTextColor={theme.textMuted}
              maxLength={80}
              testID="edit-location"
            />

            <Text style={styles.label}>Birthday</Text>
            <BirthdayPicker value={editBirthday} onChange={setEditBirthday} testID="edit-birthday" />

            <Text style={styles.label}>Interests</Text>
            <Text style={styles.helper2}>Up to 12 tags shown as chips on your profile.</Text>
            {editInterests.length > 0 && (
              <View style={styles.interestEditWrap}>
                {editInterests.map((t) => (
                  <TouchableOpacity key={t} style={styles.interestEditChip} onPress={() => removeInterest(t)} testID={`interest-chip-${t}`}>
                    <Text style={styles.interestEditText}>{t}</Text>
                    <Ionicons name="close" size={13} color={theme.textSecondary} />
                  </TouchableOpacity>
                ))}
              </View>
            )}
            {editInterests.length < 12 && (
              <View style={[styles.input, { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 0 }]}>
                <TextInput
                  style={{ flex: 1, color: theme.textPrimary, fontSize: 15, paddingVertical: 12, ...(Platform.OS === "web" ? { outlineStyle: "none" } as object : {}) }}
                  value={interestInput}
                  onChangeText={setInterestInput}
                  onSubmitEditing={addInterest}
                  placeholder="Add an interest and press +"
                  placeholderTextColor={theme.textMuted}
                  maxLength={30}
                  returnKeyType="done"
                  testID="interest-input"
                />
                <TouchableOpacity onPress={addInterest} style={styles.addChipBtn} testID="interest-add">
                  <Ionicons name="add" size={18} color="#fff" />
                </TouchableOpacity>
              </View>
            )}
            </>)}

            {editTab === "links" && (<>
            <Text style={styles.label}>Social links</Text>
            {SOCIAL_PLATFORMS.map((p) => (
              <View key={p.key} style={styles.socialInputRow}>
                <Ionicons name={p.icon as any} size={20} color={theme.textSecondary} style={{ width: 24 }} />
                {!!p.prefix && <Text style={styles.socialPrefix}>{p.prefix}</Text>}
                <TextInput
                  style={styles.socialInput}
                  value={editSocials[p.key] || ""}
                  onChangeText={(t) => setEditSocials((s) => ({ ...s, [p.key]: t.trim() }))}
                  placeholder={`${p.label} ${p.prefix ? "handle" : "username or link"}`}
                  placeholderTextColor={theme.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={120}
                  testID={`edit-social-${p.key}`}
                />
              </View>
            ))}

            <Text style={styles.label}>Featured links</Text>
            <Text style={styles.helper2}>Up to 5 links shown on your profile (link-in-bio).</Text>
            {editLinks.map((l, i) => (
              <View key={i} style={styles.linkEditRow}>
                <View style={{ flex: 1, gap: 6 }}>
                  <TextInput
                    style={styles.input}
                    value={l.label}
                    onChangeText={(t) => updateLink(i, "label", t)}
                    placeholder="Label (e.g. My website)"
                    placeholderTextColor={theme.textMuted}
                    maxLength={40}
                    testID={`link-label-${i}`}
                  />
                  <TextInput
                    style={styles.input}
                    value={l.url}
                    onChangeText={(t) => updateLink(i, "url", t)}
                    placeholder="https://example.com"
                    placeholderTextColor={theme.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    maxLength={300}
                    testID={`link-url-${i}`}
                  />
                </View>
                <TouchableOpacity onPress={() => removeLink(i)} style={styles.linkDelBtn} testID={`link-remove-${i}`}>
                  <Ionicons name="trash-outline" size={18} color="#EF4444" />
                </TouchableOpacity>
              </View>
            ))}
            {editLinks.length < 5 && (
              <TouchableOpacity style={styles.addLinkBtn} onPress={addLink} testID="link-add">
                <Ionicons name="add-circle-outline" size={18} color={theme.primary} />
                <Text style={styles.addLinkText}>Add link</Text>
              </TouchableOpacity>
            )}
            </>)}
            </ScrollView>

            {/* Sticky footer: error + Save stay visible regardless of section. */}
            {!!saveError && (
              <View style={styles.saveErrorRow}>
                <Ionicons name="alert-circle" size={15} color="#EF4444" />
                <Text style={styles.saveErrorText}>{saveError}</Text>
              </View>
            )}
            <TouchableOpacity
              style={[styles.saveBtn, saving && { opacity: 0.6 }]}
              onPress={saveEdit}
              disabled={saving}
              testID="save-profile"
            >
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, paddingHorizontal: 20 },
  topBar: {
    // root already pads 20px horizontally, so 0 here aligns the bar with content.
    position: "absolute", top: 6, left: 0, right: 0,
    borderRadius: 24, paddingHorizontal: 12, zIndex: 40,
    shadowColor: "#000", shadowOpacity: 0.32, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 10,
  },
  header: { paddingTop: 16, paddingBottom: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingHorizontal: 4 },
  title: { flex: 1, color: theme.textPrimary, fontSize: 28, fontWeight: "800", letterSpacing: -0.5, textAlign: "center" },
  headerIconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },

  // ── Hero card (gradient cover + centered identity) ──────────────────────
  hero: {
    marginTop: 12,
    backgroundColor: theme.surface, borderRadius: 24,
    borderWidth: 1, borderColor: theme.border,
    overflow: "hidden",
  },
  cover: { height: 92, width: "100%" },
  heroBody: { alignItems: "center", paddingHorizontal: 18, paddingBottom: 22, marginTop: -44 },
  avatarWrap: {
    borderRadius: 52, borderWidth: 4, borderColor: theme.surface,
    backgroundColor: theme.surface,
  },
  avatar: { width: 96, height: 96, borderRadius: 48, backgroundColor: theme.surfaceAlt },
  avPickerSub: { color: theme.textMuted, fontSize: 13, marginTop: 2, marginBottom: 14 },
  avGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12, justifyContent: "center" },
  avCell: { width: 64, height: 64, borderRadius: 32, borderWidth: 2, borderColor: "transparent", overflow: "hidden", backgroundColor: theme.surfaceAlt },
  avCellOn: { borderColor: theme.primary },
  avImg: { width: "100%", height: "100%" },
  avCheck: { position: "absolute", bottom: 0, right: 0, width: 20, height: 20, borderRadius: 10, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: theme.surface },
  avUploadBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: theme.primary, borderRadius: 14, paddingVertical: 14, marginTop: 20 },
  avUploadText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  avatarBadge: {
    position: "absolute", bottom: 2, right: 2,
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: theme.primary, borderWidth: 2, borderColor: theme.surface,
    alignItems: "center", justifyContent: "center",
  },
  name: { color: theme.textPrimary, fontSize: 24, fontWeight: "800", marginTop: 12, letterSpacing: -0.3 },
  handle: { color: theme.primary, fontSize: 14.5, fontWeight: "700", marginTop: 4 },
  bio: { color: theme.textPrimary, fontSize: 15, marginTop: 12, lineHeight: 22, textAlign: "center" },
  detailsWrap: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 14, marginTop: 12, paddingHorizontal: 8 },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 5, maxWidth: "100%" },
  detailText: { color: theme.textMuted, fontSize: 13, fontWeight: "600", flexShrink: 1 },
  detailLink: { color: theme.primary },
  socialLinks: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10, marginTop: 12 },
  socialLinkBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, alignItems: "center", justifyContent: "center" },
  socialInputRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, height: 50, marginBottom: 8 },
  socialPrefix: { color: theme.textMuted, fontSize: 15, fontWeight: "700" },
  socialInput: { flex: 1, color: theme.textPrimary, fontSize: 15, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  email: { color: theme.textMuted, fontSize: 13 },
  emailRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 9 },
  onlyYou: { flexDirection: "row", alignItems: "center", gap: 2, backgroundColor: theme.surfaceAlt, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2 },
  onlyYouText: { color: theme.textMuted, fontSize: 9.5, fontWeight: "800" },
  visCard: {
    marginTop: 14, backgroundColor: theme.surface, borderRadius: 16,
    borderWidth: 1, borderColor: theme.border, padding: 14, gap: 8,
  },
  visHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  visTitle: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  visManage: { color: theme.primary, fontSize: 13, fontWeight: "700", marginRight: 2 },
  visDesc: { color: theme.textSecondary, fontSize: 12.5, lineHeight: 17 },
  visRows: { gap: 2, marginTop: 2 },
  visRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 5, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  visRowLabel: { color: theme.textSecondary, fontSize: 13 },
  visRowValue: { color: theme.textPrimary, fontSize: 13, fontWeight: "700" },
  visPrivate: { color: theme.textMuted, fontSize: 11.5, lineHeight: 16, marginTop: 2 },

  socialBar: {
    flexDirection: "row", alignItems: "center", alignSelf: "stretch",
    marginTop: 18, paddingVertical: 15,
    backgroundColor: theme.surfaceAlt, borderRadius: 16,
  },
  socialItem: { flex: 1, alignItems: "center", gap: 2 },
  socialDivider: { width: StyleSheet.hairlineWidth, height: 28, backgroundColor: theme.borderStrong },
  socialNum: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  socialLabel: { color: theme.textSecondary, fontSize: 11.5, fontWeight: "500" },

  heroActions: { flexDirection: "row", gap: 10, alignSelf: "stretch", marginTop: 14 },
  actionBtn: {
    flex: 1, flexDirection: "row", gap: 7, alignItems: "center", justifyContent: "center",
    paddingVertical: 11, borderRadius: 14,
  },
  actionPrimary: { backgroundColor: theme.primary },
  actionPrimaryText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  actionGhost: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border },
  actionGhostText: { color: theme.primary, fontWeight: "800", fontSize: 14 },

  // ── Content stats strip ─────────────────────────────────────────────────
  statsCard: {
    marginTop: 14, flexDirection: "row", alignItems: "center",
    backgroundColor: theme.surface, borderRadius: 16,
    borderWidth: 1, borderColor: theme.border, paddingVertical: 18,
  },
  statCell: { flex: 1, alignItems: "center" },
  statCellDivider: { width: StyleSheet.hairlineWidth, height: 30, backgroundColor: theme.border },
  statNum: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  statLabel: { color: theme.textSecondary, fontSize: 11, marginTop: 2 },

  postsHeaderRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginTop: 20, marginBottom: 10,
  },
  postsHeader: {
    color: theme.textPrimary, fontSize: 16, fontWeight: "800",
    letterSpacing: -0.3,
  },
  postsCount: {
    minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 7,
    backgroundColor: theme.surfaceAlt, alignItems: "center", justifyContent: "center",
  },
  postsCountText: { color: theme.textSecondary, fontSize: 12, fontWeight: "700" },
  profileTabs: {
    flexDirection: "row", gap: 2, marginTop: 20, marginBottom: 12,
    backgroundColor: theme.surface, borderRadius: 14, padding: 4,
    borderWidth: 1, borderColor: theme.border,
  },
  profileTab: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    paddingVertical: 9, paddingHorizontal: 2, borderRadius: 10,
  },
  profileTabActive: { backgroundColor: theme.surfaceAlt },
  profileTabText: { fontSize: 12.5, fontWeight: "700" },
  mediaGrid: { flexDirection: "row", flexWrap: "wrap", gap: 5 },
  mediaTile: { width: "32%", aspectRatio: 1, borderRadius: 8, overflow: "hidden", backgroundColor: theme.surfaceAlt },
  mediaVideo: { backgroundColor: "rgba(0,0,0,0.25)", alignItems: "center", justifyContent: "center" },
  mediaStats: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    flexDirection: "row", gap: 10, alignItems: "center",
    paddingHorizontal: 7, paddingVertical: 5,
    backgroundColor: "rgba(0,0,0,0.38)",
  },
  mediaStat: { flexDirection: "row", alignItems: "center", gap: 3 },
  mediaStatText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  postsEmpty: {
    alignItems: "center", paddingVertical: 32, gap: 10,
    backgroundColor: theme.surface, borderRadius: 16,
    borderWidth: 1, borderColor: theme.border,
  },
  postsEmptyText: {
    color: theme.textMuted, fontSize: 13, textAlign: "center", paddingHorizontal: 30,
  },

  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  modalSheet: {
    backgroundColor: "#0E0E10",
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingTop: 12, paddingHorizontal: 20,
    borderTopWidth: 1, borderColor: theme.border,
  },
  sheetHandle: {
    alignSelf: "center", width: 40, height: 4, borderRadius: 2,
    backgroundColor: theme.borderStrong, marginBottom: 16,
  },
  modalTitle: { color: theme.textPrimary, fontSize: 20, fontWeight: "800", marginBottom: 16 },
  label: { color: theme.textSecondary, fontSize: 12, fontWeight: "600", marginTop: 12, marginBottom: 6 },
  input: {
    backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border,
    borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    color: theme.textPrimary, fontSize: 14,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  helper: { color: theme.textMuted, fontSize: 11, textAlign: "right", marginTop: 4 },
  saveBtn: {
    marginTop: 20, paddingVertical: 14, borderRadius: 14,
    backgroundColor: theme.primary, alignItems: "center",
  },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 15 },

  // ── Customization: cover, headline, interests, links, accent picker ──────
  coverBadge: {
    position: "absolute", bottom: 8, right: 10,
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center",
  },
  coverRemove: {
    position: "absolute", top: 8, right: 10,
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center",
  },
  headline: { color: theme.textSecondary, fontSize: 14, fontWeight: "600", marginTop: 6, textAlign: "center", paddingHorizontal: 8 },
  interestWrap: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 7, marginTop: 12 },
  interestChip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 5 },
  interestText: { fontSize: 12.5, fontWeight: "700" },
  linksWrap: { alignSelf: "stretch", gap: 8, marginTop: 14 },
  linkRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
  },
  linkLabel: { flex: 1, color: theme.textPrimary, fontSize: 14, fontWeight: "700" },

  editTabs: { flexDirection: "row", gap: 4, backgroundColor: theme.surface, borderRadius: 14, padding: 4, marginBottom: 14, borderWidth: 1, borderColor: theme.border },
  editTab: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: 9, borderRadius: 10 },
  editTabOn: { backgroundColor: theme.surfaceAlt },
  editTabText: { color: theme.textMuted, fontSize: 12.5, fontWeight: "700" },
  saveErrorRow: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(239,68,68,0.12)", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, marginTop: 12 },
  saveErrorText: { flex: 1, color: "#EF4444", fontSize: 12.5, fontWeight: "600" },
  helper2: { color: theme.textMuted, fontSize: 11.5, marginBottom: 8, marginTop: -2 },
  swatchRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  // A selected swatch sits inside a highlighted ring so the choice is obvious.
  swatchWrap: { padding: 3, borderRadius: 22, borderWidth: 2, borderColor: "transparent" },
  swatchWrapOn: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  swatch: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  swatchClear: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  checkShadow: { textShadowColor: "rgba(0,0,0,0.55)", textShadowRadius: 3, textShadowOffset: { width: 0, height: 1 } },
  hexPreview: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: theme.border },
  interestEditWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  interestEditChip: {
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    borderRadius: 14, paddingHorizontal: 11, paddingVertical: 6,
  },
  interestEditText: { color: theme.textPrimary, fontSize: 13, fontWeight: "600" },
  addChipBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  linkEditRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  linkDelBtn: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  addLinkBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: theme.border, borderStyle: "dashed" },
  addLinkText: { color: theme.primary, fontSize: 14, fontWeight: "700" },
  framePreviewInner: { width: 42, height: 42, borderRadius: 21, backgroundColor: theme.surfaceAlt },
  framePreviewNone: { width: 48, height: 48, borderRadius: 24, borderWidth: 2, borderColor: theme.border, alignItems: "center", justifyContent: "center", backgroundColor: theme.surface },
  frameLabel: { color: theme.textMuted, fontSize: 11, fontWeight: "600", marginTop: 5 },
  bgGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  bgCell: { width: 66, height: 44, borderRadius: 10 },
  // Shared selectable tile (frames + backgrounds): a highlighted ring + filled
  // check badge make the current selection unmistakable.
  pickItem: { alignItems: "center", padding: 6, borderRadius: 14, borderWidth: 2, borderColor: "transparent" },
  pickItemOn: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  checkBadge: {
    position: "absolute", top: -4, right: -4,
    width: 20, height: 20, borderRadius: 10, backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: theme.surface,
  },
});
