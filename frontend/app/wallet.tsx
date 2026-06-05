import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Platform, Linking, Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { api, WalletSummary } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

function fmtWhen(iso: string) {
  try { return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }); } catch { return ""; }
}

export default function WalletScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, refresh } = useAuth() as any;
  const [w, setW] = useState<WalletSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [price, setPrice] = useState("");
  const [savingPrice, setSavingPrice] = useState(false);
  const [payEnabled, setPayEnabled] = useState(false);
  const [payout, setPayout] = useState<{ connected: boolean; payouts_enabled: boolean; details_submitted: boolean } | null>(null);
  const [connecting, setConnecting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getWallet();
      setW(data);
      setPrice(String(data.sub_price ?? ""));
    } catch {} finally { setLoading(false); }
    // Payment/payout status (Stripe) — harmless when Stripe is off.
    try {
      const cfg = await api.getPaymentsConfig();
      setPayEnabled(cfg.enabled);
      if (cfg.enabled) setPayout(await api.getPayoutStatus());
    } catch {}
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const setupPayouts = async () => {
    setConnecting(true);
    try {
      const { url } = await api.setupPayouts();
      await Linking.openURL(url);
    } catch (e: any) {
      Alert.alert("Couldn't start payout setup", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setConnecting(false); }
  };

  const savePrice = async () => {
    const p = Math.max(0, Number(price) || 0);
    setSavingPrice(true);
    try {
      await api.updateMe({ sub_price: p });
      if (typeof refresh === "function") await refresh();
      await load();
    } catch {} finally { setSavingPrice(false); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="wallet-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="wallet-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Wallet</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}>
          <View style={styles.totalCard}>
            <Text style={styles.totalLabel}>Total earned</Text>
            <Text style={styles.totalValue}>${(w?.total_earned ?? 0).toFixed(2)}</Text>
            <Text style={styles.totalSub}>All earnings go to you. Payouts are simulated (test mode).</Text>
          </View>

          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Ionicons name="cash-outline" size={18} color={theme.primary} />
              <Text style={styles.statNum}>${(w?.tips_total ?? 0).toFixed(2)}</Text>
              <Text style={styles.statLabel}>{w?.tips_count ?? 0} tips</Text>
            </View>
            <View style={styles.statCard}>
              <Ionicons name="star" size={18} color={theme.primary} />
              <Text style={styles.statNum}>${(w?.subs_total ?? 0).toFixed(2)}</Text>
              <Text style={styles.statLabel}>subscriptions</Text>
            </View>
            <View style={styles.statCard}>
              <Ionicons name="people" size={18} color={theme.primary} />
              <Text style={styles.statNum}>{w?.active_subscribers ?? 0}</Text>
              <Text style={styles.statLabel}>subscribers</Text>
            </View>
          </View>

          <Text style={styles.section}>Getting paid</Text>
          {payEnabled ? (
            <View style={styles.payoutCard}>
              <View style={styles.payoutHead}>
                <View style={[styles.payoutDot, { backgroundColor: payout?.payouts_enabled ? "#22C55E" : theme.textMuted }]} />
                <Text style={styles.payoutStatus}>
                  {payout?.payouts_enabled ? "Payouts active" : payout?.connected ? "Setup incomplete" : "Not set up"}
                </Text>
              </View>
              <Text style={styles.payoutSub}>
                {payout?.payouts_enabled
                  ? "Tips and subscriptions are paid out to your connected account via Stripe."
                  : "Connect a bank account or card with Stripe to receive real payouts. Until then, payments run in test mode."}
              </Text>
              <TouchableOpacity style={styles.payoutBtn} onPress={setupPayouts} disabled={connecting} testID="wallet-setup-payouts">
                {connecting ? <ActivityIndicator color="#fff" size="small" /> : (
                  <>
                    <Ionicons name="card-outline" size={16} color="#fff" />
                    <Text style={styles.payoutBtnText}>{payout?.payouts_enabled ? "Manage payouts" : payout?.connected ? "Finish setup" : "Set up payouts"}</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.payoutCard}>
              <View style={styles.payoutHead}>
                <Ionicons name="flask-outline" size={16} color={theme.primary} />
                <Text style={styles.payoutStatus}>Test mode</Text>
              </View>
              <Text style={styles.payoutSub}>
                Real payouts aren't enabled on this server yet. Tips and subscriptions are simulated, and all earnings are credited to you in-app.
              </Text>
            </View>
          )}

          <Text style={styles.section}>Your subscription price</Text>
          <View style={styles.priceRow}>
            <View style={styles.priceInput}>
              <Text style={styles.dollar}>$</Text>
              <TextInput
                style={styles.priceField}
                value={price}
                onChangeText={(t) => setPrice(t.replace(/[^0-9.]/g, ""))}
                keyboardType="decimal-pad"
                testID="wallet-price"
              />
              <Text style={styles.perMo}>/mo</Text>
            </View>
            <TouchableOpacity style={[styles.saveBtn, savingPrice && { opacity: 0.6 }]} onPress={savePrice} disabled={savingPrice} testID="wallet-save-price">
              {savingPrice ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.saveBtnText}>Save</Text>}
            </TouchableOpacity>
          </View>

          <Text style={styles.section}>Received</Text>
          {(w?.recent || []).length === 0 ? (
            <Text style={styles.empty}>No earnings yet. When people tip or subscribe to you, they'll show here.</Text>
          ) : (
            (w?.recent || []).map((t) => (
              <View key={t.id} style={styles.txn}>
                <View style={[styles.txnIcon, { backgroundColor: theme.surfaceAlt }]}>
                  <Ionicons name={t.kind === "subscription" ? "star" : "cash"} size={16} color={theme.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.txnName}>{t.from_name}</Text>
                  <Text style={styles.txnKind}>{t.kind === "subscription" ? "Subscription" : "Tip"} · {fmtWhen(t.created_at)}</Text>
                </View>
                <Text style={styles.txnAmt}>+${t.amount.toFixed(2)}</Text>
              </View>
            ))
          )}

          <View style={styles.sentHeader}>
            <Text style={[styles.section, { marginBottom: 0 }]}>Sent</Text>
            <Text style={styles.spentTotal}>
              ${(w?.total_spent ?? 0).toFixed(2)} · {w?.subscriptions_count ?? 0} active sub{(w?.subscriptions_count ?? 0) === 1 ? "" : "s"}
            </Text>
          </View>
          {(w?.sent || []).length === 0 ? (
            <Text style={styles.empty}>You haven't tipped or subscribed to anyone yet.</Text>
          ) : (
            (w?.sent || []).map((t) => (
              <View key={t.id} style={styles.txn}>
                <View style={[styles.txnIcon, { backgroundColor: theme.surfaceAlt }]}>
                  <Ionicons name={t.kind === "subscription" ? "star-outline" : "arrow-up-circle-outline"} size={16} color={theme.textSecondary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.txnName}>To {t.from_name}</Text>
                  <Text style={styles.txnKind}>{t.kind === "subscription" ? "Subscription" : "Tip"} · {fmtWhen(t.created_at)}</Text>
                </View>
                <Text style={styles.txnAmtOut}>-${t.amount.toFixed(2)}</Text>
              </View>
            ))
          )}
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
  totalCard: { backgroundColor: theme.surface, borderRadius: 18, borderWidth: 1, borderColor: theme.border, padding: 20, alignItems: "center", gap: 4 },
  totalLabel: { color: theme.textMuted, fontSize: 13, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  totalValue: { color: theme.textPrimary, fontSize: 40, fontWeight: "900", letterSpacing: -1 },
  totalSub: { color: theme.textMuted, fontSize: 12, textAlign: "center", marginTop: 4 },
  statsRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  statCard: { flex: 1, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12, alignItems: "center", gap: 4 },
  statNum: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  statLabel: { color: theme.textMuted, fontSize: 11 },
  section: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 24, marginBottom: 10 },
  payoutCard: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 16, gap: 10 },
  payoutHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  payoutDot: { width: 9, height: 9, borderRadius: 5 },
  payoutStatus: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  payoutSub: { color: theme.textSecondary, fontSize: 13, lineHeight: 19 },
  payoutBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 12, marginTop: 2 },
  payoutBtnText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  priceRow: { flexDirection: "row", gap: 10 },
  priceInput: { flex: 1, flexDirection: "row", alignItems: "center", backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, height: 48 },
  dollar: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  priceField: { flex: 1, color: theme.textPrimary, fontSize: 16, paddingHorizontal: 4, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  perMo: { color: theme.textMuted, fontSize: 14 },
  saveBtn: { backgroundColor: theme.primary, borderRadius: 12, paddingHorizontal: 20, height: 48, alignItems: "center", justifyContent: "center" },
  saveBtnText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  empty: { color: theme.textMuted, fontSize: 13, paddingVertical: 16 },
  txn: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  txnIcon: { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  txnName: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  txnKind: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
  txnAmt: { color: "#22C55E", fontSize: 15, fontWeight: "800" },
  txnAmtOut: { color: theme.textSecondary, fontSize: 15, fontWeight: "800" },
  sentHeader: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginTop: 24, marginBottom: 10 },
  spentTotal: { color: theme.textMuted, fontSize: 12, fontWeight: "700" },
});
