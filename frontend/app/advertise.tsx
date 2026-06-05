import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image,
  ActivityIndicator, Modal,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { api, Post } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

const DURATIONS = [
  { days: 1, label: "1 day" },
  { days: 7, label: "1 week" },
  { days: 30, label: "1 month" },
];

export default function AdvertiseScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [picking, setPicking] = useState<Post | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    try { setPosts(await api.listUserPostsAll(user.user_id)); }
    catch {} finally { setLoading(false); }
  }, [user]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const promote = async (post: Post, days: number) => {
    setBusy(true);
    try {
      const updated = await api.promotePost(post.id, days);
      setPosts((arr) => arr.map((p) => (p.id === updated.id ? updated : p)));
      setPicking(null);
    } catch {} finally { setBusy(false); }
  };

  const endsLabel = (iso?: string | null) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }); }
    catch { return ""; }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="advertise-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="advertise-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Advertise</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30, gap: 12 }}
          ListHeaderComponent={
            <View style={styles.intro}>
              <Ionicons name="megaphone" size={20} color={theme.primary} />
              <Text style={styles.introText}>Promote a post to boost its reach. Promoted posts surface higher and show a "Sponsored" badge.</Text>
            </View>
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="newspaper-outline" size={28} color={theme.textMuted} />
              <Text style={styles.emptyText}>Post something first, then promote it here.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const media = item.media?.[0];
            return (
              <View style={styles.row}>
                {media ? (
                  media.type === "video" ? (
                    <View style={[styles.thumb, styles.thumbVideo]}><Ionicons name="play" size={18} color="#fff" /></View>
                  ) : (
                    <Image source={{ uri: media.base64 }} style={styles.thumb} resizeMode="cover" />
                  )
                ) : (
                  <View style={[styles.thumb, styles.thumbText]}><Ionicons name="text" size={18} color={theme.textMuted} /></View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowText} numberOfLines={2}>{item.text || "(media post)"}</Text>
                  {item.promoted ? (
                    <Text style={styles.promotedNote}>● Promoted · ends {endsLabel(item.promoted_until)}</Text>
                  ) : (
                    <Text style={styles.rowMeta}>{item.likes_count} likes · {item.views_count || 0} views</Text>
                  )}
                </View>
                <TouchableOpacity
                  style={[styles.promoteBtn, item.promoted && styles.promoteBtnActive]}
                  onPress={() => setPicking(item)}
                  testID={`promote-${item.id}`}
                >
                  <Text style={[styles.promoteText, item.promoted && { color: theme.primary }]}>
                    {item.promoted ? "Extend" : "Promote"}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          }}
        />
      )}

      <Modal visible={!!picking} transparent animationType="slide" onRequestClose={() => setPicking(null)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => !busy && setPicking(null)}>
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Promote for…</Text>
            {DURATIONS.map((d) => (
              <TouchableOpacity
                key={d.days}
                style={styles.durRow}
                onPress={() => picking && promote(picking, d.days)}
                disabled={busy}
                testID={`promote-dur-${d.days}`}
              >
                <Text style={styles.durText}>{d.label}</Text>
                {busy ? <ActivityIndicator size="small" color={theme.primary} /> : <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 8, paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  intro: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border,
    padding: 14, marginBottom: 6,
  },
  introText: { flex: 1, color: theme.textSecondary, fontSize: 13, lineHeight: 18 },
  empty: { alignItems: "center", paddingTop: 50, gap: 10 },
  emptyText: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingHorizontal: 40 },

  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border,
    padding: 12,
  },
  thumb: { width: 52, height: 52, borderRadius: 10, backgroundColor: theme.surfaceAlt },
  thumbVideo: { alignItems: "center", justifyContent: "center", backgroundColor: "#000" },
  thumbText: { alignItems: "center", justifyContent: "center" },
  rowText: { color: theme.textPrimary, fontSize: 14, fontWeight: "600" },
  rowMeta: { color: theme.textMuted, fontSize: 12, marginTop: 3 },
  promotedNote: { color: theme.primary, fontSize: 12, fontWeight: "700", marginTop: 3 },
  promoteBtn: {
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: 12,
    backgroundColor: theme.primary,
  },
  promoteBtnActive: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.primary },
  promoteText: { color: "#fff", fontSize: 13, fontWeight: "800" },

  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingTop: 12, paddingHorizontal: 18, borderTopWidth: 1, borderColor: theme.border,
  },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 14 },
  sheetTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800", marginBottom: 8 },
  durRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingVertical: 15, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  durText: { color: theme.textPrimary, fontSize: 15, fontWeight: "600" },
});
