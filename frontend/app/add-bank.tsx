import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator, Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api } from "@/src/api/client";
import { tokenizeBankAccount } from "@/src/lib/stripeEmbed";
import { theme } from "@/src/theme";

export default function AddBankScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [acctId, setAcctId] = useState<string | undefined>();
  const [country, setCountry] = useState("US");
  const [currency, setCurrency] = useState<string | undefined>();
  const [existing, setExisting] = useState<{ bank?: string; last4?: string } | null>(null);

  const [name, setName] = useState("");
  const [routing, setRouting] = useState("");
  const [account, setAccount] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.getPayoutStatus();
      setAcctId(s.account_id);
      if (s.country) setCountry(s.country.toUpperCase());
      if (s.account_currency) setCurrency(s.account_currency);
      setExisting(s.bank_account || null);
    } catch {} finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const routingLabel = country === "CA" ? "Transit + institution (e.g. 11000-000)" : country === "GB" ? "Sort code" : "Routing number";

  const save = async () => {
    if (!name.trim() || !routing.trim() || !account.trim()) { Alert.alert("Missing details", "Please fill in every field."); return; }
    if (!acctId) { Alert.alert("Set up payouts first", "Finish identity verification before adding a bank account."); router.replace("/verify-payouts"); return; }
    setSaving(true);
    try {
      const token = await tokenizeBankAccount(acctId, { account_holder_name: name, routing_number: routing, account_number: account }, country, currency);
      await api.addBankAccount(token);
      Alert.alert("Bank added", "Your direct-deposit account is set up.", [{ text: "Done", onPress: () => router.replace("/wallet") }]);
    } catch (e: any) {
      Alert.alert("Couldn't add bank", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setSaving(false); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="add-bank-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => { if (router.canGoBack()) safeBack(); else router.replace("/wallet"); }} style={styles.iconBtn} testID="add-bank-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Direct deposit</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
          <Text style={styles.intro}>
            Standard payouts are sent to this bank account on your schedule. Entered right here in the app — your details are tokenized securely and never stored on our servers.
          </Text>

          {existing?.last4 ? (
            <View style={styles.current}>
              <Ionicons name="business" size={18} color={theme.primary} />
              <Text style={styles.currentText}>{existing.bank || "Bank"} •••• {existing.last4} on file</Text>
            </View>
          ) : null}

          <Text style={styles.label}>Account holder name</Text>
          <TextInput style={styles.input} placeholder="Full name on the account" placeholderTextColor={theme.textMuted} value={name} onChangeText={setName} testID="ab-name" />

          <Text style={styles.label}>{routingLabel}</Text>
          <TextInput style={styles.input} placeholder={routingLabel} placeholderTextColor={theme.textMuted} keyboardType="numbers-and-punctuation" value={routing} onChangeText={setRouting} testID="ab-routing" />

          <Text style={styles.label}>Account number</Text>
          <TextInput style={styles.input} placeholder="Account number" placeholderTextColor={theme.textMuted} keyboardType="number-pad" value={account} onChangeText={(t) => setAccount(t.replace(/\s/g, ""))} secureTextEntry testID="ab-account" />

          <TouchableOpacity style={[styles.submitBtn, saving && { opacity: 0.6 }]} onPress={save} disabled={saving} testID="ab-save">
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>{existing?.last4 ? "Replace bank account" : "Save bank account"}</Text>}
          </TouchableOpacity>
          <Text style={styles.hint}>🔒 Encrypted and tokenized by Stripe. We never see or store your full account number.</Text>
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
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  intro: { color: theme.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 16 },
  current: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.surfaceAlt, borderRadius: 12, padding: 13, marginBottom: 8 },
  currentText: { color: theme.textSecondary, fontSize: 13.5, fontWeight: "700" },
  label: { color: theme.textSecondary, fontSize: 13, fontWeight: "800", marginTop: 16, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.4 },
  input: { backgroundColor: theme.surface, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border, paddingHorizontal: 14, paddingVertical: 13, color: theme.textPrimary, fontSize: 15 },
  submitBtn: { backgroundColor: theme.primary, borderRadius: 14, paddingVertical: 15, alignItems: "center", marginTop: 24 },
  submitText: { color: "#fff", fontSize: 15.5, fontWeight: "800" },
  hint: { color: theme.textMuted, fontSize: 12, lineHeight: 16, marginTop: 12, textAlign: "center" },
});
