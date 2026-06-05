import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator,
  Modal, KeyboardAvoidingView, Platform, Share,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api, Guide, Place } from "@/src/api/client";
import { theme } from "@/src/theme";

export default function GuideDetail() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [guide, setGuide] = useState<Guide | null>(null);
  const [allPlaces, setAllPlaces] = useState<Place[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [guides, places] = await Promise.all([api.listGuides(), api.listPlaces()]);
      const g = guides.find((x) => x.id === id) || null;
      setGuide(g);
      setAllPlaces(places);
    } catch {} finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const placesInGuide = guide ? allPlaces.filter((p) => guide.place_ids.includes(p.id)) : [];
  const placesAvailable = guide ? allPlaces.filter((p) => !guide.place_ids.includes(p.id)) : [];

  const remove = async (placeId: string) => {
    if (!guide) return;
    setBusy(true);
    try {
      const updated = await api.removePlaceFromGuide(guide.id, placeId);
      setGuide(updated);
    } catch {} finally {
      setBusy(false);
    }
  };

  const add = async (placeId: string) => {
    if (!guide) return;
    setBusy(true);
    try {
      const updated = await api.addPlaceToGuide(guide.id, placeId);
      setGuide(updated);
    } catch {} finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.root, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }
  if (!guide) {
    return (
      <SafeAreaView edges={["top"]} style={styles.root}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} testID="back">
            <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
          </TouchableOpacity>
        </View>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={styles.emptyTitle}>Guide not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="guide-detail">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={() => setAddOpen(true)} style={styles.iconBtn} testID="add-place-btn">
          <Ionicons name="add" size={22} color={theme.primary} />
        </TouchableOpacity>
      </View>

      <View style={styles.heroWrap}>
        <View style={[styles.heroIcon, { backgroundColor: `${guide.color}25`, borderColor: guide.color }]}>
          <Ionicons name="bookmarks" size={32} color={guide.color} />
        </View>
        <Text style={styles.heroTitle}>{guide.name}</Text>
        <Text style={styles.heroSub}>
          {placesInGuide.length} {placesInGuide.length === 1 ? "place" : "places"}
        </Text>

        <View style={styles.shareRow}>
          <TouchableOpacity
            style={[styles.shareToggle, guide.is_public && { backgroundColor: theme.primary, borderColor: theme.primary }]}
            onPress={async () => {
              setBusy(true);
              try {
                const updated = await api.patchGuide(guide.id, { is_public: !guide.is_public });
                setGuide(updated);
              } catch {} finally { setBusy(false); }
            }}
            disabled={busy}
            testID="toggle-public"
          >
            <Ionicons name={guide.is_public ? "globe" : "lock-closed"} size={14} color={guide.is_public ? "#fff" : theme.textSecondary} />
            <Text style={[styles.shareToggleText, { color: guide.is_public ? "#fff" : theme.textSecondary }]}>
              {guide.is_public ? "Public" : "Private"}
            </Text>
          </TouchableOpacity>
          {guide.is_public && guide.slug && (
            <TouchableOpacity
              style={styles.shareLinkBtn}
              testID="share-guide-link"
              onPress={async () => {
                const origin = (Platform.OS === "web" && typeof window !== "undefined")
                  ? window.location.origin
                  : (process.env.EXPO_PUBLIC_BACKEND_URL || "");
                const url = `${origin}/g/${guide.slug}`;
                const msg = `Check out my guide "${guide.name}" on Nami App:\n${url}`;
                try {
                  if (Platform.OS === "web" && (navigator as any).share) {
                    await (navigator as any).share({ title: guide.name, text: msg, url });
                  } else {
                    await Share.share({ message: msg });
                  }
                } catch {}
              }}
            >
              <Ionicons name="share-outline" size={14} color={theme.primary} />
              <Text style={styles.shareLinkText}>Share link</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        data={placesInGuide}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 80, gap: 10 }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="bookmark-outline" size={40} color={theme.textMuted} />
            <Text style={styles.emptyTitle}>No places in this guide yet</Text>
            <TouchableOpacity onPress={() => setAddOpen(true)} style={styles.emptyBtn}>
              <Text style={styles.emptyBtnText}>Add places</Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.placeCard} testID={`gp-${item.id}`}>
            <View style={[styles.placeIcon, { backgroundColor: "rgba(59,130,246,0.15)" }]}>
              <Ionicons name="pin" size={18} color={theme.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.placeTitle} numberOfLines={1}>{item.title}</Text>
              {!!item.address && <Text style={styles.placeAddr} numberOfLines={1}>{item.address}</Text>}
            </View>
            <TouchableOpacity
              onPress={() => remove(item.id)}
              disabled={busy}
              style={styles.deleteBtn}
              testID={`gp-remove-${item.id}`}
            >
              <Ionicons name="close" size={18} color={theme.error} />
            </TouchableOpacity>
          </View>
        )}
      />

      <Modal visible={addOpen} transparent animationType="slide" onRequestClose={() => setAddOpen(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.modalBackdrop}
        >
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setAddOpen(false)} />
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 24, maxHeight: "70%" }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.modalTitle}>Add places</Text>
            <FlatList
              data={placesAvailable}
              keyExtractor={(i) => i.id}
              ListEmptyComponent={
                <Text style={styles.placeAddr}>
                  All your saved places are already in this guide. Add more from the map.
                </Text>
              }
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.addRow}
                  onPress={() => add(item.id)}
                  testID={`add-place-${item.id}`}
                >
                  <View style={[styles.placeIcon, { backgroundColor: "rgba(59,130,246,0.15)" }]}>
                    <Ionicons name="pin" size={18} color={theme.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.placeTitle} numberOfLines={1}>{item.title}</Text>
                    {!!item.address && <Text style={styles.placeAddr} numberOfLines={1}>{item.address}</Text>}
                  </View>
                  <Ionicons name="add-circle" size={22} color={theme.primary} />
                </TouchableOpacity>
              )}
            />
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingTop: 8,
  },
  iconBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: "center", justifyContent: "center",
  },
  heroWrap: { alignItems: "center", paddingTop: 16, paddingBottom: 20 },
  heroIcon: {
    width: 80, height: 80, borderRadius: 20,
    borderWidth: 2,
    alignItems: "center", justifyContent: "center",
    marginBottom: 14,
  },
  heroTitle: { color: theme.textPrimary, fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  heroSub: { color: theme.textSecondary, fontSize: 13, marginTop: 4 },
  shareRow: { flexDirection: "row", gap: 8, marginTop: 16 },
  shareToggle: {
    flexDirection: "row", gap: 6, alignItems: "center",
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
  },
  shareToggleText: { fontSize: 13, fontWeight: "700" },
  shareLinkBtn: {
    flexDirection: "row", gap: 6, alignItems: "center",
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14,
    backgroundColor: "rgba(59,130,246,0.15)", borderWidth: 1, borderColor: "rgba(59,130,246,0.4)",
  },
  shareLinkText: { color: theme.primary, fontSize: 13, fontWeight: "700" },

  empty: { alignItems: "center", gap: 14, paddingTop: 40 },
  emptyTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "700" },
  emptyBtn: {
    paddingHorizontal: 20, paddingVertical: 12,
    backgroundColor: theme.primary, borderRadius: 14,
  },
  emptyBtnText: { color: "#fff", fontWeight: "700" },

  placeCard: {
    flexDirection: "row", gap: 12, alignItems: "center",
    backgroundColor: theme.surface, borderRadius: 14,
    borderWidth: 1, borderColor: theme.border,
    padding: 12,
  },
  placeIcon: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: "center", justifyContent: "center",
  },
  placeTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  placeAddr: { color: theme.textSecondary, fontSize: 12, marginTop: 2 },
  deleteBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: "rgba(239,68,68,0.1)",
    alignItems: "center", justifyContent: "center",
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
  modalTitle: { color: theme.textPrimary, fontSize: 20, fontWeight: "800", marginBottom: 16 },
  addRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
});
