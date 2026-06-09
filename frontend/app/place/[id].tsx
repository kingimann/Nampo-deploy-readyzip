import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, Linking, Platform, Modal, TextInput, Share, Dimensions,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, FsqProfile, Review, Place, buildPlaceKey } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

const { width: SCREEN_W } = Dimensions.get("window");

function Stars({ value, size = 14, onChange }: { value: number; size?: number; onChange?: (n: number) => void }) {
  return (
    <View style={{ flexDirection: "row", gap: onChange ? 6 : 2 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <TouchableOpacity key={i} disabled={!onChange} onPress={() => onChange?.(i)} testID={onChange ? `place-star-${i}` : undefined}>
          <Ionicons
            name={value >= i ? "star" : value >= i - 0.5 ? "star-half" : "star-outline"}
            size={onChange ? 30 : size}
            color="#F6C455"
          />
        </TouchableOpacity>
      ))}
    </View>
  );
}

const fmtAgo = (iso: string) => {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
};

const fmtDistance = (m?: number | null) =>
  m == null ? "" : m < 1000 ? `${Math.round(m)} m away` : `${(m / 1000).toFixed(1)} km away`;

export default function BusinessProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const params = useLocalSearchParams<{
    id?: string; name?: string; lng?: string; lat?: string; address?: string; category?: string;
  }>();

  const name = String(params.name || "Place");
  const lng = Number(params.lng);
  const lat = Number(params.lat);
  const address = params.address ? String(params.address) : "";
  const category = params.category ? String(params.category) : "";
  const placeKey = buildPlaceKey(name, lng, lat);

  const [profile, setProfile] = useState<FsqProfile | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [savedPlace, setSavedPlace] = useState<Place | null>(null);
  const [loading, setLoading] = useState(true);
  const [busySave, setBusySave] = useState(false);

  // Review composer
  const [reviewOpen, setReviewOpen] = useState(false);
  const [rating, setRating] = useState(5);
  const [text, setText] = useState("");
  const [savingReview, setSavingReview] = useState(false);

  const load = useCallback(async () => {
    const tasks: Promise<void>[] = [
      (async () => { try { setReviews(await api.listReviews(placeKey)); } catch {} })(),
      (async () => {
        try {
          const places = await api.listPlaces();
          const hit = places.find((p) => Math.abs(p.longitude - lng) < 1e-4 && Math.abs(p.latitude - lat) < 1e-4);
          setSavedPlace(hit || null);
        } catch {}
      })(),
    ];
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      tasks.push((async () => {
        try { setProfile(await api.fsqMatch(name, lng, lat)); } catch {}
      })());
    }
    await Promise.all(tasks);
    setLoading(false);
  }, [placeKey, name, lng, lat]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const cat = profile?.category || category;
  const ratingFsq = profile?.rating ?? null;             // Foursquare scale (0–10)
  const price = profile?.price ?? null;                  // 1–4
  const photo = profile?.photo || null;
  const addr = profile?.address || address;
  const avg = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : null;
  const myReview = reviews.find((r) => r.user_id === user?.user_id) || null;

  const directions = () =>
    router.push({ pathname: "/(tabs)/directions", params: { destLng: String(lng), destLat: String(lat), destName: name } });

  const call = () => { if (profile?.phone) Linking.openURL(`tel:${profile.phone}`).catch(() => {}); };
  const openWebsite = () => { if (profile?.website) Linking.openURL(profile.website).catch(() => {}); };
  const share = () => {
    Share.share({ message: `${name}${addr ? ` — ${addr}` : ""}` }).catch(() => {});
  };

  const toggleSave = async () => {
    if (busySave) return;
    setBusySave(true);
    try {
      if (savedPlace) {
        await api.deletePlace(savedPlace.id);
        setSavedPlace(null);
      } else {
        const created = await api.createPlace({
          title: name, notes: "", longitude: lng, latitude: lat, address: addr || "", category: "favorite",
        });
        setSavedPlace(created);
      }
    } catch {} finally { setBusySave(false); }
  };

  const openReview = () => {
    if (myReview) { setRating(myReview.rating); setText(myReview.text || ""); }
    else { setRating(5); setText(""); }
    setReviewOpen(true);
  };
  const submitReview = async () => {
    if (savingReview) return;
    setSavingReview(true);
    try {
      const r = await api.upsertReview({
        place_key: placeKey, place_name: name, longitude: lng, latitude: lat, rating, text: text.trim(),
      });
      setReviews((rs) => [r, ...rs.filter((x) => x.user_id !== r.user_id)]);
      setReviewOpen(false);
    } catch {} finally { setSavingReview(false); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="place-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="place-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{name}</Text>
        <TouchableOpacity onPress={share} style={styles.iconBtn} testID="place-share">
          <Ionicons name="share-outline" size={20} color={theme.textPrimary} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 28 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {/* Hero */}
          {photo ? (
            <Image source={{ uri: photo }} style={styles.hero} resizeMode="cover" />
          ) : (
            <View style={[styles.hero, styles.heroPlaceholder]}>
              <Ionicons name="storefront-outline" size={44} color={theme.textMuted} />
            </View>
          )}

          <View style={styles.body}>
            <Text style={styles.name}>{name}</Text>
            <View style={styles.metaRow}>
              {!!cat && <View style={styles.metaChip}><Text style={styles.metaChipText} numberOfLines={1}>{cat}</Text></View>}
              {price != null && price > 0 && <View style={styles.metaChip}><Text style={styles.metaChipText}>{"$".repeat(Math.min(4, price))}</Text></View>}
              {profile?.open_now != null && (
                <View style={[styles.metaChip, { backgroundColor: (profile.open_now ? theme.success : theme.error) + "22" }]}>
                  <Text style={[styles.metaChipText, { color: profile.open_now ? theme.success : theme.error }]}>
                    {profile.open_now ? "Open now" : "Closed"}
                  </Text>
                </View>
              )}
            </View>

            {(ratingFsq != null || profile?.distance != null) && (
              <View style={styles.subRow}>
                {ratingFsq != null && (
                  <View style={styles.subInline}>
                    <Ionicons name="star" size={14} color="#F6C455" />
                    <Text style={styles.subText}>{ratingFsq.toFixed(1)}<Text style={styles.subMuted}>/10 · Foursquare</Text></Text>
                  </View>
                )}
                {profile?.distance != null && <Text style={styles.subMuted}>{fmtDistance(profile.distance)}</Text>}
              </View>
            )}

            {/* Quick actions */}
            <View style={styles.actions}>
              <TouchableOpacity style={styles.actBtn} onPress={directions} testID="place-directions">
                <Ionicons name="navigate" size={20} color="#fff" />
                <Text style={styles.actText}>Directions</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actBtn, styles.actGhost, busySave && { opacity: 0.6 }]} onPress={toggleSave} disabled={busySave} testID="place-save">
                <Ionicons name={savedPlace ? "bookmark" : "bookmark-outline"} size={20} color={theme.primary} />
                <Text style={[styles.actText, styles.actGhostText]}>{savedPlace ? "Saved" : "Save"}</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.actions}>
              {!!profile?.phone && (
                <TouchableOpacity style={[styles.actBtn, styles.actGhost]} onPress={call} testID="place-call">
                  <Ionicons name="call-outline" size={18} color={theme.primary} />
                  <Text style={[styles.actText, styles.actGhostText]}>Call</Text>
                </TouchableOpacity>
              )}
              {!!profile?.website && (
                <TouchableOpacity style={[styles.actBtn, styles.actGhost]} onPress={openWebsite} testID="place-website">
                  <Ionicons name="globe-outline" size={18} color={theme.primary} />
                  <Text style={[styles.actText, styles.actGhostText]}>Website</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Details */}
            {(!!addr || !!profile?.hours_display) && (
              <View style={styles.card}>
                {!!addr && (
                  <View style={styles.infoRow}>
                    <Ionicons name="location-outline" size={18} color={theme.textMuted} />
                    <Text style={styles.infoText}>{addr}</Text>
                  </View>
                )}
                {!!profile?.hours_display && (
                  <View style={styles.infoRow}>
                    <Ionicons name="time-outline" size={18} color={theme.textMuted} />
                    <Text style={styles.infoText}>{profile.hours_display}</Text>
                  </View>
                )}
                {!!profile?.phone && (
                  <TouchableOpacity style={styles.infoRow} onPress={call}>
                    <Ionicons name="call-outline" size={18} color={theme.textMuted} />
                    <Text style={[styles.infoText, { color: theme.primary }]}>{profile.phone}</Text>
                  </TouchableOpacity>
                )}
                {!!profile?.website && (
                  <TouchableOpacity style={styles.infoRow} onPress={openWebsite}>
                    <Ionicons name="globe-outline" size={18} color={theme.textMuted} />
                    <Text style={[styles.infoText, { color: theme.primary }]} numberOfLines={1}>{profile.website.replace(/^https?:\/\//, "")}</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Reviews */}
            <View style={styles.reviewsHead}>
              <Text style={styles.sectionTitle}>Reviews</Text>
              {avg != null && (
                <View style={styles.subInline}>
                  <Stars value={avg} />
                  <Text style={styles.subText}>{avg.toFixed(1)} · {reviews.length}</Text>
                </View>
              )}
            </View>
            <TouchableOpacity style={styles.writeBtn} onPress={openReview} testID="place-write-review">
              <Ionicons name="create-outline" size={16} color={theme.primary} />
              <Text style={styles.writeText}>{myReview ? "Edit your review" : "Write a review"}</Text>
            </TouchableOpacity>

            {reviews.length === 0 ? (
              <Text style={styles.empty}>No reviews yet. Be the first to review {name}.</Text>
            ) : (
              reviews.map((r) => (
                <View key={r.id} style={styles.reviewRow}>
                  <View style={styles.avatar}>
                    {r.user_picture ? (
                      <Image source={{ uri: r.user_picture }} style={{ width: "100%", height: "100%" }} />
                    ) : (
                      <Text style={styles.avatarInit}>{(r.user_name?.[0] || "?").toUpperCase()}</Text>
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.reviewTop}>
                      <Text style={styles.reviewName} numberOfLines={1}>{r.user_name}{r.user_id === user?.user_id ? " (you)" : ""}</Text>
                      <Text style={styles.reviewAgo}>{fmtAgo(r.created_at)}</Text>
                    </View>
                    <Stars value={r.rating} size={13} />
                    {!!r.text && <Text style={styles.reviewText}>{r.text}</Text>}
                  </View>
                </View>
              ))
            )}
          </View>
        </ScrollView>
      )}

      <Modal visible={reviewOpen} transparent animationType="fade" onRequestClose={() => setReviewOpen(false)}>
        <View style={styles.modalBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => !savingReview && setReviewOpen(false)} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle} numberOfLines={1}>Review {name}</Text>
            <View style={{ alignItems: "center", marginVertical: 14 }}>
              <Stars value={rating} onChange={setRating} />
            </View>
            <TextInput
              style={styles.modalInput}
              placeholder="Share your experience (optional)"
              placeholderTextColor={theme.textMuted}
              value={text}
              onChangeText={setText}
              multiline
              maxLength={500}
              testID="place-review-text"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalBtn, styles.actGhost]} onPress={() => setReviewOpen(false)}>
                <Text style={[styles.modalBtnText, { color: theme.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: theme.primary }, savingReview && { opacity: 0.6 }]} onPress={submitReview} disabled={savingReview} testID="place-review-submit">
                {savingReview ? <ActivityIndicator color="#fff" /> : <Text style={styles.modalBtnText}>{myReview ? "Update" : "Post"}</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 6, paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, color: theme.textPrimary, fontSize: 16, fontWeight: "700", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  hero: { width: SCREEN_W, height: SCREEN_W * 0.52, backgroundColor: theme.surfaceAlt },
  heroPlaceholder: { alignItems: "center", justifyContent: "center" },

  body: { padding: 18 },
  name: { color: theme.textPrimary, fontSize: 23, fontWeight: "900", letterSpacing: -0.4 },
  metaRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  metaChip: { backgroundColor: theme.surfaceAlt, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, maxWidth: SCREEN_W * 0.6 },
  metaChipText: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "700", textTransform: "capitalize" },
  subRow: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: 10 },
  subInline: { flexDirection: "row", alignItems: "center", gap: 5 },
  subText: { color: theme.textSecondary, fontSize: 13, fontWeight: "700" },
  subMuted: { color: theme.textMuted, fontSize: 12.5, fontWeight: "600" },

  actions: { flexDirection: "row", gap: 10, marginTop: 14 },
  actBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: theme.primary, borderRadius: 14, paddingVertical: 13,
  },
  actText: { color: "#fff", fontWeight: "800", fontSize: 14.5 },
  actGhost: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  actGhostText: { color: theme.primary },

  card: {
    marginTop: 18, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    borderRadius: 16, paddingHorizontal: 14, paddingVertical: 6,
  },
  infoRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11 },
  infoText: { flex: 1, color: theme.textPrimary, fontSize: 14.5, lineHeight: 20 },

  reviewsHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 24, marginBottom: 4 },
  sectionTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  writeBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7,
    backgroundColor: theme.surfaceAlt, borderRadius: 12, paddingVertical: 11, marginTop: 10, marginBottom: 6,
  },
  writeText: { color: theme.primary, fontWeight: "800", fontSize: 14 },
  empty: { color: theme.textMuted, fontSize: 13.5, paddingVertical: 12 },
  reviewRow: { flexDirection: "row", gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  avatar: { width: 38, height: 38, borderRadius: 19, overflow: "hidden", backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  avatarInit: { color: "#fff", fontSize: 16, fontWeight: "700" },
  reviewTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 3 },
  reviewName: { flex: 1, color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  reviewAgo: { color: theme.textMuted, fontSize: 12 },
  reviewText: { color: theme.textSecondary, fontSize: 14, lineHeight: 20, marginTop: 4 },

  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { width: "100%", maxWidth: 420, backgroundColor: theme.surface, borderRadius: 18, borderWidth: 1, borderColor: theme.border, padding: 18 },
  modalTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800", textAlign: "center" },
  modalInput: {
    backgroundColor: theme.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 14, paddingVertical: 12, minHeight: 84, textAlignVertical: "top",
    color: theme.textPrimary, fontSize: 14.5, marginBottom: 14,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  modalActions: { flexDirection: "row", gap: 10 },
  modalBtn: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  modalBtnText: { color: "#fff", fontWeight: "800", fontSize: 14.5 },
});
