import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, Dimensions, Alert, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { api, Listing } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

const { width: SCREEN_W } = Dimensions.get("window");

const CONDITIONS: Record<string, string> = {
  new: "New", like_new: "Like new", good: "Good", fair: "Fair", used: "Used",
};

export default function ListingDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [photoIdx, setPhotoIdx] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try { setListing(await api.getListing(id)); }
    catch {} finally { setLoading(false); }
  }, [id]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const mine = !!listing && listing.user_id === user?.user_id;
  const photos = listing?.photos?.length ? listing.photos : (listing?.photo_base64 ? [listing.photo_base64] : []);

  const toggleSave = async () => {
    if (!listing || busy) return;
    const next = !listing.saved_by_me;
    setListing({ ...listing, saved_by_me: next, saved_count: (listing.saved_count || 0) + (next ? 1 : -1) });
    try { next ? await api.saveListing(listing.id) : await api.unsaveListing(listing.id); } catch { load(); }
  };

  const messageSeller = async () => {
    if (!listing || busy) return;
    setBusy(true);
    try {
      const conv = await api.contactSeller(listing.id);
      router.push({ pathname: "/chat/[id]", params: { id: conv.id, name: conv.other_user?.name || listing.seller.name } });
    } catch {} finally { setBusy(false); }
  };

  const toggleSold = async () => {
    if (!listing) return;
    const status = listing.status === "sold" ? "active" : "sold";
    setListing({ ...listing, status });
    try { await api.updateListing(listing.id, { status }); } catch { load(); }
  };

  const remove = () => {
    if (!listing) return;
    const doDelete = async () => { try { await api.deleteListing(listing.id); router.back(); } catch {} };
    if (Platform.OS === "web") {
      // eslint-disable-next-line no-alert
      if (typeof window !== "undefined" && window.confirm("Delete this listing?")) doDelete();
    } else {
      Alert.alert("Delete listing", "This cannot be undone.", [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doDelete },
      ]);
    }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="listing-detail-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="listing-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{listing?.title || "Listing"}</Text>
        {mine ? (
          <TouchableOpacity onPress={remove} style={styles.iconBtn} testID="listing-delete">
            <Ionicons name="trash-outline" size={20} color={theme.error} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={toggleSave} style={styles.iconBtn} testID="listing-save">
            <Ionicons name={listing?.saved_by_me ? "bookmark" : "bookmark-outline"} size={20} color={theme.primary} />
          </TouchableOpacity>
        )}
      </View>

      {loading || !listing ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 120 }} showsVerticalScrollIndicator={false}>
          {photos.length > 0 ? (
            <View>
              <ScrollView
                horizontal pagingEnabled showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={(e) => setPhotoIdx(Math.round(e.nativeEvent.contentOffset.x / SCREEN_W))}
              >
                {photos.map((p, i) => (
                  <Image key={i} source={{ uri: p }} style={{ width: SCREEN_W, height: SCREEN_W }} resizeMode="cover" />
                ))}
              </ScrollView>
              {photos.length > 1 && (
                <View style={styles.dots}>
                  {photos.map((_, i) => (
                    <View key={i} style={[styles.dot, i === photoIdx && styles.dotActive]} />
                  ))}
                </View>
              )}
              {listing.status === "sold" && (
                <View style={styles.soldBanner}><Text style={styles.soldText}>SOLD</Text></View>
              )}
            </View>
          ) : (
            <View style={[styles.noPhoto, { height: SCREEN_W * 0.6 }]}>
              <Ionicons name="image-outline" size={40} color={theme.textMuted} />
            </View>
          )}

          <View style={styles.body}>
            <Text style={styles.price}>{listing.price > 0 ? `${listing.currency} ${listing.price.toFixed(0)}` : "Free"}</Text>
            <Text style={styles.title}>{listing.title}</Text>
            <View style={styles.metaRow}>
              <View style={styles.badge}><Text style={styles.badgeText}>{CONDITIONS[listing.condition || "used"] || "Used"}</Text></View>
              <View style={styles.badge}><Text style={styles.badgeText}>{listing.category}</Text></View>
              {!!listing.locality && (
                <View style={styles.metaInline}><Ionicons name="location-outline" size={13} color={theme.textMuted} /><Text style={styles.metaText}>{listing.locality}</Text></View>
              )}
            </View>
            <Text style={styles.stats}>
              {(listing.views_count || 0)} views · {(listing.saved_count || 0)} saved
            </Text>

            {!!listing.description && (
              <>
                <Text style={styles.sectionTitle}>Description</Text>
                <Text style={styles.description}>{listing.description}</Text>
              </>
            )}

            <Text style={styles.sectionTitle}>Seller</Text>
            <TouchableOpacity
              style={styles.sellerRow}
              onPress={() => router.push({ pathname: "/user/[name]", params: { name: listing.seller.name } })}
              testID="listing-seller"
            >
              <View style={styles.sellerAvatar}>
                {listing.seller.picture ? (
                  <Image source={{ uri: listing.seller.picture }} style={{ width: "100%", height: "100%" }} />
                ) : (
                  <Text style={styles.sellerInit}>{(listing.seller.name?.[0] || "?").toUpperCase()}</Text>
                )}
              </View>
              <Text style={styles.sellerName}>{listing.seller.name}</Text>
              <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}

      {!!listing && (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
          {mine ? (
            <TouchableOpacity style={[styles.primaryBtn, listing.status === "sold" && styles.ghostBtn]} onPress={toggleSold} testID="listing-toggle-sold">
              <Ionicons name={listing.status === "sold" ? "refresh" : "checkmark-done"} size={18} color={listing.status === "sold" ? theme.primary : "#fff"} />
              <Text style={[styles.primaryText, listing.status === "sold" && { color: theme.primary }]}>
                {listing.status === "sold" ? "Mark as available" : "Mark as sold"}
              </Text>
            </TouchableOpacity>
          ) : (
            <>
              <TouchableOpacity style={styles.ghostBtn} onPress={toggleSave} testID="listing-save-2">
                <Ionicons name={listing.saved_by_me ? "bookmark" : "bookmark-outline"} size={18} color={theme.primary} />
                <Text style={[styles.primaryText, { color: theme.primary }]}>{listing.saved_by_me ? "Saved" : "Save"}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.primaryBtn, busy && { opacity: 0.6 }]} onPress={messageSeller} disabled={busy} testID="listing-message-seller">
                {busy ? <ActivityIndicator color="#fff" /> : (
                  <>
                    <Ionicons name="chatbubble" size={18} color="#fff" />
                    <Text style={styles.primaryText}>Message seller</Text>
                  </>
                )}
              </TouchableOpacity>
            </>
          )}
        </View>
      )}
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
  headerTitle: { flex: 1, color: theme.textPrimary, fontSize: 16, fontWeight: "700", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  dots: { position: "absolute", bottom: 10, left: 0, right: 0, flexDirection: "row", justifyContent: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.5)" },
  dotActive: { backgroundColor: "#fff", width: 18 },
  soldBanner: { position: "absolute", top: 14, left: 14, backgroundColor: theme.error, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 8 },
  soldText: { color: "#fff", fontWeight: "900", fontSize: 12, letterSpacing: 1 },
  noPhoto: { width: "100%", backgroundColor: theme.surfaceAlt, alignItems: "center", justifyContent: "center" },

  body: { padding: 20, gap: 12 },
  price: { color: theme.textPrimary, fontSize: 30, fontWeight: "900", letterSpacing: -0.5 },
  title: { color: theme.textPrimary, fontSize: 20, fontWeight: "700", lineHeight: 27 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 4 },
  badge: { backgroundColor: theme.surfaceAlt, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 6 },
  badgeText: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "700", textTransform: "capitalize" },
  metaInline: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { color: theme.textMuted, fontSize: 13 },
  stats: { color: theme.textMuted, fontSize: 13, marginTop: 4 },
  sectionTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "800", marginTop: 22, marginBottom: 8 },
  description: { color: theme.textSecondary, fontSize: 15.5, lineHeight: 24 },
  sellerRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface, borderRadius: 16, padding: 14,
    borderWidth: 1, borderColor: theme.border,
  },
  sellerAvatar: {
    width: 44, height: 44, borderRadius: 22, overflow: "hidden",
    backgroundColor: theme.primary, alignItems: "center", justifyContent: "center",
  },
  sellerInit: { color: "#fff", fontSize: 18, fontWeight: "700" },
  sellerName: { flex: 1, color: theme.textPrimary, fontSize: 15, fontWeight: "700" },

  footer: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingTop: 14,
    backgroundColor: theme.bg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border,
  },
  primaryBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: theme.primary, borderRadius: 15, paddingVertical: 15,
  },
  primaryText: { color: "#fff", fontWeight: "800", fontSize: 15.5 },
  ghostBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: theme.surfaceAlt, borderRadius: 15, paddingVertical: 15,
    borderWidth: 1, borderColor: theme.border,
  },
});
