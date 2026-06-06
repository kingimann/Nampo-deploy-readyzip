import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator, Alert, Image,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { api } from "@/src/api/client";
import { theme } from "@/src/theme";

type Req = Awaited<ReturnType<typeof api.getPayoutRequirements>>;

export default function VerifyPayoutsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [req, setReq] = useState<Req | null>(null);
  const [saving, setSaving] = useState(false);

  // Form fields
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dobDay, setDobDay] = useState("");
  const [dobMonth, setDobMonth] = useState("");
  const [dobYear, setDobYear] = useState("");
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [city, setCity] = useState("");
  const [stateProv, setStateProv] = useState("");
  const [postal, setPostal] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [acceptTos, setAcceptTos] = useState(false);

  // Document upload
  const [frontImg, setFrontImg] = useState<{ uri: string; base64: string } | null>(null);
  const [backImg, setBackImg] = useState<{ uri: string; base64: string } | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.getPayoutRequirements();
      setReq(r);
      const p = r.prefill || {};
      if (p.first_name) setFirstName(p.first_name);
      if (p.last_name) setLastName(p.last_name);
      if (p.email) setEmail(p.email);
      if (p.phone) setPhone(p.phone);
      if (p.line1) setLine1(p.line1);
      if (p.line2) setLine2(p.line2);
      if (p.city) setCity(p.city);
      if (p.state) setStateProv(p.state);
      if (p.postal_code) setPostal(p.postal_code);
      if (p.dob_day) setDobDay(String(p.dob_day));
      if (p.dob_month) setDobMonth(String(p.dob_month));
      if (p.dob_year) setDobYear(String(p.dob_year));
    } catch (e: any) {
      Alert.alert("Couldn't load", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const country = (req?.country || "US").toUpperCase();
  const idLabel = country === "US" ? "Social Security Number" : country === "CA" ? "Social Insurance Number (SIN)" : "Government ID number";
  const stateLabel = country === "CA" ? "Province" : country === "US" ? "State" : "State / Province";

  const submit = async () => {
    if (!firstName.trim() || !lastName.trim()) { Alert.alert("Name required", "Enter your legal first and last name."); return; }
    if (!dobDay || !dobMonth || !dobYear) { Alert.alert("Date of birth required", "Enter your full date of birth."); return; }
    if (!line1.trim() || !city.trim() || !postal.trim()) { Alert.alert("Address required", "Enter your home address."); return; }
    if (!acceptTos) { Alert.alert("Agreement required", "Please accept the payout agreement to continue."); return; }
    setSaving(true);
    try {
      const body: Record<string, any> = {
        first_name: firstName.trim(), last_name: lastName.trim(),
        dob_day: Number(dobDay), dob_month: Number(dobMonth), dob_year: Number(dobYear),
        line1: line1.trim(), line2: line2.trim() || undefined, city: city.trim(),
        state: stateProv.trim() || undefined, postal_code: postal.trim(), country,
        email: email.trim() || undefined, phone: phone.trim() || undefined,
        accept_tos: true,
      };
      const digits = idNumber.replace(/\D/g, "");
      if (digits) {
        if (country === "US") { body.ssn_last_4 = digits.slice(-4); if (digits.length >= 9) body.id_number = digits; }
        else body.id_number = digits;
      }
      const r = await api.submitVerification(body);
      setReq((prev) => prev ? { ...prev, ...r } as Req : prev);
      if (r.payouts_enabled) {
        Alert.alert("You're verified", "Payouts are now enabled. You can cash out and get paid.", [{ text: "Done", onPress: () => router.replace("/wallet") }]);
      } else if (r.needs_document) {
        Alert.alert("One more step", "Please upload a photo of your government ID below to finish.");
      } else {
        Alert.alert("Submitted", "Your details were submitted. Verification can take a few minutes — we'll enable payouts automatically.");
      }
    } catch (e: any) {
      Alert.alert("Couldn't submit", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setSaving(false); }
  };

  const pickImage = async (which: "front" | "back") => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert("Permission needed", "Allow photo access to upload your ID."); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"] as any, quality: 0.6, base64: true });
    if (res.canceled || !res.assets?.[0]?.base64) return;
    const a = res.assets[0];
    const img = { uri: a.uri, base64: a.base64 as string };
    if (which === "front") setFrontImg(img); else setBackImg(img);
  };

  const uploadDoc = async () => {
    if (!frontImg) { Alert.alert("Photo required", "Add a photo of the front of your ID."); return; }
    setUploading(true);
    try {
      const r = await api.uploadVerificationDocument(frontImg.base64, backImg?.base64);
      setReq((prev) => prev ? { ...prev, needs_document: r.needs_document, payouts_enabled: r.payouts_enabled } as Req : prev);
      if (r.payouts_enabled) {
        Alert.alert("You're verified", "Payouts are now enabled.", [{ text: "Done", onPress: () => router.replace("/wallet") }]);
      } else {
        Alert.alert("Uploaded", "Your ID was uploaded. Verification can take a few minutes.");
      }
    } catch (e: any) {
      Alert.alert("Couldn't upload", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setUploading(false); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="verify-payouts-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/wallet"); }} style={styles.iconBtn} testID="verify-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Verify your identity</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : req?.payouts_enabled ? (
        <View style={styles.center}>
          <Ionicons name="checkmark-circle" size={48} color={theme.primary} />
          <Text style={styles.doneTitle}>You're verified</Text>
          <Text style={styles.doneSub}>Payouts are enabled. You can cash out and get paid.</Text>
          <TouchableOpacity style={styles.submitBtn} onPress={() => router.replace("/wallet")}>
            <Text style={styles.submitText}>Back to wallet</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
          <Text style={styles.intro}>
            We collect this securely to pay you out. It's submitted directly to our payment processor — you never leave the app.
          </Text>

          <Text style={styles.label}>Legal name</Text>
          <View style={styles.row}>
            <TextInput style={[styles.input, { flex: 1 }]} placeholder="First name" placeholderTextColor={theme.textMuted} value={firstName} onChangeText={setFirstName} testID="vf-first" />
            <TextInput style={[styles.input, { flex: 1 }]} placeholder="Last name" placeholderTextColor={theme.textMuted} value={lastName} onChangeText={setLastName} testID="vf-last" />
          </View>

          <Text style={styles.label}>Date of birth</Text>
          <View style={styles.row}>
            <TextInput style={[styles.input, { flex: 1 }]} placeholder="DD" placeholderTextColor={theme.textMuted} keyboardType="number-pad" maxLength={2} value={dobDay} onChangeText={(t) => setDobDay(t.replace(/\D/g, ""))} testID="vf-dob-d" />
            <TextInput style={[styles.input, { flex: 1 }]} placeholder="MM" placeholderTextColor={theme.textMuted} keyboardType="number-pad" maxLength={2} value={dobMonth} onChangeText={(t) => setDobMonth(t.replace(/\D/g, ""))} testID="vf-dob-m" />
            <TextInput style={[styles.input, { flex: 1.4 }]} placeholder="YYYY" placeholderTextColor={theme.textMuted} keyboardType="number-pad" maxLength={4} value={dobYear} onChangeText={(t) => setDobYear(t.replace(/\D/g, ""))} testID="vf-dob-y" />
          </View>

          <Text style={styles.label}>Home address</Text>
          <TextInput style={styles.input} placeholder="Street address" placeholderTextColor={theme.textMuted} value={line1} onChangeText={setLine1} testID="vf-line1" />
          <TextInput style={styles.input} placeholder="Apt, suite (optional)" placeholderTextColor={theme.textMuted} value={line2} onChangeText={setLine2} testID="vf-line2" />
          <View style={styles.row}>
            <TextInput style={[styles.input, { flex: 1.3 }]} placeholder="City" placeholderTextColor={theme.textMuted} value={city} onChangeText={setCity} testID="vf-city" />
            <TextInput style={[styles.input, { flex: 1 }]} placeholder={stateLabel} placeholderTextColor={theme.textMuted} value={stateProv} onChangeText={setStateProv} testID="vf-state" />
          </View>
          <TextInput style={styles.input} placeholder="Postal / ZIP code" placeholderTextColor={theme.textMuted} value={postal} onChangeText={setPostal} testID="vf-postal" />

          <Text style={styles.label}>Contact</Text>
          <TextInput style={styles.input} placeholder="Phone" placeholderTextColor={theme.textMuted} keyboardType="phone-pad" value={phone} onChangeText={setPhone} testID="vf-phone" />
          <TextInput style={styles.input} placeholder="Email" placeholderTextColor={theme.textMuted} keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} testID="vf-email" />

          <Text style={styles.label}>{idLabel}</Text>
          <TextInput style={styles.input} placeholder={country === "US" ? "SSN (or last 4)" : idLabel} placeholderTextColor={theme.textMuted} keyboardType="number-pad" secureTextEntry value={idNumber} onChangeText={setIdNumber} testID="vf-id" />
          <Text style={styles.hint}>Used only to verify your identity with our payment processor. Stored encrypted, never shown again.</Text>

          <TouchableOpacity style={styles.tosRow} onPress={() => setAcceptTos((v) => !v)} testID="vf-tos">
            <Ionicons name={acceptTos ? "checkbox" : "square-outline"} size={22} color={acceptTos ? theme.primary : theme.textMuted} />
            <Text style={styles.tosText}>I agree to the connected-account payout agreement and confirm this information is accurate.</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.submitBtn, saving && { opacity: 0.6 }]} onPress={submit} disabled={saving} testID="vf-submit">
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Submit & verify</Text>}
          </TouchableOpacity>

          {req?.needs_document ? (
            <View style={styles.docBox}>
              <Text style={styles.label}>Upload your government ID</Text>
              <Text style={styles.hint}>A clear photo of your ID (passport, driver's license, or ID card). Taken/picked right here — never leaves the app except to our processor.</Text>
              <View style={styles.row}>
                <TouchableOpacity style={styles.docPick} onPress={() => pickImage("front")} testID="vf-doc-front">
                  {frontImg ? <Image source={{ uri: frontImg.uri }} style={styles.docImg} /> : <><Ionicons name="camera" size={22} color={theme.primary} /><Text style={styles.docPickText}>Front</Text></>}
                </TouchableOpacity>
                <TouchableOpacity style={styles.docPick} onPress={() => pickImage("back")} testID="vf-doc-back">
                  {backImg ? <Image source={{ uri: backImg.uri }} style={styles.docImg} /> : <><Ionicons name="camera-outline" size={22} color={theme.textMuted} /><Text style={styles.docPickText}>Back (optional)</Text></>}
                </TouchableOpacity>
              </View>
              <TouchableOpacity style={[styles.submitBtn, (uploading || !frontImg) && { opacity: 0.6 }]} onPress={uploadDoc} disabled={uploading || !frontImg} testID="vf-doc-upload">
                {uploading ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Upload ID</Text>}
              </TouchableOpacity>
            </View>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 30 },
  doneTitle: { color: theme.textPrimary, fontSize: 20, fontWeight: "800", marginTop: 14 },
  doneSub: { color: theme.textMuted, fontSize: 14, textAlign: "center", marginTop: 8, lineHeight: 20 },
  intro: { color: theme.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 16 },
  label: { color: theme.textSecondary, fontSize: 13, fontWeight: "800", marginTop: 16, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.4 },
  row: { flexDirection: "row", gap: 10 },
  input: { backgroundColor: theme.surface, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border, paddingHorizontal: 14, paddingVertical: 13, color: theme.textPrimary, fontSize: 15, marginBottom: 10 },
  hint: { color: theme.textMuted, fontSize: 12, lineHeight: 16, marginTop: -2, marginBottom: 4 },
  tosRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 18 },
  tosText: { flex: 1, color: theme.textSecondary, fontSize: 13, lineHeight: 18 },
  submitBtn: { backgroundColor: theme.primary, borderRadius: 14, paddingVertical: 15, alignItems: "center", marginTop: 20 },
  submitText: { color: "#fff", fontSize: 15.5, fontWeight: "800" },
  docBox: { marginTop: 26, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border, paddingTop: 10 },
  docPick: { flex: 1, height: 110, borderRadius: 12, borderWidth: 1, borderColor: theme.border, borderStyle: "dashed", alignItems: "center", justifyContent: "center", backgroundColor: theme.surface, overflow: "hidden" },
  docPickText: { color: theme.textMuted, fontSize: 12.5, fontWeight: "700", marginTop: 6 },
  docImg: { width: "100%", height: "100%" },
});
