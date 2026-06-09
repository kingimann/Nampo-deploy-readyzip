import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  ActivityIndicator, RefreshControl, Modal, KeyboardAvoidingView,
  Platform, Image, ScrollView, Animated, Easing, Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@/src/platform/icons";
import { useFocusEffect, useRouter, useLocalSearchParams } from "@/src/platform/navigation";
import * as ImagePicker from "@/src/platform/image-picker";
import { pickImages } from "@/src/utils/thumbnail";
import * as Location from "@/src/platform/location";
import { api, Listing } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import { GLASS } from "@/src/lib/glass";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";
import RestrictionBanner from "@/src/components/RestrictionBanner";
import FadeIn from "@/src/components/FadeIn";

const CATEGORIES = [
  { key: "all", label: "All" },
  { key: "electronics", label: "Electronics" },
  { key: "furniture", label: "Furniture" },
  { key: "fashion", label: "Fashion" },
  { key: "vehicles", label: "Vehicles" },
  { key: "home", label: "Home & Garden" },
  { key: "appliances", label: "Appliances" },
  { key: "toys", label: "Toys & Games" },
  { key: "sports", label: "Sports & Outdoors" },
  { key: "books", label: "Books & Media" },
  { key: "music", label: "Music & Instruments" },
  { key: "beauty", label: "Beauty & Health" },
  { key: "baby", label: "Baby & Kids" },
  { key: "pets", label: "Pets" },
  { key: "tools", label: "Tools" },
  { key: "collectibles", label: "Collectibles & Art" },
  { key: "tickets", label: "Tickets & Events" },
  { key: "services", label: "Services" },
  { key: "property", label: "Property & Rentals" },
  { key: "free", label: "Free Stuff" },
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
  { key: "nearby", label: "Nearest first" },
  { key: "price_low", label: "Price: low to high" },
  { key: "price_high", label: "Price: high to low" },
];

const RADII = [
  { km: 2, label: "2 km" },
  { km: 5, label: "5 km" },
  { km: 10, label: "10 km" },
  { km: 25, label: "25 km" },
  { km: 50, label: "50 km" },
  { km: 100, label: "100 km" },
  { km: 0, label: "Any distance" },
];

const DELIVERY = [
  { key: "pickup", label: "Pickup", icon: "walk-outline" as const },
  { key: "shipping", label: "Shipping", icon: "cube-outline" as const },
  { key: "both", label: "Both", icon: "swap-horizontal-outline" as const },
];

const MAX_PHOTOS = 6;

const EMPTY_DRAFT = {
  title: "", price: "", category: "other", condition: "used", description: "",
  photos: [] as string[], brand: "", quantity: "1", negotiable: false,
  delivery: "pickup", lng: null as number | null, lat: null as number | null, locality: "",
  contactEmail: "", contactPhone: "",
};

// Shimmering placeholder grid shown while listings load — keeps the layout
// stable instead of flashing a bare spinner.
function SkeletonTiles() {
  const pulse = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [pulse]);
  return (
    <View style={styles.skelWrap}>
      {Array.from({ length: 6 }).map((_, i) => (
        <Animated.View key={i} style={[styles.skelTile, { opacity: pulse }]}>
          <View style={styles.skelImg} />
          <View style={styles.skelBody}>
            <View style={[styles.skelLine, { width: "42%", height: 16 }]} />
            <View style={[styles.skelLine, { width: "88%" }]} />
            <View style={[styles.skelLine, { width: "55%" }]} />
          </View>
        </Animated.View>
      ))}
    </View>
  );
}

export default function MarketplaceScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const marketOff = !!user?.marketplace_disabled;
  const insets = useSafeAreaInsets();
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [sort, setSort] = useState("recent");
  const [condFilter, setCondFilter] = useState("all");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [savedView, setSavedView] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [draft, setDraft] = useState({ ...EMPTY_DRAFT });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [picker, setPicker] = useState<null | "category" | "condition">(null);
  const [posting, setPosting] = useState(false);
  const [postErr, setPostErr] = useState<string | null>(null);
  // Location + radius (Facebook-Marketplace style).
  const [coords, setCoords] = useState<[number, number] | null>(null);
  const [locality, setLocality] = useState("");
  const [radius, setRadius] = useState(0); // km; 0 = any distance
  const [locating, setLocating] = useState(false);

  const filtersActive = cat !== "all" || condFilter !== "all" || sort !== "recent" || !!minPrice || !!maxPrice || (!!coords && radius > 0);
  const activeFilterCount =
    (cat !== "all" ? 1 : 0) +
    (condFilter !== "all" ? 1 : 0) +
    (sort !== "recent" ? 1 : 0) +
    (minPrice || maxPrice ? 1 : 0) +
    (coords && radius > 0 ? 1 : 0);

  // Resolve the device location + a human-readable locality.
  const detectLocation = useCallback(async (prompt = true): Promise<{ coords: [number, number]; locality: string } | null> => {
    try {
      // On web the expo-location permission methods don't reliably prompt — the
      // browser only asks when you actually request a position. So on web we skip
      // the permission dance (except to avoid prompting on first mount) and call
      // getCurrentPositionAsync directly, which triggers the browser prompt.
      if (Platform.OS !== "web") {
        let { status } = await Location.getForegroundPermissionsAsync();
        if (status !== "granted") {
          if (!prompt) return null;  // don't prompt on first mount — only on tap
          const req = await Location.requestForegroundPermissionsAsync();
          status = req.status;
        }
        if (status !== "granted") return null;
      } else if (!prompt) {
        return null;  // don't trigger the browser prompt on first mount
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const c: [number, number] = [pos.coords.longitude, pos.coords.latitude];
      let loc = "";
      try {
        const places = await Location.reverseGeocodeAsync({ latitude: c[1], longitude: c[0] });
        const p = places?.[0];
        if (p) loc = [p.city || p.subregion || p.district, p.region].filter(Boolean).join(", ");
      } catch {}
      return { coords: c, locality: loc };
    } catch { return null; }
  }, []);

  const useMyLocation = useCallback(async () => {
    setLocating(true);
    const r = await detectLocation();
    if (r) { setCoords(r.coords); setLocality(r.locality); }
    setLocating(false);
  }, [detectLocation]);

  const load = useCallback(async () => {
    try {
      const list = savedView
        ? await api.listSavedListings()
        : await api.listListings({
            category: cat === "all" ? undefined : cat, q: debouncedQ, sort,
            condition: condFilter === "all" ? undefined : condFilter,
            min_price: minPrice ? Number(minPrice) : undefined,
            max_price: maxPrice ? Number(maxPrice) : undefined,
            lat: coords ? coords[1] : undefined,
            lng: coords ? coords[0] : undefined,
            radius_km: coords && radius > 0 ? radius : undefined,
          });
      setListings(list);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [cat, debouncedQ, sort, condFilter, minPrice, maxPrice, savedView, coords, radius]);

  const resetFilters = () => {
    setCat("all"); setCondFilter("all"); setSort("recent"); setMinPrice(""); setMaxPrice(""); setRadius(0);
  };

  // Debounce the search box so typing doesn't refetch (and flash the grid) on
  // every keystroke — the query only applies ~350ms after you stop typing.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  // On first mount, use the location only if permission is already granted —
  // no prompt. Tapping "Set your location" / "Use my location" prompts.
  useEffect(() => {
    (async () => {
      const r = await detectLocation(false);
      if (r) { setCoords(r.coords); setLocality(r.locality); }
    })();
  }, [detectLocation]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const pickPhotos = async () => {
    if (draft.photos.length >= MAX_PHOTOS) return;
    // pickImages uploads to the Cloudinary CDN when configured (URLs), else
    // falls back to base64 — so listing photos no longer bloat the database.
    const added = await pickImages(MAX_PHOTOS - draft.photos.length);
    if (added.length) setDraft((d) => ({ ...d, photos: [...d.photos, ...added].slice(0, MAX_PHOTOS) }));
  };

  const [locatingDraft, setLocatingDraft] = useState(false);
  const detectDraftLocation = async () => {
    setLocatingDraft(true);
    const r = await detectLocation();
    setLocatingDraft(false);
    if (r) setDraft((d) => ({ ...d, lng: r.coords[0], lat: r.coords[1], locality: r.locality }));
    else Alert.alert("Couldn't get your location", "Allow location access in your browser/device settings and try again.");
  };

  const openCompose = () => {
    setEditingId(null);
    setDraft({ ...EMPTY_DRAFT });
    // Prefill the listing location from the browse location when available.
    setDraft((d) => (d.lat == null && coords ? { ...d, lng: coords[0], lat: coords[1], locality } : d));
    setComposeOpen(true);
  };

  // Prefill the compose sheet from an existing listing → edit mode.
  const openEditListing = useCallback((l: Listing) => {
    setEditingId(l.id);
    setPostErr(null);
    setDraft({
      title: l.title || "",
      price: l.price != null ? String(l.price) : "",
      category: l.category || "other",
      condition: l.condition || "used",
      description: l.description || "",
      photos: l.photos?.length ? l.photos : (l.photo_base64 ? [l.photo_base64] : []),
      brand: l.brand || "",
      quantity: String(l.quantity || 1),
      negotiable: !!l.negotiable,
      delivery: l.delivery || "pickup",
      lng: l.longitude ?? null,
      lat: l.latitude ?? null,
      locality: l.locality || "",
      contactEmail: l.contact_email || "",
      contactPhone: l.contact_phone || "",
    });
    setComposeOpen(true);
  }, []);

  // Deep-link: /marketplace?edit=<id> opens that listing in edit mode.
  const { edit } = useLocalSearchParams<{ edit?: string }>();
  useEffect(() => {
    if (!edit) return;
    (async () => {
      try { openEditListing(await api.getListing(String(edit))); } catch {}
      router.setParams({ edit: undefined });
    })();
  }, [edit, openEditListing]);

  const submit = async () => {
    const title = draft.title.trim();
    if (!title) return;
    setPosting(true); setPostErr(null);
    const body = {
      title,
      price: Number(draft.price) || 0,
      category: draft.category,
      condition: draft.condition,
      description: draft.description.trim(),
      photos: draft.photos,
      brand: draft.brand.trim() || undefined,
      quantity: Math.max(1, Number(draft.quantity) || 1),
      negotiable: draft.negotiable,
      delivery: draft.delivery,
      longitude: draft.lng ?? undefined,
      latitude: draft.lat ?? undefined,
      locality: draft.locality || undefined,
      contact_email: draft.contactEmail.trim() || undefined,
      contact_phone: draft.contactPhone.trim() || undefined,
    };
    try {
      if (editingId) {
        const p = await api.updateListing(editingId, body);
        setListings((x) => x.map((l) => (l.id === p.id ? p : l)));
      } else {
        const p = await api.createListing(body);
        setListings((x) => [p, ...x]);
      }
      setDraft({ ...EMPTY_DRAFT });
      setEditingId(null);
      setComposeOpen(false);
    } catch (e: any) {
      setPostErr(String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setPosting(false); }
  };

  const openListing = (l: Listing) =>
    router.push({ pathname: "/listing/[id]", params: { id: l.id } });

  // ── Floating top bar that hides on scroll-down and returns on scroll-up,
  //    mirroring the feed + the bottom LiquidTabBar. ──
  const [topHidden, setTopHidden] = useState(false);
  const [topBarH, setTopBarH] = useState(160);  // measured; default avoids initial overlap
  const topHide = useRef(new Animated.Value(0)).current;  // 0 = shown, 1 = hidden
  const lastScrollY = useRef(0);
  const onScroll = useCallback((e: any) => {
    const y = e?.nativeEvent?.contentOffset?.y ?? 0;
    const dy = y - lastScrollY.current;
    if (y <= 4) setTopHidden(false);
    else if (dy > 6) setTopHidden(true);
    else if (dy < -6) setTopHidden(false);
    lastScrollY.current = y;
  }, []);
  useEffect(() => {
    Animated.timing(topHide, {
      toValue: topHidden ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [topHidden, topHide]);
  useFocusEffect(useCallback(() => { setTopHidden(false); lastScrollY.current = 0; }, []));

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="marketplace-screen">
      {/* Floating frosted top bar — hides on scroll-down, returns on scroll-up,
          mirroring the feed + the bottom LiquidTabBar. */}
      <Animated.View
        onLayout={(e) => setTopBarH(e.nativeEvent.layout.height)}
        pointerEvents={topHidden ? "none" : "box-none"}
        style={[
          styles.topBar,
          GLASS,
          {
            opacity: topHide.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 0.25, 0] }),
            transform: [{ translateY: topHide.interpolate({ inputRange: [0, 1], outputRange: [0, -(topBarH + insets.top + 14)] }) }],
          },
        ]}
      >
      <View style={styles.header}>
        <SidebarMenuButton />
        <Text style={styles.title}>{savedView ? "Saved" : "Marketplace"}</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TouchableOpacity
            onPress={() => { if (marketOff) return; openCompose(); }}
            disabled={marketOff}
            style={[styles.headerIconBtn, marketOff && { opacity: 0.4 }]}
            testID="market-create"
          >
            <Ionicons name="add" size={24} color={theme.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push("/my-marketplace")}
            style={styles.headerIconBtn}
            testID="market-profile"
          >
            <Ionicons name="storefront-outline" size={20} color={theme.textPrimary} />
          </TouchableOpacity>
        </View>
      </View>

      <RestrictionBanner kind="marketplace" />

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
            {activeFilterCount > 0 && (
              <View style={styles.filterBadge}>
                <Text style={styles.filterBadgeText}>{activeFilterCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        )}
      </View>

      </Animated.View>

      {loading ? (
        <View style={{ paddingTop: topBarH }}><SkeletonTiles /></View>
      ) : (
        <FlatList
          data={listings}
          keyExtractor={(i) => i.id}
          numColumns={2}
          columnWrapperStyle={{ gap: 14 }}
          onScroll={onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: topBarH + 8, paddingBottom: insets.bottom + 90, gap: 18 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} />
          }
          ListEmptyComponent={
            savedView ? (
              <View style={styles.empty}>
                <View style={styles.emptyIcon}><Ionicons name="bookmark-outline" size={30} color={theme.textMuted} /></View>
                <Text style={styles.emptyTitle}>No saved listings</Text>
                <Text style={styles.emptySub}>Tap the bookmark on any listing to keep it here for later.</Text>
              </View>
            ) : (filtersActive || !!q) ? (
              <View style={styles.empty}>
                <View style={styles.emptyIcon}><Ionicons name="search-outline" size={30} color={theme.textMuted} /></View>
                <Text style={styles.emptyTitle}>No matches</Text>
                <Text style={styles.emptySub}>Try a different search or widen your filters.</Text>
                <TouchableOpacity style={styles.emptyBtn} onPress={() => { resetFilters(); setQ(""); }} testID="market-empty-clear">
                  <Text style={styles.emptyBtnText}>Clear filters</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.empty}>
                <View style={styles.emptyIcon}><Ionicons name="storefront-outline" size={30} color={theme.textMuted} /></View>
                <Text style={styles.emptyTitle}>No listings yet</Text>
                <Text style={styles.emptySub}>Be the first to sell something in your area.</Text>
                {!marketOff && (
                  <TouchableOpacity style={styles.emptyBtn} onPress={openCompose} testID="market-empty-create">
                    <Text style={styles.emptyBtnText}>Create a listing</Text>
                  </TouchableOpacity>
                )}
              </View>
            )
          }
          renderItem={({ item, index }) => (
            <FadeIn animateKey={item.id} delay={Math.min(index, 8) * 40} style={{ flex: 1 }}>
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
                {item.seller?.id_verified && (
                  <View style={styles.verifiedTag} testID={`listing-verified-${item.id}`}>
                    <Ionicons name="shield-checkmark" size={11} color="#fff" />
                    <Text style={styles.verifiedTagText}>ID</Text>
                  </View>
                )}
              </View>
              <View style={styles.tileBody}>
                <View style={styles.tilePriceRow}>
                  <Text style={styles.tilePrice}>
                    {item.price > 0 ? `$${item.price.toFixed(0)}` : "Free"}
                  </Text>
                  {item.negotiable && <Text style={styles.oboTag}>OBO</Text>}
                </View>
                <Text style={styles.tileTitle} numberOfLines={2}>{item.title}</Text>
                {(item.distance_km != null || !!item.locality) && (
                  <View style={styles.tileLocRow}>
                    <Ionicons name="location-outline" size={11} color={theme.textMuted} />
                    <Text style={styles.tileLoc} numberOfLines={1}>
                      {item.distance_km != null
                        ? `${item.distance_km} km away${item.locality ? ` · ${item.locality}` : ""}`
                        : item.locality}
                    </Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
            </FadeIn>
          )}
        />
      )}

      <Modal visible={composeOpen} transparent animationType="slide" onRequestClose={() => { setComposeOpen(false); setEditingId(null); }}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.modalBackdrop}
        >
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => { setComposeOpen(false); setEditingId(null); }} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 24, maxHeight: "85%" }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>{editingId ? "Edit listing" : "New listing"}</Text>
            <ScrollView keyboardShouldPersistTaps="handled">
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
              <Text style={styles.label}>Price ($)</Text>
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
              <TouchableOpacity style={styles.dropdown} onPress={() => setPicker("category")} testID="listing-category">
                <Text style={styles.dropdownText}>{CATEGORIES.find((c) => c.key === draft.category)?.label || "Select a category"}</Text>
                <Ionicons name="chevron-down" size={18} color={theme.textMuted} />
              </TouchableOpacity>
              <Text style={styles.label}>Condition</Text>
              <TouchableOpacity style={styles.dropdown} onPress={() => setPicker("condition")} testID="listing-condition">
                <Text style={styles.dropdownText}>{CONDITIONS.find((c) => c.key === draft.condition)?.label || "Select a condition"}</Text>
                <Ionicons name="chevron-down" size={18} color={theme.textMuted} />
              </TouchableOpacity>
              <Text style={styles.label}>Brand (optional)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Apple, IKEA, Nike"
                placeholderTextColor={theme.textMuted}
                value={draft.brand}
                onChangeText={(t) => setDraft({ ...draft, brand: t })}
                maxLength={80}
                testID="listing-brand-input"
              />

              <View style={styles.row2}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Quantity</Text>
                  <View style={styles.stepper}>
                    <TouchableOpacity
                      style={styles.stepBtn}
                      onPress={() => setDraft((d) => ({ ...d, quantity: String(Math.max(1, (Number(d.quantity) || 1) - 1)) }))}
                      testID="listing-qty-minus"
                    >
                      <Ionicons name="remove" size={18} color={theme.textPrimary} />
                    </TouchableOpacity>
                    <Text style={styles.stepVal}>{draft.quantity || "1"}</Text>
                    <TouchableOpacity
                      style={styles.stepBtn}
                      onPress={() => setDraft((d) => ({ ...d, quantity: String((Number(d.quantity) || 1) + 1) }))}
                      testID="listing-qty-plus"
                    >
                      <Ionicons name="add" size={18} color={theme.textPrimary} />
                    </TouchableOpacity>
                  </View>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Pricing</Text>
                  <TouchableOpacity
                    style={[styles.negChip, draft.negotiable && styles.negChipOn]}
                    onPress={() => setDraft((d) => ({ ...d, negotiable: !d.negotiable }))}
                    testID="listing-negotiable"
                  >
                    <Ionicons name={draft.negotiable ? "checkmark-circle" : "ellipse-outline"} size={18} color={draft.negotiable ? theme.primary : theme.textMuted} />
                    <Text style={[styles.negChipText, draft.negotiable && { color: theme.primary }]}>{draft.negotiable ? "Negotiable" : "Firm price"}</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <Text style={styles.label}>Delivery</Text>
              <View style={styles.segment}>
                {DELIVERY.map((d) => {
                  const a = d.key === draft.delivery;
                  return (
                    <TouchableOpacity
                      key={d.key}
                      style={[styles.segBtn, a && styles.segBtnOn]}
                      onPress={() => setDraft((dr) => ({ ...dr, delivery: d.key }))}
                      testID={`listing-delivery-${d.key}`}
                    >
                      <Ionicons name={d.icon} size={15} color={a ? "#fff" : theme.textSecondary} />
                      <Text style={[styles.segText, { color: a ? "#fff" : theme.textSecondary }]}>{d.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={styles.label}>Location</Text>
              <TouchableOpacity style={styles.locInput} onPress={detectDraftLocation} disabled={locatingDraft} testID="listing-location">
                <Ionicons name="location" size={16} color={draft.lat != null ? theme.primary : theme.textMuted} />
                <Text style={[styles.locInputText, draft.lat != null && { color: theme.textPrimary }]} numberOfLines={1}>
                  {locatingDraft ? "Getting your location…" : (draft.locality || (draft.lat != null ? "Pinned to your location" : "Tap to use my current location"))}
                </Text>
                {locatingDraft ? <ActivityIndicator size="small" color={theme.primary} /> : <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />}
              </TouchableOpacity>

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

              <Text style={styles.label}>Contact email (optional)</Text>
              <TextInput
                style={styles.input}
                placeholder="Shown publicly so buyers can reach you"
                placeholderTextColor={theme.textMuted}
                value={draft.contactEmail}
                onChangeText={(t) => setDraft({ ...draft, contactEmail: t })}
                autoCapitalize="none"
                keyboardType="email-address"
                maxLength={120}
                testID="listing-contact-email"
              />
              <Text style={styles.label}>Contact phone (optional)</Text>
              <TextInput
                style={styles.input}
                placeholder="Shown publicly so buyers can call/text"
                placeholderTextColor={theme.textMuted}
                value={draft.contactPhone}
                onChangeText={(t) => setDraft({ ...draft, contactPhone: t })}
                keyboardType="phone-pad"
                maxLength={40}
                testID="listing-contact-phone"
              />
              <Text style={styles.ageNote}>Contact details are visible to anyone viewing your listing.</Text>

              {!!postErr && <Text style={styles.postErr}>{postErr}</Text>}
              {!editingId && <Text style={styles.ageNote}>Your account must be at least 30 days old to sell.</Text>}
              <TouchableOpacity
                style={[styles.postBtn, (!draft.title.trim() || posting) && { opacity: 0.5 }]}
                onPress={submit}
                disabled={!draft.title.trim() || posting}
                testID="listing-submit"
              >
                {posting ? <ActivityIndicator color="#fff" /> : <Text style={styles.postBtnText}>{editingId ? "Save changes" : "Post listing"}</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Category / Condition dropdown picker */}
      <Modal visible={!!picker} transparent animationType="fade" onRequestClose={() => setPicker(null)}>
        <TouchableOpacity style={styles.pickerBackdrop} activeOpacity={1} onPress={() => setPicker(null)}>
          <View style={styles.pickerCard}>
            <Text style={styles.pickerTitle}>{picker === "category" ? "Category" : "Condition"}</Text>
            <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator keyboardShouldPersistTaps="handled">
            {(picker === "category" ? CATEGORIES.filter((c) => c.key !== "all") : CONDITIONS).map((o) => {
              const sel = picker === "category" ? draft.category === o.key : draft.condition === o.key;
              return (
                <TouchableOpacity
                  key={o.key}
                  style={styles.pickerRow}
                  onPress={() => { if (picker) setDraft((d) => ({ ...d, [picker]: o.key })); setPicker(null); }}
                  testID={`listing-pick-${o.key}`}
                >
                  <Text style={[styles.pickerRowText, sel && { color: theme.primary, fontWeight: "800" }]}>{o.label}</Text>
                  {sel && <Ionicons name="checkmark" size={18} color={theme.primary} />}
                </TouchableOpacity>
              );
            })}
            </ScrollView>
          </View>
        </TouchableOpacity>
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
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* Location lives inside Filters now (was a separate bar/sheet). */}
              <Text style={styles.filterLabel}>Location</Text>
              <TouchableOpacity style={styles.locateRow} onPress={useMyLocation} disabled={locating} testID="market-locate">
                <Ionicons name="navigate" size={16} color={theme.primary} />
                <Text style={styles.locateRowText} numberOfLines={1}>
                  {locality ? `Using: ${locality}` : (coords ? "Near you" : "Use my current location")}
                </Text>
                {locating && <ActivityIndicator size="small" color={theme.primary} />}
              </TouchableOpacity>
              <Text style={styles.filterSubLabel}>Distance</Text>
              {!coords && (
                <Text style={styles.radiusHint}>Set your location to filter listings by distance.</Text>
              )}
              <View style={styles.condWrap}>
                {RADII.map((r) => {
                  const a = radius === r.km;
                  return (
                    <TouchableOpacity key={r.km} onPress={() => setRadius(r.km)} style={[styles.condChip, a && styles.condChipActive]} testID={`radius-${r.km}`}>
                      <Text style={[styles.condChipText, { color: a ? theme.primary : theme.textMuted }]}>{r.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={styles.filterDivider} />

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

              <View style={styles.filterDivider} />

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

              <View style={styles.filterDivider} />

              <Text style={styles.filterLabel}>Price range ($)</Text>
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

              <View style={styles.filterDivider} />

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
  topBar: {
    position: "absolute", top: 6, left: 8, right: 8,
    borderRadius: 24,
    paddingTop: 2, paddingBottom: 6,
    zIndex: 40,
    shadowColor: "#000", shadowOpacity: 0.32, shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 10,
  },
  title: { color: theme.textPrimary, fontSize: 24, fontWeight: "800", letterSpacing: -0.4, flex: 1, textAlign: "center" },
  headerIconBtn: {
    width: 40, height: 40, borderRadius: 20,
    ...GLASS, borderWidth: 1, borderColor: theme.border,
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
    ...GLASS, borderWidth: 1, borderColor: theme.border,
    shadowColor: "#000", shadowOpacity: 0.16, shadowRadius: 7, shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  tileImg: { width: "100%", aspectRatio: 1, backgroundColor: theme.surfaceAlt },
  tileImgPlaceholder: { alignItems: "center", justifyContent: "center" },
  tileBody: { paddingHorizontal: 13, paddingVertical: 13, gap: 4 },
  tilePriceRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  oboTag: {
    color: theme.primary, fontSize: 9.5, fontWeight: "900", letterSpacing: 0.3,
    backgroundColor: theme.surfaceAlt, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2,
    overflow: "hidden",
  },
  tilePrice: { color: theme.textPrimary, fontSize: 18, fontWeight: "900", letterSpacing: -0.3 },
  tileTitle: { color: theme.textPrimary, fontSize: 14.5, lineHeight: 19 },
  tileLocRow: { flexDirection: "row", alignItems: "center", gap: 3, marginTop: 1 },
  tileLoc: { color: theme.textMuted, fontSize: 11.5, flex: 1 },
  soldTag: { position: "absolute", top: 8, left: 8, backgroundColor: theme.error, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  soldTagText: { color: "#fff", fontSize: 10, fontWeight: "900", letterSpacing: 0.5 },
  savedTag: { position: "absolute", top: 8, right: 8, width: 24, height: 24, borderRadius: 12, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  verifiedTag: { position: "absolute", bottom: 8, left: 8, flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "rgba(34,197,94,0.92)", paddingHorizontal: 7, paddingVertical: 3, borderRadius: 999 },
  verifiedTagText: { color: "#fff", fontSize: 10, fontWeight: "800", letterSpacing: 0.3 },

  searchRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 },
  filterBtn: {
    width: 44, height: 44, borderRadius: 14,
    ...GLASS, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  filterBtnActive: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  filterBadge: {
    position: "absolute", top: -5, right: -5, minWidth: 18, height: 18, borderRadius: 9,
    paddingHorizontal: 4, backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: theme.bg,
  },
  filterBadgeText: { color: "#fff", fontSize: 10.5, fontWeight: "900" },
  chipScroll: { flexGrow: 0 },
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
    ...GLASS, borderRadius: 14, padding: 5,
    borderWidth: 1, borderColor: theme.border,
  },
  tab: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 9, borderRadius: 10 },
  tabActive: { backgroundColor: theme.surfaceAlt },
  tabText: { fontSize: 13.5, fontWeight: "700" },
  filterLabel: { color: theme.textPrimary, fontSize: 14, fontWeight: "800", letterSpacing: 0.2, marginBottom: 12 },
  filterSubLabel: { color: theme.textMuted, fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 14, marginBottom: 8 },
  filterDivider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.border, marginVertical: 18 },
  condWrap: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  applyBtn: { marginTop: 20, paddingVertical: 14, borderRadius: 14, backgroundColor: theme.primary, alignItems: "center" },
  applyText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  condChip: {
    flexShrink: 0, height: 38, paddingHorizontal: 16, borderRadius: 19,
    ...GLASS, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  condChipActive: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  condChipText: { fontSize: 13.5, fontWeight: "700" },
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
    ...GLASS, borderWidth: 1, borderColor: theme.border, borderStyle: "dashed",
    alignItems: "center", justifyContent: "center",
  },
  photoAddText: { color: theme.primary, fontSize: 11, fontWeight: "700" },
  sortRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 14 },
  sortRowText: { color: theme.textPrimary, fontSize: 15, fontWeight: "600" },
  searchPill: {
    flex: 1, height: 44,
    flexDirection: "row", alignItems: "center", gap: 8,
    ...GLASS, borderRadius: 14,
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
    borderRadius: 18, ...GLASS,
    borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  chipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  chipText: { fontSize: 13, fontWeight: "700" },
  empty: { paddingTop: 90, paddingHorizontal: 40, alignItems: "center", gap: 8 },
  emptyIcon: {
    width: 64, height: 64, borderRadius: 32, marginBottom: 6,
    ...GLASS, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  emptyTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  emptySub: { color: theme.textMuted, fontSize: 13.5, textAlign: "center", lineHeight: 19 },
  emptyBtn: { marginTop: 12, backgroundColor: theme.primary, borderRadius: 12, paddingHorizontal: 22, paddingVertical: 11 },
  emptyBtnText: { color: "#fff", fontSize: 14, fontWeight: "800" },

  // Loading skeletons
  skelWrap: {
    flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between",
    paddingHorizontal: 16, paddingTop: 8, rowGap: 18,
  },
  skelTile: {
    width: "47%", borderRadius: 18, overflow: "hidden",
    ...GLASS, borderWidth: 1, borderColor: theme.border,
  },
  skelImg: { width: "100%", aspectRatio: 1, backgroundColor: theme.surfaceAlt },
  skelBody: { paddingHorizontal: 13, paddingVertical: 13, gap: 9 },
  skelLine: { height: 12, borderRadius: 6, backgroundColor: theme.surfaceAlt },
  fab: {
    position: "absolute", right: 20,
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 14, elevation: 8,
  },
  fabDisabled: { backgroundColor: theme.surfaceAlt, opacity: 0.6 },
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
    ...GLASS, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    color: theme.textPrimary, fontSize: 14,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  dropdown: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    ...GLASS, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13,
  },
  dropdownText: { color: theme.textPrimary, fontSize: 14, fontWeight: "600" },
  pickerBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", paddingHorizontal: 28 },
  pickerCard: { width: "100%", maxHeight: "70%", ...GLASS, borderRadius: 18, borderWidth: 1, borderColor: theme.border, paddingVertical: 8, paddingHorizontal: 6 },
  pickerTitle: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 6 },
  pickerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 11, borderRadius: 12 },
  pickerRowText: { color: theme.textPrimary, fontSize: 15, fontWeight: "600" },
  postBtn: {
    marginTop: 20, paddingVertical: 14, borderRadius: 14,
    backgroundColor: theme.primary, alignItems: "center",
  },
  postBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  ageNote: { color: theme.textMuted, fontSize: 12, textAlign: "center", marginTop: 16 },
  postErr: { color: theme.error, fontSize: 13, fontWeight: "600", marginBottom: 8, textAlign: "center" },

  // Location + radius bar (browse)
  locateRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: theme.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 14, paddingVertical: 12, marginBottom: 6,
  },
  locateRowText: { flex: 1, color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  radiusHint: { color: theme.textMuted, fontSize: 12, marginBottom: 4, paddingHorizontal: 2 },

  // Composer advanced fields
  row2: { flexDirection: "row", gap: 14 },
  stepper: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    ...GLASS, borderRadius: 12, borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 6, height: 46,
  },
  stepBtn: { width: 34, height: 34, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: theme.surfaceAlt },
  stepVal: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  negChip: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, height: 46,
    ...GLASS, borderRadius: 12, borderWidth: 1, borderColor: theme.border,
  },
  negChipOn: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  negChipText: { color: theme.textSecondary, fontSize: 13.5, fontWeight: "700" },
  segment: {
    flexDirection: "row", gap: 6, ...GLASS,
    borderRadius: 12, borderWidth: 1, borderColor: theme.border, padding: 5,
  },
  segBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    paddingVertical: 10, borderRadius: 9,
  },
  segBtnOn: { backgroundColor: theme.primary },
  segText: { fontSize: 13, fontWeight: "700" },
  locInput: {
    flexDirection: "row", alignItems: "center", gap: 10,
    ...GLASS, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13,
  },
  locInputText: { flex: 1, color: theme.textMuted, fontSize: 14 },
});
