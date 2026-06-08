import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, Image, TouchableOpacity, ActivityIndicator,
  Modal, TextInput, KeyboardAvoidingView, Platform, ScrollView, Alert, RefreshControl, Linking,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import * as ImagePicker from "expo-image-picker";
import { assetToUri } from "@/src/utils/thumbnail";
import { useFocusEffect, useRouter } from "expo-router";
import { useAuth } from "@/src/context/AuthContext";
import { api, Post, mediaUri } from "@/src/api/client";
import { theme } from "@/src/theme";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";
import PostCard from "@/src/components/PostCard";
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

export default function ProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
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
  const [usernameCheck, setUsernameCheck] = useState<{ checking: boolean; available: boolean | null }>({ checking: false, available: null });
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [myPosts, setMyPosts] = useState<Post[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [profileTab, setProfileTab] = useState<"posts" | "media">("posts");

  const loadPosts = useCallback(async () => {
    if (!user) return;
    try {
      const list = await api.listUserPostsAll(user.user_id);
      setMyPosts(list);
    } catch {} finally { setLoadingPosts(false); }
  }, [user]);

  useFocusEffect(useCallback(() => { loadPosts(); }, [loadPosts]));

  const onLike = async (p: Post) => {
    setMyPosts((arr) => arr.map((x) => x.id !== p.id ? x : {
      ...x, liked_by_me: !x.liked_by_me,
      likes_count: x.likes_count + (x.liked_by_me ? -1 : 1),
    }));
    try { await api.toggleLike(p.id); } catch { loadPosts(); }
  };
  const onDislike = async (p: Post) => {
    setMyPosts((arr) => arr.map((x) => {
      if (x.id !== p.id) return x;
      const nowDis = !x.disliked_by_me;
      return {
        ...x,
        disliked_by_me: nowDis,
        dislikes_count: (x.dislikes_count || 0) + (nowDis ? 1 : -1),
        liked_by_me: nowDis ? false : x.liked_by_me,
        likes_count: x.likes_count - (nowDis && x.liked_by_me ? 1 : 0),
      };
    }));
    try { await api.toggleDislike(p.id); } catch { loadPosts(); }
  };
  const onRepost = async (p: Post) => {
    try { await api.toggleRepost(p.repost_of || p.id); loadPosts(); } catch { loadPosts(); }
  };
  const onBookmark = async (p: Post) => {
    setMyPosts((arr) => arr.map((x) => x.id !== p.id ? x : {
      ...x, bookmarked_by_me: !x.bookmarked_by_me,
    }));
    try { await api.toggleBookmark(p.id); } catch { loadPosts(); }
  };
  const onReply = (p: Post) => router.push({ pathname: "/post/[id]", params: { id: p.id } });

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
    setUsernameCheck({ checking: false, available: true });
    setEditOpen(true);
  };

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
    try {
      const u = editUsername.trim().toLowerCase();
      if (u && u !== (user?.username || "")) {
        if (!/^[a-z0-9_]{3,20}$/.test(u)) {
          throw new Error("Username must be 3-20 chars, a-z, 0-9, _");
        }
        if (usernameCheck.available === false) {
          throw new Error("Username taken");
        }
        await api.setUsername(u);
      }
      await api.updateMe({
        name: editName, bio: editBio,
        location: editLocation, pronouns: editPronouns, birthday: editBirthday,
        socials: editSocials,
      });
      await refresh();
      setEditOpen(false);
    } catch (e: any) {
      Alert.alert("Couldn't save", e?.message || String(e));
    } finally { setSaving(false); }
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await Promise.all([loadPosts(), loadStats()]); }
    finally { setRefreshing(false); }
  }, [loadPosts, loadStats]);

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="profile-screen">
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} colors={[theme.primary]} />
        }
      >
        <View style={styles.header}>
          <SidebarMenuButton />
          <Text style={styles.title}>Profile</Text>
          <TouchableOpacity onPress={() => router.push("/settings")} style={styles.headerIconBtn} testID="open-settings-btn">
            <Ionicons name="settings-outline" size={22} color={theme.textPrimary} />
          </TouchableOpacity>
        </View>

        <View style={styles.hero}>
          <LinearGradient
            colors={[theme.primaryHover, theme.primary, theme.primaryActive]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.cover}
          />
          <View style={styles.heroBody}>
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

            <Text style={styles.name} numberOfLines={1}>{user?.name || "Explorer"}</Text>
            {!!user?.username && (
              <Text style={styles.handle} numberOfLines={1}>@{user.username}</Text>
            )}
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

            {!!user?.email && <Text style={styles.email} numberOfLines={1}>{user.email}</Text>}

            <View style={styles.socialBar}>
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

            <View style={styles.heroActions}>
              <TouchableOpacity
                style={[styles.actionBtn, styles.actionPrimary]}
                onPress={openEdit}
                activeOpacity={0.85}
                testID="edit-profile-btn"
              >
                <Ionicons name="create-outline" size={16} color="#fff" />
                <Text style={styles.actionPrimaryText}>Edit profile</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, styles.actionGhost]}
                onPress={() => router.push("/people")}
                activeOpacity={0.85}
                testID="find-friends-btn"
              >
                <Ionicons name="person-add-outline" size={16} color={theme.primary} />
                <Text style={styles.actionGhostText}>Find friends</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <View style={styles.statsCard}>
          <View style={styles.statCell}>
            <Text style={styles.statNum}>{myPosts.length}</Text>
            <Text style={styles.statLabel}>Posts</Text>
          </View>
          <View style={styles.statCellDivider} />
          <View style={styles.statCell}>
            <Text style={styles.statNum}>{stats.reviews}</Text>
            <Text style={styles.statLabel}>Reviews</Text>
          </View>
        </View>

        <View style={styles.profileTabs}>
          <TouchableOpacity
            style={[styles.profileTab, profileTab === "posts" && styles.profileTabActive]}
            onPress={() => setProfileTab("posts")}
            testID="profile-tab-posts"
          >
            <Ionicons name="list" size={16} color={profileTab === "posts" ? theme.primary : theme.textMuted} />
            <Text style={[styles.profileTabText, { color: profileTab === "posts" ? theme.primary : theme.textMuted }]}>Posts</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.profileTab, profileTab === "media" && styles.profileTabActive]}
            onPress={() => setProfileTab("media")}
            testID="profile-tab-media"
          >
            <Ionicons name="grid" size={15} color={profileTab === "media" ? theme.primary : theme.textMuted} />
            <Text style={[styles.profileTabText, { color: profileTab === "media" ? theme.primary : theme.textMuted }]}>Photos &amp; videos</Text>
          </TouchableOpacity>
        </View>

        {loadingPosts ? (
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
        ) : myPosts.length === 0 ? (
          <View style={styles.postsEmpty}>
            <Ionicons name="newspaper-outline" size={28} color={theme.textMuted} />
            <Text style={styles.postsEmptyText}>No posts yet. Share something on the feed!</Text>
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            {interleaveAds(myPosts).map((item) =>
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
                />
              ),
            )}
          </View>
        )}
      </ScrollView>

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
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
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

            <TouchableOpacity
              style={[styles.saveBtn, saving && { opacity: 0.6 }]}
              onPress={saveEdit}
              disabled={saving}
              testID="save-profile"
            >
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save</Text>}
            </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, paddingHorizontal: 20 },
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
  email: { color: theme.textMuted, fontSize: 13, marginTop: 9 },

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
    flexDirection: "row", gap: 8, marginTop: 20, marginBottom: 12,
    backgroundColor: theme.surface, borderRadius: 14, padding: 4,
    borderWidth: 1, borderColor: theme.border,
  },
  profileTab: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 6, paddingVertical: 9, borderRadius: 10,
  },
  profileTabActive: { backgroundColor: theme.surfaceAlt },
  profileTabText: { fontSize: 13, fontWeight: "700" },
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
});
