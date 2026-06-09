import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl,
  ActivityIndicator, TextInput, Modal, KeyboardAvoidingView, Platform, Animated,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { api, Guide, Place } from "@/src/api/client";
import { theme } from "@/src/theme";
import { GLASS } from "@/src/lib/glass";
import { useFloatingHeader } from "@/src/hooks/useFloatingHeader";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";

type Tab = "places" | "guides";

const GUIDE_COLORS = ["#3B82F6", "#22C55E", "#EAB308", "#A855F7", "#EF4444", "#06B6D4"];

export default function FavoritesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const fh = useFloatingHeader(150);
  const [tab, setTab] = useState<Tab>("places");
  const [places, setPlaces] = useState<Place[]>([]);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<"all" | "favorite" | "marker">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [newGuideName, setNewGuideName] = useState("");
  const [newGuideColor, setNewGuideColor] = useState(GUIDE_COLORS[0]);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, g] = await Promise.all([api.listPlaces(), api.listGuides()]);
      setPlaces(p);
      setGuides(g);
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { load(); }, [load]);

  const deletePlace = async (id: string) => {
    setPlaces((p) => p.filter((x) => x.id !== id));
    try { await api.deletePlace(id); } catch { load(); }
  };
  const deleteGuide = async (id: string) => {
    setGuides((g) => g.filter((x) => x.id !== id));
    try { await api.deleteGuide(id); } catch { load(); }
  };

  const createGuide = async () => {
    if (!newGuideName.trim()) return;
    setCreating(true);
    try {
      const g = await api.createGuide({ name: newGuideName.trim(), color: newGuideColor });
      setGuides((all) => [g, ...all]);
      setNewGuideName("");
      setNewGuideColor(GUIDE_COLORS[0]);
      setCreateOpen(false);
    } catch {} finally {
      setCreating(false);
    }
  };

  const filteredPlaces =
    filter === "all" ? places : places.filter((p) => p.category === filter);

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="favorites-screen">
      <Animated.View
        onLayout={(e) => fh.setTopBarH(e.nativeEvent.layout.height)}
        pointerEvents={fh.barPointerEvents}
        style={[styles.topBar, GLASS, fh.barStyle(insets.top)]}
      >
        <View style={styles.header}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <SidebarMenuButton />
            <View style={{ width: 40 }} />
          </View>
          <Text style={styles.title}>Library</Text>
          <Text style={styles.subtitle}>
            {tab === "places"
              ? `${places.length} ${places.length === 1 ? "place" : "places"}`
              : `${guides.length} ${guides.length === 1 ? "guide" : "guides"}`}
          </Text>
        </View>

        <View style={styles.tabsRow}>
          {([["places", "Places"], ["guides", "Guides"]] as [Tab, string][]).map(([k, label]) => {
            const a = k === tab;
            return (
              <TouchableOpacity
                key={k}
                onPress={() => setTab(k)}
                style={[styles.tabBtn, a && styles.tabBtnActive]}
                testID={`tab-${k}`}
              >
                <Text style={[styles.tabText, { color: a ? "#fff" : theme.textSecondary }]}>
                  {label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {tab === "places" && (
          <View style={styles.chipRow}>
            {(
              [["all", "All"], ["favorite", "Favorites"], ["marker", "Pins"]] as [typeof filter, string][]
            ).map(([k, label]) => {
              const a = k === filter;
              return (
                <TouchableOpacity
                  key={k}
                  onPress={() => setFilter(k)}
                  style={[styles.chip, a && styles.chipActive]}
                  testID={`filter-${k}`}
                >
                  <Text style={[styles.chipText, { color: a ? "#fff" : theme.textSecondary }]}>
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </Animated.View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : tab === "places" ? (
        <FlatList
          data={filteredPlaces}
          keyExtractor={(i) => i.id}
          onScroll={fh.onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: fh.topBarH + 12, paddingBottom: insets.bottom + 80, gap: 12 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              progressViewOffset={fh.topBarH}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={theme.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty} testID="empty-places">
              <View style={styles.emptyIcon}>
                <Ionicons name="bookmark-outline" size={32} color={theme.textMuted} />
              </View>
              <Text style={styles.emptyTitle}>No saved places yet</Text>
              <Text style={styles.emptySub}>Tap on the map to drop a pin and save it.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.placeCard} testID={`place-${item.id}`}>
              <TouchableOpacity style={styles.placeMain} onPress={() => router.push("/(tabs)")} activeOpacity={0.85}>
                <View style={[styles.placeIcon, { backgroundColor: item.category === "favorite" ? "rgba(234,179,8,0.15)" : "rgba(59,130,246,0.15)" }]}>
                  <Ionicons
                    name={item.category === "favorite" ? "bookmark" : "pin"}
                    size={20}
                    color={item.category === "favorite" ? "#EAB308" : theme.primary}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.placeTitle} numberOfLines={1}>{item.title}</Text>
                  {!!item.address && <Text style={styles.placeAddr} numberOfLines={1}>{item.address}</Text>}
                  {!!item.notes && <Text style={styles.placeNotes} numberOfLines={2}>{item.notes}</Text>}
                  <Text style={styles.placeCoords}>
                    {item.latitude.toFixed(4)}, {item.longitude.toFixed(4)}
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => deletePlace(item.id)} style={styles.deleteBtn} testID={`delete-${item.id}`}>
                <Ionicons name="trash" size={18} color={theme.error} />
              </TouchableOpacity>
            </View>
          )}
        />
      ) : (
        <FlatList
          data={guides}
          keyExtractor={(i) => i.id}
          onScroll={fh.onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: fh.topBarH + 12, paddingBottom: insets.bottom + 100, gap: 12 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              progressViewOffset={fh.topBarH}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={theme.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty} testID="empty-guides">
              <View style={styles.emptyIcon}>
                <Ionicons name="albums-outline" size={32} color={theme.textMuted} />
              </View>
              <Text style={styles.emptyTitle}>No guides yet</Text>
              <Text style={styles.emptySub}>
                Group your saved places into named guides like "Italy 2026".
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.guideCard} testID={`guide-${item.id}`}>
              <TouchableOpacity
                style={styles.placeMain}
                onPress={() => router.push({ pathname: "/guide/[id]", params: { id: item.id } })}
                activeOpacity={0.85}
              >
                <View style={[styles.guideIcon, { backgroundColor: `${item.color}25`, borderColor: item.color }]}>
                  <Ionicons name="bookmarks" size={22} color={item.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.placeTitle} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.placeAddr}>
                    {item.place_ids.length} {item.place_ids.length === 1 ? "place" : "places"}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => deleteGuide(item.id)} style={styles.deleteBtn} testID={`delete-guide-${item.id}`}>
                <Ionicons name="trash" size={16} color={theme.error} />
              </TouchableOpacity>
            </View>
          )}
        />
      )}

      {tab === "guides" && (
        <TouchableOpacity
          style={[styles.createFab, { bottom: insets.bottom + 80 }]}
          onPress={() => setCreateOpen(true)}
          testID="create-guide-fab"
          activeOpacity={0.85}
        >
          <Ionicons name="add" size={26} color="#fff" />
        </TouchableOpacity>
      )}

      <Modal visible={createOpen} transparent animationType="slide" onRequestClose={() => setCreateOpen(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.modalBackdrop}
        >
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setCreateOpen(false)} />
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.modalTitle}>New guide</Text>
            <TextInput
              testID="guide-name-input"
              style={styles.modalInput}
              placeholder="Guide name (e.g. Italy 2026)"
              placeholderTextColor={theme.textMuted}
              value={newGuideName}
              onChangeText={setNewGuideName}
              autoFocus
            />
            <Text style={styles.modalLabel}>Color</Text>
            <View style={styles.colorRow}>
              {GUIDE_COLORS.map((c) => (
                <TouchableOpacity
                  key={c}
                  onPress={() => setNewGuideColor(c)}
                  style={[
                    styles.colorChip,
                    { backgroundColor: c },
                    newGuideColor === c && styles.colorChipActive,
                  ]}
                  testID={`color-${c}`}
                />
              ))}
            </View>
            <TouchableOpacity
              style={[styles.createBtn, !newGuideName.trim() && { opacity: 0.5 }]}
              onPress={createGuide}
              disabled={!newGuideName.trim() || creating}
              testID="create-guide-btn"
            >
              {creating ? <ActivityIndicator color="#fff" /> : <Text style={styles.createBtnText}>Create guide</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  topBar: {
    position: "absolute", top: 6, left: 8, right: 8,
    borderRadius: 24, paddingBottom: 8, zIndex: 40,
    shadowColor: "#000", shadowOpacity: 0.32, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 10,
  },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  title: { color: theme.textPrimary, fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  subtitle: { color: theme.textSecondary, fontSize: 13, marginTop: 4 },
  tabsRow: {
    flexDirection: "row", gap: 8,
    paddingHorizontal: 20, paddingTop: 8,
  },
  tabBtn: {
    paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: 14, backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border,
  },
  tabBtnActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  tabText: { fontSize: 13, fontWeight: "700" },

  chipRow: {
    flexDirection: "row", gap: 8,
    paddingHorizontal: 20, paddingVertical: 8,
  },
  chip: {
    height: 36, flexShrink: 0,
    paddingHorizontal: 16, borderRadius: 18,
    backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  chipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  chipText: { fontSize: 13, fontWeight: "600" },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { paddingTop: 80, alignItems: "center", gap: 10 },
  emptyIcon: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center", marginBottom: 4,
  },
  emptyTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "700" },
  emptySub: { color: theme.textSecondary, fontSize: 13, textAlign: "center", maxWidth: 260 },

  placeCard: {
    flexDirection: "row",
    backgroundColor: theme.surface, borderRadius: 16,
    borderWidth: 1, borderColor: theme.border,
    padding: 14, gap: 12, alignItems: "center",
  },
  guideCard: {
    flexDirection: "row",
    backgroundColor: theme.surface, borderRadius: 16,
    borderWidth: 1, borderColor: theme.border,
    padding: 14, gap: 12, alignItems: "center",
  },
  placeMain: { flex: 1, flexDirection: "row", gap: 12, alignItems: "center" },
  placeIcon: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: "center", justifyContent: "center",
  },
  guideIcon: {
    width: 48, height: 48, borderRadius: 14,
    borderWidth: 1,
    alignItems: "center", justifyContent: "center",
  },
  placeTitle: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  placeAddr: { color: theme.textSecondary, fontSize: 12, marginTop: 2 },
  placeNotes: { color: theme.textSecondary, fontSize: 12, marginTop: 4 },
  placeCoords: { color: theme.textMuted, fontSize: 11, marginTop: 4 },
  deleteBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: "rgba(239,68,68,0.1)",
    alignItems: "center", justifyContent: "center",
  },

  createFab: {
    position: "absolute", right: 20,
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 14, elevation: 8,
  },

  modalBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
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
  modalInput: {
    backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border,
    borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14,
    color: theme.textPrimary, fontSize: 15,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  modalLabel: { color: theme.textSecondary, fontSize: 13, marginTop: 18, marginBottom: 10, fontWeight: "600" },
  colorRow: { flexDirection: "row", gap: 12 },
  colorChip: {
    width: 36, height: 36, borderRadius: 18,
    borderWidth: 3, borderColor: "transparent",
  },
  colorChipActive: { borderColor: "#fff" },
  createBtn: {
    marginTop: 24, paddingVertical: 16, borderRadius: 16,
    backgroundColor: theme.primary, alignItems: "center",
  },
  createBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
