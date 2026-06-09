import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Image, ActivityIndicator, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api, ListingComment } from "@/src/api/client";
import { theme } from "@/src/theme";
import VerifiedBadge from "@/src/components/VerifiedBadge";
import UserBadges from "@/src/components/UserBadges";

const fmtAgo = (iso: string) => {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
};

/**
 * Full-featured marketplace listing comments — likes, replies (one level),
 * edit, delete, author badges and time-ago, mirroring newsfeed comments.
 */
export default function ListingComments({
  listingId, ownerId, viewerId, onCountChange,
}: { listingId: string; ownerId?: string; viewerId?: string; onCountChange?: (n: number) => void }) {
  const [comments, setComments] = useState<ListingComment[]>([]);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [replyTo, setReplyTo] = useState<ListingComment | null>(null);
  const [editing, setEditing] = useState<ListingComment | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const inputRef = useRef<TextInput>(null);

  const load = useCallback(async () => {
    try { setComments(await api.listingComments(listingId)); } catch {}
  }, [listingId]);
  useEffect(() => { load(); }, [load]);

  const { tops, repliesByParent } = useMemo(() => {
    const t: ListingComment[] = [];
    const r: Record<string, ListingComment[]> = {};
    for (const c of comments) {
      if (c.parent_id) (r[c.parent_id] = r[c.parent_id] || []).push(c);
      else t.push(c);
    }
    return { tops: t, repliesByParent: r };
  }, [comments]);

  const merge = (c: ListingComment) => setComments((arr) => arr.map((x) => (x.id === c.id ? c : x)));

  const submit = async () => {
    const t = text.trim();
    if (!t || posting) return;
    setPosting(true);
    try {
      if (editing) {
        const c = await api.editListingComment(listingId, editing.id, t);
        merge(c);
      } else {
        const c = await api.addListingComment(listingId, t, replyTo?.id);
        setComments((arr) => [...arr, c]);
        if (c.parent_id) setExpanded((s) => new Set(s).add(c.parent_id!));
        onCountChange?.(comments.length + 1);
      }
      setText(""); setReplyTo(null); setEditing(null);
    } catch {} finally { setPosting(false); }
  };

  const toggleLike = async (c: ListingComment) => {
    const liked = !c.liked_by_me;
    merge({ ...c, liked_by_me: liked, likes_count: Math.max(0, (c.likes_count || 0) + (liked ? 1 : -1)) });
    try { merge(await api.likeListingComment(listingId, c.id)); } catch { load(); }
  };

  const remove = async (c: ListingComment) => {
    const childIds = (repliesByParent[c.id] || []).map((x) => x.id);
    setComments((arr) => arr.filter((x) => x.id !== c.id && !childIds.includes(x.id)));
    onCountChange?.(Math.max(0, comments.length - 1 - childIds.length));
    try { await api.deleteListingComment(listingId, c.id); } catch { load(); }
  };

  const beginReply = (c: ListingComment) => { setEditing(null); setReplyTo(c); inputRef.current?.focus(); };
  const beginEdit = (c: ListingComment) => { setReplyTo(null); setEditing(c); setText(c.text); inputRef.current?.focus(); };
  const cancel = () => { setReplyTo(null); setEditing(null); setText(""); };

  const Row = ({ c, isReply }: { c: ListingComment; isReply?: boolean }) => {
    const canDelete = c.mine || viewerId === ownerId;
    return (
      <View style={[styles.row, isReply && styles.replyRow]}>
        <View style={styles.avatar}>
          {c.author.picture ? <Image source={{ uri: c.author.picture }} style={{ width: "100%", height: "100%" }} /> : <Text style={styles.init}>{(c.author.name?.[0] || "?").toUpperCase()}</Text>}
        </View>
        <View style={{ flex: 1 }}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>{c.author.name}</Text>
            {c.author.verified && <VerifiedBadge size={12} />}
            <UserBadges badges={c.author.badges} size={12} />
            <Text style={styles.time}>· {fmtAgo(c.created_at)}{c.edited_at ? " · edited" : ""}</Text>
          </View>
          <Text style={styles.body}>{c.text}</Text>
          <View style={styles.actions}>
            <TouchableOpacity style={styles.actionBtn} onPress={() => toggleLike(c)} testID={`lc-like-${c.id}`}>
              <Ionicons name={c.liked_by_me ? "heart" : "heart-outline"} size={15} color={c.liked_by_me ? "#EF4444" : theme.textMuted} />
              {(c.likes_count || 0) > 0 && <Text style={[styles.actionText, c.liked_by_me && { color: "#EF4444" }]}>{c.likes_count}</Text>}
            </TouchableOpacity>
            {!isReply && (
              <TouchableOpacity style={styles.actionBtn} onPress={() => beginReply(c)} testID={`lc-reply-${c.id}`}>
                <Ionicons name="chatbubble-outline" size={14} color={theme.textMuted} />
                <Text style={styles.actionText}>Reply</Text>
              </TouchableOpacity>
            )}
            {c.mine && (
              <TouchableOpacity style={styles.actionBtn} onPress={() => beginEdit(c)} testID={`lc-edit-${c.id}`}>
                <Text style={styles.actionText}>Edit</Text>
              </TouchableOpacity>
            )}
            {canDelete && (
              <TouchableOpacity style={styles.actionBtn} onPress={() => remove(c)} testID={`lc-del-${c.id}`}>
                <Text style={[styles.actionText, { color: theme.error }]}>Delete</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    );
  };

  return (
    <View>
      {/* Composer */}
      {(replyTo || editing) && (
        <View style={styles.banner}>
          <Text style={styles.bannerText} numberOfLines={1}>
            {editing ? "Editing your comment" : `Replying to ${replyTo?.author.name}`}
          </Text>
          <TouchableOpacity onPress={cancel} hitSlop={8} testID="lc-cancel"><Ionicons name="close" size={16} color={theme.textMuted} /></TouchableOpacity>
        </View>
      )}
      <View style={styles.composer}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          placeholder={replyTo ? "Write a reply…" : "Ask a question or leave a comment…"}
          placeholderTextColor={theme.textMuted}
          value={text}
          onChangeText={setText}
          multiline
          testID="listing-comment-input"
        />
        <TouchableOpacity onPress={submit} disabled={!text.trim() || posting} style={[styles.send, (!text.trim() || posting) && { opacity: 0.4 }]} testID="listing-comment-send">
          {posting ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name={editing ? "checkmark" : "arrow-up"} size={18} color="#fff" />}
        </TouchableOpacity>
      </View>

      {tops.length === 0 ? (
        <Text style={styles.empty}>No comments yet. Be the first to ask.</Text>
      ) : tops.map((c) => {
        const replies = repliesByParent[c.id] || [];
        const isOpen = expanded.has(c.id);
        return (
          <View key={c.id}>
            <Row c={c} />
            {replies.length > 0 && (
              <TouchableOpacity
                style={styles.expander}
                onPress={() => setExpanded((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })}
                testID={`lc-expand-${c.id}`}
              >
                <View style={styles.expanderLine} />
                <Text style={styles.expanderText}>{isOpen ? "Hide replies" : `View ${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}</Text>
              </TouchableOpacity>
            )}
            {isOpen && replies.map((r) => <Row key={r.id} c={r} isReply />)}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: theme.surfaceAlt, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7, marginBottom: 6 },
  bannerText: { flex: 1, color: theme.textSecondary, fontSize: 12.5, fontWeight: "600" },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, marginBottom: 12 },
  input: { flex: 1, color: theme.textPrimary, fontSize: 14.5, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9, maxHeight: 100, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  send: { width: 36, height: 36, borderRadius: 18, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  empty: { color: theme.textMuted, fontSize: 13.5, paddingVertical: 8 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10 },
  replyRow: { paddingLeft: 28 },
  avatar: { width: 34, height: 34, borderRadius: 17, overflow: "hidden", backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  init: { color: "#fff", fontSize: 13, fontWeight: "700" },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  name: { color: theme.textSecondary, fontSize: 13, fontWeight: "700", flexShrink: 1 },
  time: { color: theme.textMuted, fontSize: 12 },
  body: { color: theme.textPrimary, fontSize: 14.5, lineHeight: 20, marginTop: 2 },
  actions: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 6 },
  actionBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  actionText: { color: theme.textMuted, fontSize: 12.5, fontWeight: "700" },
  expander: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 44, paddingVertical: 6 },
  expanderLine: { width: 22, height: StyleSheet.hairlineWidth, backgroundColor: theme.border },
  expanderText: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "700" },
});
