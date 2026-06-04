import React, { useEffect, useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView,
  ActivityIndicator, Image, Modal, KeyboardAvoidingView, Platform, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { api, Post, PostMedia } from "@/src/api/client";
import { theme } from "@/src/theme";

type Props = {
  visible: boolean;
  onClose: () => void;
  onPosted: (post: Post) => void;
  /** If set, opens in reply mode and submits with `parent_id`. */
  replyTo?: Post | null;
  /** If set, opens in edit mode and submits PATCH. */
  editing?: Post | null;
  /** If set, opens in quote mode and submits with `quote_of`. */
  quoting?: Post | null;
  /** If set, posts into this group. */
  groupId?: string | null;
};

const MAX_MEDIA = 4;
const TEXT_MAX = 500;
const POLL_DURATIONS: { label: string; hours: number }[] = [
  { label: "1 hour", hours: 1 },
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 24 * 3 },
  { label: "7 days", hours: 24 * 7 },
];

export default function PostComposer({
  visible, onClose, onPosted, replyTo, editing, quoting, groupId,
}: Props) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [media, setMedia] = useState<PostMedia[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [showPoll, setShowPoll] = useState(false);
  const [pollOptions, setPollOptions] = useState<string[]>(["", ""]);
  const [pollHours, setPollHours] = useState(24);

  useEffect(() => {
    if (visible) {
      if (editing) {
        setText(editing.text || "");
        setMedia(editing.media || []);
      } else {
        setText(""); setMedia([]);
      }
      setShowPoll(false);
      setPollOptions(["", ""]);
      setPollHours(24);
    }
  }, [visible, editing]);

  const pickMedia = async () => {
    if (media.length >= MAX_MEDIA) {
      Alert.alert("Limit reached", `You can attach up to ${MAX_MEDIA} files.`);
      return;
    }
    try {
      // Web doesn't gate behind permission popup.
      if (Platform.OS !== "web") {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          if (!perm.canAskAgain) {
            Alert.alert(
              "Photos access needed",
              "Enable photo library access in Settings to attach media.",
            );
          }
          return;
        }
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"] as any,
        allowsMultipleSelection: true,
        selectionLimit: MAX_MEDIA - media.length,
        quality: 0.7,
        base64: true,
        videoMaxDuration: 60,
      });
      if (result.canceled) return;
      const toAdd: PostMedia[] = [];
      for (const a of result.assets || []) {
        const isVideo = a.type === "video";
        let uri = a.uri;
        // Convert to data-URI base64 so it embeds in JSON cleanly
        if (a.base64 && !isVideo) {
          uri = `data:image/jpeg;base64,${a.base64}`;
        }
        toAdd.push({
          type: isVideo ? "video" : "image",
          base64: uri,
          width: a.width || null,
          height: a.height || null,
        });
      }
      setMedia((arr) => [...arr, ...toAdd].slice(0, MAX_MEDIA));
    } catch (e) {
      Alert.alert("Couldn't attach media", String(e));
    }
  };

  const takePhoto = async () => {
    if (media.length >= MAX_MEDIA) return;
    if (Platform.OS === "web") {
      Alert.alert("Camera unavailable", "Use the photo library instead.");
      return;
    }
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const r = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"] as any,
      quality: 0.7,
      base64: true,
    });
    if (r.canceled) return;
    const a = r.assets?.[0];
    if (a?.base64) {
      setMedia((arr) =>
        [...arr, { type: "image", base64: `data:image/jpeg;base64,${a.base64}` }].slice(0, MAX_MEDIA),
      );
    }
  };

  const submit = async () => {
    const t = text.trim();
    const validPoll = showPoll && pollOptions.filter((o) => o.trim()).length >= 2;
    if (!t && media.length === 0 && !quoting && !validPoll) return;
    setSubmitting(true);
    try {
      let p: Post;
      if (editing) {
        p = await api.editPost(editing.id, { text: t, media });
      } else if (groupId) {
        p = await api.createGroupPost(groupId, {
          text: t || undefined,
          parent_id: replyTo?.id,
          quote_of: quoting?.id,
          media: media.length ? media : undefined,
          poll: validPoll ? {
            options: pollOptions.map((o) => o.trim()).filter(Boolean),
            duration_hours: pollHours,
          } : undefined,
        });
      } else {
        p = await api.createPost({
          text: t || undefined,
          parent_id: replyTo?.id,
          quote_of: quoting?.id,
          media: media.length ? media : undefined,
          poll: validPoll ? {
            options: pollOptions.map((o) => o.trim()).filter(Boolean),
            duration_hours: pollHours,
          } : undefined,
        });
      }
      onPosted(p);
      onClose();
    } catch (e: any) {
      Alert.alert("Couldn't post", String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  const remaining = TEXT_MAX - text.length;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.backdrop}
      >
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16, paddingTop: insets.top + 12 }]}>
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} testID="composer-close">
              <Ionicons name="close" size={26} color={theme.textPrimary} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>
              {editing ? "Edit post" : quoting ? "Quote post" : replyTo ? "Reply" : "New post"}
            </Text>
            <TouchableOpacity
              onPress={submit}
              disabled={submitting || (!text.trim() && media.length === 0 && !quoting && !(showPoll && pollOptions.filter((o) => o.trim()).length >= 2))}
              style={[
                styles.postBtn,
                (submitting || (!text.trim() && media.length === 0 && !quoting && !(showPoll && pollOptions.filter((o) => o.trim()).length >= 2))) && { opacity: 0.4 },
              ]}
              testID="composer-submit"
            >
              {submitting
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.postBtnText}>{editing ? "Save" : quoting ? "Quote" : replyTo ? "Reply" : "Post"}</Text>}
            </TouchableOpacity>
          </View>

          {!!replyTo && (
            <View style={styles.replyTo}>
              <Text style={styles.replyToLabel}>Replying to <Text style={{ color: theme.primary }}>@{replyTo.author.name}</Text></Text>
              {!!replyTo.text && <Text style={styles.replyToText} numberOfLines={2}>{replyTo.text}</Text>}
            </View>
          )}

          {!!quoting && (
            <View style={styles.replyTo}>
              <Text style={styles.replyToLabel}>Quoting <Text style={{ color: theme.primary }}>@{quoting.author.name}</Text></Text>
              {!!quoting.text && <Text style={styles.replyToText} numberOfLines={3}>{quoting.text}</Text>}
            </View>
          )}

          <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={(s) => setText(s.slice(0, TEXT_MAX))}
              placeholder={replyTo ? "Post your reply" : "What's happening?"}
              placeholderTextColor={theme.textMuted}
              multiline
              autoFocus
              testID="composer-text"
            />

            {media.length > 0 && (
              <View style={styles.mediaRow}>
                {media.map((m, idx) => (
                  <View key={idx} style={styles.mediaChip}>
                    <Image
                      source={{ uri: m.base64 }}
                      style={StyleSheet.absoluteFill}
                      resizeMode="cover"
                    />
                    {m.type === "video" && (
                      <View style={styles.videoBadge}>
                        <Ionicons name="videocam" size={14} color="#fff" />
                      </View>
                    )}
                    <TouchableOpacity
                      style={styles.removeBtn}
                      onPress={() => setMedia((a) => a.filter((_, i) => i !== idx))}
                    >
                      <Ionicons name="close" size={14} color="#fff" />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            {showPoll && (
              <View style={styles.pollBuilder}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={styles.pollTitle}>Poll</Text>
                  <TouchableOpacity onPress={() => setShowPoll(false)}>
                    <Ionicons name="close-circle" size={18} color={theme.textMuted} />
                  </TouchableOpacity>
                </View>
                {pollOptions.map((opt, idx) => (
                  <View key={idx} style={styles.pollOptRow}>
                    <TextInput
                      placeholder={`Choice ${idx + 1}`}
                      placeholderTextColor={theme.textMuted}
                      value={opt}
                      onChangeText={(v) =>
                        setPollOptions((arr) => arr.map((o, i) => i === idx ? v.slice(0, 60) : o))
                      }
                      style={styles.pollOptInput}
                      maxLength={60}
                    />
                    {pollOptions.length > 2 && (
                      <TouchableOpacity
                        onPress={() => setPollOptions((arr) => arr.filter((_, i) => i !== idx))}
                      >
                        <Ionicons name="remove-circle-outline" size={20} color={theme.textMuted} />
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
                {pollOptions.length < 4 && (
                  <TouchableOpacity
                    style={styles.pollAddBtn}
                    onPress={() => setPollOptions((arr) => [...arr, ""])}
                  >
                    <Ionicons name="add" size={16} color={theme.primary} />
                    <Text style={styles.pollAddText}>Add choice</Text>
                  </TouchableOpacity>
                )}
                <View style={styles.pollDurationRow}>
                  <Text style={styles.pollLabel}>Duration:</Text>
                  {POLL_DURATIONS.map((d) => (
                    <TouchableOpacity
                      key={d.hours}
                      onPress={() => setPollHours(d.hours)}
                      style={[styles.durationChip, pollHours === d.hours && styles.durationChipActive]}
                    >
                      <Text style={[styles.durationChipText, pollHours === d.hours && { color: "#fff" }]}>
                        {d.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
          </ScrollView>

          <View style={styles.toolbar}>
            <View style={{ flexDirection: "row", gap: 6 }}>
              <TouchableOpacity
                onPress={pickMedia}
                disabled={media.length >= MAX_MEDIA}
                style={[styles.toolBtn, media.length >= MAX_MEDIA && { opacity: 0.3 }]}
                testID="composer-attach"
              >
                <Ionicons name="image-outline" size={22} color={theme.primary} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={takePhoto}
                disabled={media.length >= MAX_MEDIA}
                style={[styles.toolBtn, media.length >= MAX_MEDIA && { opacity: 0.3 }]}
                testID="composer-camera"
              >
                <Ionicons name="camera-outline" size={22} color={theme.primary} />
              </TouchableOpacity>
              {!editing && !replyTo && !quoting && (
                <TouchableOpacity
                  onPress={() => setShowPoll((v) => !v)}
                  style={[styles.toolBtn, showPoll && { backgroundColor: theme.primary, borderColor: theme.primary }]}
                  testID="composer-poll"
                >
                  <Ionicons name="bar-chart" size={22} color={showPoll ? "#fff" : theme.primary} />
                </TouchableOpacity>
              )}
            </View>
            <Text style={[styles.counter, remaining < 20 && { color: "#F59E0B" }, remaining < 0 && { color: "#EF4444" }]}>
              {remaining}
            </Text>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: {
    flex: 1, backgroundColor: theme.bg, paddingHorizontal: 16,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
  },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
  },
  headerTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  postBtn: {
    backgroundColor: theme.primary, paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: 999,
  },
  postBtnText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  replyTo: {
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
  },
  replyToLabel: { color: theme.textMuted, fontSize: 12 },
  replyToText: { color: theme.textSecondary, fontSize: 13, marginTop: 4 },
  input: {
    color: theme.textPrimary, fontSize: 17, lineHeight: 23,
    minHeight: 120, paddingTop: 12, paddingBottom: 4,
    textAlignVertical: "top",
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  mediaRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8, paddingBottom: 12 },
  mediaChip: {
    width: 88, height: 88, borderRadius: 12, overflow: "hidden",
    backgroundColor: theme.surface, position: "relative",
  },
  removeBtn: {
    position: "absolute", top: 4, right: 4,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center", justifyContent: "center",
  },
  videoBadge: {
    position: "absolute", bottom: 4, left: 4,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
    backgroundColor: "rgba(0,0,0,0.6)",
    flexDirection: "row", alignItems: "center", gap: 4,
  },
  toolbar: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
  },
  toolBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: "center", justifyContent: "center",
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
  },
  counter: { color: theme.textMuted, fontSize: 13, fontWeight: "700" },
  pollBuilder: {
    marginTop: 10, padding: 12, borderRadius: 14,
    borderWidth: 1, borderColor: theme.border,
    backgroundColor: theme.surfaceAlt, gap: 8,
  },
  pollTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "800" },
  pollOptRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  pollOptInput: {
    flex: 1, color: theme.textPrimary, fontSize: 14,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  pollAddBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    alignSelf: "flex-start", paddingVertical: 4, paddingHorizontal: 8,
  },
  pollAddText: { color: theme.primary, fontSize: 13, fontWeight: "700" },
  pollDurationRow: {
    flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 4,
  },
  pollLabel: { color: theme.textMuted, fontSize: 12, fontWeight: "700", marginRight: 4 },
  durationChip: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999,
    borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface,
  },
  durationChipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  durationChipText: { color: theme.textSecondary, fontSize: 11, fontWeight: "700" },
});
