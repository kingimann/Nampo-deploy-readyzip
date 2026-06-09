import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image, ActivityIndicator, RefreshControl,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, Listing, MarketplaceReview, SellerProfile } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import { GLASS } from "@/src/lib/glass";

type Tab = "listings" | "saved" | "reviews";

function Stars({ rating, size = 14 }: { rating: number; size?: number }) {
  return (
    <View style={{ flexDirection: "row", gap: 1 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Ionicons
          key={i}
          name={rating >= i ? "star" : rating >= i - 0.5 ? "star-half" : "star-outline"}
          size={size}
          color="#F5A623"
        />
      ))}
    </View>
  );
}

export default function MyMarketplaceScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("listings");
  const [profile, setProfile] = useState<SellerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saved, setSaved] = useState<Listing[] | null>(null);
  const [reviews, setReviews] = useState<MarketplaceReview[] | null>(null);

  const load = useCallback(async () => {
    if (!user?.user_id) { setLoading(false); return; }
    try { setProfile(await api.getSellerProfile(user.user_id)); }
    catch {} finally { setLoading(false); setRefreshing(false); }
  }, [user?.user_id]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const loadSaved = useCallback(async () => {
    try { setSaved(await api.listSavedListings()); } catch { setSaved([]); }
  }, []);
  const loadReviews = useCallback(async () => {
    if (!user?.user_id) return;
    try { setReviews(await api.listSellerReviews(user.user_id)); } catch { setReviews([]); }
  }, [user?.user_id]);

  const switchTab = (t: Tab) => {
    setTab(t);
    if (t === "saved" && saved == null) loadSaved();
    if (t === "reviews" && reviews == null) loadReviews();
  };

  const photoOf = (l: Listing) => (l.photos?.length ? l.photos[0] : l.photo_base64) || null;
  const openListing = (l: Listing) => router.push({ pathname: "/listing/[id]", params: { id: l.id } });

  const renderTile = ({ item }: { item: Listing }) => (
    <TouchableOpacity style={styles.tile} activeOpacity={0.85} onPress={() => openListing(item)} testID={`mm-listing-${item.id}`}>
      <View style={styles.tileImgWrap}>
        {photoOf(item) ? (
          <Image source={{ uri: photoOf(item)! }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <Ionicons name="image-outline" size={26} color={theme.textMuted} />
        )}
        {item.status === "sold" && <View style={styles.soldTag}><Text style={styles.soldText}>SOLD</Text></View>}
      </View>
      <View style={styles.tileBody}>
        <Text style={styles.tilePrice}>{item.price > 0 ? `$${item.price.toFixed(0)}` : "Free"}</Text>
        <Text style={styles.tileTitle} numberOfLines={1}>{item.title}</Text>
      </View>
    </TouchableOpacity>
  );

  const listings = profile?.listings || [];
  const gridData: Listing[] = tab === "listings" ? listings : tab === "saved" ? (saved || []) : [];

  const segment = (
    <>
      <View style={styles.summary}>
        <View style={styles.avatar}>
          {user?.picture
            ? <Image source={{ uri: user.picture }} style={styles.avatarImg} />
            : <Text style={styles.avatarInit}>{(user?.name?.[0] || "?").toUpperCase()}</Text>}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>{user?.name}</Text>
          <View style={styles.ratingRow}>
            <Stars rating={profile?.rating || 0} />
            <Text style={styles.ratingText}>
              {profile?.review_count
                ? `${(profile.rating || 0).toFixed(1)} · ${profile.review_count} review${profile.review_count === 1 ? "" : "s"}`
                : "No reviews yet"}
            </Text>
          </View>
          <Text style={styles.countText}>
            {(profile?.listing_count ?? listings.length)} listing{(profile?.listing_count ?? listings.length) === 1 ? "" : "s"}
          </Text>
        </View>
      </View>

      <View style={styles.segment}>
        {(([["listings", "Listings"], ["saved", "Saved"], ["reviews", "Reviews"]]) as [Tab, string][]).map(([k, label]) => (
          <TouchableOpacity key={k} style={[styles.segItem, tab === k && styles.segItemOn]} onPress={() => switchTab(k)} testID={`mm-tab-${k}`}>
            <Text style={[styles.segText, { color: tab === k ? theme.textPrimary : theme.textMuted }]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === "reviews" && (
        reviews == null ? (
          <View style={{ paddingVertical: 30 }}><ActivityIndicator color={theme.primary} /></View>
        ) : reviews.length === 0 ? (
          <Text style={styles.emptyInline}>No marketplace reviews yet. Reviews from buyers and sellers you trade with show up here.</Text>
        ) : (
          reviews.map((r) => (
            <View key={r.id} style={styles.reviewCard}>
              <View style={styles.reviewTop}>
                <View style={styles.reviewAvatar}>
                  {r.reviewer?.picture
                    ? <Image source={{ uri: r.reviewer.picture }} style={styles.avatarImg} />
                    : <Text style={styles.reviewInit}>{(r.reviewer?.name?.[0] || "?").toUpperCase()}</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.reviewName} numberOfLines={1}>{r.reviewer?.name || "Someone"}</Text>
                  <Stars rating={r.rating} size={12} />
                </View>
                {!!r.role && <Text style={styles.roleTag}>{r.role === "seller" ? "As seller" : "As buyer"}</Text>}
              </View>
              {!!r.text && <Text style={styles.reviewText}>{r.text}</Text>}
            </View>
          ))
        )
      )}
    </>
  );

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="my-marketplace-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack("/(tabs)/marketplace")} style={styles.iconBtn} testID="mm-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Marketplace</Text>
        <TouchableOpacity onPress={() => router.push("/(tabs)/marketplace")} style={styles.iconBtn} testID="mm-new">
          <Ionicons name="add" size={26} color={theme.primary} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          key={tab === "reviews" ? "rev" : "grid"}   // numColumns change requires a remount
          data={gridData}
          keyExtractor={(i) => i.id}
          numColumns={tab === "reviews" ? 1 : 2}
          columnWrapperStyle={tab === "reviews" ? undefined : { gap: 12 }}
          renderItem={renderTile}
          ListHeaderComponent={segment}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); if (tab === "saved") loadSaved(); if (tab === "reviews") loadReviews(); }}
              tintColor={theme.primary}
            />
          }
          contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 10, paddingBottom: insets.bottom + 24, gap: 12 }}
          ListEmptyComponent={
            tab === "reviews" ? null : (
              <View style={styles.empty}>
                <View style={styles.emptyIcon}>
                  <Ionicons name={tab === "saved" ? "bookmark-outline" : "pricetags-outline"} size={28} color={theme.textMuted} />
                </View>
                <Text style={styles.emptyTitle}>{tab === "saved" ? "No saved listings" : "No listings yet"}</Text>
                <Text style={styles.emptySub}>
                  {tab === "saved" ? "Tap the bookmark on any listing to keep it here." : "Items you post on Marketplace show up here."}
                </Text>
                {tab !== "saved" && (
                  <TouchableOpacity style={styles.emptyBtn} onPress={() => router.push("/(tabs)/marketplace")} testID="mm-create">
                    <Text style={styles.emptyBtnText}>Create a listing</Text>
                  </TouchableOpacity>
                )}
              </View>
            )
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 8, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  summary: {
    flexDirection: "row", alignItems: "center", gap: 14,
    ...GLASS, borderRadius: 18, borderWidth: 1, borderColor: theme.border,
    padding: 14, marginBottom: 12,
  },
  avatar: {
    width: 60, height: 60, borderRadius: 30, overflow: "hidden",
    backgroundColor: theme.primary, alignItems: "center", justifyContent: "center",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontSize: 24, fontWeight: "800" },
  name: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  ratingRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  ratingText: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "600" },
  countText: { color: theme.textMuted, fontSize: 12.5, marginTop: 4 },

  segment: {
    flexDirection: "row", gap: 4,
    ...GLASS, borderRadius: 14, borderWidth: 1, borderColor: theme.border,
    padding: 4, marginBottom: 14,
  },
  segItem: { flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  segItemOn: { backgroundColor: theme.surfaceAlt },
  segText: { fontSize: 13.5, fontWeight: "800" },

  tile: {
    flex: 1, borderRadius: 16, overflow: "hidden",
    ...GLASS, borderWidth: 1, borderColor: theme.border,
  },
  tileImgWrap: { width: "100%", aspectRatio: 1, backgroundColor: theme.surfaceAlt, alignItems: "center", justifyContent: "center" },
  soldTag: { position: "absolute", top: 8, left: 8, backgroundColor: theme.error, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  soldText: { color: "#fff", fontSize: 10, fontWeight: "900", letterSpacing: 0.5 },
  tileBody: { paddingHorizontal: 12, paddingVertical: 11, gap: 3 },
  tilePrice: { color: theme.textPrimary, fontSize: 16, fontWeight: "900", letterSpacing: -0.3 },
  tileTitle: { color: theme.textSecondary, fontSize: 13.5 },

  reviewCard: {
    ...GLASS, borderRadius: 14, borderWidth: 1, borderColor: theme.border,
    padding: 14, marginBottom: 10,
  },
  reviewTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  reviewAvatar: { width: 38, height: 38, borderRadius: 19, overflow: "hidden", backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  reviewInit: { color: "#fff", fontSize: 15, fontWeight: "800" },
  reviewName: { color: theme.textPrimary, fontSize: 14, fontWeight: "700", marginBottom: 2 },
  roleTag: { color: theme.textMuted, fontSize: 11, fontWeight: "700" },
  reviewText: { color: theme.textSecondary, fontSize: 13.5, lineHeight: 19, marginTop: 10 },

  emptyInline: { color: theme.textMuted, fontSize: 13.5, textAlign: "center", lineHeight: 19, paddingVertical: 30, paddingHorizontal: 16 },
  empty: { alignItems: "center", paddingTop: 50, paddingHorizontal: 30, gap: 8 },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, ...GLASS, borderWidth: 1, borderColor: theme.border, alignItems: "center", justifyContent: "center", marginBottom: 6 },
  emptyTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  emptySub: { color: theme.textMuted, fontSize: 13.5, textAlign: "center", lineHeight: 19 },
  emptyBtn: { marginTop: 12, backgroundColor: theme.primary, borderRadius: 12, paddingHorizontal: 22, paddingVertical: 11 },
  emptyBtnText: { color: "#fff", fontSize: 14, fontWeight: "800" },
});
