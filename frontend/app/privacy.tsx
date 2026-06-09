import React, { useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import { storage } from "@/src/utils/storage";

const HIDE_STORIES_KEY = "hide_stories"; // keep in sync with the feed screen

const POLICIES = [
  { k: "everyone", label: "Everyone", icon: "earth-outline" },
  { k: "followers", label: "Followers", icon: "person-add-outline" },
  { k: "friends", label: "Friends", icon: "people-outline" },
  { k: "nobody", label: "No one", icon: "lock-closed-outline" },
] as const;

// Who can start a DM with you.
const MSG_POLICIES = [
  { k: "everyone", label: "Everyone", icon: "earth-outline" },
  { k: "followers", label: "Followers", icon: "person-add-outline" },
  { k: "nobody", label: "No one", icon: "lock-closed-outline" },
] as const;

export default function PrivacyScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, refresh } = useAuth() as any;
  const [policy, setPolicy] = useState<string>(user?.default_comment_policy || "everyone");
  const [likesOff, setLikesOff] = useState<boolean>(!!user?.default_likes_disabled);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [savingLikes, setSavingLikes] = useState(false);
  const [showStories, setShowStories] = useState(true);
  // Account-privacy settings (server-stored).
  const [isPrivate, setIsPrivate] = useState<boolean>(!!user?.is_private);
  const [msgPolicy, setMsgPolicy] = useState<string>(user?.message_policy || "everyone");
  const [searchable, setSearchable] = useState<boolean>(user?.searchable !== false);
  const [hideOnline, setHideOnline] = useState<boolean>(!!user?.hide_online);
  const [connVis, setConnVis] = useState<string>(user?.connections_visibility || "everyone");
  const [hideLikes, setHideLikes] = useState<boolean>(!!user?.hide_likes);
  const [tagPolicy, setTagPolicy] = useState<string>(user?.tag_policy || "everyone");

  React.useEffect(() => {
    storage.getItem(HIDE_STORIES_KEY, false).then((h) => setShowStories(!h));
  }, []);
  const toggleStories = async () => {
    const next = !showStories; setShowStories(next);
    await storage.setItem(HIDE_STORIES_KEY, !next); // stored value is "hidden"
  };

  // Persist a profile patch with an optimistic update + refresh.
  const patchMe = async (patch: Record<string, any>) => {
    try { await api.updateMe(patch); if (typeof refresh === "function") await refresh(); } catch {}
  };

  const savePolicy = async (k: string) => {
    setPolicy(k); setSavingPolicy(true);
    try { await api.updateMe({ default_comment_policy: k }); if (typeof refresh === "function") await refresh(); }
    catch {} finally { setSavingPolicy(false); }
  };
  const toggleLikes = async () => {
    const next = !likesOff; setLikesOff(next); setSavingLikes(true);
    try { await api.updateMe({ default_likes_disabled: next }); if (typeof refresh === "function") await refresh(); }
    catch {} finally { setSavingLikes(false); }
  };
  const togglePrivate = () => { const n = !isPrivate; setIsPrivate(n); patchMe({ is_private: n }); };
  const toggleSearchable = () => { const n = !searchable; setSearchable(n); patchMe({ searchable: n }); };
  const toggleHideOnline = () => { const n = !hideOnline; setHideOnline(n); patchMe({ hide_online: n }); };
  const pickMsgPolicy = (k: string) => { setMsgPolicy(k); patchMe({ message_policy: k }); };
  const pickConnVis = (k: string) => { setConnVis(k); patchMe({ connections_visibility: k }); };
  const toggleHideLikes = () => { const n = !hideLikes; setHideLikes(n); patchMe({ hide_likes: n }); };
  const pickTagPolicy = (k: string) => { setTagPolicy(k); patchMe({ tag_policy: k }); };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="privacy-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn} testID="privacy-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Privacy</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
        <Text style={[styles.section, { marginTop: 8 }]}>Account privacy</Text>
        <View style={styles.card}>
          <TouchableOpacity style={styles.optRow} onPress={togglePrivate} testID="privacy-private">
            <Ionicons name="lock-closed-outline" size={18} color={theme.textMuted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.optLabel}>Private account</Text>
              <Text style={styles.optSub}>Only your followers can see the posts on your profile.</Text>
            </View>
            <View style={[styles.switch, isPrivate && styles.switchOn]}>
              <View style={[styles.knob, isPrivate && styles.knobOn]} />
            </View>
          </TouchableOpacity>
        </View>

        <Text style={styles.section}>Feed filters</Text>
        <View style={styles.card}>
          <TouchableOpacity style={styles.optRow} onPress={() => router.push("/muted-words")} testID="privacy-muted-words">
            <Ionicons name="filter-outline" size={18} color={theme.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.optLabel}>Feed controls</Text>
              <Text style={styles.optSub}>Mute words/topics to hide them, or prioritize topics to see more of them.</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
          </TouchableOpacity>
        </View>

        <Text style={styles.section}>Who can message you</Text>
        <View style={styles.card}>
          {MSG_POLICIES.map((p, i) => {
            const on = msgPolicy === p.k;
            return (
              <TouchableOpacity
                key={p.k}
                style={[styles.optRow, i < MSG_POLICIES.length - 1 && styles.optDivider]}
                onPress={() => pickMsgPolicy(p.k)}
                testID={`privacy-msg-${p.k}`}
              >
                <Ionicons name={p.icon as any} size={18} color={on ? theme.primary : theme.textMuted} />
                <Text style={[styles.optLabel, on && { color: theme.primary }]}>{p.label}</Text>
                <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={20} color={on ? theme.primary : theme.textMuted} />
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.section}>Discoverability</Text>
        <View style={styles.card}>
          <TouchableOpacity style={styles.optRow} onPress={toggleSearchable} testID="privacy-searchable">
            <Ionicons name="search-outline" size={18} color={theme.textMuted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.optLabel}>Appear in search</Text>
              <Text style={styles.optSub}>Let other people find your account when they search.</Text>
            </View>
            <View style={[styles.switch, searchable && styles.switchOn]}>
              <View style={[styles.knob, searchable && styles.knobOn]} />
            </View>
          </TouchableOpacity>
        </View>

        <Text style={styles.section}>Activity status</Text>
        <View style={styles.card}>
          <TouchableOpacity style={styles.optRow} onPress={toggleHideOnline} testID="privacy-hide-online">
            <Ionicons name="ellipse-outline" size={18} color={theme.textMuted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.optLabel}>Hide my online status</Text>
              <Text style={styles.optSub}>Others won't see when you're active or your last-seen time.</Text>
            </View>
            <View style={[styles.switch, hideOnline && styles.switchOn]}>
              <View style={[styles.knob, hideOnline && styles.knobOn]} />
            </View>
          </TouchableOpacity>
        </View>

        <Text style={styles.section}>Who can see your followers & following</Text>
        <View style={styles.card}>
          {MSG_POLICIES.map((p, i) => {
            const on = connVis === p.k;
            return (
              <TouchableOpacity
                key={p.k}
                style={[styles.optRow, i < MSG_POLICIES.length - 1 && styles.optDivider]}
                onPress={() => pickConnVis(p.k)}
                testID={`privacy-conn-${p.k}`}
              >
                <Ionicons name={p.icon as any} size={18} color={on ? theme.primary : theme.textMuted} />
                <Text style={[styles.optLabel, on && { color: theme.primary }]}>{p.label}</Text>
                <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={20} color={on ? theme.primary : theme.textMuted} />
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.section}>Who can tag you in a post</Text>
        <View style={styles.card}>
          {MSG_POLICIES.map((p, i) => {
            const on = tagPolicy === p.k;
            return (
              <TouchableOpacity
                key={p.k}
                style={[styles.optRow, i < MSG_POLICIES.length - 1 && styles.optDivider]}
                onPress={() => pickTagPolicy(p.k)}
                testID={`privacy-tag-${p.k}`}
              >
                <Ionicons name={p.icon as any} size={18} color={on ? theme.primary : theme.textMuted} />
                <Text style={[styles.optLabel, on && { color: theme.primary }]}>{p.label}</Text>
                <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={20} color={on ? theme.primary : theme.textMuted} />
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.section}>Likes activity</Text>
        <View style={styles.card}>
          <TouchableOpacity style={styles.optRow} onPress={toggleHideLikes} testID="privacy-hide-likes">
            <Ionicons name="heart-dislike-outline" size={18} color={theme.textMuted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.optLabel}>Hide my likes</Text>
              <Text style={styles.optSub}>Stop others from seeing the list of posts you've liked.</Text>
            </View>
            <View style={[styles.switch, hideLikes && styles.switchOn]}>
              <View style={[styles.knob, hideLikes && styles.knobOn]} />
            </View>
          </TouchableOpacity>
        </View>

        <View style={styles.sectionHead}>
          <Text style={styles.section}>Who can comment on your posts</Text>
          {savingPolicy && <ActivityIndicator color={theme.primary} size="small" />}
        </View>
        <Text style={styles.note}>This is the default for new posts. You can still change it per post when you write one.</Text>
        <View style={styles.card}>
          {POLICIES.map((p, i) => {
            const on = policy === p.k;
            return (
              <TouchableOpacity
                key={p.k}
                style={[styles.optRow, i < POLICIES.length - 1 && styles.optDivider]}
                onPress={() => savePolicy(p.k)}
                testID={`privacy-comment-${p.k}`}
              >
                <Ionicons name={p.icon as any} size={18} color={on ? theme.primary : theme.textMuted} />
                <Text style={[styles.optLabel, on && { color: theme.primary }]}>{p.label}</Text>
                <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={20} color={on ? theme.primary : theme.textMuted} />
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.section}>Likes</Text>
        <View style={styles.card}>
          <TouchableOpacity style={styles.optRow} onPress={toggleLikes} testID="privacy-likes">
            <Ionicons name="heart-outline" size={18} color={theme.textMuted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.optLabel}>Turn off likes on new posts</Text>
              <Text style={styles.optSub}>Hides the like button on posts you create.</Text>
            </View>
            {savingLikes ? <ActivityIndicator color={theme.primary} size="small" /> : (
              <View style={[styles.switch, likesOff && styles.switchOn]}>
                <View style={[styles.knob, likesOff && styles.knobOn]} />
              </View>
            )}
          </TouchableOpacity>
        </View>

        <Text style={styles.section}>Stories</Text>
        <View style={styles.card}>
          <TouchableOpacity style={styles.optRow} onPress={toggleStories} testID="privacy-stories">
            <Ionicons name="albums-outline" size={18} color={theme.textMuted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.optLabel}>Show stories in feed</Text>
              <Text style={styles.optSub}>Hide the stories row at the top of your feed entirely.</Text>
            </View>
            <View style={[styles.switch, showStories && styles.switchOn]}>
              <View style={[styles.knob, showStories && styles.knobOn]} />
            </View>
          </TouchableOpacity>
        </View>

        <Text style={styles.section}>Messages</Text>
        <View style={styles.card}>
          <TouchableOpacity style={styles.optRow} onPress={() => router.push("/encryption-key")} testID="privacy-encryption">
            <Ionicons name="key-outline" size={18} color={theme.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.optLabel}>Encryption key backup</Text>
              <Text style={styles.optSub}>Back up your end-to-end key to restore chats on a new device.</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
          </TouchableOpacity>
        </View>

        <Text style={styles.footer}>You can always see who viewed your own posts by tapping the view count.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  backBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
  section: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 22, marginBottom: 10 },
  note: { color: theme.textSecondary, fontSize: 12.5, lineHeight: 18, marginBottom: 10, marginTop: -4 },
  card: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, overflow: "hidden" },
  optRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 16 },
  optDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  optLabel: { flex: 1, color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  optSub: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  switch: { width: 46, height: 28, borderRadius: 14, backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, padding: 2, justifyContent: "center" },
  switchOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: "#fff" },
  knobOn: { alignSelf: "flex-end" },
  segRow: { flexDirection: "row", gap: 4, backgroundColor: theme.surfaceAlt, borderRadius: 10, padding: 3, borderWidth: 1, borderColor: theme.border },
  seg: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 8 },
  segOn: { backgroundColor: theme.primary },
  segText: { color: theme.textSecondary, fontSize: 13, fontWeight: "700" },
  footer: { color: theme.textMuted, fontSize: 12, lineHeight: 18, marginTop: 18, textAlign: "center" },
});
