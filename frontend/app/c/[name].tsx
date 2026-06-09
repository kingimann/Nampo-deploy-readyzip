import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  ActivityIndicator, RefreshControl, Modal, KeyboardAvoidingView, Platform, ScrollView, Animated, Image,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import * as ImagePicker from "expo-image-picker";
import { assetToUri } from "@/src/utils/thumbnail";
import { api, Community, Post } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { useConfirm } from "@/src/context/ConfirmContext";
import { theme } from "@/src/theme";
import { GLASS } from "@/src/lib/glass";
import { useFloatingHeader } from "@/src/hooks/useFloatingHeader";
import PostCard from "@/src/components/PostCard";
import AdSlot from "@/src/components/AdSlot";
import { interleaveAds, isAd } from "@/src/lib/ads";
import CommentsSheet from "@/src/components/CommentsSheet";

const SORTS = [
  { key: "hot", label: "Hot" },
  { key: "new", label: "New" },
  { key: "top", label: "Top" },
  { key: "rising", label: "Rising" },
];

export default function CommunityScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const fh = useFloatingHeader();
  const { user } = useAuth();
  const confirm = useConfirm();
  const { name } = useLocalSearchParams<{ name: string }>();
  const [community, setCommunity] = useState<Community | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sort, setSort] = useState("hot");
  const [flairFilter, setFlairFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const searchRef = useRef("");
  const [commentsPost, setCommentsPost] = useState<Post | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [draft, setDraft] = useState<{ title: string; body: string; flair: string }>({ title: "", body: "", flair: "" });
  const [posting, setPosting] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [edit, setEdit] = useState({ title: "", description: "", rules: "", flairs: "", banner: "" as string | null, wiki: "", banned: "" });
  const [savingEdit, setSavingEdit] = useState(false);
  const [editErr, setEditErr] = useState("");

  const load = useCallback(async () => {
    if (!name) return;
    try {
      const [c, p] = await Promise.all([api.getCommunity(name), api.communityPosts(name, sort, flairFilter || undefined, searchRef.current || undefined)]);
      setCommunity(c); setPosts(p);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [name, sort, flairFilter]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  // Debounced search — reload posts ~300ms after typing stops (searchRef keeps
  // `load` stable so sort/flair taps stay instant).
  useEffect(() => {
    searchRef.current = search;
    const t = setTimeout(() => { load(); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

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
      const p = await api.createPost({ community_id: community.id, title, text: draft.body.trim(), flair: draft.flair || undefined });
      setPosts((arr) => [p, ...arr]);
      setDraft({ title: "", body: "", flair: "" });
      setComposeOpen(false);
    } catch {} finally { setPosting(false); }
  };

  const toggleFavorite = async () => {
    if (!community) return;
    const next = !community.is_favorite;
    setCommunity({ ...community, is_favorite: next });
    try { next ? await api.favoriteCommunity(community.name) : await api.unfavoriteCommunity(community.name); }
    catch { setCommunity((c) => (c ? { ...c, is_favorite: !next } : c)); }
  };

  const openEdit = () => {
    if (!community) return;
    setEdit({
      title: community.title || "",
      description: community.description || "",
      rules: (community.rules || []).join("\n"),
      flairs: (community.flairs || []).join(", "),
      banner: community.banner || "",
      wiki: community.wiki || "",
      banned: (community.banned_keywords || []).join(", "),
    });
    setEditErr("");
    setEditOpen(true);
  };
  const pickBanner = async () => {
    if (Platform.OS !== "web") {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"] as any, allowsEditing: true, aspect: [4, 1], quality: 0.7, base64: true });
    if (res.canceled || !res.assets?.[0]) return;
    const uri = await assetToUri(res.assets[0], "image");
    if (uri) setEdit((e) => ({ ...e, banner: uri }));
  };
  const saveEdit = async () => {
    if (!community) return;
    setSavingEdit(true); setEditErr("");
    try {
      const rules = edit.rules.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 15);
      const flairs = edit.flairs.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
      const banned = edit.banned.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
      const c = await api.updateCommunity(community.name, {
        title: edit.title.trim() || community.name,
        description: edit.description.trim(),
        rules, flairs, banner: edit.banner || "",
        wiki: edit.wiki.trim(), banned_keywords: banned,
      });
      setCommunity(c);
      setEditOpen(false);
    } catch (e: any) {
      setEditErr(e?.message || "Couldn't save changes.");
    } finally { setSavingEdit(false); }
  };

  const onMore = async (p: Post) => {
    if (!community?.can_moderate) return;
    if (!(await confirm({ title: "Remove this post?", message: "It will be removed from the community.", confirmLabel: "Remove", destructive: true }))) return;
    setPosts((arr) => arr.filter((x) => x.id !== p.id));
    try { await api.removeCommunityPost(community.name, p.id); } catch { load(); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="community-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <Animated.View
        onLayout={(e) => fh.setTopBarH(e.nativeEvent.layout.height)}
        pointerEvents={fh.barPointerEvents}
        style={[styles.topBar, GLASS, fh.barStyle(insets.top)]}
      >
        <View style={styles.header}>
          <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="community-back">
            <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} numberOfLines={1}>{community ? `/${community.name}` : "Community"}</Text>
          <View style={{ width: 40 }} />
        </View>
      </Animated.View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={interleaveAds(posts)}
          keyExtractor={(i) => (isAd(i) ? `ad-${i.__ad}` : i.id)}
          style={{ flex: 1 }}
          onScroll={fh.onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{ flexGrow: 1, paddingTop: fh.topBarH + 8, paddingBottom: insets.bottom + 90 }}
          refreshControl={<RefreshControl refreshing={refreshing} progressViewOffset={fh.topBarH} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} />}
          ListHeaderComponent={
            community ? (
              <View>
                {!!community.banner && (
                  <Image source={{ uri: community.banner }} style={styles.bannerImg} resizeMode="cover" />
                )}
                <View style={styles.banner}>
                  <View style={[styles.cIcon, { backgroundColor: (community.color || theme.primary) + "22" }]}>
                    <Ionicons name={(community.icon as any) || "people"} size={26} color={community.color || theme.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cTitle}>{community.title}</Text>
                    <TouchableOpacity onPress={() => router.push({ pathname: "/c/[name]/members", params: { name: community.name } })} testID="community-members-link">
                      <Text style={styles.cMeta}>{community.member_count || 0} members · {community.post_count || 0} posts ›</Text>
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity style={styles.gearBtn} onPress={toggleFavorite} testID="community-favorite">
                    <Ionicons name={community.is_favorite ? "star" : "star-outline"} size={20} color={community.is_favorite ? "#EAB308" : theme.textPrimary} />
                  </TouchableOpacity>
                  {community.can_moderate && (
                    <TouchableOpacity style={styles.gearBtn} onPress={openEdit} testID="community-edit">
                      <Ionicons name="settings-outline" size={20} color={theme.textPrimary} />
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity style={[styles.joinBtn, community.is_member && styles.joinBtnGhost]} onPress={toggleJoin} testID="community-join">
                    <Text style={[styles.joinText, community.is_member && { color: theme.textPrimary }]}>{community.is_member ? "Joined" : "Join"}</Text>
                  </TouchableOpacity>
                </View>
                {!!community.description && <Text style={styles.cDesc}>{community.description}</Text>}
                {!!community.rules?.length && (
                  <View style={styles.rulesCard}>
                    <TouchableOpacity style={styles.rulesHead} onPress={() => setRulesOpen((v) => !v)} testID="community-rules">
                      <Ionicons name="shield-checkmark-outline" size={16} color={theme.primary} />
                      <Text style={styles.rulesTitle}>Community rules</Text>
                      <Ionicons name={rulesOpen ? "chevron-up" : "chevron-down"} size={16} color={theme.textMuted} />
                    </TouchableOpacity>
                    {rulesOpen && community.rules.map((r, i) => (
                      <Text key={i} style={styles.ruleItem}>{i + 1}. {r}</Text>
                    ))}
                  </View>
                )}
                {!!community.wiki && (
                  <View style={styles.rulesCard}>
                    <TouchableOpacity style={styles.rulesHead} onPress={() => setAboutOpen((v) => !v)} testID="community-about">
                      <Ionicons name="book-outline" size={16} color={theme.primary} />
                      <Text style={styles.rulesTitle}>About this community</Text>
                      <Ionicons name={aboutOpen ? "chevron-up" : "chevron-down"} size={16} color={theme.textMuted} />
                    </TouchableOpacity>
                    {aboutOpen && <Text style={styles.wikiText}>{community.wiki}</Text>}
                  </View>
                )}
                <View style={styles.searchPill}>
                  <Ionicons name="search" size={16} color={theme.textMuted} />
                  <TextInput
                    style={styles.searchInput}
                    placeholder={`Search /${community.name}`}
                    placeholderTextColor={theme.textMuted}
                    value={search}
                    onChangeText={setSearch}
                    autoCapitalize="none"
                    testID="community-post-search"
                  />
                  {!!search && (
                    <TouchableOpacity onPress={() => setSearch("")} hitSlop={8}>
                      <Ionicons name="close-circle" size={16} color={theme.textMuted} />
                    </TouchableOpacity>
                  )}
                </View>
                <View style={styles.sortRow}>
                  {SORTS.map((s) => (
                    <TouchableOpacity key={s.key} onPress={() => setSort(s.key)} style={[styles.sortChip, sort === s.key && styles.sortChipOn]} testID={`sort-${s.key}`}>
                      <Text style={[styles.sortText, sort === s.key && { color: theme.primary }]}>{s.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {!!community.flairs?.length && (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.flairRow}>
                    <TouchableOpacity onPress={() => setFlairFilter("")} style={[styles.flairChip, !flairFilter && styles.flairChipOn]}>
                      <Text style={[styles.flairChipText, !flairFilter && { color: "#fff" }]}>All</Text>
                    </TouchableOpacity>
                    {community.flairs.map((f) => (
                      <TouchableOpacity key={f} onPress={() => setFlairFilter(f === flairFilter ? "" : f)} style={[styles.flairChip, flairFilter === f && styles.flairChipOn]}>
                        <Text style={[styles.flairChipText, flairFilter === f && { color: "#fff" }]}>{f}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                )}
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
              onReply={(p) => setCommentsPost(p)}
              onComments={(p) => setCommentsPost(p)}
              onMore={community?.can_moderate ? onMore : undefined}
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

      <Modal visible={editOpen} transparent animationType="slide" onRequestClose={() => setEditOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setEditOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.handle} />
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.sheetTitle}>Community settings</Text>

              <Text style={styles.fieldLabel}>Banner</Text>
              <TouchableOpacity onPress={pickBanner} testID="edit-banner">
                {edit.banner ? (
                  <Image source={{ uri: edit.banner }} style={styles.bannerEditImg} resizeMode="cover" />
                ) : (
                  <View style={styles.bannerEditEmpty}><Ionicons name="image-outline" size={22} color={theme.textMuted} /><Text style={styles.bannerEditText}>Add a banner image</Text></View>
                )}
              </TouchableOpacity>
              {!!edit.banner && (
                <TouchableOpacity onPress={() => setEdit((e) => ({ ...e, banner: "" }))}><Text style={styles.removeBanner}>Remove banner</Text></TouchableOpacity>
              )}

              <Text style={styles.fieldLabel}>Title</Text>
              <TextInput style={styles.titleInput} value={edit.title} onChangeText={(t) => setEdit((e) => ({ ...e, title: t }))} maxLength={60} placeholderTextColor={theme.textMuted} />
              <Text style={styles.fieldLabel}>Description</Text>
              <TextInput style={styles.bodyInput} value={edit.description} onChangeText={(t) => setEdit((e) => ({ ...e, description: t }))} multiline maxLength={500} placeholderTextColor={theme.textMuted} />
              <Text style={styles.fieldLabel}>Rules (one per line)</Text>
              <TextInput style={styles.bodyInput} value={edit.rules} onChangeText={(t) => setEdit((e) => ({ ...e, rules: t }))} multiline placeholder={"Be respectful\nNo spam"} placeholderTextColor={theme.textMuted} />
              <Text style={styles.fieldLabel}>Flairs (comma-separated)</Text>
              <TextInput style={styles.titleInput} value={edit.flairs} onChangeText={(t) => setEdit((e) => ({ ...e, flairs: t }))} placeholder="Discussion, Question, News" placeholderTextColor={theme.textMuted} autoCapitalize="none" />
              <Text style={styles.fieldLabel}>About / wiki</Text>
              <TextInput style={[styles.bodyInput, { minHeight: 120 }]} value={edit.wiki} onChangeText={(t) => setEdit((e) => ({ ...e, wiki: t }))} multiline placeholder="A longer description, FAQ, or posting guidelines for your community." placeholderTextColor={theme.textMuted} />
              <Text style={styles.fieldLabel}>Auto-mod: banned words (comma-separated)</Text>
              <TextInput style={styles.titleInput} value={edit.banned} onChangeText={(t) => setEdit((e) => ({ ...e, banned: t }))} placeholder="spam, scam" placeholderTextColor={theme.textMuted} autoCapitalize="none" />
              <Text style={styles.bannedHint}>New posts containing any of these words are blocked.</Text>

              {!!editErr && <Text style={styles.editErr}>{editErr}</Text>}
              <TouchableOpacity style={[styles.postBtn, savingEdit && { opacity: 0.5 }]} onPress={saveEdit} disabled={savingEdit} testID="community-save">
                {savingEdit ? <ActivityIndicator color="#fff" /> : <Text style={styles.postBtnText}>Save settings</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={composeOpen} transparent animationType="slide" onRequestClose={() => setComposeOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setComposeOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.handle} />
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.sheetTitle}>New thread in /{community?.name}</Text>
              {!!community?.flairs?.length && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 10 }}>
                  {community.flairs.map((f) => (
                    <TouchableOpacity key={f} onPress={() => setDraft((d) => ({ ...d, flair: d.flair === f ? "" : f }))} style={[styles.flairChip, draft.flair === f && styles.flairChipOn]}>
                      <Text style={[styles.flairChipText, draft.flair === f && { color: "#fff" }]}>{f}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
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
  topBar: {
    position: "absolute", top: 6, left: 8, right: 8,
    borderRadius: 24, zIndex: 40,
    shadowColor: "#000", shadowOpacity: 0.32, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 10,
  },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, color: theme.textPrimary, fontSize: 17, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  bannerImg: { width: "100%", height: 110, backgroundColor: theme.surfaceAlt },
  banner: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16 },
  gearBtn: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  rulesCard: { marginHorizontal: 16, marginBottom: 8, backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, paddingVertical: 10 },
  rulesHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  rulesTitle: { flex: 1, color: theme.textPrimary, fontSize: 14, fontWeight: "800" },
  ruleItem: { color: theme.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 8 },
  wikiText: { color: theme.textSecondary, fontSize: 13.5, lineHeight: 20, marginTop: 8 },
  bannedHint: { color: theme.textMuted, fontSize: 11.5, marginTop: 4 },
  flairRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  flairChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  flairChipOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  flairChipText: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "700" },
  fieldLabel: { color: theme.textSecondary, fontSize: 12, fontWeight: "700", marginTop: 14, marginBottom: 6 },
  bannerEditImg: { width: "100%", height: 90, borderRadius: 12, backgroundColor: theme.surfaceAlt },
  bannerEditEmpty: { height: 90, borderRadius: 12, borderWidth: 1, borderColor: theme.border, borderStyle: "dashed", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.surface },
  bannerEditText: { color: theme.textMuted, fontSize: 13, fontWeight: "600" },
  removeBanner: { color: theme.error, fontSize: 12.5, fontWeight: "700", marginTop: 6 },
  editErr: { color: theme.error, fontSize: 12.5, fontWeight: "600", marginTop: 12 },
  cIcon: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
  cTitle: { color: theme.textPrimary, fontSize: 20, fontWeight: "800" },
  cMeta: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  joinBtn: { backgroundColor: theme.primary, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 9 },
  joinBtnGhost: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  joinText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  cDesc: { color: theme.textSecondary, fontSize: 14, paddingHorizontal: 16, marginBottom: 8, lineHeight: 19 },
  searchPill: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginBottom: 4, height: 40, backgroundColor: theme.surface, borderRadius: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: theme.border },
  searchInput: { flex: 1, color: theme.textPrimary, fontSize: 14, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
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
