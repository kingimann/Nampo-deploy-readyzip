import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  ActivityIndicator, RefreshControl, Modal, KeyboardAvoidingView,
  Platform, Image, ScrollView,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { api, Listing } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";

const CATEGORIES = [
  { key: "all", label: "All" },
  { key: "electronics", label: "Electronics" },
  { key: "furniture", label: "Furniture" },
  { key: "fashion", label: "Fashion" },
  { key: "vehicles", label: "Vehicles" },
  { key: "home", label: "Home" },
  { key: "other", label: "Other" },
];

const CONDITIONS = [
  { key: "new", label: "New" },
  { key: "like_new", label: "Like new" },
  { key: "good", label: "Good" },
  { key: "fair", label: "Fair" },
  { key: "used", label: "Used" },
];

const SORTS = [
  { key: "recent", label: "Most recent" },
  { key: "price_low", label: "Price: low to high" },
  { key: "price_high", label: "Price: high to low" },
];

const MAX_PHOTOS = 6;

export default function MarketplaceScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("recent");
  const [condFilter, setCondFilter] = useState("all");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [savedView, setSavedView] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [draft, setDraft] = useState({ title: "", price: "", category: "other", condition: "used", description: "", photos: [] as string[] });
  const [posting, setPosting] = useState(false);

  const filtersActive = cat !== "all" || condFilter !== "all" || sort !== "recent" || !!minPrice || !!maxPrice;

  const load = useCallback(async () => {
    try {
      const list = savedView
        ? await api.listSavedListings()
        : await api.listListings({
            category: cat === "all" ? undefined : cat, q, sort,
            condition: condFilter === "all" ? undefined : condFilter,
            min_price: minPrice ? Number(minPrice) : undefined,
            max_price: maxPrice ? Number(maxPrice) : undefined,
          });
      setListings(list);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [cat, q, sort, condFilter, minPrice, maxPrice, savedView]);

  const resetFilters = () => {
    setCat("all"); setCondFilter("all"); setSort("recent"); setMinPrice(""); setMaxPrice("");
  };

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { setLoading(true); load(); }, [load]);

  const pickPhotos = async () => {
    if (draft.photos.length >= MAX_PHOTOS) return;
    if (Platform.OS !== "web") {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"] as any,
      allowsMultipleSelection: true,
      selectionLimit: MAX_PHOTOS - draft.photos.length,
      quality: 0.6,
      base64: true,
    });
    if (result.canceled) return;
    const added = (result.assets || [])
      .filter((a) => a.base64)
      .map((a) => `data:image/jpeg;base64,${a.base64}`);
    setDraft((d) => ({ ...d, photos: [...d.photos, ...added].slice(0, MAX_PHOTOS) }));
  };

  const submit = async () => {
    const title = draft.title.trim();
    if (!title) return;
    setPosting(true);
    try {
      const p = await api.createListing({
        title,
        price: Number(draft.price) || 0,
        category: draft.category,
        condition: draft.condition,
        description: draft.description.trim(),
        photos: draft.photos,
      });
      setListings((x) => [p, ...x]);
      setDraft({ title: "", price: "", category: "other", condition: "used", description: "", photos: [] });
      setComposeOpen(false);
    } catch {} finally { setPosting(false); }
  };

  const openListing = (l: Listing) =>
    router.push({ pathname: "/listing/[id]", params: { id: l.id } });

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="marketplace-screen">
      <View style={styles.header}>
        <SidebarMenuButton />
        <Text style={styles.title}>{savedView ? "Saved" : "Marketplace"}</Text>
        <TouchableOpacity
          onPress={() => setSavedView((v) => !v)}
          style={[styles.headerIconBtn, savedView && styles.headerIconBtnActive]}
          testID="market-saved-toggle"
        >
          <Ionicons name={savedView ? "bookmark" : "bookmark-outline"} size={20} color={savedView ? theme.primary : theme.textPrimary} />
        </TouchableOpacity>
      </View>

      <View style={styles.searchRow}>
        <View style={styles.searchPill}>
          <Ionicons name="search" size={17} color={theme.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search Marketplace"
            placeholderTextColor={theme.textMuted}
            value={q}
            onChangeText={setQ}
            returnKeyType="search"
            testID="market-search"
          />
          {!!q && (
            <TouchableOpacity onPress={() => setQ("")}>
              <Ionicons name="close-circle" size={17} color={theme.textMuted} />
            </TouchableOpacity>
          )}
        </View>
        {!savedView && (
          <TouchableOpacity
            style={[styles.filterBtn, filtersActive && styles.filterBtnActive]}
            onPress={() => setFiltersOpen(true)}
            testID="market-filters"
          >
            <Ionicons name="options-outline" size={20} color={filtersActive ? theme.primary : theme.textSecondary} />
            {filtersActive && <View style={styles.filterDot} />}
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={listings}
          keyExtractor={(i) => i.id}
          numColumns={2}
          columnWrapperStyle={{ gap: 14 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: insets.bottom + 110, gap: 18 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="storefront-outline" size={40} color={theme.textMuted} />
              <Text style={styles.emptyTitle}>No listings yet</Text>
              <Text style={styles.emptySub}>Tap the + button to post the first one.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.tile}
              activeOpacity={0.85}
              onPress={() => openListing(item)}
              testID={`listing-${item.id}`}
            >
              <View>
                {item.photo_base64 ? (
                  <Image source={{ uri: item.photo_base64 }} style={styles.tileImg} resizeMode="cover" />
                ) : (
                  <View style={[styles.tileImg, styles.tileImgPlaceholder]}>
                    <Ionicons name="image-outline" size={28} color={theme.textMuted} />
                  </View>
                )}
                {item.status === "sold" && (
                  <View style={styles.soldTag}><Text style={styles.soldTagText}>SOLD</Text></View>
                )}
                {item.saved_by_me && (
                  <View style={styles.savedTag}><Ionicons name="bookmark" size={12} color="#fff" /></View>
                )}
              </View>
              <View style={styles.tileBody}>
                <Text style={styles.tilePrice}>
                  {item.price > 0 ? `${item.currency} ${item.price.toFixed(0)}` : "Free"}
                </Text>
                <Text style={styles.tileTitle} numberOfLines={2}>{item.title}</Text>
                {!!item.locality && (
                  <View style={styles.tileLocRow}>
                    <Ionicons name="location-outline" size={11} color={theme.textMuted} />
                    <Text style={styles.tileLoc} numberOfLines={1}>{item.locality}</Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      <TouchableOpacity
        style={[styles.fab, { bottom: insets.bottom + 66 }]}
        onPress={() => setComposeOpen(true)}
        testID="new-listing-fab"
      >
        <Ionicons name="add" size={26} color="#fff" />
      </TouchableOpacity>

      <Modal visible={composeOpen} transparent animationType="slide" onRequestClose={() => setComposeOpen(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.modalBackdrop}
        >
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setComposeOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 24, maxHeight: "85%" }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>New listing</Text>
            <ScrollView>
              <Text style={styles.label}>Photos</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
                <View style={{ flexDirection: "row", gap: 8, paddingRight: 16 }}>
                  {draft.photos.map((p, i) => (
                    <View key={i} style={styles.photoThumb}>
                      <Image source={{ uri: p }} style={StyleSheet.absoluteFill} />
                      <TouchableOpacity
                        style={styles.photoRemove}
                        onPress={() => setDraft((d) => ({ ...d, photos: d.photos.filter((_, j) => j !== i) }))}
                      >
                        <Ionicons name="close" size={12} color="#fff" />
                      </TouchableOpacity>
                    </View>
                  ))}
                  {draft.photos.length < MAX_PHOTOS && (
                    <TouchableOpacity style={styles.photoAdd} onPress={pickPhotos} testID="listing-add-photo">
                      <Ionicons name="camera" size={22} color={theme.primary} />
                      <Text style={styles.photoAddText}>Add</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </ScrollView>
              <Text style={styles.label}>Title</Text>
              <TextInput
                style={styles.input}
                placeholder="What are you selling?"
                placeholderTextColor={theme.textMuted}
                value={draft.title}
                onChangeText={(t) => setDraft({ ...draft, title: t })}
                maxLength={120}
                testID="listing-title-input"
              />
              <Text style={styles.label}>Price (USD)</Text>
              <TextInput
                style={styles.input}
                placeholder="0 for free"
                placeholderTextColor={theme.textMuted}
                value={draft.price}
                onChangeText={(t) => setDraft({ ...draft, price: t.replace(/[^0-9.]/g, "") })}
                keyboardType="decimal-pad"
                testID="listing-price-input"
              />
              <Text style={styles.label}>Category</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
                <View style={{ flexDirection: "row", gap: 8, paddingRight: 16 }}>
                  {CATEGORIES.filter((c) => c.key !== "all").map((c) => {
                    const a = c.key === draft.category;
                    return (
                      <TouchableOpacity
                        key={c.key}
                        onPress={() => setDraft({ ...draft, category: c.key })}
                        style={[styles.chip, a && styles.chipActive, { flexShrink: 0 }]}
                      >
                        <Text style={[styles.chipText, { color: a ? "#fff" : theme.textSecondary }]}>{c.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>
              <Text style={styles.label}>Condition</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
                <View style={{ flexDirection: "row", gap: 8, paddingRight: 16 }}>
                  {CONDITIONS.map((c) => {
                    const a = c.key === draft.condition;
                    return (
                      <TouchableOpacity
                        key={c.key}
                        onPress={() => setDraft({ ...draft, condition: c.key })}
                        style={[styles.chip, a && styles.chipActive, { flexShrink: 0 }]}
                      >
                        <Text style={[styles.chipText, { color: a ? "#fff" : theme.textSecondary }]}>{c.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>
              <Text style={styles.label}>Description (optional)</Text>
              <TextInput
                style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
                placeholder="Condition, details, pickup location…"
                placeholderTextColor={theme.textMuted}
                value={draft.description}
                onChangeText={(t) => setDraft({ ...draft, description: t })}
                multiline
                maxLength={2000}
                testID="listing-desc-input"
              />
              <TouchableOpacity
                style={[styles.postBtn, (!draft.title.trim() || posting) && { opacity: 0.5 }]}
                onPress={submit}
                disabled={!draft.title.trim() || posting}
                testID="listing-submit"
              >
                {posting ? <ActivityIndicator color="#fff" /> : <Text style={styles.postBtnText}>Post listing</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={filtersOpen} transparent animationType="slide" onRequestClose={() => setFiltersOpen(false)}>
        <View style={styles.modalBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setFiltersOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16, maxHeight: "85%" }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.filterHead}>
              <Text style={styles.sheetTitle}>Filters</Text>
              <TouchableOpacity onPress={resetFilters} testID="market-reset-filters">
                <Text style={styles.resetText}>Reset</Text>
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text style={styles.filterLabel}>Category</Text>
              <View style={styles.condWrap}>
                {CATEGORIES.map((c) => {
                  const a = c.key === cat;
                  return (
                    <TouchableOpacity key={c.key} onPress={() => setCat(c.key)} style={[styles.condChip, a && styles.condChipActive]} testID={`market-cat-${c.key}`}>
                      <Text style={[styles.condChipText, { color: a ? theme.primary : theme.textMuted }]}>{c.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={styles.filterLabel}>Condition</Text>
              <View style={styles.condWrap}>
                {[{ key: "all", label: "Any" }, ...CONDITIONS].map((c) => {
                  const a = c.key === condFilter;
                  return (
                    <TouchableOpacity key={c.key} onPress={() => setCondFilter(c.key)} style={[styles.condChip, a && styles.condChipActive]} testID={`market-cond-${c.key}`}>
                      <Text style={[styles.condChipText, { color: a ? theme.primary : theme.textMuted }]}>{c.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={styles.filterLabel}>Price range (USD)</Text>
              <View style={styles.priceRow}>
                <TextInput
                  style={styles.priceInput}
                  placeholder="Min"
                  placeholderTextColor={theme.textMuted}
                  value={minPrice}
                  onChangeText={(t) => setMinPrice(t.replace(/[^0-9]/g, ""))}
                  keyboardType="number-pad"
                  testID="market-min-price"
                />
                <Text style={styles.priceDash}>–</Text>
                <TextInput
                  style={styles.priceInput}
                  placeholder="Max"
                  placeholderTextColor={theme.textMuted}
                  value={maxPrice}
                  onChangeText={(t) => setMaxPrice(t.replace(/[^0-9]/g, ""))}
                  keyboardType="number-pad"
                  testID="market-max-price"
                />
              </View>

              <Text style={styles.filterLabel}>Sort by</Text>
              {SORTS.map((s) => (
                <TouchableOpacity key={s.key} style={styles.sortRow} onPress={() => setSort(s.key)} testID={`market-sort-${s.key}`}>
                  <Text style={[styles.sortRowText, sort === s.key && { color: theme.primary, fontWeight: "800" }]}>{s.label}</Text>
                  {sort === s.key && <Ionicons name="checkmark" size={18} color={theme.primary} />}
                </TouchableOpacity>
              ))}

              <TouchableOpacity style={styles.applyBtn} onPress={() => setFiltersOpen(false)} testID="market-apply-filters">
                <Text style={styles.applyText}>Show results</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 10,
  },
  title: { color: theme.textPrimary, fontSize: 24, fontWeight: "800", letterSpacing: -0.4, flex: 1, textAlign: "center" },
  headerIconBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  headerIconBtnActive: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  sectionLabel: {
    color: theme.textMuted, fontSize: 11, fontWeight: "800",
    textTransform: "uppercase", letterSpacing: 0.6,
    paddingHorizontal: 4, paddingVertical: 8,
  },
  tile: {
    flex: 1, borderRadius: 18, overflow: "hidden",
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
  },
  tileImg: { width: "100%", aspectRatio: 1, backgroundColor: theme.surfaceAlt },
  tileImgPlaceholder: { alignItems: "center", justifyContent: "center" },
  tileBody: { paddingHorizontal: 13, paddingVertical: 13, gap: 4 },
  tilePrice: { color: theme.textPrimary, fontSize: 18, fontWeight: "900", letterSpacing: -0.3 },
  tileTitle: { color: theme.textPrimary, fontSize: 14.5, lineHeight: 19 },
  tileLocRow: { flexDirection: "row", alignItems: "center", gap: 3, marginTop: 1 },
  tileLoc: { color: theme.textMuted, fontSize: 11.5, flex: 1 },
  soldTag: { position: "absolute", top: 8, left: 8, backgroundColor: theme.error, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  soldTagText: { color: "#fff", fontSize: 10, fontWeight: "900", letterSpacing: 0.5 },
  savedTag: { position: "absolute", top: 8, right: 8, width: 24, height: 24, borderRadius: 12, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },

  searchRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 },
  filterBtn: {
    width: 44, height: 44, borderRadius: 14,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  filterBtnActive: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  filterDot: { position: "absolute", top: 8, right: 8, width: 8, height: 8, borderRadius: 4, backgroundColor: theme.primary },
  filterHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  resetText: { color: theme.primary, fontSize: 14, fontWeight: "700" },
  priceRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  priceInput: {
    flex: 1, height: 46, backgroundColor: theme.surfaceAlt, borderRadius: 12,
    borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14,
    color: theme.textPrimary, fontSize: 15,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  priceDash: { color: theme.textMuted, fontSize: 16 },
  tabs: {
    flexDirection: "row", gap: 8,
    marginHorizontal: 16, marginTop: 10, marginBottom: 6,
    backgroundColor: theme.surface, borderRadius: 14, padding: 5,
    borderWidth: 1, borderColor: theme.border,
  },
  tab: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 9, borderRadius: 10 },
  tabActive: { backgroundColor: theme.surfaceAlt },
  tabText: { fontSize: 13.5, fontWeight: "700" },
  filterLabel: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 14, marginBottom: 8 },
  condWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  applyBtn: { marginTop: 20, paddingVertical: 14, borderRadius: 14, backgroundColor: theme.primary, alignItems: "center" },
  applyText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  condChip: {
    flexShrink: 0, height: 30, paddingHorizontal: 12, borderRadius: 15,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  condChipActive: { borderColor: theme.primary },
  condChipText: { fontSize: 12, fontWeight: "700" },
  photoThumb: {
    width: 80, height: 80, borderRadius: 12, overflow: "hidden",
    backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border,
  },
  photoRemove: {
    position: "absolute", top: 3, right: 3, width: 20, height: 20, borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center",
  },
  photoAdd: {
    width: 80, height: 80, borderRadius: 12, gap: 2,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderStyle: "dashed",
    alignItems: "center", justifyContent: "center",
  },
  photoAddText: { color: theme.primary, fontSize: 11, fontWeight: "700" },
  sortRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 14 },
  sortRowText: { color: theme.textPrimary, fontSize: 15, fontWeight: "600" },
  searchPill: {
    flex: 1, height: 44,
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.surface, borderRadius: 14,
    paddingHorizontal: 14,
    borderWidth: 1, borderColor: theme.border,
  },
  searchInput: {
    flex: 1, color: theme.textPrimary, fontSize: 15,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  chipRow: { gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  chip: {
    flexShrink: 0, height: 36, paddingHorizontal: 14,
    borderRadius: 18, backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  chipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  chipText: { fontSize: 13, fontWeight: "700" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { paddingTop: 80, alignItems: "center", gap: 10 },
  emptyTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "700" },
  emptySub: { color: theme.textSecondary, fontSize: 13 },
  fab: {
    position: "absolute", right: 20,
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 14, elevation: 8,
  },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#0E0E10",
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingTop: 12, paddingHorizontal: 20,
    borderTopWidth: 1, borderColor: theme.border,
  },
  sheetHandle: {
    alignSelf: "center", width: 40, height: 4, borderRadius: 2,
    backgroundColor: theme.borderStrong, marginBottom: 16,
  },
  sheetTitle: { color: theme.textPrimary, fontSize: 20, fontWeight: "800", marginBottom: 12 },
  label: { color: theme.textSecondary, fontSize: 12, fontWeight: "700", marginTop: 12, marginBottom: 6 },
  input: {
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    color: theme.textPrimary, fontSize: 14,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  postBtn: {
    marginTop: 20, paddingVertical: 14, borderRadius: 14,
    backgroundColor: theme.primary, alignItems: "center",
  },
  postBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
