import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, Modal, FlatList, TouchableOpacity, Image,
  ActivityIndicator, Share, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { api, ConversationView, Post } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

type Props = {
  visible: boolean;
  post: Post | null;
  onClose: () => void;
};

/** Bottom sheet to send a post into a DM/group chat, or share it externally. */
export default function ShareToChatSheet({ visible, post, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [convs, setConvs] = useState<ConversationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());
  const [sendingId, setSendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setConvs(await api.listConversations()); }
    catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (visible) { setSentTo(new Set()); load(); }
  }, [visible, load]);

  const nameFor = (c: ConversationView) =>
    c.kind === "group" ? (c.name || "Group") : (c.other_user?.name || "Chat");
  const avatarFor = (c: ConversationView) =>
    c.kind === "group" ? c.avatar : c.other_user?.picture;

  const sendTo = async (c: ConversationView) => {
    if (!post || sentTo.has(c.id) || sendingId) return;
    setSendingId(c.id);
    try {
      await api.sendMessage(c.id, { type: "post", post_id: post.id });
      setSentTo((s) => new Set(s).add(c.id));
    } catch {} finally { setSendingId(null); }
  };

  const shareExternally = async () => {
    if (!post) return;
    const url = `atlas://post/${post.id}`;
    try {
      if (Platform.OS === "web") { await Clipboard.setStringAsync(url); }
      else { await Share.share({ message: post.text ? `${post.text}\n\n${url}` : url, url }); }
    } catch {}
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} testID="share-backdrop" />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 8 }]} testID="share-sheet">
          <View style={styles.handle} />
          <Text style={styles.title}>Send to</Text>

          {loading ? (
            <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
          ) : (
            <FlatList
              data={convs}
              keyExtractor={(i) => i.id}
              style={{ maxHeight: 360 }}
              contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8 }}
              ListEmptyComponent={<Text style={styles.empty}>No conversations yet.</Text>}
              renderItem={({ item }) => {
                const sent = sentTo.has(item.id);
                const pic = avatarFor(item);
                return (
                  <TouchableOpacity
                    style={styles.row}
                    onPress={() => sendTo(item)}
                    disabled={sent || !!sendingId}
                    testID={`share-conv-${item.id}`}
                  >
                    <View style={styles.avatar}>
                      {pic ? (
                        <Image source={{ uri: pic }} style={styles.avatarImg} />
                      ) : (
                        <Text style={styles.avatarInit}>{(nameFor(item)[0] || "?").toUpperCase()}</Text>
                      )}
                    </View>
                    <Text style={styles.rowName} numberOfLines={1}>{nameFor(item)}</Text>
                    {sendingId === item.id ? (
                      <ActivityIndicator size="small" color={theme.primary} />
                    ) : sent ? (
                      <View style={styles.sentPill}><Text style={styles.sentText}>Sent</Text></View>
                    ) : (
                      <View style={styles.sendPill}><Text style={styles.sendText}>Send</Text></View>
                    )}
                  </TouchableOpacity>
                );
              }}
            />
          )}

          <TouchableOpacity style={styles.externalBtn} onPress={shareExternally} testID="share-external">
            <Ionicons name="share-outline" size={18} color={theme.primary} />
            <Text style={styles.externalText}>Share via…</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.bg,
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderColor: theme.border, paddingTop: 10,
  },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 10 },
  title: { color: theme.textPrimary, fontSize: 16, fontWeight: "800", textAlign: "center", marginBottom: 8 },
  center: { paddingVertical: 40, alignItems: "center" },
  empty: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingVertical: 30 },
  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingVertical: 9, paddingHorizontal: 4,
  },
  avatar: {
    width: 40, height: 40, borderRadius: 20, overflow: "hidden",
    backgroundColor: theme.primary, alignItems: "center", justifyContent: "center",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontSize: 16, fontWeight: "700" },
  rowName: { flex: 1, color: theme.textPrimary, fontSize: 15, fontWeight: "600" },
  sendPill: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 16, backgroundColor: theme.primary },
  sendText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  sentPill: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 16, backgroundColor: theme.surfaceAlt },
  sentText: { color: theme.textSecondary, fontSize: 13, fontWeight: "800" },
  externalBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    marginHorizontal: 16, marginTop: 6, paddingVertical: 13, borderRadius: 14,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
  },
  externalText: { color: theme.primary, fontSize: 14, fontWeight: "800" },
});
