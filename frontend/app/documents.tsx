import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Image, Alert, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { pickDocumentBase64 } from "@/src/utils/thumbnail";
import { api, RoadsideVerificationStatus } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

type Guide = { q: string; a: string };
const GUIDES: Guide[] = [
  { q: "How does roadside help work?", a: "Open Roadside from the map. As a customer you pick a service (tow, lockout, battery, tire), share your location and vehicle, then pay — by wallet (held in escrow) or cash in person. A nearby verified member accepts, heads over, and both of you take before/after photos and verify to finish. The $80 releases to the helper (or you pay cash)." },
  { q: "What do I need to get verified?", a: "To request or give roadside help you must be ID, email and phone verified, have an account at least 3 months old, and no bans or warnings. To request help you also upload your auto insurance and proof of ownership — an AI check confirms they match your vehicle, then the documents are deleted (we don't keep them)." },
  { q: "Payments, wallet & fees", a: "Wallet jobs hold $80 + a 10% tax/fee; the $80 goes to your helper once both of you verify, the tax is a platform fee. Cash jobs skip the hold and tax — you hand the helper $80 in person. Top up your wallet under Settings → Wallet." },
  { q: "Cancelling & refunds", a: "Cancel before a helper sets off (en route) for a full refund. Once they're en route you forfeit half the $80 to them and the rest is refunded. Cash jobs have nothing to refund." },
  { q: "Reviews & disputes", a: "After a job completes, both sides can leave a star rating and comment in Roadside → History. You can open a dispute up to 7 days after the service call — it notifies the other party and opens a support ticket." },
  { q: "Safety", a: "Roadside help is provided by other members, not a professional service. Stay somewhere safe while you wait, meet in view of others, and for emergencies always call your local emergency number first." },
];

export default function DocumentsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [verif, setVerif] = useState<RoadsideVerificationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [insuranceDoc, setInsuranceDoc] = useState<string | null>(null);
  const [ownershipDoc, setOwnershipDoc] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [openGuide, setOpenGuide] = useState<number | null>(null);

  const load = useCallback(async () => {
    try { setVerif(await api.roadsideVerification()); } catch {} finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const pickDoc = async (which: "ins" | "own") => {
    try {
      const uri = await pickDocumentBase64();
      if (!uri) return;
      if (which === "ins") setInsuranceDoc(uri); else setOwnershipDoc(uri);
    } catch (e: any) { Alert.alert("Couldn't add document", String(e?.message || e)); }
  };

  const submitDocs = async () => {
    if (!insuranceDoc || !ownershipDoc) { Alert.alert("Add both", "Add a photo of both your insurance and proof of ownership."); return; }
    setSubmitting(true);
    try {
      const r = await api.submitRoadsideVerification({ insurance_photo: insuranceDoc, ownership_photo: ownershipDoc });
      setInsuranceDoc(null); setOwnershipDoc(null);
      await load();
      if (r.status === "approved") Alert.alert("Verified ✓", "You're cleared for roadside help.");
      else if (r.status === "rejected") Alert.alert("Couldn't verify", r.reason || "The documents didn't match. Use clearer photos.");
      else Alert.alert("Submitted", "Your documents are under review.");
    } catch (e: any) {
      Alert.alert("Couldn't submit", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setSubmitting(false); }
  };

  const StatusRow = ({ icon, label, ok, sub, onPress, cta }: {
    icon: any; label: string; ok: boolean; sub?: string; onPress?: () => void; cta?: string;
  }) => (
    <View style={styles.row}>
      <View style={[styles.rowIcon, { backgroundColor: (ok ? theme.success : theme.textMuted) + "22" }]}>
        <Ionicons name={icon} size={18} color={ok ? theme.success : theme.textMuted} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={[styles.rowSub, ok && { color: theme.success }]}>{sub || (ok ? "Verified" : "Not verified")}</Text>
      </View>
      {!ok && onPress && (
        <TouchableOpacity style={styles.rowBtn} onPress={onPress} testID={`doc-${label}`}>
          <Text style={styles.rowBtnText}>{cta || "Verify"}</Text>
        </TouchableOpacity>
      )}
      {ok && <Ionicons name="checkmark-circle" size={20} color={theme.success} />}
    </View>
  );

  const DocBox = ({ label, uri, onPress }: { label: string; uri: string | null; onPress: () => void }) => (
    <TouchableOpacity style={styles.docBox} onPress={onPress} testID={`doc-box-${label}`}>
      {uri ? (
        <>
          <Image source={{ uri }} style={styles.docImg} resizeMode="cover" />
          <View style={styles.docCheck}><Ionicons name="checkmark-circle" size={20} color={theme.success} /></View>
        </>
      ) : (
        <><Ionicons name="camera-outline" size={24} color={theme.primary} /><Text style={styles.docLabel}>{label}</Text></>
      )}
    </TouchableOpacity>
  );

  const eligible = !!verif?.eligibility?.eligible;
  const rsStatus = verif?.verified ? "approved" : verif?.status || "none";

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="documents-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack("/settings")} style={styles.iconBtn} testID="documents-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Documents & verification</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
          {/* Verification */}
          <Text style={styles.sectionLabel}>Your verification</Text>
          <View style={styles.group}>
            <StatusRow icon="card-outline" label="Government ID" ok={!!user?.id_verified} onPress={() => router.push("/account")} />
            <StatusRow icon="mail-outline" label="Email" ok={!!user?.email_verified} onPress={() => router.push("/account")} />
            <StatusRow icon="call-outline" label="Phone" ok={!!user?.phone_verified} onPress={() => router.push("/account")} />
            <StatusRow
              icon="construct-outline" label="Roadside"
              ok={!!verif?.verified}
              sub={verif?.verified ? "Verified" : rsStatus === "pending" ? "Under review" : rsStatus === "rejected" ? "Declined — resubmit below" : "Not verified"}
            />
          </View>

          {/* Roadside documents */}
          <Text style={styles.sectionLabel}>Roadside documents</Text>
          {verif?.verified ? (
            <View style={styles.infoCard}>
              <Ionicons name="shield-checkmark" size={20} color={theme.success} />
              <Text style={styles.infoText}>You're verified for roadside help. Re-submit any time your insurance changes.</Text>
            </View>
          ) : !eligible ? (
            <View style={styles.infoCard}>
              <Ionicons name="information-circle" size={20} color={theme.warning} />
              <Text style={styles.infoText}>Finish ID, email and phone verification above first — then you can upload your roadside documents.</Text>
            </View>
          ) : rsStatus === "pending" ? (
            <View style={styles.infoCard}>
              <Ionicons name="hourglass" size={20} color={theme.warning} />
              <Text style={styles.infoText}>Your insurance and ownership are under review. You'll be notified once approved.</Text>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.cardText}>
                Upload your auto insurance and proof of ownership (registration or title). An AI check confirms they match your vehicle, then the documents are deleted — we don't keep them.
              </Text>
              {rsStatus === "rejected" && !!verif?.reason && <Text style={styles.err}>Last attempt declined: {verif.reason}</Text>}
              <View style={styles.docRow}>
                <View style={{ flex: 1 }}><DocBox label="Insurance" uri={insuranceDoc} onPress={() => pickDoc("ins")} /></View>
                <View style={{ flex: 1 }}><DocBox label="Ownership" uri={ownershipDoc} onPress={() => pickDoc("own")} /></View>
              </View>
              <TouchableOpacity
                style={[styles.submit, (!insuranceDoc || !ownershipDoc || submitting) && { opacity: 0.5 }]}
                onPress={submitDocs} disabled={!insuranceDoc || !ownershipDoc || submitting} testID="doc-submit"
              >
                {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>{rsStatus === "rejected" ? "Resubmit documents" : "Submit for verification"}</Text>}
              </TouchableOpacity>
            </View>
          )}

          {/* Update your info */}
          <Text style={styles.sectionLabel}>Update your information</Text>
          <View style={styles.group}>
            <LinkRow icon="person-outline" label="Edit profile" onPress={() => router.push("/(tabs)/profile")} />
            <LinkRow icon="settings-outline" label="Account & login" onPress={() => router.push("/account")} />
            <LinkRow icon="wallet-outline" label="Wallet & payouts" onPress={() => router.push("/wallet")} />
            <LinkRow icon="lock-closed-outline" label="Privacy" onPress={() => router.push("/privacy")} last />
          </View>

          {/* Help & guides */}
          <Text style={styles.sectionLabel}>Guides & help</Text>
          <View style={styles.group}>
            {GUIDES.map((g, i) => {
              const open = openGuide === i;
              return (
                <View key={i} style={[styles.guide, i === GUIDES.length - 1 && { borderBottomWidth: 0 }]}>
                  <TouchableOpacity style={styles.guideHead} onPress={() => setOpenGuide(open ? null : i)} testID={`guide-${i}`}>
                    <Text style={styles.guideQ}>{g.q}</Text>
                    <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={theme.textMuted} />
                  </TouchableOpacity>
                  {open && <Text style={styles.guideA}>{g.a}</Text>}
                </View>
              );
            })}
          </View>
          <TouchableOpacity style={styles.supportRow} onPress={() => router.push("/support")} testID="doc-support">
            <Ionicons name="help-buoy-outline" size={18} color={theme.primary} />
            <Text style={styles.supportText}>Still need help? Contact support</Text>
            <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
          </TouchableOpacity>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function LinkRow({ icon, label, onPress, last }: { icon: any; label: string; onPress: () => void; last?: boolean }) {
  return (
    <TouchableOpacity style={[styles.row, last && { borderBottomWidth: 0 }]} onPress={onPress} testID={`link-${label}`}>
      <View style={[styles.rowIcon, { backgroundColor: theme.primary + "22" }]}><Ionicons name={icon} size={18} color={theme.primary} /></View>
      <Text style={[styles.rowLabel, { flex: 1 }]}>{label}</Text>
      <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  sectionLabel: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 22, marginBottom: 10 },
  group: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  rowIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  rowLabel: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  rowSub: { color: theme.textMuted, fontSize: 12.5, marginTop: 1 },
  rowBtn: { backgroundColor: theme.primary, borderRadius: 9, paddingHorizontal: 14, paddingVertical: 8 },
  rowBtnText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  card: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 16 },
  cardText: { color: theme.textSecondary, fontSize: 13.5, lineHeight: 19 },
  infoCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 14 },
  infoText: { flex: 1, color: theme.textSecondary, fontSize: 13.5, lineHeight: 19 },
  err: { color: theme.error, fontSize: 13, marginTop: 10 },
  docRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  docBox: { height: 110, borderRadius: 12, borderWidth: 1, borderColor: theme.border, borderStyle: "dashed", backgroundColor: theme.surfaceAlt, alignItems: "center", justifyContent: "center", gap: 6, overflow: "hidden", position: "relative" },
  docImg: { ...StyleSheet.absoluteFillObject, width: "100%", height: "100%" },
  docLabel: { color: theme.textSecondary, fontSize: 13, fontWeight: "700" },
  docCheck: { position: "absolute", top: 6, right: 6, backgroundColor: theme.bg, borderRadius: 11 },
  submit: { backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 14 },
  submitText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  guide: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border, paddingHorizontal: 14 },
  guideHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 15, gap: 10 },
  guideQ: { flex: 1, color: theme.textPrimary, fontSize: 14.5, fontWeight: "700" },
  guideA: { color: theme.textSecondary, fontSize: 13.5, lineHeight: 20, paddingBottom: 15 },
  supportRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, paddingVertical: 14, marginTop: 12 },
  supportText: { flex: 1, color: theme.textPrimary, fontSize: 14.5, fontWeight: "700" },
});
