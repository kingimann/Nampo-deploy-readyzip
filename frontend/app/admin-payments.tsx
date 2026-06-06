import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Platform, Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { api } from "@/src/api/client";
import { theme } from "@/src/theme";

export default function AdminPaymentsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [testPayments, setTestPayments] = useState(false);
  const [stripeConfigured, setStripeConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const r = await api.adminGetTestPayments(); setTestPayments(r.test_payments); setStripeConfigured(r.stripe_configured); }
    catch {} finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const toggle = async () => {
    const next = !testPayments; setTestPayments(next); setSaving(true); setMsg(null);
    try { await api.adminSetTestPayments(next); }
    catch (e: any) { setTestPayments(!next); Alert.alert("Couldn't save", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setSaving(false); }
  };

  const confirmReset = (kind: "money" | "analytics") => {
    const label = kind === "money" ? "all wallets, tips, subscriptions, payouts, transfers and ad balances" : "all ad/view analytics (impressions, clicks, spend, views)";
    const run = async () => {
      setBusy(kind); setMsg(null);
      try {
        if (kind === "money") await api.adminResetMoney(); else await api.adminResetAnalytics();
        setMsg(kind === "money" ? "Money data reset." : "Analytics reset.");
      } catch (e: any) { Alert.alert("Reset failed", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
      finally { setBusy(null); }
    };
    if (Platform.OS === "web") { if (typeof window !== "undefined" && window.confirm(`Reset ${label}? This can't be undone.`)) run(); }
    else Alert.alert("Are you sure?", `This resets ${label}. It can't be undone.`, [{ text: "Cancel", style: "cancel" }, { text: "Reset", style: "destructive", onPress: run }]);
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="admin-payments-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="ap-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Payments & data</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
          <Text style={styles.section}>Test payments</Text>
          <View style={styles.card}>
            <TouchableOpacity style={styles.toggleRow} onPress={toggle} disabled={saving} testID="ap-toggle">
              <View style={{ flex: 1 }}>
                <Text style={styles.rowLabel}>Use test payments</Text>
                <Text style={styles.rowSub}>
                  {stripeConfigured
                    ? "When on, the app uses simulated payments even though Stripe is live."
                    : "Stripe isn't configured, so payments are always simulated."}
                </Text>
              </View>
              {saving ? <ActivityIndicator color={theme.primary} size="small" /> : (
                <View style={[styles.switch, testPayments && styles.switchOn]}>
                  <View style={[styles.knob, testPayments && styles.knobOn]} />
                </View>
              )}
            </TouchableOpacity>
          </View>
          <Text style={styles.note}>
            {testPayments
              ? "🧪 Test mode — no real charges. Tips/subscriptions/promotes run as simulated."
              : stripeConfigured ? "💳 Live — real Stripe charges." : "Simulated (Stripe not set up)."}
          </Text>

          <Text style={styles.section}>Reset data</Text>
          <TouchableOpacity style={[styles.resetBtn, busy === "money" && { opacity: 0.6 }]} onPress={() => confirmReset("money")} disabled={busy !== null} testID="ap-reset-money">
            {busy === "money" ? <ActivityIndicator color={theme.error} /> : (
              <><Ionicons name="cash-outline" size={18} color={theme.error} /><Text style={styles.resetText}>Reset fake money (wallets, tips, subs, payouts)</Text></>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={[styles.resetBtn, busy === "analytics" && { opacity: 0.6 }]} onPress={() => confirmReset("analytics")} disabled={busy !== null} testID="ap-reset-analytics">
            {busy === "analytics" ? <ActivityIndicator color={theme.error} /> : (
              <><Ionicons name="bar-chart-outline" size={18} color={theme.error} /><Text style={styles.resetText}>Reset analytics (impressions, clicks, views)</Text></>
            )}
          </TouchableOpacity>
          {msg && <Text style={styles.msg}>{msg}</Text>}
          <Text style={styles.warn}>Resets apply to the whole site and can't be undone. Use them to clear test data before going live.</Text>
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
  section: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 18, marginBottom: 10 },
  card: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16 },
  rowLabel: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  rowSub: { color: theme.textMuted, fontSize: 12.5, marginTop: 3, lineHeight: 17 },
  switch: { width: 46, height: 28, borderRadius: 14, backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, padding: 2, justifyContent: "center" },
  switchOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: "#fff" },
  knobOn: { alignSelf: "flex-end" },
  note: { color: theme.textSecondary, fontSize: 13, marginTop: 10, fontWeight: "600" },
  resetBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.error, borderRadius: 12, paddingVertical: 14, marginBottom: 10 },
  resetText: { color: theme.error, fontSize: 13.5, fontWeight: "700" },
  msg: { color: theme.primary, fontSize: 13, fontWeight: "600", marginTop: 8, textAlign: "center" },
  warn: { color: theme.textMuted, fontSize: 12, lineHeight: 18, marginTop: 16, textAlign: "center" },
});
