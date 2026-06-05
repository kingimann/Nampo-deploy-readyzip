import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, Modal, FlatList, TextInput, TouchableOpacity,
  ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api, Post } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import RichText from "./RichText";
import { fmtTime } from "./PostCard";

type Props = {
  visible: boolean;
  post: Post | null;
  onClose: () => void;
  /** Called after a comment is posted so the caller can bump reply counts. */
  onCommented?: (postId: string, newReply: Post) => void;
};

/** Instagram-style comments bottom sheet for a feed post. */
export default function CommentsSheet({ visible, post, onClose, onCommented }: Props) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const [replies, setReplies] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);

  const load = useCallback(async () => {
    if (!post) return;
    setLoading(true);
    try {
      const r = await api.listReplies(post.id);
      setReplies(r);
    } catch {} finally { setLoading(false); }
  }, [post]);

  useEffect(() => {
    if (visible && post) { setText(""); setEditingId(null); load(); }
  }, [visible, post, load]);

  const send = async () => {
    const body = text.trim();
    if (!body || !post || sending) return;
    setSending(true);
    try {
      if (editingId) {
        const updated = await api.editPost(editingId, { text: body });
        setReplies((arr) => arr.map((r) => (r.id === editingId ? updated : r)));
        setEditingId(null);
      } else {
        const reply = await api.createPost({ text: body, parent_id: post.id });
        setReplies((arr) => [...arr, reply]);
        onCommented?.(post.id, reply);
      }
      setText("");
    } catch {} finally { setSending(false); }
  };

  const beginEdit = (c: Post) => { setEditingId(c.id); setText(c.text || ""); inputRef.current?.focus(); };
  const cancelEdit = () => { setEditingId(null); setText(""); };
  const removeComment = async (c: Post) => {
    setReplies((arr) => arr.filter((r) => r.id !== c.id));
    try { await api.deletePost(c.id); } catch {}
  };

  const openProfile = (name?: string) => {
    if (!name) return;
    onClose();
    router.push({ pathname: "/user/[name]", params: { name } });
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} testID="comments-backdrop" />
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.sheetWrap}
        >
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 8 }]} testID="comments-sheet">
            <View style={styles.handle} />
            <Text style={styles.title}>Comments</Text>

            {loading ? (
              <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
            ) : (
              <FlatList
                data={replies}
                keyExtractor={(i) => i.id}
                contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12, gap: 16 }}
                keyboardShouldPersistTaps="handled"
                style={{ flexGrow: 0, maxHeight: 380 }}
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Ionicons name="chatbubble-ellipses-outline" size={28} color={theme.textMuted} />
                    <Text style={styles.emptyText}>No comments yet. Start the conversation.</Text>
                  </View>
                }
                renderItem={({ item }) => (
                  <View style={styles.row}>
                    <TouchableOpacity onPress={() => openProfile(item.author.name)}>
                      <View style={styles.avatar}>
                        {item.author.picture ? (
                          <Image source={{ uri: item.author.picture }} style={styles.avatarImg} />
                        ) : (
                          <Text style={styles.avatarInit}>{(item.author.name?.[0] || "?").toUpperCase()}</Text>
                        )}
                      </View>
                    </TouchableOpacity>
                    <View style={{ flex: 1 }}>
                      <View style={styles.rowHead}>
                        <Text style={styles.rowName} numberOfLines={1}>{item.author.name}</Text>
                        <Text style={styles.rowTime}>{fmtTime(item.created_at)}</Text>
                        {!!item.edited_at && <Text style={styles.rowTime}>· edited</Text>}
                      </View>
                      {!!item.text && <RichText text={item.text} style={styles.rowText} />}
                      {item.user_id === user?.user_id && (
                        <View style={styles.rowActions}>
                          <TouchableOpacity onPress={() => beginEdit(item)} testID={`comment-edit-${item.id}`}>
                            <Text style={styles.rowAction}>Edit</Text>
                          </TouchableOpacity>
                          <TouchableOpacity onPress={() => removeComment(item)} testID={`comment-delete-${item.id}`}>
                            <Text style={[styles.rowAction, { color: theme.error }]}>Delete</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                    </View>
                  </View>
                )}
              />
            )}

            {editingId && (
              <View style={styles.editHint}>
                <Ionicons name="create-outline" size={14} color={theme.primary} />
                <Text style={[styles.editHintText, { flex: 1 }]}>Editing comment</Text>
                <TouchableOpacity onPress={cancelEdit} testID="comment-cancel-edit">
                  <Text style={[styles.editHintText, { color: theme.textMuted }]}>Cancel</Text>
                </TouchableOpacity>
              </View>
            )}
            <View style={styles.inputRow}>
              <View style={styles.inputAvatar}>
                {user?.picture ? (
                  <Image source={{ uri: user.picture }} style={styles.avatarImg} />
                ) : (
                  <Text style={styles.avatarInit}>{(user?.name?.[0] || "?").toUpperCase()}</Text>
                )}
              </View>
              <TextInput
                ref={inputRef}
                style={styles.input}
                placeholder={editingId ? "Edit your comment…" : "Add a comment…"}
                placeholderTextColor={theme.textMuted}
                value={text}
                onChangeText={setText}
                multiline
                testID="comment-input"
              />
              <TouchableOpacity
                onPress={send}
                disabled={!text.trim() || sending}
                style={[styles.sendBtn, (!text.trim() || sending) && { opacity: 0.4 }]}
                testID="comment-send"
              >
                {sending ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name={editingId ? "checkmark" : "arrow-up"} size={18} color="#fff" />}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheetWrap: { width: "100%" },
  sheet: {
    backgroundColor: theme.bg,
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderColor: theme.border,
    paddingTop: 10,
  },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 10 },
  title: { color: theme.textPrimary, fontSize: 16, fontWeight: "800", textAlign: "center", marginBottom: 12 },
  center: { paddingVertical: 40, alignItems: "center" },
  empty: { alignItems: "center", paddingVertical: 40, gap: 10 },
  emptyText: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingHorizontal: 40 },

  row: { flexDirection: "row", gap: 10 },
  avatar: {
    width: 34, height: 34, borderRadius: 17, overflow: "hidden",
    backgroundColor: theme.primary, alignItems: "center", justifyContent: "center",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontSize: 13, fontWeight: "700" },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 2 },
  rowName: { color: theme.textPrimary, fontSize: 13, fontWeight: "800", flexShrink: 1 },
  rowTime: { color: theme.textMuted, fontSize: 11 },
  rowText: { color: theme.textPrimary, fontSize: 14, lineHeight: 19 },
  rowActions: { flexDirection: "row", gap: 16, marginTop: 5 },
  rowAction: { color: theme.textMuted, fontSize: 12, fontWeight: "700" },

  editHint: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 16, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 7,
    backgroundColor: theme.surface, borderRadius: 10, borderWidth: 1, borderColor: theme.border,
  },
  editHintText: { color: theme.textSecondary, fontSize: 12, fontWeight: "600" },

  inputRow: {
    flexDirection: "row", alignItems: "flex-end", gap: 10,
    paddingHorizontal: 16, paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border,
  },
  inputAvatar: {
    width: 32, height: 32, borderRadius: 16, overflow: "hidden",
    backgroundColor: theme.primary, alignItems: "center", justifyContent: "center",
  },
  input: {
    flex: 1, color: theme.textPrimary, fontSize: 14,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9, maxHeight: 100,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  sendBtn: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
  },
});
