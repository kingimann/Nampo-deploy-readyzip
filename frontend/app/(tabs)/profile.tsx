import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, Image, TouchableOpacity, ActivityIndicator,
  Modal, TextInput, KeyboardAvoidingView, Platform, ScrollView, Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useFocusEffect, useRouter } from "expo-router";
import { useAuth } from "@/src/context/AuthContext";
import { api, Post } from "@/src/api/client";
import { theme } from "@/src/theme";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";
import PostCard from "@/src/components/PostCard";

const DEFAULT_AVATAR =
  "https://images.unsplash.com/photo-1544005313-94ddf0286df2?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NTYxOTJ8MHwxfHNlYXJjaHwxfHxwb3J0cmFpdCUyMHBlcnNvbnxlbnwwfHx8fDE3ODA1NTgzMjh8MA&ixlib=rb-4.1.0&q=85";

export default function ProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, signOut, refresh } = useAuth();
  const [stats, setStats] = useState({ places: 0, guides: 0, reviews: 0 });
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editBio, setEditBio] = useState("");
  const [editUsername, setEditUsername] = useState("");
  const [usernameCheck, setUsernameCheck] = useState<{ checking: boolean; available: boolean | null }>({ checking: false, available: null });
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [myPosts, setMyPosts] = useState<Post[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(true);

  const loadPosts = useCallback(async () => {
    if (!user) return;
    try {
      const list = await api.listUserPostsAll(user.user_id);
      setMyPosts(list);
    } catch {} finally { setLoadingPosts(false); }
  }, [user]);

  useFocusEffect(useCallback(() => { loadPosts(); }, [loadPosts]));
  useEffect(() => { loadPosts(); }, [loadPosts]);

  const onLike = async (p: Post) => {
    setMyPosts((arr) => arr.map((x) => x.id !== p.id ? x : {
      ...x, liked_by_me: !x.liked_by_me,
      likes_count: x.likes_count + (x.liked_by_me ? -1 : 1),
    }));
    try { await api.toggleLike(p.id); } catch { loadPosts(); }
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

  const changeAvatar = async () => {
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
    if (result.canceled || !result.assets?.[0]?.base64) return;
    setUploadingAvatar(true);
    try {
      const dataUri = `data:image/jpeg;base64,${result.assets[0].base64}`;
      await api.updateMe({ picture: dataUri });
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
    } catch {}
  }, [user]);

  useFocusEffect(useCallback(() => { loadStats(); }, [loadStats]));
  useEffect(() => { loadStats(); }, [loadStats]);

  const openEdit = () => {
    setEditName(user?.name || "");
    setEditBio(user?.bio || "");
    setEditUsername(user?.username || "");
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
      await api.updateMe({ name: editName, bio: editBio });
      await refresh();
      setEditOpen(false);
    } catch (e: any) {
      Alert.alert("Couldn't save", e?.message || String(e));
    } finally { setSaving(false); }
  };

  const onSignOut = async () => {
    await signOut();
    router.replace("/login");
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="profile-screen">
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 100 }} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <SidebarMenuButton />
          <Text style={styles.title}>Profile</Text>
          <TouchableOpacity onPress={openEdit} style={styles.editBtn} testID="edit-profile-btn">
            <Ionicons name="create-outline" size={18} color={theme.primary} />
            <Text style={styles.editText}>Edit</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          <TouchableOpacity onPress={changeAvatar} activeOpacity={0.85} testID="change-avatar-btn">
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
          <View style={{ flex: 1 }}>
            <Text style={styles.name} numberOfLines={1}>{user?.name || "Explorer"}</Text>
            {!!user?.username && (
              <Text style={styles.handle} numberOfLines={1}>@{user.username}</Text>
            )}
            <Text style={styles.email} numberOfLines={1}>{user?.email}</Text>
            {!!user?.bio && <Text style={styles.bio}>{user.bio}</Text>}
          </View>
        </View>

        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statNum}>{stats.places}</Text>
            <Text style={styles.statLabel}>Places</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statNum}>{stats.guides}</Text>
            <Text style={styles.statLabel}>Guides</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statNum}>{stats.reviews}</Text>
            <Text style={styles.statLabel}>Reviews</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About Atlas</Text>
          <View style={styles.aboutRow}><Ionicons name="map" size={18} color={theme.primary} /><Text style={styles.aboutText}>Powered by Mapbox</Text></View>
          <View style={styles.aboutRow}><Ionicons name="navigate" size={18} color={theme.primary} /><Text style={styles.aboutText}>Turn-by-turn navigation</Text></View>
          <View style={styles.aboutRow}><Ionicons name="bookmarks" size={18} color={theme.primary} /><Text style={styles.aboutText}>Shareable public guides</Text></View>
          <View style={styles.aboutRow}><Ionicons name="chatbubbles" size={18} color={theme.primary} /><Text style={styles.aboutText}>Chat with friends & share places</Text></View>
        </View>

        <Text style={styles.postsHeader}>Your posts</Text>
        {loadingPosts ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 12 }} />
        ) : myPosts.length === 0 ? (
          <View style={styles.postsEmpty}>
            <Ionicons name="newspaper-outline" size={28} color={theme.textMuted} />
            <Text style={styles.postsEmptyText}>No posts yet. Share something on the feed!</Text>
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            {myPosts.map((p) => (
              <PostCard
                key={p.id}
                post={p}
                viewerId={user?.user_id}
                onLike={onLike}
                onRepost={onRepost}
                onReply={onReply}
                onBookmark={onBookmark}
              />
            ))}
          </View>
        )}

        <TouchableOpacity
          style={styles.signoutBtn}
          onPress={onSignOut}
          testID="signout-btn"
          activeOpacity={0.85}
        >
          <Ionicons name="log-out-outline" size={20} color={theme.error} />
          <Text style={styles.signoutText}>Sign out</Text>
        </TouchableOpacity>
      </ScrollView>

      <Modal visible={editOpen} transparent animationType="slide" onRequestClose={() => setEditOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setEditOpen(false)} />
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.modalTitle}>Edit profile</Text>
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
  header: { paddingTop: 16, paddingBottom: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingHorizontal: 4 },
  title: { color: theme.textPrimary, fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  editBtn: {
    flexDirection: "row", gap: 6, alignItems: "center",
    paddingHorizontal: 14, paddingVertical: 8,
    backgroundColor: theme.surface, borderRadius: 12,
    borderWidth: 1, borderColor: theme.border,
  },
  editText: { color: theme.primary, fontWeight: "700", fontSize: 13 },

  card: {
    marginTop: 16,
    backgroundColor: theme.surface, borderRadius: 20,
    borderWidth: 1, borderColor: theme.border,
    padding: 16, flexDirection: "row", gap: 16,
  },
  avatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: theme.surfaceAlt },
  avatarBadge: {
    position: "absolute", bottom: 0, right: 0,
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: theme.primary, borderWidth: 2, borderColor: theme.surface,
    alignItems: "center", justifyContent: "center",
  },
  handle: { color: theme.primary, fontSize: 13, fontWeight: "700", marginTop: 2 },
  name: { color: theme.textPrimary, fontSize: 20, fontWeight: "800" },
  email: { color: theme.textSecondary, fontSize: 13, marginTop: 4 },
  bio: { color: theme.textPrimary, fontSize: 13, marginTop: 8, lineHeight: 18 },

  statsRow: {
    marginTop: 12, flexDirection: "row", gap: 10,
  },
  statBox: {
    flex: 1, backgroundColor: theme.surface, borderRadius: 14,
    borderWidth: 1, borderColor: theme.border,
    paddingVertical: 10, alignItems: "center",
  },
  statNum: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  statLabel: { color: theme.textSecondary, fontSize: 11, marginTop: 2 },

  section: {
    marginTop: 16,
    backgroundColor: theme.surface, borderRadius: 16,
    borderWidth: 1, borderColor: theme.border,
    padding: 14, gap: 10,
  },
  sectionTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "700", marginBottom: 4 },
  aboutRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  aboutText: { color: theme.textSecondary, fontSize: 14 },

  signoutBtn: {
    marginTop: 16,
    flexDirection: "row", gap: 10, alignItems: "center", justifyContent: "center",
    paddingVertical: 12, borderRadius: 14,
    backgroundColor: "rgba(239,68,68,0.1)",
    borderWidth: 1, borderColor: "rgba(239,68,68,0.3)",
  },
  signoutText: { color: theme.error, fontWeight: "700", fontSize: 15 },

  postsHeader: {
    color: theme.textPrimary, fontSize: 16, fontWeight: "800",
    marginTop: 18, marginBottom: 8, letterSpacing: -0.3,
  },
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
