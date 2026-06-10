import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Platform, Alert, TextInput, RefreshControl,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api } from "@/src/api/client";
import { theme } from "@/src/theme";
import { useConfirm } from "@/src/context/ConfirmContext";

export default function AdminPaymentsScreen() {
  const router = useRouter();
  const confirm = useConfirm();
  const insets = useSafeAreaInsets();
  const [testPayments, setTestPayments] = useState(false);
  const [stripeConfigured, setStripeConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [feePct, setFeePct] = useState("");      // platform's cut % of subscriptions/tips
  const [feeCents, setFeeCents] = useState("");  // flat per-payment fee, in cents
  const [savingFees, setSavingFees] = useState(false);
  const [revenue, setRevenue] = useState<{ total: number; count: number; by_source: Record<string, number>; transfer_fees?: number; cashout_fees?: number; cashout_count?: number; total_paid_out?: number; cashout_fee?: number; transaction_fee_cents: number } | null>(null);
  const [mobileOnly, setMobileOnly] = useState(false);
  const [savingMobile, setSavingMobile] = useState(false);
  const [webBuild, setWebBuild] = useState<string>("");
  const [bumpingWeb, setBumpingWeb] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const toggleMobileOnly = async () => {
    const next = !mobileOnly; setMobileOnly(next); setSavingMobile(true);
    try { await api.adminSetMobileOnly(next); }
    catch (e: any) { setMobileOnly(!next); Alert.alert("Couldn't save", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setSavingMobile(false); }
  };

  const forceWebUpdate = async () => {
    if (!(await confirm({ title: "Force web update?", message: "Every open web browser will clear its cache and reload to the latest deploy within a few minutes (mobile apps are unaffected).", confirmLabel: "Update all" }))) return;
    setBumpingWeb(true); setMsg(null);
    try { const r = await api.adminBumpWebBuild(); setWebBuild(r.web_build); setMsg("Web clients will refresh to the latest version shortly."); }
    catch (e: any) { Alert.alert("Couldn't bump", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setBumpingWeb(false); }
  };

  const load = useCallback(async () => {
    try { const r = await api.adminGetTestPayments(); setTestPayments(r.test_payments); setStripeConfigured(r.stripe_configured); }
    catch {} finally { setLoading(false); }
    try { const f = await api.adminGetFees(); setFeePct(String(f.platform_fee_percent)); setFeeCents(String(f.transaction_fee_cents)); }
    catch {}
    try { setRevenue(await api.adminGetRevenue()); } catch {}
    try { setMobileOnly((await api.adminGetMobileOnly()).mobile_only); } catch {}
    try { setWebBuild((await api.adminGetWebBuild()).web_build); } catch {}
    setRefreshing(false);
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const saveFees = async () => {
    setSavingFees(true); setMsg(null);
    try {
      const f = await api.adminSetFees({
        platform_fee_percent: Math.max(0, Math.min(100, Number(feePct) || 0)),
        transaction_fee_cents: Math.max(0, Math.round(Number(feeCents) || 0)),
      });
      setFeePct(String(f.platform_fee_percent)); setFeeCents(String(f.transaction_fee_cents));
      setMsg(`Saved — creators keep ${f.creator_share_percent}%, ${f.transaction_fee_cents}¢ fee per payment.`);
    } catch (e: any) { Alert.alert("Couldn't save", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setSavingFees(false); }
  };
  const creatorShare = Math.max(0, Math.min(100, 100 - (Number(feePct) || 0)));

  const toggle = async () => {
    const next = !testPayments; setTestPayments(next); setSaving(true); setMsg(null);
    try { await api.adminSetTestPayments(next); }
    catch (e: any) { setTestPayments(!next); Alert.alert("Couldn't save", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setSaving(false); }
  };

  const confirmReset = async (kind: "money" | "analytics") => {
    const label = kind === "money" ? "all wallets, tips, subscriptions, payouts, transfers and ad balances" : "all ad/view analytics (impressions, clicks, spend, views)";
    if (!(await confirm({ title: "Are you sure?", message: `This resets ${label}. It can't be undone.`, confirmLabel: "Reset", destructive: true }))) return;
    setBusy(kind); setMsg(null);
    try {
      if (kind === "money") await api.adminResetMoney(); else await api.adminResetAnalytics();
      setMsg(kind === "money" ? "Money data reset." : "Analytics reset.");
    } catch (e: any) { Alert.alert("Reset failed", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setBusy(null); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="admin-payments-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="ap-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Payments & data</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} />}
        >
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

          <Text style={styles.section}>Access</Text>
          <View style={styles.card}>
            <TouchableOpacity style={styles.toggleRow} onPress={toggleMobileOnly} disabled={savingMobile} testID="ap-mobile-only">
              <View style={{ flex: 1 }}>
                <Text style={styles.rowLabel}>Mobile only (web)</Text>
                <Text style={styles.rowSub}>Deprecated — the web app now runs as a full website on desktop. Toggling this no longer blocks PC browsers.</Text>
              </View>
              {savingMobile ? <ActivityIndicator color={theme.primary} size="small" /> : (
                <View style={[styles.switch, mobileOnly && styles.switchOn]}>
                  <View style={[styles.knob, mobileOnly && styles.knobOn]} />
                </View>
              )}
            </TouchableOpacity>
            <View style={styles.divider} />
            <TouchableOpacity style={styles.toggleRow} onPress={forceWebUpdate} disabled={bumpingWeb} testID="ap-web-update">
              <View style={{ flex: 1 }}>
                <Text style={styles.rowLabel}>Force web update</Text>
                <Text style={styles.rowSub}>Make every open web browser clear its cache and reload to the latest deploy. Use after a release if anyone reports a stale page.{webBuild ? ` Current build: ${webBuild}.` : ""}</Text>
              </View>
              {bumpingWeb ? <ActivityIndicator color={theme.primary} size="small" /> : (
                <Text style={styles.actionLink}>Update all</Text>
              )}
            </TouchableOpacity>
          </View>

          {revenue ? (
            <>
              <Text style={styles.section}>Platform revenue</Text>
              <View style={styles.card}>
                <View style={styles.revRow}>
                  <Text style={styles.revLabel}>Total fees collected</Text>
                  <Text style={styles.revValue}>${revenue.total.toFixed(2)}</Text>
                </View>
                <View style={styles.revBreakdown}>
                  <View style={styles.revStat}>
                    <Text style={styles.revStatNum}>${(revenue.transfer_fees ?? 0).toFixed(2)}</Text>
                    <Text style={styles.revStatLabel}>from sends</Text>
                  </View>
                  <View style={styles.revStat}>
                    <Text style={styles.revStatNum}>${(revenue.cashout_fees ?? 0).toFixed(2)}</Text>
                    <Text style={styles.revStatLabel}>cash-out fees</Text>
                  </View>
                  <View style={styles.revStat}>
                    <Text style={styles.revStatNum}>${(revenue.total_paid_out ?? 0).toFixed(2)}</Text>
                    <Text style={styles.revStatLabel}>paid to creators</Text>
                  </View>
                </View>
                <View style={styles.revBreakdown}>
                  <View style={styles.revStat}>
                    <Text style={styles.revStatNum}>{revenue.count}</Text>
                    <Text style={styles.revStatLabel}>fee-paying events</Text>
                  </View>
                  <View style={styles.revStat}>
                    <Text style={styles.revStatNum}>{revenue.transaction_fee_cents}¢</Text>
                    <Text style={styles.revStatLabel}>per-send fee</Text>
                  </View>
                  <View style={styles.revStat}>
                    <Text style={styles.revStatNum}>${(revenue.cashout_fee ?? 0).toFixed(2)}</Text>
                    <Text style={styles.revStatLabel}>per cash-out</Text>
                  </View>
                </View>
                <Text style={styles.revNote}>In-app flat fees (charged on every send, including admins). Send fees show as soon as the money is sent and are removed if it's reversed/declined. The % cut on tips/subscriptions is collected by Stripe — see your Stripe Dashboard.</Text>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.section}>Platform revenue</Text>
              <View style={styles.card}>
                <Text style={styles.revNote}>Couldn't load revenue right now. Pull down to refresh.</Text>
              </View>
            </>
          )}

          <Text style={styles.section}>Fees & revenue split</Text>
          <View style={styles.card}>
            <View style={styles.feeRow}>
              <Text style={styles.rowLabel}>Platform cut (subscriptions & tips)</Text>
              <Text style={styles.rowSub}>Your share of each subscription & tip. Creators keep the rest.</Text>
              <View style={styles.feeInputWrap}>
                <TextInput
                  style={styles.feeInput} value={feePct}
                  onChangeText={(t) => setFeePct(t.replace(/[^0-9.]/g, ""))}
                  keyboardType="decimal-pad" placeholder="30" placeholderTextColor={theme.textMuted} testID="ap-fee-pct"
                />
                <Text style={styles.feeUnit}>%</Text>
              </View>
              <Text style={styles.splitText}>Creators keep {creatorShare}% · you keep {Math.max(0, Math.min(100, Number(feePct) || 0))}%</Text>
            </View>
            <View style={styles.feeDivider} />
            <View style={styles.feeRow}>
              <Text style={styles.rowLabel}>Transaction fee</Text>
              <Text style={styles.rowSub}>Flat fee charged to the payer on each payment (tips & money sends).</Text>
              <View style={styles.feeInputWrap}>
                <TextInput
                  style={styles.feeInput} value={feeCents}
                  onChangeText={(t) => setFeeCents(t.replace(/[^0-9]/g, ""))}
                  keyboardType="number-pad" placeholder="10" placeholderTextColor={theme.textMuted} testID="ap-fee-cents"
                />
                <Text style={styles.feeUnit}>¢</Text>
              </View>
              <Text style={styles.splitText}>{feeCents || "10"}¢ on every payment</Text>
            </View>
            <TouchableOpacity style={styles.saveBtn} onPress={saveFees} disabled={savingFees} testID="ap-save-fees">
              {savingFees ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.saveText}>Save fees</Text>}
            </TouchableOpacity>
          </View>

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
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.border, marginHorizontal: 16 },
  actionLink: { color: theme.primary, fontSize: 14, fontWeight: "700" },
  switch: { width: 46, height: 28, borderRadius: 14, backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, padding: 2, justifyContent: "center" },
  switchOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: "#fff" },
  knobOn: { alignSelf: "flex-end" },
  note: { color: theme.textSecondary, fontSize: 13, marginTop: 10, fontWeight: "600" },
  feeRow: { padding: 16 },
  feeInputWrap: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", backgroundColor: theme.surfaceAlt, borderRadius: 10, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, height: 48, marginTop: 12 },
  feeInput: { width: 56, color: theme.textPrimary, fontSize: 18, fontWeight: "800", ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  feeUnit: { color: theme.textMuted, fontSize: 16, fontWeight: "800", marginLeft: 2 },
  splitText: { color: theme.primary, fontSize: 13, fontWeight: "700", marginTop: 10 },
  feeDivider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.border, marginVertical: 6, marginHorizontal: 16 },
  saveBtn: { backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 13, alignItems: "center", margin: 16, marginTop: 10 },
  saveText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  revRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, paddingBottom: 6 },
  revLabel: { color: theme.textSecondary, fontSize: 14, fontWeight: "600" },
  revValue: { color: theme.primary, fontSize: 22, fontWeight: "900" },
  revBreakdown: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 10 },
  revStat: { flex: 1, backgroundColor: theme.surfaceAlt, borderRadius: 12, paddingVertical: 12, alignItems: "center", gap: 3 },
  revStatNum: { color: theme.textPrimary, fontSize: 17, fontWeight: "900" },
  revStatLabel: { color: theme.textMuted, fontSize: 10.5, textAlign: "center" },
  revNote: { color: theme.textMuted, fontSize: 12, lineHeight: 17, paddingHorizontal: 16, paddingBottom: 14 },
  resetBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.error, borderRadius: 12, paddingVertical: 14, marginBottom: 10 },
  resetText: { color: theme.error, fontSize: 13.5, fontWeight: "700" },
  msg: { color: theme.primary, fontSize: 13, fontWeight: "600", marginTop: 8, textAlign: "center" },
  warn: { color: theme.textMuted, fontSize: 12, lineHeight: 18, marginTop: 16, textAlign: "center" },
});
