import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import VerifiedBadge from "./VerifiedBadge";
import UserBadges from "./UserBadges";
import InlineMedia from "./InlineMedia";
import GifPickerSheet from "./GifPickerSheet";
import { getInlineImage } from "@/src/utils/embeds";

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
  const [replyTo, setReplyTo] = useState<Post | null>(null);
  const [gifOpen, setGifOpen] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const load = useCallback(async () => {
    if (!post) return;
    setLoading(true);
    try {
      // Whole thread (replies + replies-to-replies); we nest it client-side.
      const r = await api.postThread(post.id);
      setReplies(r);
    } catch {} finally { setLoading(false); }
  }, [post]);

  useEffect(() => {
    if (visible && post) { setText(""); setEditingId(null); setReplyTo(null); load(); }
  }, [visible, post, load]);

  // Flatten the thread into render rows: each top-level comment (depth 0)
  // followed by its descendants (depth 1), each tagged with who it replies to.
  const rows = useMemo(() => {
    if (!post) return [] as { c: Post; depth: number; replyToName?: string }[];
    const byId = new Map(replies.map((r) => [r.id, r]));
    const kids = new Map<string, Post[]>();
    for (const r of replies) {
      const pid = r.parent_id || "";
      (kids.get(pid) || kids.set(pid, []).get(pid)!).push(r);
    }
    const sortKids = (list: Post[]) =>
      [...list].sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || (a.created_at < b.created_at ? -1 : 1));
    const out: { c: Post; depth: number; replyToName?: string }[] = [];
    const visit = (node: Post) => {
      out.push({ c: node, depth: 1, replyToName: byId.get(node.parent_id || "")?.author?.name });
      for (const ch of sortKids(kids.get(node.id) || [])) visit(ch);
    };
    for (const t of sortKids(kids.get(post.id) || [])) {
      out.push({ c: t, depth: 0 });
      for (const ch of sortKids(kids.get(t.id) || [])) visit(ch);
    }
    return out;
  }, [replies, post]);

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
        const parentId = replyTo ? replyTo.id : post.id;
        const reply = await api.createPost({ text: body, parent_id: parentId });
        setReplies((arr) => [...arr, reply]);
        if (!replyTo) onCommented?.(post.id, reply);  // only top-level bumps the post's count
        setReplyTo(null);
      }
      setText("");
    } catch {} finally { setSending(false); }
  };

  const beginEdit = (c: Post) => { setEditingId(c.id); setReplyTo(null); setText(c.text || ""); inputRef.current?.focus(); };
  const cancelEdit = () => { setEditingId(null); setText(""); };
  const beginReply = (c: Post) => {
    setReplyTo(c); setEditingId(null);
    setText(c.author.username ? `@${c.author.username} ` : "");
    inputRef.current?.focus();
  };
  // Post a GIF as a comment — its URL renders inline (getInlineImage).
  const sendGif = async (url: string) => {
    setGifOpen(false);
    if (!post || !url) return;
    try {
      const parentId = replyTo ? replyTo.id : post.id;
      const reply = await api.createPost({ text: url, parent_id: parentId });
      setReplies((arr) => [...arr, reply]);
      if (!replyTo) onCommented?.(post.id, reply);
      setReplyTo(null);
    } catch {}
  };
  const removeComment = async (c: Post) => {
    setReplies((arr) => arr.filter((r) => r.id !== c.id));
    try { await api.deletePost(c.id); } catch {}
  };

  const applyEngagement = (u: Post) => setReplies((arr) => arr.map((r) =>
    r.id === u.id
      ? { ...r, liked_by_me: u.liked_by_me, likes_count: u.likes_count, disliked_by_me: u.disliked_by_me, dislikes_count: u.dislikes_count }
      : r,
  ));
  const reactLike = (c: Post) => {
    setReplies((arr) => arr.map((r) => {
      if (r.id !== c.id) return r;
      const nowLiked = !r.liked_by_me;
      return {
        ...r,
        liked_by_me: nowLiked,
        likes_count: r.likes_count + (nowLiked ? 1 : -1),
        disliked_by_me: nowLiked ? false : r.disliked_by_me,
        dislikes_count: (r.dislikes_count || 0) - (nowLiked && r.disliked_by_me ? 1 : 0),
      };
    }));
    api.toggleLike(c.id).then(applyEngagement).catch(() => {});
  };
  const reactDislike = (c: Post) => {
    setReplies((arr) => arr.map((r) => {
      if (r.id !== c.id) return r;
      const nowDis = !r.disliked_by_me;
      return {
        ...r,
        disliked_by_me: nowDis,
        dislikes_count: (r.dislikes_count || 0) + (nowDis ? 1 : -1),
        liked_by_me: nowDis ? false : r.liked_by_me,
        likes_count: r.likes_count - (nowDis && r.liked_by_me ? 1 : 0),
      };
    }));
    api.toggleDislike(c.id).then(applyEngagement).catch(() => {});
  };
  // The owner of the post can pin a comment to the top of the thread.
  const pinComment = (c: Post) => {
    setReplies((arr) => arr.map((r) => (r.id === c.id ? { ...r, pinned: !r.pinned } : r)));
    api.pinPost(c.id)
      .then((u) => setReplies((arr) => {
        const next = arr.map((r) => (r.id === u.id ? { ...r, pinned: u.pinned } : r));
        return [...next].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
      }))
      .catch(() => {});
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
                data={rows}
                keyExtractor={(i) => i.c.id}
                contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12, gap: 16 }}
                keyboardShouldPersistTaps="handled"
                style={{ flexGrow: 0, maxHeight: 380 }}
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Ionicons name="chatbubble-ellipses-outline" size={28} color={theme.textMuted} />
                    <Text style={styles.emptyText}>No comments yet. Start the conversation.</Text>
                  </View>
                }
                renderItem={({ item: row }) => {
                  const item = row.c;
                  return (
                  <View style={[styles.row, row.depth > 0 && styles.rowNested]}>
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
                        {item.author.verified && <VerifiedBadge size={12} />}
                        <UserBadges badges={item.author.badges} size={12} />
                        {item.pinned && (
                          <View style={styles.pinnedBadge}>
                            <Ionicons name="pin" size={10} color={theme.primary} />
                            <Text style={styles.pinnedBadgeText}>Pinned</Text>
                          </View>
                        )}
                        <Text style={styles.rowTime}>{fmtTime(item.created_at)}</Text>
                        {!!item.edited_at && <Text style={styles.rowTime}>· edited</Text>}
                      </View>
                      {!!row.replyToName && (
                        <Text style={styles.replyingTo}>Replying to <Text style={{ color: theme.primary }}>@{row.replyToName}</Text></Text>
                      )}
                      {!!item.text && <RichText text={item.text} style={styles.rowText} />}
                      {(() => { const im = getInlineImage(item.text); return im ? <InlineMedia uri={im} compact /> : null; })()}
                      <View style={styles.reactRow}>
                        <TouchableOpacity onPress={() => reactLike(item)} style={styles.reactBtn} testID={`comment-like-${item.id}`}>
                          <Ionicons name={item.liked_by_me ? "heart" : "heart-outline"} size={14} color={item.liked_by_me ? "#EF4444" : theme.textMuted} />
                          {!!item.likes_count && item.likes_count > 0 && <Text style={styles.reactText}>{item.likes_count}</Text>}
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => reactDislike(item)} style={styles.reactBtn} testID={`comment-dislike-${item.id}`}>
                          <Ionicons name={item.disliked_by_me ? "thumbs-down" : "thumbs-down-outline"} size={13} color={item.disliked_by_me ? "#8696A0" : theme.textMuted} />
                        </TouchableOpacity>
                        {post?.user_id === user?.user_id && (
                          <TouchableOpacity onPress={() => pinComment(item)} style={styles.reactBtn} testID={`comment-pin-${item.id}`}>
                            <Ionicons name={item.pinned ? "pin" : "pin-outline"} size={13} color={item.pinned ? theme.primary : theme.textMuted} />
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity onPress={() => beginReply(item)} style={styles.reactBtn} testID={`comment-reply-${item.id}`}>
                          <Ionicons name="arrow-undo-outline" size={13} color={theme.textMuted} />
                          <Text style={styles.reactText}>Reply</Text>
                        </TouchableOpacity>
                      </View>
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
                  );
                }}
              />
            )}

            {replyTo && !editingId && (
              <View style={styles.editHint}>
                <Ionicons name="arrow-undo-outline" size={14} color={theme.primary} />
                <Text style={[styles.editHintText, { flex: 1 }]} numberOfLines={1}>Replying to {replyTo.author.name}</Text>
                <TouchableOpacity onPress={() => { setReplyTo(null); setText(""); }} testID="comment-cancel-reply">
                  <Text style={[styles.editHintText, { color: theme.textMuted }]}>Cancel</Text>
                </TouchableOpacity>
              </View>
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
              {!editingId && (
                <TouchableOpacity onPress={() => setGifOpen(true)} style={styles.gifBtn} testID="comment-gif">
                  <Ionicons name="film-outline" size={20} color={theme.primary} />
                </TouchableOpacity>
              )}
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
      <GifPickerSheet visible={gifOpen} onClose={() => setGifOpen(false)} onPick={sendGif} />
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
  rowNested: { marginLeft: 30, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: theme.border },
  replyingTo: { color: theme.textMuted, fontSize: 11.5, marginBottom: 2 },
  avatar: {
    width: 34, height: 34, borderRadius: 17, overflow: "hidden",
    backgroundColor: theme.primary, alignItems: "center", justifyContent: "center",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontSize: 13, fontWeight: "700" },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 2 },
  rowName: { color: theme.textPrimary, fontSize: 13, fontWeight: "800", flexShrink: 1 },
  pinnedBadge: { flexDirection: "row", alignItems: "center", gap: 2 },
  pinnedBadgeText: { color: theme.primary, fontSize: 10, fontWeight: "800" },
  rowTime: { color: theme.textMuted, fontSize: 11 },
  rowText: { color: theme.textPrimary, fontSize: 14, lineHeight: 19 },
  reactRow: { flexDirection: "row", gap: 16, marginTop: 6 },
  reactBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  reactText: { color: theme.textMuted, fontSize: 12, fontWeight: "600" },
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
  gifBtn: { width: 32, height: 36, alignItems: "center", justifyContent: "center" },
});
