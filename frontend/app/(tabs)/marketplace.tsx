import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  ActivityIndicator, RefreshControl, Modal, KeyboardAvoidingView,
  Platform, Image, ScrollView,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
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

export default function MarketplaceScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [draft, setDraft] = useState({ title: "", price: "", category: "other", description: "" });
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.listListings({ category: cat, q });
      setListings(list);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [cat, q]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { setLoading(true); load(); }, [load]);

  const submit = async () => {
    const title = draft.title.trim();
    if (!title) return;
    setPosting(true);
    try {
      const p = await api.createListing({
        title,
        price: Number(draft.price) || 0,
        category: draft.category,
        description: draft.description.trim(),
      });
      setListings((x) => [p, ...x]);
      setDraft({ title: "", price: "", category: "other", description: "" });
      setComposeOpen(false);
    } catch {} finally { setPosting(false); }
  };

  const remove = async (l: Listing) => {
    setListings((x) => x.filter((y) => y.id !== l.id));
    try { await api.deleteListing(l.id); } catch { load(); }
  };

  const contact = async (l: Listing) => {
    try {
      const conv = await api.contactSeller(l.id);
      router.push({ pathname: "/chat/[id]", params: { id: conv.id, name: conv.other_user?.name || "Seller" } });
    } catch {}
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="marketplace-screen">
      <View style={styles.header}>
        <SidebarMenuButton />
        <Text style={styles.title}>Marketplace</Text>
        <View style={{ width: 36 }} />
      </View>
      <View style={styles.searchPill}>
        <Ionicons name="search" size={16} color={theme.textSecondary} />
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
            <Ionicons name="close-circle" size={16} color={theme.textMuted} />
          </TouchableOpacity>
        )}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {CATEGORIES.map((c) => {
          const a = c.key === cat;
          return (
            <TouchableOpacity
              key={c.key}
              onPress={() => setCat(c.key)}
              style={[styles.chip, a && styles.chipActive]}
              testID={`market-cat-${c.key}`}
            >
              <Text style={[styles.chipText, { color: a ? "#fff" : theme.textSecondary }]}>{c.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={listings}
          keyExtractor={(i) => i.id}
          numColumns={2}
          columnWrapperStyle={{ gap: 10 }}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 100, gap: 10 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} />
          }
          ListHeaderComponent={
            listings.length > 0
              ? <Text style={styles.sectionLabel}>Today's picks</Text>
              : null
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="storefront-outline" size={40} color={theme.textMuted} />
              <Text style={styles.emptyTitle}>No listings yet</Text>
              <Text style={styles.emptySub}>Tap the + button to post the first one.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const mine = item.user_id === user?.user_id;
            return (
              <TouchableOpacity
                style={styles.tile}
                activeOpacity={0.85}
                onLongPress={() => mine && remove(item)}
                onPress={() => !mine && contact(item)}
                testID={`listing-${item.id}`}
              >
                {item.photo_base64 ? (
                  <Image source={{ uri: item.photo_base64 }} style={styles.tileImg} resizeMode="cover" />
                ) : (
                  <View style={[styles.tileImg, styles.tileImgPlaceholder]}>
                    <Ionicons name="image-outline" size={28} color={theme.textMuted} />
                  </View>
                )}
                <View style={styles.tileBody}>
                  <Text style={styles.tilePrice}>
                    {item.price > 0 ? `${item.currency} ${item.price.toFixed(0)}` : "Free"}
                  </Text>
                  <Text style={styles.tileTitle} numberOfLines={2}>{item.title}</Text>
                  {!!item.locality && (
                    <Text style={styles.tileLoc} numberOfLines={1}>{item.locality}</Text>
                  )}
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}

      <TouchableOpacity
        style={[styles.fab, { bottom: insets.bottom + 80 }]}
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
  sectionLabel: {
    color: theme.textMuted, fontSize: 11, fontWeight: "800",
    textTransform: "uppercase", letterSpacing: 0.6,
    paddingHorizontal: 4, paddingVertical: 8,
  },
  tile: {
    flex: 1, borderRadius: 14, overflow: "hidden",
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
  },
  tileImg: { width: "100%", aspectRatio: 1, backgroundColor: theme.surfaceAlt },
  tileImgPlaceholder: { alignItems: "center", justifyContent: "center" },
  tileBody: { padding: 10, gap: 2 },
  tilePrice: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  tileTitle: { color: theme.textSecondary, fontSize: 13, lineHeight: 17 },
  tileLoc: { color: theme.textMuted, fontSize: 11, marginTop: 2 },
  searchPill: {
    marginHorizontal: 16, marginVertical: 8,
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.surface, borderRadius: 14,
    paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1, borderColor: theme.border,
  },
  searchInput: {
    flex: 1, color: theme.textPrimary, fontSize: 14,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  chipRow: { gap: 8, paddingHorizontal: 16, paddingVertical: 4 },
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
