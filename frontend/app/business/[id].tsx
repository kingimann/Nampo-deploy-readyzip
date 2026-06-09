import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, ActivityIndicator, Linking,
  Modal, TextInput, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, BusinessProfile, MarketplaceReview } from "@/src/api/client";
import { theme } from "@/src/theme";
import { resolveAccent, accentGradient } from "@/src/lib/profileCustomize";
import { AvatarFrame } from "@/src/components/ProfileDecor";
import { LinearGradient } from "expo-linear-gradient";

const REVIEW_CATEGORIES = [
  { key: "communication", label: "Communication" },
  { key: "as_described", label: "Item as described" },
  { key: "shipping", label: "Handoff / shipping" },
  { key: "friendliness", label: "Friendliness" },
];
const DEFAULT_RATINGS: Record<string, number> = { communication: 5, as_described: 5, shipping: 5, friendliness: 5 };

function Stars({ value, size = 14 }: { value: number; size?: number }) {
  return (
    <View style={{ flexDirection: "row", gap: 1 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Ionicons key={i} name={value >= i ? "star" : value >= i - 0.5 ? "star-half" : "star-outline"} size={size} color="#F6C455" />
      ))}
    </View>
  );
}

export default function BusinessStorefrontScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [biz, setBiz] = useState<BusinessProfile | null>(null);
  const [reviews, setReviews] = useState<MarketplaceReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [writeOpen, setWriteOpen] = useState(false);
  const [draftRatings, setDraftRatings] = useState<Record<string, number>>({ ...DEFAULT_RATINGS });
  const [draftText, setDraftText] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [b, r] = await Promise.all([
        api.getBusiness(String(id)),
        api.listBusinessReviews(String(id)).catch(() => []),
      ]);
      setBiz(b); setReviews(r); setMissing(false);
    } catch { setMissing(true); }
    finally { setLoading(false); }
  }, [id]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openReview = () => {
    setDraftRatings({ ...DEFAULT_RATINGS }); setDraftText("");
    setWriteOpen(true);
  };

  const submitReview = async () => {
    if (!id || saving) return;
    setSaving(true);
    try {
      await api.addBusinessReview(String(id), draftRatings, draftText.trim());
      setWriteOpen(false);
      await load();
    } catch {} finally { setSaving(false); }
  };

  const accent = resolveAccent(biz?.accent);

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="business-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="business-storefront-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{biz?.name || "Business"}</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : missing || !biz ? (
        <View style={styles.center}>
          <Ionicons name="storefront-outline" size={40} color={theme.textMuted} />
          <Text style={styles.emptyBig}>Storefront unavailable</Text>
          <Text style={styles.emptyText}>This business may have been closed or its owner suspended.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 30 }} showsVerticalScrollIndicator={false}>
          {biz.banner ? (
            <Image source={{ uri: biz.banner }} style={styles.cover} resizeMode="cover" />
          ) : (
            <LinearGradient colors={accentGradient(biz.accent)} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.cover} />
          )}
          <View style={styles.top}>
            <AvatarFrame frame={null} size={84} ring={3} style={{ marginTop: -46 }}>
              <View style={[styles.avatar, { backgroundColor: accent }]}>
                {biz.logo ? (
                  <Image source={{ uri: biz.logo }} style={{ width: "100%", height: "100%" }} />
                ) : (
                  <Ionicons name="business" size={34} color="#fff" />
                )}
              </View>
            </AvatarFrame>
            <Text style={styles.name}>{biz.name}</Text>
            {!!biz.category && <Text style={[styles.handle, { color: accent }]}>{biz.category}</Text>}
            {!!biz.tagline && <Text style={styles.headline} numberOfLines={2}>{biz.tagline}</Text>}
            {!!biz.bio && <Text style={styles.bio} numberOfLines={5}>{biz.bio}</Text>}

            <View style={styles.statRow}>
              <View style={styles.statCol}>
                <Stars value={biz.rating || 0} size={15} />
                <Text style={styles.statCount}>{(biz.review_count || 0) > 0 ? `${(biz.rating || 0).toFixed(1)} · ${biz.review_count}` : "No reviews"}</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statCol}>
                <Text style={styles.statNum}>{biz.listing_count || 0}</Text>
                <Text style={styles.statCount}>listing{(biz.listing_count || 0) === 1 ? "" : "s"}</Text>
              </View>
            </View>

            {!!(biz.location || biz.website || biz.contact_email) && (
              <View style={styles.metaWrap}>
                {!!biz.location && (
                  <View style={styles.metaRow}><Ionicons name="location-outline" size={14} color={theme.textMuted} /><Text style={styles.metaText}>{biz.location}</Text></View>
                )}
                {!!biz.website && (
                  <TouchableOpacity style={styles.metaRow} onPress={() => Linking.openURL(/^https?:\/\//.test(biz.website!) ? biz.website! : `https://${biz.website}`)}>
                    <Ionicons name="globe-outline" size={14} color={accent} /><Text style={[styles.metaText, { color: accent }]} numberOfLines={1}>{biz.website}</Text>
                  </TouchableOpacity>
                )}
                {!!biz.contact_email && (
                  <View style={styles.metaRow}><Ionicons name="mail-outline" size={14} color={theme.textMuted} /><Text style={styles.metaText}>{biz.contact_email}</Text></View>
                )}
              </View>
            )}

            <View style={styles.topBtns}>
              {biz.is_owner ? (
                <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: accent }]} onPress={() => router.push("/business")} testID="business-edit">
                  <Ionicons name="create-outline" size={16} color="#fff" />
                  <Text style={styles.primaryText}>Edit business</Text>
                </TouchableOpacity>
              ) : (
                !!biz.owner && (
                  <TouchableOpacity style={styles.ghostBtn} onPress={() => router.push({ pathname: "/seller/[id]", params: { id: biz.owner!.user_id } })} testID="business-owner">
                    <Ionicons name="person-outline" size={16} color={theme.primary} />
                    <Text style={styles.ghostText}>Seller profile</Text>
                  </TouchableOpacity>
                )
              )}
            </View>
          </View>

          {!!biz.policies && (
            <View style={styles.shopCard}>
              <View style={styles.shopHead}>
                <Ionicons name="receipt-outline" size={15} color={accent} />
                <Text style={styles.shopTitle}>Shop policies</Text>
              </View>
              <Text style={styles.shopText}>{biz.policies}</Text>
            </View>
          )}

          <Text style={styles.sectionTitle}>Listings</Text>
          {!biz.listings || biz.listings.length === 0 ? (
            <Text style={styles.emptyText}>No active listings.</Text>
          ) : (
            <View style={styles.grid}>
              {biz.listings.map((l) => (
                <TouchableOpacity key={l.id} style={styles.tile} onPress={() => router.push({ pathname: "/listing/[id]", params: { id: l.id } })} testID={`business-listing-${l.id}`}>
                  {l.photo_base64 ? (
                    <Image source={{ uri: l.photo_base64 }} style={styles.tileImg} resizeMode="cover" />
                  ) : (
                    <View style={[styles.tileImg, styles.tileImgPlaceholder]}><Ionicons name="image-outline" size={24} color={theme.textMuted} /></View>
                  )}
                  <Text style={styles.tilePrice}>{l.price > 0 ? `$${l.price.toFixed(0)}` : "Free"}</Text>
                  <Text style={styles.tileTitle} numberOfLines={1}>{l.title}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <View style={styles.reviewsHead}>
            <Text style={styles.sectionTitle}>Reviews</Text>
            {(biz.can_review || biz.reviewed_by_me) && (
              <TouchableOpacity style={styles.writeBtn} onPress={openReview} testID="business-write-review">
                <Ionicons name="star-outline" size={15} color={theme.primary} />
                <Text style={styles.writeBtnText}>{biz.reviewed_by_me ? "Edit review" : "Write a review"}</Text>
              </TouchableOpacity>
            )}
          </View>
          {reviews.length === 0 ? (
            <Text style={styles.emptyText}>No reviews yet. Reviews come from buyers with a verified trade with this business.</Text>
          ) : (
            <View style={{ gap: 12, paddingHorizontal: 16 }}>
              {reviews.map((r) => (
                <View key={r.id} style={styles.reviewCard}>
                  <View style={styles.reviewHead}>
                    <View style={styles.reviewAvatar}>
                      {r.reviewer.picture ? (
                        <Image source={{ uri: r.reviewer.picture }} style={{ width: "100%", height: "100%" }} />
                      ) : (
                        <Text style={styles.reviewInit}>{(r.reviewer.name?.[0] || "?").toUpperCase()}</Text>
                      )}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.reviewName}>{r.reviewer.name}</Text>
                      <Stars value={r.rating} />
                    </View>
                    {r.verified && <Ionicons name="shield-checkmark" size={14} color="#22C55E" />}
                  </View>
                  {!!r.text && <Text style={styles.reviewText}>{r.text}</Text>}
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      )}

      <Modal visible={writeOpen} transparent animationType="slide" onRequestClose={() => setWriteOpen(false)}>
        <View style={styles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => !saving && setWriteOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Rate this business</Text>
            {REVIEW_CATEGORIES.map((c) => (
              <View key={c.key} style={styles.catRow}>
                <Text style={styles.catLabel}>{c.label}</Text>
                <View style={styles.catStars}>
                  {[1, 2, 3, 4, 5].map((i) => (
                    <TouchableOpacity key={i} onPress={() => setDraftRatings((r) => ({ ...r, [c.key]: i }))} testID={`biz-star-${c.key}-${i}`}>
                      <Ionicons name={(draftRatings[c.key] || 0) >= i ? "star" : "star-outline"} size={26} color="#F6C455" />
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ))}
            <TextInput
              style={styles.reviewInput}
              placeholder="Share your experience (optional)"
              placeholderTextColor={theme.textMuted}
              value={draftText}
              onChangeText={setDraftText}
              multiline
              maxLength={1000}
              testID="biz-review-text"
            />
            <TouchableOpacity style={[styles.submitBtn, saving && { opacity: 0.6 }]} onPress={submitReview} disabled={saving} testID="biz-review-submit">
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Submit review</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, color: theme.textPrimary, fontSize: 17, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 30 },
  emptyBig: { color: theme.textPrimary, fontSize: 16, fontWeight: "800", marginTop: 4 },
  cover: { width: "100%", height: 120, backgroundColor: theme.surfaceAlt },
  top: { alignItems: "center", paddingBottom: 18, paddingHorizontal: 20, gap: 4 },
  avatar: { width: 84, height: 84, borderRadius: 42, overflow: "hidden", alignItems: "center", justifyContent: "center", marginBottom: 6 },
  name: { color: theme.textPrimary, fontSize: 22, fontWeight: "800" },
  handle: { fontSize: 13.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  headline: { color: theme.textSecondary, fontSize: 14, fontWeight: "600", textAlign: "center", marginTop: 6, paddingHorizontal: 10 },
  bio: { color: theme.textSecondary, fontSize: 13.5, textAlign: "center", marginTop: 6, lineHeight: 19, paddingHorizontal: 10 },
  statRow: { flexDirection: "row", alignItems: "center", alignSelf: "stretch", backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, paddingVertical: 12, marginTop: 12 },
  statCol: { flex: 1, alignItems: "center", gap: 3 },
  statDivider: { width: StyleSheet.hairlineWidth, alignSelf: "stretch", backgroundColor: theme.border },
  statNum: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  statCount: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "600", marginTop: 1 },
  metaWrap: { alignSelf: "stretch", gap: 6, marginTop: 12 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  metaText: { color: theme.textSecondary, fontSize: 13, fontWeight: "600", flexShrink: 1 },
  topBtns: { flexDirection: "row", gap: 10, marginTop: 14, alignSelf: "stretch" },
  primaryBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: 14, paddingVertical: 12 },
  primaryText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  ghostBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: theme.surfaceAlt, borderRadius: 14, paddingVertical: 12, borderWidth: 1, borderColor: theme.border },
  ghostText: { color: theme.primary, fontWeight: "800", fontSize: 14 },
  shopCard: { marginHorizontal: 16, marginTop: 6, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 14, gap: 6 },
  shopHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  shopTitle: { color: theme.textPrimary, fontSize: 14.5, fontWeight: "800" },
  shopText: { color: theme.textSecondary, fontSize: 13.5, lineHeight: 19 },
  sectionTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "800", paddingHorizontal: 16, marginTop: 18, marginBottom: 10 },
  emptyText: { color: theme.textMuted, fontSize: 13, paddingHorizontal: 16, textAlign: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12, paddingHorizontal: 16 },
  tile: { width: "47%", backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, overflow: "hidden" },
  tileImg: { width: "100%", aspectRatio: 1, backgroundColor: theme.surfaceAlt },
  tileImgPlaceholder: { alignItems: "center", justifyContent: "center" },
  tilePrice: { color: theme.textPrimary, fontSize: 15, fontWeight: "800", paddingHorizontal: 10, paddingTop: 8 },
  tileTitle: { color: theme.textSecondary, fontSize: 12.5, paddingHorizontal: 10, paddingBottom: 10, paddingTop: 1 },
  reviewsHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingRight: 16 },
  writeBtn: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999, backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, marginTop: 16 },
  writeBtnText: { color: theme.primary, fontSize: 12.5, fontWeight: "800" },
  reviewCard: { backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 14, gap: 8 },
  reviewHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  reviewAvatar: { width: 38, height: 38, borderRadius: 19, overflow: "hidden", backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  reviewInit: { color: "#fff", fontSize: 16, fontWeight: "700" },
  reviewName: { color: theme.textPrimary, fontSize: 14, fontWeight: "800", marginBottom: 2 },
  reviewText: { color: theme.textSecondary, fontSize: 14, lineHeight: 20 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: theme.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 12, paddingHorizontal: 18, borderTopWidth: 1, borderColor: theme.border },
  sheetHandle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 14 },
  sheetTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center", marginBottom: 14 },
  catRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  catLabel: { color: theme.textPrimary, fontSize: 14, fontWeight: "600", flex: 1 },
  catStars: { flexDirection: "row", gap: 4 },
  reviewInput: { backgroundColor: theme.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, paddingVertical: 12, minHeight: 90, textAlignVertical: "top", color: theme.textPrimary, fontSize: 14, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  submitBtn: { marginTop: 16, paddingVertical: 14, borderRadius: 14, backgroundColor: theme.primary, alignItems: "center" },
  submitText: { color: "#fff", fontWeight: "800", fontSize: 15 },
});
