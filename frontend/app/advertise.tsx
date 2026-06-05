import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image,
  ActivityIndicator, Modal, TextInput, Alert, KeyboardAvoidingView, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { api, Post } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

// Prototype ad pricing. Real billing will replace the fake checkout below;
// these numbers just drive the demo "Pay" amount.
const DURATIONS = [
  { days: 1, label: "1 day", price: 4.99 },
  { days: 7, label: "1 week", price: 19.99 },
  { days: 30, label: "1 month", price: 49.99 },
];

type Step = "duration" | "pay" | "done";

const formatCard = (t: string) =>
  t.replace(/\D/g, "").slice(0, 16).replace(/(.{4})/g, "$1 ").trim();
const formatExp = (t: string) => {
  const d = t.replace(/\D/g, "").slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
};

export default function AdvertiseScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  // Checkout flow state.
  const [picking, setPicking] = useState<Post | null>(null);
  const [step, setStep] = useState<Step>("duration");
  const [selDays, setSelDays] = useState<number>(7);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Post | null>(null);

  // Prefilled demo card — this is a prototype, so we ship a working test card.
  const [card, setCard] = useState("4242 4242 4242 4242");
  const [exp, setExp] = useState("12/28");
  const [cvc, setCvc] = useState("123");
  const [name, setName] = useState(user?.name || "");

  const selected = DURATIONS.find((d) => d.days === selDays) ?? DURATIONS[1];

  const load = useCallback(async () => {
    if (!user) return;
    try { setPosts(await api.listUserPostsAll(user.user_id)); }
    catch {} finally { setLoading(false); }
  }, [user]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openCheckout = (post: Post) => {
    setPicking(post);
    setSelDays(7);
    setResult(null);
    setStep("duration");
  };
  const closeCheckout = () => {
    if (busy) return;
    setPicking(null);
    setStep("duration");
    setResult(null);
  };

  const chooseDuration = (days: number) => {
    setSelDays(days);
    setStep("pay");
  };

  const pay = async () => {
    if (!picking) return;
    setBusy(true);
    try {
      // ── Fake payment ────────────────────────────────────────────────
      // Simulate a payment-processor round-trip. When real payments land,
      // replace this delay with a charge call (Stripe/RevenueCat/etc.) and
      // only promote once it confirms.
      await new Promise((r) => setTimeout(r, 1400));
      const updated = await api.promotePost(picking.id, selDays);
      setPosts((arr) => arr.map((p) => (p.id === updated.id ? updated : p)));
      setResult(updated);
      setStep("done");
    } catch {
      Alert.alert("Payment failed", "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const endsLabel = (iso?: string | null) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }); }
    catch { return ""; }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="advertise-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="advertise-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Advertise</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30, gap: 12 }}
          ListHeaderComponent={
            <View style={styles.intro}>
              <Ionicons name="megaphone" size={20} color={theme.primary} />
              <Text style={styles.introText}>Promote a post to boost its reach. Promoted posts surface higher and show a "Sponsored" badge.</Text>
            </View>
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="newspaper-outline" size={28} color={theme.textMuted} />
              <Text style={styles.emptyText}>Post something first, then promote it here.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const media = item.media?.[0];
            return (
              <View style={styles.row}>
                {media ? (
                  media.type === "video" ? (
                    <View style={[styles.thumb, styles.thumbVideo]}><Ionicons name="play" size={18} color="#fff" /></View>
                  ) : (
                    <Image source={{ uri: media.base64 }} style={styles.thumb} resizeMode="cover" />
                  )
                ) : (
                  <View style={[styles.thumb, styles.thumbText]}><Ionicons name="text" size={18} color={theme.textMuted} /></View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowText} numberOfLines={2}>{item.text || "(media post)"}</Text>
                  {item.promoted ? (
                    <Text style={styles.promotedNote}>● Promoted · ends {endsLabel(item.promoted_until)}</Text>
                  ) : (
                    <Text style={styles.rowMeta}>{item.likes_count} likes · {item.views_count || 0} views</Text>
                  )}
                </View>
                <TouchableOpacity
                  style={[styles.promoteBtn, item.promoted && styles.promoteBtnActive]}
                  onPress={() => openCheckout(item)}
                  testID={`promote-${item.id}`}
                >
                  <Text style={[styles.promoteText, item.promoted && { color: theme.primary }]}>
                    {item.promoted ? "Extend" : "Promote"}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          }}
        />
      )}

      <Modal visible={!!picking} transparent animationType="slide" onRequestClose={closeCheckout}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.backdrop}
        >
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={closeCheckout} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.handle} />

            {/* ── Step 1: pick a duration ─────────────────────────────── */}
            {step === "duration" && (
              <>
                <Text style={styles.sheetTitle}>Choose a package</Text>
                <Text style={styles.sheetSub}>How long should this post stay promoted?</Text>
                {DURATIONS.map((d) => (
                  <TouchableOpacity
                    key={d.days}
                    style={styles.durRow}
                    onPress={() => chooseDuration(d.days)}
                    testID={`promote-dur-${d.days}`}
                  >
                    <View>
                      <Text style={styles.durText}>{d.label}</Text>
                      <Text style={styles.durMeta}>Boosted reach for {d.label}</Text>
                    </View>
                    <View style={styles.durRight}>
                      <Text style={styles.durPrice}>${d.price.toFixed(2)}</Text>
                      <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
                    </View>
                  </TouchableOpacity>
                ))}
              </>
            )}

            {/* ── Step 2: fake checkout ───────────────────────────────── */}
            {step === "pay" && (
              <>
                <View style={styles.payHeader}>
                  <TouchableOpacity onPress={() => !busy && setStep("duration")} testID="pay-back">
                    <Ionicons name="chevron-back" size={22} color={theme.textPrimary} />
                  </TouchableOpacity>
                  <Text style={styles.sheetTitle}>Payment</Text>
                  <View style={{ width: 22 }} />
                </View>

                <View style={styles.testBanner}>
                  <Ionicons name="lock-closed" size={13} color={theme.primary} />
                  <Text style={styles.testBannerText}>Test mode · no real charge</Text>
                </View>

                <View style={styles.summary}>
                  <Text style={styles.summaryLabel}>Promote · {selected.label}</Text>
                  <Text style={styles.summaryPrice}>${selected.price.toFixed(2)}</Text>
                </View>

                <Text style={styles.fieldLabel}>Card number</Text>
                <View style={styles.inputWrap}>
                  <Ionicons name="card-outline" size={18} color={theme.textMuted} />
                  <TextInput
                    style={styles.input}
                    value={card}
                    onChangeText={(t) => setCard(formatCard(t))}
                    keyboardType="number-pad"
                    placeholder="1234 5678 9012 3456"
                    placeholderTextColor={theme.textMuted}
                    maxLength={19}
                    editable={!busy}
                    testID="pay-card"
                  />
                </View>

                <View style={styles.fieldRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>Expiry</Text>
                    <View style={styles.inputWrap}>
                      <TextInput
                        style={styles.input}
                        value={exp}
                        onChangeText={(t) => setExp(formatExp(t))}
                        keyboardType="number-pad"
                        placeholder="MM/YY"
                        placeholderTextColor={theme.textMuted}
                        maxLength={5}
                        editable={!busy}
                        testID="pay-exp"
                      />
                    </View>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>CVC</Text>
                    <View style={styles.inputWrap}>
                      <TextInput
                        style={styles.input}
                        value={cvc}
                        onChangeText={(t) => setCvc(t.replace(/\D/g, "").slice(0, 4))}
                        keyboardType="number-pad"
                        placeholder="123"
                        placeholderTextColor={theme.textMuted}
                        maxLength={4}
                        editable={!busy}
                        testID="pay-cvc"
                      />
                    </View>
                  </View>
                </View>

                <Text style={styles.fieldLabel}>Name on card</Text>
                <View style={styles.inputWrap}>
                  <TextInput
                    style={styles.input}
                    value={name}
                    onChangeText={setName}
                    placeholder="Full name"
                    placeholderTextColor={theme.textMuted}
                    editable={!busy}
                    testID="pay-name"
                  />
                </View>

                <TouchableOpacity
                  style={[styles.payBtn, busy && { opacity: 0.7 }]}
                  onPress={pay}
                  disabled={busy}
                  testID="pay-submit"
                >
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.payBtnText}>Pay ${selected.price.toFixed(2)}</Text>
                  )}
                </TouchableOpacity>
              </>
            )}

            {/* ── Step 3: success ─────────────────────────────────────── */}
            {step === "done" && (
              <View style={styles.doneWrap}>
                <View style={styles.doneCheck}>
                  <Ionicons name="checkmark" size={40} color="#fff" />
                </View>
                <Text style={styles.doneTitle}>Payment successful</Text>
                <Text style={styles.doneSub}>
                  Your post is promoted until {endsLabel(result?.promoted_until)}. It'll surface higher and show a "Sponsored" badge.
                </Text>
                <TouchableOpacity style={styles.payBtn} onPress={closeCheckout} testID="pay-done">
                  <Text style={styles.payBtnText}>Done</Text>
                </TouchableOpacity>
              </View>
            )}
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
    paddingHorizontal: 8, paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  intro: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border,
    padding: 14, marginBottom: 6,
  },
  introText: { flex: 1, color: theme.textSecondary, fontSize: 13, lineHeight: 18 },
  empty: { alignItems: "center", paddingTop: 50, gap: 10 },
  emptyText: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingHorizontal: 40 },

  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border,
    padding: 12,
  },
  thumb: { width: 52, height: 52, borderRadius: 10, backgroundColor: theme.surfaceAlt },
  thumbVideo: { alignItems: "center", justifyContent: "center", backgroundColor: "#000" },
  thumbText: { alignItems: "center", justifyContent: "center" },
  rowText: { color: theme.textPrimary, fontSize: 14, fontWeight: "600" },
  rowMeta: { color: theme.textMuted, fontSize: 12, marginTop: 3 },
  promotedNote: { color: theme.primary, fontSize: 12, fontWeight: "700", marginTop: 3 },
  promoteBtn: {
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: 12,
    backgroundColor: theme.primary,
  },
  promoteBtnActive: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.primary },
  promoteText: { color: "#fff", fontSize: 13, fontWeight: "800" },

  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingTop: 12, paddingHorizontal: 18, borderTopWidth: 1, borderColor: theme.border,
  },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 14 },
  sheetTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  sheetSub: { color: theme.textMuted, fontSize: 13, marginTop: 2, marginBottom: 8 },

  durRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingVertical: 15, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  durText: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  durMeta: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  durRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  durPrice: { color: theme.primary, fontSize: 15, fontWeight: "800" },

  payHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginBottom: 12,
  },
  testBanner: {
    flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start",
    backgroundColor: theme.surfaceAlt, borderRadius: 8, borderWidth: 1, borderColor: theme.primary,
    paddingHorizontal: 10, paddingVertical: 5, marginBottom: 14,
  },
  testBannerText: { color: theme.primary, fontSize: 12, fontWeight: "700" },
  summary: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: theme.surfaceAlt, borderRadius: 12, padding: 14, marginBottom: 16,
  },
  summaryLabel: { color: theme.textSecondary, fontSize: 14, fontWeight: "600" },
  summaryPrice: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  fieldLabel: { color: theme.textMuted, fontSize: 12, fontWeight: "700", marginBottom: 6, marginTop: 4 },
  inputWrap: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.bg, borderRadius: 12, borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 12, height: 48, marginBottom: 10,
  },
  input: { flex: 1, color: theme.textPrimary, fontSize: 15, height: "100%" },
  fieldRow: { flexDirection: "row", gap: 12 },
  payBtn: {
    backgroundColor: theme.primary, borderRadius: 14, height: 52,
    alignItems: "center", justifyContent: "center", marginTop: 10,
  },
  payBtnText: { color: "#fff", fontSize: 16, fontWeight: "800" },

  doneWrap: { alignItems: "center", paddingVertical: 10, gap: 8 },
  doneCheck: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: "#22C55E",
    alignItems: "center", justifyContent: "center", marginBottom: 6,
  },
  doneTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  doneSub: { color: theme.textSecondary, fontSize: 13, textAlign: "center", lineHeight: 19, paddingHorizontal: 10 },
});
