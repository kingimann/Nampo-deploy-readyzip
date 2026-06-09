import React, { useEffect, useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, Pressable, ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { api, Post } from "@/src/api/client";
import { theme } from "@/src/theme";

const POLICIES = [
  { k: "everyone", label: "Everyone", icon: "earth-outline" },
  { k: "followers", label: "Followers", icon: "person-add-outline" },
  { k: "friends", label: "Friends", icon: "people-outline" },
  { k: "nobody", label: "No one", icon: "lock-closed-outline" },
] as const;

/** Per-post privacy editor: turn likes on/off and choose who can comment, for
 *  one individual post. Calls onUpdated with the refreshed post. */
export default function PostPrivacySheet({
  post, visible, onClose, onUpdated,
}: {
  post: Post | null;
  visible: boolean;
  onClose: () => void;
  onUpdated: (p: Post) => void;
}) {
  const insets = useSafeAreaInsets();
  const [likesOff, setLikesOff] = useState(false);
  const [policy, setPolicy] = useState<string>("everyone");
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (visible && post) {
      setLikesOff(!!post.likes_disabled);
      setPolicy(post.comment_policy || "everyone");
    }
  }, [visible, post]);

  if (!post) return null;

  const save = async (patch: { likes_disabled?: boolean; comment_policy?: string }, tag: string) => {
    setSaving(tag);
    try {
      const updated = await api.editPostPrivacy(post.id, patch);
      onUpdated(updated);
    } catch {} finally { setSaving(null); }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 18 }]}>
          <View style={styles.handle} />
          <Text style={styles.title}>Post privacy</Text>
          <Text style={styles.sub}>Applies to this post only.</Text>

          <View style={styles.row}>
            <View style={styles.rowLabelWrap}>
              <Ionicons name="heart-outline" size={17} color={theme.textSecondary} />
              <Text style={styles.rowLabel}>Likes</Text>
            </View>
            <TouchableOpacity
              style={[styles.toggle, !likesOff && styles.toggleOn]}
              onPress={() => { const v = !likesOff; setLikesOff(v); save({ likes_disabled: v }, "likes"); }}
              testID="postpriv-likes"
            >
              {saving === "likes" ? <ActivityIndicator size="small" color={!likesOff ? "#fff" : theme.textSecondary} />
                : <Text style={[styles.toggleText, !likesOff && { color: "#fff" }]}>{likesOff ? "Off" : "On"}</Text>}
            </TouchableOpacity>
          </View>

          <Text style={styles.section}>Who can comment</Text>
          {POLICIES.map((p) => {
            const on = policy === p.k;
            return (
              <TouchableOpacity
                key={p.k}
                style={styles.optRow}
                onPress={() => { setPolicy(p.k); save({ comment_policy: p.k }, `c-${p.k}`); }}
                testID={`postpriv-${p.k}`}
              >
                <Ionicons name={p.icon as any} size={18} color={on ? theme.primary : theme.textMuted} />
                <Text style={[styles.optLabel, on && { color: theme.primary }]}>{p.label}</Text>
                {saving === `c-${p.k}` ? <ActivityIndicator size="small" color={theme.primary} />
                  : <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={20} color={on ? theme.primary : theme.textMuted} />}
              </TouchableOpacity>
            );
          })}

          <TouchableOpacity style={styles.doneBtn} onPress={onClose} testID="postpriv-done">
            <Text style={styles.doneText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#0E0E10", borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 10, paddingHorizontal: 18, borderTopWidth: 1, borderColor: theme.border },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 14 },
  title: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  sub: { color: theme.textMuted, fontSize: 12.5, marginTop: 2, marginBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  rowLabelWrap: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowLabel: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  toggle: { minWidth: 56, paddingHorizontal: 14, height: 32, borderRadius: 999, alignItems: "center", justifyContent: "center", backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  toggleOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  toggleText: { color: theme.textSecondary, fontSize: 13, fontWeight: "800" },
  section: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 16, marginBottom: 4 },
  optRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  optLabel: { flex: 1, color: theme.textPrimary, fontSize: 15, fontWeight: "600" },
  doneBtn: { marginTop: 16, height: 50, borderRadius: 14, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  doneText: { color: "#fff", fontSize: 15, fontWeight: "800" },
});
