import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, Modal, TextInput, Platform, Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { api, SellerProfile, MarketplaceReview } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

function Stars({ value, size = 14 }: { value: number; size?: number }) {
  return (
    <View style={{ flexDirection: "row", gap: 1 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Ionicons
          key={i}
          name={value >= i ? "star" : value >= i - 0.5 ? "star-half" : "star-outline"}
          size={size}
          color="#F6C455"
        />
      ))}
    </View>
  );
}

export default function SellerProfileScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [profile, setProfile] = useState<SellerProfile | null>(null);
  const [reviews, setReviews] = useState<MarketplaceReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [writeOpen, setWriteOpen] = useState(false);
  const [draftRating, setDraftRating] = useState(5);
  const [draftText, setDraftText] = useState("");
  const [saving, setSaving] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);

  const verifyTrade = async () => {
    if (!code.trim() || verifying) return;
    setVerifying(true);
    try {
      await api.confirmTrade(code.trim());
      setVerifyOpen(false); setCode("");
      await load();
      Alert.alert("Trade verified", "You can now leave a review for this seller.");
    } catch (e: any) {
      Alert.alert("Couldn't verify", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setVerifying(false); }
  };

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [p, r] = await Promise.all([api.getSellerProfile(id), api.listSellerReviews(id)]);
      setProfile(p); setReviews(r);
    } catch {} finally { setLoading(false); }
  }, [id]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const isMe = !!profile && profile.user.user_id === user?.user_id;

  const submitReview = async () => {
    if (!id || saving) return;
    setSaving(true);
    try {
      await api.addSellerReview(id, draftRating, draftText.trim());
      setWriteOpen(false); setDraftText(""); setDraftRating(5);
      await load();
    } catch {} finally { setSaving(false); }
  };

  const openReview = () => {
    const existing = reviews.find((r) => r.reviewer.user_id === user?.user_id);
    if (existing) { setDraftRating(existing.rating); setDraftText(existing.text || ""); }
    setWriteOpen(true);
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="seller-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="seller-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{profile?.user.name || name || "Seller"}</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading || !profile ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 30 }} showsVerticalScrollIndicator={false}>
          <View style={styles.top}>
            <View style={styles.avatar}>
              {profile.user.picture ? (
                <Image source={{ uri: profile.user.picture }} style={{ width: "100%", height: "100%" }} />
              ) : (
                <Text style={styles.avatarInit}>{(profile.user.name?.[0] || "?").toUpperCase()}</Text>
              )}
            </View>
            <Text style={styles.name}>{profile.user.name}</Text>
            {!!profile.user.username && <Text style={styles.handle}>@{profile.user.username}</Text>}
            <View style={styles.ratingRow}>
              <Stars value={profile.rating} size={16} />
              <Text style={styles.ratingText}>
                {profile.review_count > 0 ? `${profile.rating.toFixed(1)} · ${profile.review_count} review${profile.review_count === 1 ? "" : "s"}` : "No reviews yet"}
              </Text>
            </View>
            <Text style={styles.subStat}>{profile.listing_count} listing{profile.listing_count === 1 ? "" : "s"}</Text>

            <View style={styles.topBtns}>
              {!isMe && (
                <>
                  <TouchableOpacity
                    style={styles.primaryBtn}
                    onPress={() => router.push({ pathname: "/user/[name]", params: { name: profile.user.name } })}
                    testID="seller-view-profile"
                  >
                    <Ionicons name="person-outline" size={16} color="#fff" />
                    <Text style={styles.primaryText}>View profile</Text>
                  </TouchableOpacity>
                  {(profile.can_review || profile.reviewed_by_me) ? (
                    <TouchableOpacity style={styles.ghostBtn} onPress={openReview} testID="seller-write-review">
                      <Ionicons name="star-outline" size={16} color={theme.primary} />
                      <Text style={styles.ghostText}>{profile.reviewed_by_me ? "Edit review" : "Write a review"}</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity style={styles.ghostBtn} onPress={() => setVerifyOpen(true)} testID="seller-verify-trade">
                      <Ionicons name="shield-checkmark-outline" size={16} color={theme.primary} />
                      <Text style={styles.ghostText}>Verify trade</Text>
                    </TouchableOpacity>
                  )}
                </>
              )}
            </View>
          </View>

          <Text style={styles.sectionTitle}>Listings</Text>
          {profile.listings.length === 0 ? (
            <Text style={styles.emptyText}>No active listings.</Text>
          ) : (
            <View style={styles.grid}>
              {profile.listings.map((l) => (
                <TouchableOpacity
                  key={l.id}
                  style={styles.tile}
                  onPress={() => router.push({ pathname: "/listing/[id]", params: { id: l.id } })}
                  testID={`seller-listing-${l.id}`}
                >
                  {l.photo_base64 ? (
                    <Image source={{ uri: l.photo_base64 }} style={styles.tileImg} resizeMode="cover" />
                  ) : (
                    <View style={[styles.tileImg, styles.tileImgPlaceholder]}><Ionicons name="image-outline" size={24} color={theme.textMuted} /></View>
                  )}
                  <Text style={styles.tilePrice}>{l.price > 0 ? `${l.currency} ${l.price.toFixed(0)}` : "Free"}</Text>
                  <Text style={styles.tileTitle} numberOfLines={1}>{l.title}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <Text style={styles.sectionTitle}>Reviews</Text>
          {reviews.length === 0 ? (
            <Text style={styles.emptyText}>No reviews yet.</Text>
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
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Rate this seller</Text>
            <View style={styles.starPick}>
              {[1, 2, 3, 4, 5].map((i) => (
                <TouchableOpacity key={i} onPress={() => setDraftRating(i)} testID={`star-${i}`}>
                  <Ionicons name={draftRating >= i ? "star" : "star-outline"} size={34} color="#F6C455" />
                </TouchableOpacity>
              ))}
            </View>
            <TextInput
              style={styles.reviewInput}
              placeholder="Share your experience (optional)"
              placeholderTextColor={theme.textMuted}
              value={draftText}
              onChangeText={setDraftText}
              multiline
              maxLength={1000}
              testID="review-text"
            />
            <TouchableOpacity
              style={[styles.submitBtn, saving && { opacity: 0.6 }]}
              onPress={submitReview}
              disabled={saving}
              testID="review-submit"
            >
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Submit review</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={verifyOpen} transparent animationType="fade" onRequestClose={() => setVerifyOpen(false)}>
        <View style={styles.verifyBackdrop}>
          <View style={styles.verifyCard}>
            <View style={styles.verifyIcon}><Ionicons name="shield-checkmark" size={24} color={theme.primary} /></View>
            <Text style={styles.verifyTitle}>Verify your trade</Text>
            <Text style={styles.verifySub}>
              Ask {name || "the seller"} for the 6-character code from their listing, then enter it here. Reviews are only open to people who actually traded.
            </Text>
            <TextInput
              style={styles.verifyInput}
              placeholder="ABC123"
              placeholderTextColor={theme.textMuted}
              value={code}
              onChangeText={(t) => setCode(t.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={6}
              testID="verify-code-input"
            />
            <TouchableOpacity style={[styles.verifyBtn, (verifying || code.length < 6) && { opacity: 0.5 }]} onPress={verifyTrade} disabled={verifying || code.length < 6} testID="verify-submit">
              {verifying ? <ActivityIndicator color="#fff" /> : <Text style={styles.verifyBtnText}>Verify</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setVerifyOpen(false)}><Text style={styles.verifyCancel}>Cancel</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  verifyBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center", padding: 24 },
  verifyCard: { width: "100%", maxWidth: 360, backgroundColor: theme.surface, borderRadius: 20, borderWidth: 1, borderColor: theme.border, padding: 22, alignItems: "center", gap: 10 },
  verifyIcon: { width: 52, height: 52, borderRadius: 26, backgroundColor: theme.primary + "22", alignItems: "center", justifyContent: "center" },
  verifyTitle: { color: theme.textPrimary, fontSize: 19, fontWeight: "800" },
  verifySub: { color: theme.textSecondary, fontSize: 13, lineHeight: 19, textAlign: "center" },
  verifyInput: { alignSelf: "stretch", backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingVertical: 14, color: theme.textPrimary, fontSize: 22, fontWeight: "800", letterSpacing: 6, textAlign: "center", ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  verifyBtn: { alignSelf: "stretch", backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 4 },
  verifyBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  verifyCancel: { color: theme.textMuted, fontSize: 14, fontWeight: "600", marginTop: 4 },
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 8, paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, color: theme.textPrimary, fontSize: 17, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  top: { alignItems: "center", paddingVertical: 20, paddingHorizontal: 20, gap: 4 },
  avatar: {
    width: 84, height: 84, borderRadius: 42, overflow: "hidden",
    backgroundColor: theme.primary, alignItems: "center", justifyContent: "center", marginBottom: 6,
  },
  avatarInit: { color: "#fff", fontSize: 34, fontWeight: "800" },
  name: { color: theme.textPrimary, fontSize: 22, fontWeight: "800" },
  handle: { color: theme.primary, fontSize: 14, fontWeight: "700" },
  ratingRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  ratingText: { color: theme.textSecondary, fontSize: 13, fontWeight: "600" },
  subStat: { color: theme.textMuted, fontSize: 13, marginTop: 2 },
  topBtns: { flexDirection: "row", gap: 10, marginTop: 14, alignSelf: "stretch" },
  primaryBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: theme.primary, borderRadius: 14, paddingVertical: 12 },
  primaryText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  ghostBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: theme.surfaceAlt, borderRadius: 14, paddingVertical: 12, borderWidth: 1, borderColor: theme.border },
  ghostText: { color: theme.primary, fontWeight: "800", fontSize: 14 },

  sectionTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "800", paddingHorizontal: 16, marginTop: 18, marginBottom: 10 },
  emptyText: { color: theme.textMuted, fontSize: 13, paddingHorizontal: 16 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12, paddingHorizontal: 16 },
  tile: { width: "47%", backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, overflow: "hidden" },
  tileImg: { width: "100%", aspectRatio: 1, backgroundColor: theme.surfaceAlt },
  tileImgPlaceholder: { alignItems: "center", justifyContent: "center" },
  tilePrice: { color: theme.textPrimary, fontSize: 15, fontWeight: "800", paddingHorizontal: 10, paddingTop: 8 },
  tileTitle: { color: theme.textSecondary, fontSize: 12.5, paddingHorizontal: 10, paddingBottom: 10, paddingTop: 1 },

  reviewCard: { backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 14, gap: 8 },
  reviewHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  reviewAvatar: { width: 38, height: 38, borderRadius: 19, overflow: "hidden", backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  reviewInit: { color: "#fff", fontSize: 16, fontWeight: "700" },
  reviewName: { color: theme.textPrimary, fontSize: 14, fontWeight: "800", marginBottom: 2 },
  reviewText: { color: theme.textSecondary, fontSize: 14, lineHeight: 20 },

  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: theme.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 12, paddingHorizontal: 18, borderTopWidth: 1, borderColor: theme.border },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 14 },
  sheetTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center", marginBottom: 14 },
  starPick: { flexDirection: "row", justifyContent: "center", gap: 8, marginBottom: 16 },
  reviewInput: {
    backgroundColor: theme.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 14, paddingVertical: 12, minHeight: 90, textAlignVertical: "top",
    color: theme.textPrimary, fontSize: 14,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  submitBtn: { marginTop: 16, paddingVertical: 14, borderRadius: 14, backgroundColor: theme.primary, alignItems: "center" },
  submitText: { color: "#fff", fontWeight: "800", fontSize: 15 },
});
