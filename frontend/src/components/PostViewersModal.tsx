import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Modal, Image,
  ActivityIndicator, Pressable,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api, PostViewer } from "@/src/api/client";
import { theme } from "@/src/theme";

function ago(iso?: string) {
  if (!iso) return "";
  try {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  } catch { return ""; }
}

export default function PostViewersModal({
  visible, postId, onClose,
}: { visible: boolean; postId: string | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [items, setItems] = useState<PostViewer[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!postId) return;
    setLoading(true); setError(null);
    try {
      const r = await api.getPostViewers(postId);
      setItems(r.viewers); setCount(r.count);
    } catch (e: any) {
      setError(String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setLoading(false); }
  }, [postId]);

  useEffect(() => { if (visible) load(); }, [visible, load]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16, maxHeight: "75%" }]}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title}>Viewed by{count ? ` · ${count.toLocaleString()}` : ""}</Text>
            <TouchableOpacity onPress={onClose} testID="viewers-close">
              <Ionicons name="close" size={22} color={theme.textPrimary} />
            </TouchableOpacity>
          </View>
          {loading ? (
            <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
          ) : error ? (
            <Text style={styles.empty}>{error}</Text>
          ) : (
            <FlatList
              data={items}
              keyExtractor={(i) => i.user_id}
              ListEmptyComponent={<Text style={styles.empty}>No views from other users yet.</Text>}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.row}
                  onPress={() => { onClose(); setTimeout(() => router.push({ pathname: "/user/[name]", params: { name: item.name } }), 100); }}
                >
                  <View style={styles.avatar}>
                    {item.picture ? (
                      <Image source={{ uri: item.picture }} style={{ width: "100%", height: "100%" }} />
                    ) : (
                      <Text style={styles.avatarInit}>{(item.name?.[0] || "?").toUpperCase()}</Text>
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                    {!!item.username && <Text style={styles.sub} numberOfLines={1}>@{item.username}</Text>}
                  </View>
                  <Text style={styles.when}>{ago(item.viewed_at)}</Text>
                </TouchableOpacity>
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#0E0E10", borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 10, paddingHorizontal: 16, borderTopWidth: 1, borderColor: theme.border },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 14 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: 12 },
  title: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  center: { paddingVertical: 40, alignItems: "center" },
  empty: { color: theme.textMuted, textAlign: "center", paddingVertical: 40, fontSize: 13 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  avatar: { width: 44, height: 44, borderRadius: 22, overflow: "hidden", backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  avatarInit: { color: "#fff", fontSize: 16, fontWeight: "700" },
  name: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  sub: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  when: { color: theme.textMuted, fontSize: 12, fontWeight: "600" },
});
