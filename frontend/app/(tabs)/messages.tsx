import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, SectionList, ActivityIndicator,
  TextInput, Image, Modal, KeyboardAvoidingView, Platform, Alert, RefreshControl, Animated, Easing,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { api, ConversationView, PublicUser } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import { GLASS } from "@/src/lib/glass";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";
import RestrictionBanner from "@/src/components/RestrictionBanner";
import { isE2E, tryDecrypt, getPeerPublicKey } from "@/src/utils/e2e";
import UnlockChatSheet from "@/src/components/UnlockChatSheet";
import { useKeyboardHeight } from "@/src/hooks/useKeyboardHeight";
import { useConfirm } from "@/src/context/ConfirmContext";

type Mode = "new-dm" | "new-group" | null;

export default function MessagesScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const confirm = useConfirm();
  const msgOff = !!user?.messaging_disabled;
  const insets = useSafeAreaInsets();
  const kb = useKeyboardHeight();
  const [convs, setConvs] = useState<ConversationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<Mode>(null);
  const [actionConv, setActionConv] = useState<ConversationView | null>(null);

  // New chat state
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<PublicUser[]>([]);
  const [searching, setSearching] = useState(false);

  // New group state
  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState<PublicUser[]>([]);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await api.listConversations();
      setConvs(c);
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Decrypt E2E last-message previews so the inbox shows real text (like the
  // chat does) instead of a permanent "Encrypted message". Re-runs whenever the
  // conversations reload (incl. after unlocking a key elsewhere, since the
  // screen reloads on focus).
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [keyTick, setKeyTick] = useState(0);     // bumped after an unlock → re-decrypt
  const [unlockOpen, setUnlockOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const c of convs) {
        const last = c.last_message;
        if (!last || !last.text || !isE2E(last.text)) continue;
        try {
          let peer: Uint8Array | null = null;
          if (c.kind === "group") {
            if (last.sender_id !== user?.user_id) {
              const m = (c.members || []).find((x) => x.user_id === last.sender_id);
              peer = m ? await getPeerPublicKey(m.user_id) : null;
            }
          } else if (c.other_user) {
            peer = await getPeerPublicKey(c.other_user.user_id);
          }
          const plain = await tryDecrypt(last.text, peer);
          if (plain != null) next[c.id] = plain.slice(0, 140);
        } catch {}
      }
      if (!cancelled && Object.keys(next).length) setPreviews((p) => ({ ...p, ...next }));
    })();
    return () => { cancelled = true; };
  }, [convs, user?.user_id, keyTick]);

  // Conversations whose last message is encrypted but couldn't be decrypted here
  // (key missing) → drives the inbox "unlock" banner.
  const lockedCount = useMemo(
    () => convs.filter((c) => !!c.last_message?.text && isE2E(c.last_message.text) && !previews[c.id]).length,
    [convs, previews],
  );

  useEffect(() => {
    if (!mode) return;
    if (!searchQ.trim()) { setSearchResults([]); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.searchUsers(searchQ);
        // Hide users already picked in group flow
        const picked = new Set(groupMembers.map((u) => u.user_id));
        setSearchResults(r.filter((u) => !picked.has(u.user_id)));
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchQ, mode, groupMembers]);

  const resetCompose = () => {
    setMode(null);
    setSearchQ("");
    setSearchResults([]);
    setGroupName("");
    setGroupMembers([]);
  };

  const startChat = async (u: PublicUser) => {
    try {
      const conv = await api.getOrCreateConversation(u.user_id);
      resetCompose();
      router.push({ pathname: "/chat/[id]", params: { id: conv.id, name: u.name } });
    } catch {}
  };

  const startNoteToSelf = async () => {
    if (!user) return;
    try {
      const conv = await api.getOrCreateConversation(user.user_id);
      resetCompose();
      router.push({ pathname: "/chat/[id]", params: { id: conv.id, name: "Notes to self" } });
    } catch {}
  };

  const togglePickMember = (u: PublicUser) => {
    setGroupMembers((arr) =>
      arr.find((x) => x.user_id === u.user_id)
        ? arr.filter((x) => x.user_id !== u.user_id)
        : [...arr, u]
    );
    setSearchQ("");
    setSearchResults([]);
  };

  const createGroup = async () => {
    const name = groupName.trim();
    if (!name) return;
    if (groupMembers.length < 1) return;
    setCreating(true);
    try {
      const conv = await api.createGroupChat({
        name,
        member_ids: groupMembers.map((u) => u.user_id),
      });
      resetCompose();
      router.push({ pathname: "/chat/[id]", params: { id: conv.id, name: conv.name || name } });
    } catch (e) {
      Alert.alert("Couldn't create group", String(e));
    } finally {
      setCreating(false);
    }
  };

  const onLongPress = (c: ConversationView) => setActionConv(c);

  const confirmDelete = async (c: ConversationView) => {
    // Close the action sheet first so the confirm dialog isn't rendered behind
    // it (modals stack by the order they're presented).
    setActionConv(null);
    const isGroup = c.kind === "group";
    const title = isGroup ? "Leave group?" : "Delete conversation?";
    const msg = isGroup
      ? "You'll be removed from this group and the chat will disappear from your inbox."
      : "This chat will disappear from your inbox. The other person still has it.";
    await new Promise((r) => setTimeout(r, 220));
    // In-app confirm (ConfirmModal) on every platform — never the browser's
    // window.confirm on web.
    if (!(await confirm({ title, message: msg, confirmLabel: isGroup ? "Leave" : "Delete", destructive: true }))) return;
    try {
      await api.deleteConversation(c.id);
      setConvs((arr) => arr.filter((x) => x.id !== c.id));
    } catch (e) {
      Alert.alert("Couldn't delete", String(e));
    }
  };

  // Split conversations into Direct / Marketplace / Groups sections. Empty
  // sections are dropped so headers only appear when there's something in them.
  const sections = useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (c: ConversationView) => {
      if (!q) return true;
      const nm = c.kind === "group" ? (c.name || "Group") : (c.other_user?.name || "User");
      return nm.toLowerCase().includes(q) || (c.listing_title || "").toLowerCase().includes(q);
    };
    const filtered = convs.filter(match);
    const direct = filtered.filter((c) => c.kind === "dm" && !c.listing_id);
    const market = filtered.filter((c) => c.kind === "dm" && !!c.listing_id);
    const groups = filtered.filter((c) => c.kind === "group");
    const out: { title: string; data: ConversationView[] }[] = [];
    if (direct.length) out.push({ title: "Direct messages", data: direct });
    if (market.length) out.push({ title: "Marketplace", data: market });
    if (groups.length) out.push({ title: "Group chats", data: groups });
    return out;
  }, [convs, search]);

  const fmtTime = (s?: string | null) => {
    if (!s) return "";
    const d = new Date(s);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString();
  };

  // Floating frosted top bar that hides on scroll-down, returns on scroll-up,
  // mirroring the feed + marketplace headers.
  const [topHidden, setTopHidden] = useState(false);
  const [topBarH, setTopBarH] = useState(150);
  const topHide = useRef(new Animated.Value(0)).current;
  const lastScrollY = useRef(0);
  const onScroll = useCallback((e: any) => {
    const y = e?.nativeEvent?.contentOffset?.y ?? 0;
    const dy = y - lastScrollY.current;
    if (y <= 4) setTopHidden(false);
    else if (dy > 6) setTopHidden(true);
    else if (dy < -6) setTopHidden(false);
    lastScrollY.current = y;
  }, []);
  useEffect(() => {
    Animated.timing(topHide, {
      toValue: topHidden ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [topHidden, topHide]);
  useFocusEffect(useCallback(() => { setTopHidden(false); lastScrollY.current = 0; }, []));

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="messages-screen">
      {/* Floating frosted top bar — hides on scroll-down, returns on scroll-up. */}
      <Animated.View
        onLayout={(e) => setTopBarH(e.nativeEvent.layout.height)}
        pointerEvents={topHidden ? "none" : "box-none"}
        style={[
          styles.topBar,
          GLASS,
          {
            opacity: topHide.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 0.25, 0] }),
            transform: [{ translateY: topHide.interpolate({ inputRange: [0, 1], outputRange: [0, -(topBarH + insets.top + 14)] }) }],
          },
        ]}
      >
        <View style={styles.header}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
            <SidebarMenuButton />
            <Text style={styles.title}>Messages</Text>
          </View>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <TouchableOpacity
              onPress={() => { if (msgOff) return; setMode("new-dm"); }}
              disabled={msgOff}
              style={[styles.iconBtn, msgOff && { opacity: 0.4 }]}
              testID="new-chat-btn"
            >
              <Ionicons name="create-outline" size={20} color={theme.primary} />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.searchWrap}>
          <Ionicons name="search" size={16} color={theme.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search messages"
            placeholderTextColor={theme.textMuted}
            value={search}
            onChangeText={setSearch}
            testID="messages-search"
          />
          {!!search && (
            <TouchableOpacity onPress={() => setSearch("")} testID="messages-search-clear">
              <Ionicons name="close-circle" size={16} color={theme.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        {lockedCount > 0 ? (
          <TouchableOpacity style={styles.unlockBanner} activeOpacity={0.85} onPress={() => setUnlockOpen(true)} testID="inbox-unlock">
            <Ionicons name="lock-closed" size={16} color={theme.primary} />
            <Text style={styles.unlockText} numberOfLines={2}>
              {lockedCount} chat{lockedCount === 1 ? "" : "s"} locked on this device. Tap to enter your PIN and unlock.
            </Text>
            <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
          </TouchableOpacity>
        ) : (
          <View style={styles.encNote}>
            <Ionicons name="lock-closed" size={12} color={theme.textMuted} />
            <Text style={styles.encNoteText}>Your chats are encrypted</Text>
          </View>
        )}

        <RestrictionBanner kind="messaging" />
      </Animated.View>

      <UnlockChatSheet
        visible={unlockOpen}
        onClose={() => setUnlockOpen(false)}
        onUnlocked={() => setKeyTick((t) => t + 1)}
      />

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(i) => i.id}
          stickySectionHeadersEnabled={false}
          onScroll={onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: topBarH + 12, paddingBottom: insets.bottom + 80, gap: 8 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              progressViewOffset={topBarH}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={theme.primary}
              colors={[theme.primary]}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Ionicons name="chatbubbles-outline" size={32} color={theme.textMuted} />
              </View>
              <Text style={styles.emptyTitle}>No conversations yet</Text>
              <Text style={styles.emptySub}>Tap the compose icon to find someone or start a group.</Text>
            </View>
          }
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionHeader}>{section.title}</Text>
          )}
          renderItem={({ item }) => {
            const isGroup = item.kind === "group";
            const displayName = isGroup ? (item.name || "Group") : (item.other_user?.name || "User");
            const displayPic = isGroup ? item.avatar : item.other_user?.picture;
            const last = item.last_message;
            const preview = last
              ? last.deleted
                ? "🚫 Message deleted"
                : last.type === "place"
                ? `📍 ${last.place_name || "Shared a place"}`
                : last.type === "media"
                ? "📎 Media"
                : last.type === "voice"
                ? "🎤 Voice message"
                : last.type === "post"
                ? "📄 Shared a post"
                : last.type === "poll"
                ? `📊 ${last.poll_question || "Poll"}`
                : (last.text || "").startsWith("e2e:v1:")
                ? (previews[item.id] || "🔒 Encrypted message")
                : last.text
              : "Say hi 👋";
            return (
              <TouchableOpacity
                style={[styles.convRow, (item.unread_count || 0) > 0 && styles.convRowUnread]}
                onPress={() => router.push({ pathname: "/chat/[id]", params: { id: item.id, name: displayName } })}
                onLongPress={() => onLongPress(item)}
                delayLongPress={350}
                testID={`conv-${item.id}`}
                activeOpacity={0.85}
              >
                <View style={[styles.avatar, isGroup && { backgroundColor: "#7C3AED" }]}>
                  {displayPic ? (
                    <Image source={{ uri: displayPic }} style={styles.avatarImg} />
                  ) : (
                    <Ionicons
                      name={isGroup ? "people" : undefined as any}
                      size={isGroup ? 22 : 0}
                      color="#fff"
                    />
                  )}
                  {!displayPic && !isGroup && (
                    <Text style={styles.avatarInit}>
                      {(displayName?.[0] || "?").toUpperCase()}
                    </Text>
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.convTopRow}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
                      <Text style={styles.convName} numberOfLines={1}>{displayName}</Text>
                      {isGroup && (
                        <View style={styles.groupPill}>
                          <Text style={styles.groupPillText}>{item.members?.length || 0}</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.convTime}>{fmtTime(item.last_message_at)}</Text>
                  </View>
                  {!!item.listing_id && !!item.listing_title && (
                    <Text style={styles.listingTag} numberOfLines={1}>🏷️ {item.listing_title}</Text>
                  )}
                  <View style={styles.convBottomRow}>
                    <Text
                      style={[styles.convPreview, (item.unread_count || 0) > 0 && { color: theme.textPrimary, fontWeight: "700" }]}
                      numberOfLines={1}
                    >
                      {preview}
                    </Text>
                    {(item.unread_count || 0) > 0 && (
                      <View style={styles.unreadBadge}>
                        <Text style={styles.unreadBadgeText}>{item.unread_count}</Text>
                      </View>
                    )}
                  </View>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {/* Compose / new-group modal */}
      <Modal visible={mode !== null} transparent animationType="slide" onRequestClose={resetCompose}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.modalBackdrop}
        >
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={resetCompose} />
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 24, maxHeight: "82%", marginBottom: kb }]}>
            <View style={styles.sheetHandle} />
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <Text style={styles.modalTitle}>
                {mode === "new-group" ? "New group" : "New message"}
              </Text>
              <TouchableOpacity onPress={() => setMode(mode === "new-dm" ? "new-group" : "new-dm")}>
                <Text style={styles.switchModeText}>
                  {mode === "new-dm" ? "+ Group" : "1:1 chat"}
                </Text>
              </TouchableOpacity>
            </View>

            {mode === "new-dm" && (
              <TouchableOpacity
                style={styles.selfChatRow}
                onPress={startNoteToSelf}
                testID="self-chat-btn"
              >
                <View style={[styles.avatar, { backgroundColor: theme.surfaceAlt }]}>
                  <Ionicons name="bookmark" size={20} color={theme.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.convName}>Notes to self</Text>
                  <Text style={styles.convPreview}>A private place to save thoughts & places</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
              </TouchableOpacity>
            )}

            {mode === "new-group" && (
              <>
                <TextInput
                  placeholder="Group name"
                  placeholderTextColor={theme.textMuted}
                  style={[styles.searchPill, styles.composeSearchInput, { marginBottom: 10 }]}
                  value={groupName}
                  onChangeText={setGroupName}
                  maxLength={80}
                />
                {groupMembers.length > 0 && (
                  <View style={styles.chipsRow}>
                    {groupMembers.map((u) => (
                      <TouchableOpacity
                        key={u.user_id}
                        style={styles.chip}
                        onPress={() => setGroupMembers((arr) => arr.filter((x) => x.user_id !== u.user_id))}
                      >
                        <Text style={styles.chipText} numberOfLines={1}>{u.name}</Text>
                        <Ionicons name="close" size={12} color="#fff" />
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </>
            )}

            <View style={styles.searchPill}>
              <Ionicons name="search" size={18} color={theme.textSecondary} />
              <TextInput
                placeholder={mode === "new-group" ? "Add members…" : "Search by email or name"}
                placeholderTextColor={theme.textMuted}
                style={styles.composeSearchInput}
                value={searchQ}
                onChangeText={setSearchQ}
                autoFocus={mode === "new-dm"}
                testID="user-search-input"
              />
              {searching && <ActivityIndicator color={theme.primary} size="small" />}
            </View>

            <FlatList
              data={searchResults}
              keyExtractor={(i) => i.user_id}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <Text style={styles.helperText}>
                  {searchQ ? "No users found." : "Start typing to find someone."}
                </Text>
              }
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.userRow}
                  onPress={() => mode === "new-group" ? togglePickMember(item) : startChat(item)}
                  testID={`user-${item.user_id}`}
                >
                  <View style={styles.avatar}>
                    {item.picture ? (
                      <Image source={{ uri: item.picture }} style={styles.avatarImg} />
                    ) : (
                      <Text style={styles.avatarInit}>{(item.name?.[0] || "?").toUpperCase()}</Text>
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.convName} numberOfLines={1}>{item.name}</Text>
                    {!!item.bio && <Text style={styles.convPreview} numberOfLines={1}>{item.bio}</Text>}
                  </View>
                  <Ionicons
                    name={mode === "new-group" ? "add-circle-outline" : "chevron-forward"}
                    size={mode === "new-group" ? 22 : 18}
                    color={mode === "new-group" ? theme.primary : theme.textMuted}
                  />
                </TouchableOpacity>
              )}
            />

            {mode === "new-group" && (
              <TouchableOpacity
                style={[
                  styles.createGroupBtn,
                  (!groupName.trim() || groupMembers.length < 1 || creating) && { opacity: 0.5 },
                ]}
                disabled={!groupName.trim() || groupMembers.length < 1 || creating}
                onPress={createGroup}
                testID="create-group-btn"
              >
                {creating
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.createGroupBtnText}>Create group ({groupMembers.length})</Text>}
              </TouchableOpacity>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Long-press action sheet */}
      <Modal visible={!!actionConv} transparent animationType="fade" onRequestClose={() => setActionConv(null)}>
        <TouchableOpacity style={styles.actionBackdrop} onPress={() => setActionConv(null)} activeOpacity={1}>
          <View style={[styles.actionSheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.actionTitle} numberOfLines={1}>
              {actionConv?.kind === "group" ? actionConv?.name : actionConv?.other_user?.name}
            </Text>
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => actionConv && confirmDelete(actionConv)}
              testID="conv-action-delete"
            >
              <Ionicons name="trash-outline" size={18} color="#EF4444" />
              <Text style={[styles.actionBtnText, { color: "#EF4444" }]}>
                {actionConv?.kind === "group" ? "Leave group" : "Delete chat"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, { marginTop: 6 }]}
              onPress={() => setActionConv(null)}
            >
              <Text style={styles.actionBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  topBar: {
    position: "absolute", top: 6, left: 8, right: 8,
    borderRadius: 24, paddingTop: 2, paddingBottom: 4,
    zIndex: 40,
    shadowColor: "#000", shadowOpacity: 0.32, shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8,
  },
  title: { color: theme.textPrimary, fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  encNote: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingBottom: 6 },
  encNoteText: { color: theme.textMuted, fontSize: 11.5, fontWeight: "600" },
  unlockBanner: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 14, paddingVertical: 11, ...GLASS, borderRadius: 12, borderWidth: 1, borderColor: theme.border },
  unlockText: { flex: 1, color: theme.textSecondary, fontSize: 12.5, lineHeight: 17, fontWeight: "600" },
  searchWrap: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 16, marginTop: 4, marginBottom: 6,
    paddingHorizontal: 14, height: 42,
    ...GLASS, borderRadius: 21,
    borderWidth: 1, borderColor: theme.border,
  },
  searchInput: {
    flex: 1, color: theme.textPrimary, fontSize: 15,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  iconBtn: {
    width: 40, height: 40, borderRadius: 20,
    ...GLASS, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  iconBadge: {
    position: "absolute", top: -2, right: -2,
    minWidth: 16, height: 16, paddingHorizontal: 4,
    borderRadius: 8, backgroundColor: "#EF4444",
    alignItems: "center", justifyContent: "center",
  },
  iconBadgeText: { color: "#fff", fontSize: 10, fontWeight: "800" },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { paddingTop: 80, alignItems: "center", gap: 10 },
  emptyIcon: {
    width: 64, height: 64, borderRadius: 32,
    ...GLASS, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center", marginBottom: 4,
  },
  emptyTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "700" },
  emptySub: { color: theme.textSecondary, fontSize: 13, textAlign: "center", maxWidth: 280 },

  convRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    ...GLASS, borderRadius: 16,
    borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  // Unread conversations get an accent border so they stand out at a glance.
  convRowUnread: { borderColor: theme.primary },
  avatar: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
    overflow: "hidden",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontSize: 18, fontWeight: "700" },
  convName: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  convPreview: { color: theme.textSecondary, fontSize: 13, marginTop: 2, flex: 1 },
  convTime: { color: theme.textMuted, fontSize: 11 },
  convTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  convBottomRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 },
  unreadBadge: {
    minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
  },
  unreadBadgeText: { color: "#fff", fontSize: 11, fontWeight: "800" },
  groupPill: {
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8,
    backgroundColor: "#7C3AED22",
  },
  groupPillText: { color: "#A78BFA", fontSize: 10, fontWeight: "800" },
  sectionHeader: {
    color: theme.textSecondary, fontSize: 12.5, fontWeight: "800",
    textTransform: "uppercase", letterSpacing: 0.5,
    marginTop: 14, marginBottom: 2,
  },
  listingTag: { color: theme.primary, fontSize: 12, fontWeight: "600", marginTop: 1 },
  selfChatRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    ...GLASS,
    borderRadius: 14, borderWidth: 1, borderColor: theme.border,
    padding: 12, marginBottom: 14,
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
  modalTitle: { color: theme.textPrimary, fontSize: 20, fontWeight: "800" },
  switchModeText: { color: theme.primary, fontSize: 14, fontWeight: "700" },
  searchPill: {
    flexDirection: "row", alignItems: "center", gap: 8,
    ...GLASS,
    borderWidth: 1, borderColor: theme.border,
    borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12,
    marginBottom: 12,
  },
  composeSearchInput: {
    flex: 1, color: theme.textPrimary, fontSize: 14,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  helperText: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingVertical: 24 },
  userRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  chipsRow: {
    flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8,
  },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: theme.primary, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  chipText: { color: "#fff", fontSize: 12, fontWeight: "700", maxWidth: 120 },
  createGroupBtn: {
    marginTop: 8, paddingVertical: 14, borderRadius: 14,
    backgroundColor: theme.primary, alignItems: "center",
  },
  createGroupBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },

  actionBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end",
  },
  actionSheet: {
    backgroundColor: "#0E0E10",
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingTop: 16, paddingHorizontal: 20,
    borderTopWidth: 1, borderColor: theme.border,
  },
  actionTitle: {
    color: theme.textMuted, fontSize: 12, fontWeight: "700",
    textAlign: "center", marginBottom: 14, textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  actionBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
    ...GLASS, borderRadius: 14,
    borderWidth: 1, borderColor: theme.border,
    paddingVertical: 14, paddingHorizontal: 16,
  },
  actionBtnText: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
});
