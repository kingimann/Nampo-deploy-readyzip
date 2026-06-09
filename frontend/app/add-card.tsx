import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api } from "@/src/api/client";
import { mountDebitCardField } from "@/src/lib/stripeEmbed";
import { theme } from "@/src/theme";

const FIELD_ID = "nami-card-field";

export default function AddCardScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [acctId, setAcctId] = useState<string | undefined>();
  const [currency, setCurrency] = useState<string | undefined>();
  const [existing, setExisting] = useState<{ brand?: string; last4?: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const ctrl = useRef<{ tokenize: (c?: string) => Promise<string>; destroy: () => void } | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.getPayoutStatus();
      setAcctId(s.account_id);
      if (s.account_currency) setCurrency(s.account_currency);
      setExisting(s.debit_card || null);
    } catch {} finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Mount the secure Stripe card field into our own screen once it's on-screen.
  useEffect(() => {
    let cancelled = false;
    if (loading || !acctId || Platform.OS !== "web") return;
    const t = setTimeout(async () => {
      try {
        const c = await mountDebitCardField(FIELD_ID, acctId);
        if (cancelled) { c.destroy(); return; }
        ctrl.current = c;
        setReady(true);
      } catch (e: any) {
        Alert.alert("Couldn't load card field", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
      }
    }, 120);
    return () => { cancelled = true; clearTimeout(t); try { ctrl.current?.destroy(); } catch {} ctrl.current = null; };
  }, [loading, acctId]);

  const save = async () => {
    if (Platform.OS !== "web") { Alert.alert("Use the web app", "Debit-card entry is available on the website."); return; }
    if (!acctId) { Alert.alert("Set up payouts first", "Finish identity verification before adding a card."); router.replace("/verify-payouts"); return; }
    if (!ctrl.current || !ready) { Alert.alert("One sec", "The card field is still loading."); return; }
    setSaving(true);
    try {
      const token = await ctrl.current.tokenize(currency);
      await api.addDebitCard(token);
      Alert.alert("Card added", "Your debit card is set up. You can now cash out instantly.", [{ text: "Done", onPress: () => router.replace("/wallet") }]);
    } catch (e: any) {
      Alert.alert("Couldn't add card", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setSaving(false); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="add-card-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => { if (router.canGoBack()) safeBack(); else router.replace("/wallet"); }} style={styles.iconBtn} testID="add-card-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Debit card</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
          <Text style={styles.intro}>
            Instant cash-out sends money straight to this debit card, usually within minutes. Entered right here in the app.
          </Text>

          {existing?.last4 ? (
            <View style={styles.current}>
              <Ionicons name="card" size={18} color={theme.primary} />
              <Text style={styles.currentText}>{existing.brand || "Card"} •••• {existing.last4} on file</Text>
            </View>
          ) : null}

          <Text style={styles.label}>Card details</Text>
          {/* The secure card field (Stripe) mounts into this node — styled to match the app. */}
          <View nativeID={FIELD_ID} style={styles.cardField} />
          {!ready ? <Text style={styles.loadingHint}>Loading secure card field…</Text> : null}

          <TouchableOpacity style={[styles.submitBtn, (saving || !ready) && { opacity: 0.6 }]} onPress={save} disabled={saving || !ready} testID="ac-save">
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>{existing?.last4 ? "Replace debit card" : "Save debit card"}</Text>}
          </TouchableOpacity>
          <Text style={styles.hint}>🔒 Your card number is handled by Stripe's secure field and never touches our servers. Credit and most prepaid cards aren't eligible for instant cash-out.</Text>
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
  cardField: { backgroundColor: theme.surface, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border, paddingHorizontal: 14, paddingVertical: 16, minHeight: 52, justifyContent: "center" },
  loadingHint: { color: theme.textMuted, fontSize: 12, marginTop: 8 },
  submitBtn: { backgroundColor: theme.primary, borderRadius: 14, paddingVertical: 15, alignItems: "center", marginTop: 24 },
  submitText: { color: "#fff", fontSize: 15.5, fontWeight: "800" },
  hint: { color: theme.textMuted, fontSize: 12, lineHeight: 16, marginTop: 12, textAlign: "center" },
});
