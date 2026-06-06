import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Platform, Linking, Alert, Share, Modal,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { Stack, useFocusEffect, useRouter, useLocalSearchParams } from "expo-router";
import { api, WalletSummary, WalletTxn, WalletBalance } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import { stripeOnboarding, stripeTopup } from "@/src/lib/stripeEmbed";

function fmtWhen(iso: string) {
  try { return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }); } catch { return ""; }
}
function fmtFull(iso: string) {
  try {
    return new Date(iso).toLocaleString([], {
      year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  } catch { return iso || "—"; }
}
function sourceLabel(src?: string) {
  if (src === "stripe") return "Card · Stripe";
  return "Test mode";
}
const REQ_LABELS: Record<string, string> = {
  external_account: "a bank account or debit card",
  "individual.verification.document": "a photo ID",
  "individual.id_number": "your ID/SSN number",
  "individual.dob.day": "your date of birth",
  "individual.address.line1": "your address",
  "business_profile.url": "a website or product description",
  "business_profile.mcc": "a business category",
  "tos_acceptance.date": "accepting Stripe's terms",
};
function prettyReq(r: string): string {
  return REQ_LABELS[r] || r.replace(/_/g, " ").replace(/\./g, " · ");
}

export default function WalletScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, refresh } = useAuth() as any;
  const [w, setW] = useState<WalletSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [subTiers, setSubTiers] = useState<{ id: string; name: string; price: number }[]>([]);
  const [detail, setDetail] = useState<{ txn: WalletTxn; direction: "received" | "sent" } | null>(null);
  const [copied, setCopied] = useState(false);
  const [payEnabled, setPayEnabled] = useState(false);
  const [payout, setPayout] = useState<{ connected: boolean; payouts_enabled: boolean; details_submitted: boolean } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [payoutInfo, setPayoutInfo] = useState<Awaited<ReturnType<typeof api.getPayouts>> | null>(null);
  const [runningPayout, setRunningPayout] = useState(false);
  const [threshold, setThreshold] = useState("");
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [bal, setBal] = useState<WalletBalance | null>(null);
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupAmt, setTopupAmt] = useState("");
  const [toppingUp, setToppingUp] = useState(false);
  const [curOpen, setCurOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getWallet();
      setW(data);
    } catch {} finally { setLoading(false); }
    try { setBal(await api.getWalletBalance()); } catch {}
    try { const { tiers } = await api.getSubscriptionTiers(); setSubTiers(tiers); } catch {}
    // Payment/payout status (Stripe) — harmless when Stripe is off.
    try {
      const cfg = await api.getPaymentsConfig();
      setPayEnabled(cfg.enabled);
      if (cfg.enabled) setPayout(await api.getPayoutStatus());
    } catch {}
    try { setPayoutInfo(await api.getPayouts()); } catch {}
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Returning from hosted Stripe onboarding (?payouts=done) — poll until Stripe
  // flips payouts on, since it can lag a few seconds after submitting details.
  const params = useLocalSearchParams<{ payouts?: string; session_id?: string; stripe_return?: string }>();
  useEffect(() => { if (params?.payouts === "done") { pollPayoutStatus(); } }, [params?.payouts]);

  // Returning from a wallet top-up checkout — confirm the payment server-side so
  // the balance updates even if the Stripe webhook is delayed/misconfigured.
  useEffect(() => {
    const sid = params?.session_id;
    if (!sid) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 6 && !cancelled; i++) {
        try {
          const r = await api.confirmTopup(String(sid));
          if (r.paid) { await load(); break; }
        } catch { break; }   // not a top-up session (e.g. subscription) or not ours
        await new Promise((res) => setTimeout(res, 2000));
      }
    })();
    return () => { cancelled = true; };
  }, [params?.session_id]);

  useEffect(() => { if (user?.payout_threshold != null) setThreshold(String(user.payout_threshold || "")); }, [user?.payout_threshold]);

  const runPayoutsNow = async () => {
    setRunningPayout(true);
    try { await api.runPayouts(); await load(); } catch {} finally { setRunningPayout(false); }
  };
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const { filename, csv } = await api.exportWallet();
      if (Platform.OS === "web" && typeof document !== "undefined") {
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
      } else {
        await Share.share({ message: csv, title: filename });
      }
    } catch (e: any) {
      Alert.alert("Export failed", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setExporting(false); }
  };

  const saveThreshold = async () => {
    setSavingThreshold(true);
    try { await api.updateMe({ payout_threshold: Math.max(0, Number(threshold) || 0) }); if (typeof refresh === "function") await refresh(); }
    catch {} finally { setSavingThreshold(false); }
  };
  const fmtDay = (iso?: string | null) => {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }); } catch { return "—"; }
  };

  // Re-check payout status a few times — Stripe can take a moment to flip
  // payouts_enabled on after onboarding details are submitted.
  const pollPayoutStatus = useCallback(async (tries = 5) => {
    for (let i = 0; i < tries; i++) {
      try {
        const st = await api.getPayoutStatus();
        setPayout(st);
        if (st.payouts_enabled) return st;
      } catch {}
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 2500));
    }
    return null;
  }, []);

  const setupPayouts = async () => {
    setConnecting(true);
    try {
      await stripeOnboarding();
      await load();
      await pollPayoutStatus();
    } catch (e: any) {
      Alert.alert("Couldn't start payout setup", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setConnecting(false); }
  };

  const [checkingPayout, setCheckingPayout] = useState(false);
  const checkPayoutAgain = async () => {
    setCheckingPayout(true);
    try {
      const st = await pollPayoutStatus(1);
      if (st && !st.payouts_enabled) {
        Alert.alert("Still verifying", "Stripe hasn't finished verifying your details yet. This can take a few minutes — check back shortly.");
      }
    } finally { setCheckingPayout(false); }
  };

  const fmtBal = (usd: number) =>
    bal ? `${bal.symbol}${(usd * bal.rate).toFixed(2)}` : `$${(usd || 0).toFixed(2)}`;

  const doTopup = async () => {
    const amt = Math.round((Number(topupAmt) || 0) * 100) / 100;
    if (amt <= 0) { Alert.alert("Enter an amount", "How much would you like to add?"); return; }
    setToppingUp(true);
    try {
      const credited = await stripeTopup(amt);
      setTopupOpen(false); setTopupAmt("");
      if (credited) await load();   // test mode: funds added instantly
    } catch (e: any) {
      Alert.alert("Top up failed", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setToppingUp(false); }
  };

  const changeCurrency = async (code: string) => {
    try {
      const r = await api.setCurrency(code);
      setBal(r); setCurOpen(false);
      if (typeof refresh === "function") await refresh();
    } catch {}
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="wallet-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/(tabs)/profile"); }} style={styles.iconBtn} testID="wallet-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Wallet</Text>
        <View style={{ flexDirection: "row" }}>
          <TouchableOpacity onPress={() => router.push("/pay-qr")} style={styles.iconBtn} testID="wallet-qr">
            <Ionicons name="qr-code-outline" size={22} color={theme.textPrimary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push("/money")} style={styles.iconBtn} testID="wallet-money">
            <Ionicons name="swap-horizontal" size={22} color={theme.textPrimary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={exportCsv} style={styles.iconBtn} disabled={exporting} testID="wallet-export">
            {exporting ? <ActivityIndicator color={theme.primary} size="small" /> : <Ionicons name="download-outline" size={22} color={theme.textPrimary} />}
          </TouchableOpacity>
        </View>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}>
          <View style={styles.balanceCard}>
            <View style={styles.balanceTop}>
              <Text style={styles.balLabel}>Wallet balance</Text>
              <TouchableOpacity style={styles.curChip} onPress={() => setCurOpen(true)} testID="wallet-currency">
                <Text style={styles.curChipText}>{bal?.currency || w?.currency || "USD"}</Text>
                <Ionicons name="chevron-down" size={13} color="#fff" />
              </TouchableOpacity>
            </View>
            <Text style={styles.balValue}>
              {bal ? `${bal.symbol}${bal.display.toFixed(2)}` : `$${(w?.balance ?? 0).toFixed(2)}`}
            </Text>
            {bal && bal.currency !== "USD" ? (
              <Text style={styles.balUsd}>≈ ${bal.balance.toFixed(2)} USD</Text>
            ) : null}
            <View style={styles.balActions}>
              <TouchableOpacity style={styles.topupBtn} onPress={() => { setTopupAmt(""); setTopupOpen(true); }} testID="wallet-topup">
                <Ionicons name="add-circle" size={18} color={theme.primary} />
                <Text style={styles.topupBtnText}>Top up</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.sendMoneyBtn} onPress={() => router.push("/money")} testID="wallet-send">
                <Ionicons name="paper-plane-outline" size={16} color="#fff" />
                <Text style={styles.sendMoneyText}>Send</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.totalCard}>
            <Text style={styles.totalLabel}>Total earned</Text>
            <Text style={styles.totalValue}>${(w?.total_earned ?? 0).toFixed(2)}</Text>
            <Text style={styles.totalSub}>{payEnabled ? "All earnings go to you, paid out via Stripe." : "All earnings go to you. Payouts are simulated (test mode)."}</Text>
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
              <Ionicons name="megaphone" size={18} color={theme.primary} />
              <Text style={styles.statNum}>${(w?.ads_total ?? 0).toFixed(2)}</Text>
              <Text style={styles.statLabel}>ads & views</Text>
            </View>
            <View style={styles.statCard}>
              <Ionicons name="people" size={18} color={theme.primary} />
              <Text style={styles.statNum}>{w?.active_subscribers ?? 0}</Text>
              <Text style={styles.statLabel}>subscribers</Text>
            </View>
          </View>

          <Text style={styles.section}>Payout frequency</Text>
          <View style={styles.freqRow}>
            {(["biweekly", "monthly"] as const).map((f) => {
              const on = (user?.payout_frequency || "monthly") === f;
              return (
                <TouchableOpacity
                  key={f}
                  style={[styles.freqChip, on && styles.freqChipOn]}
                  onPress={async () => { try { await api.updateMe({ payout_frequency: f }); if (typeof refresh === "function") await refresh(); } catch {} }}
                  testID={`freq-${f}`}
                >
                  <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={16} color={on ? theme.primary : theme.textMuted} />
                  <Text style={[styles.freqText, on && { color: theme.primary }]}>{f === "biweekly" ? "Bi-weekly" : "Monthly"}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.section}>Getting paid</Text>
          {payEnabled ? (() => {
            const verifying = !!payout?.connected && !!payout?.details_submitted && !payout?.payouts_enabled;
            const dotColor = payout?.payouts_enabled ? "#22C55E" : verifying ? "#F59E0B" : theme.textMuted;
            const statusText = payout?.payouts_enabled ? "Payouts active"
              : verifying ? "Verifying with Stripe"
              : payout?.connected ? "Setup incomplete" : "Not set up";
            const subText = payout?.payouts_enabled
              ? "Tips and subscriptions are paid out to your connected account via Stripe."
              : verifying
                ? "You've submitted your details — Stripe is verifying them. This can take a few minutes, then payouts turn on automatically."
                : "Connect a bank account or card with Stripe to receive real payouts. Until then, payments run in test mode.";
            const btnText = payout?.payouts_enabled ? "Manage payouts"
              : verifying ? "Update details"
              : payout?.connected ? "Finish setup" : "Set up payouts";
            return (
            <View style={styles.payoutCard}>
              <View style={styles.payoutHead}>
                <View style={[styles.payoutDot, { backgroundColor: dotColor }]} />
                <Text style={styles.payoutStatus}>{statusText}</Text>
              </View>
              <Text style={styles.payoutSub}>{subText}</Text>
              {!payout?.payouts_enabled && (payout?.requirements_due?.length ?? 0) > 0 ? (
                <Text style={styles.reqText}>Stripe still needs: {(payout?.requirements_due || []).slice(0, 4).map(prettyReq).join(", ")}.</Text>
              ) : null}
              <TouchableOpacity style={styles.payoutBtn} onPress={setupPayouts} disabled={connecting} testID="wallet-setup-payouts">
                {connecting ? <ActivityIndicator color="#fff" size="small" /> : (
                  <>
                    <Ionicons name="card-outline" size={16} color="#fff" />
                    <Text style={styles.payoutBtnText}>{btnText}</Text>
                  </>
                )}
              </TouchableOpacity>
              {verifying && (
                <TouchableOpacity style={styles.checkAgainBtn} onPress={checkPayoutAgain} disabled={checkingPayout} testID="wallet-check-payout">
                  {checkingPayout ? <ActivityIndicator color={theme.primary} size="small" /> : (
                    <Text style={styles.checkAgainText}>Check again</Text>
                  )}
                </TouchableOpacity>
              )}
            </View>
            );
          })() : (
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

          <View style={styles.payoutsHead}>
            <Text style={[styles.section, { marginBottom: 0 }]}>Payouts</Text>
            {user?.role === "admin" && (
              <TouchableOpacity onPress={runPayoutsNow} disabled={runningPayout} testID="run-payouts">
                {runningPayout ? <ActivityIndicator color={theme.primary} size="small" /> : <Text style={styles.runLink}>Run now</Text>}
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.payoutsCard}>
            <View style={styles.payoutsTop}>
              <View>
                <Text style={styles.balanceNum}>${(payoutInfo?.balance ?? 0).toFixed(2)}</Text>
                <Text style={styles.balanceLabel}>available balance</Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.balanceMeta}>{payoutInfo?.frequency === "biweekly" ? "Bi-weekly" : "Monthly"}</Text>
                <Text style={styles.balanceMeta}>next: {fmtDay(payoutInfo?.next_payout)}</Text>
              </View>
            </View>
            <Text style={styles.payoutsNote}>Paid out automatically on your schedule once you've connected payouts. ${(payoutInfo?.total_paid_out ?? 0).toFixed(2)} paid so far.</Text>
            <View style={styles.thresholdRow}>
              <Text style={styles.thresholdLabel}>Hold until balance reaches</Text>
              <View style={styles.thresholdInputWrap}>
                <Text style={styles.dollar}>$</Text>
                <TextInput
                  style={styles.thresholdInput}
                  value={threshold}
                  onChangeText={(t) => setThreshold(t.replace(/[^0-9.]/g, ""))}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  placeholderTextColor={theme.textMuted}
                  testID="payout-threshold"
                />
              </View>
              <TouchableOpacity style={styles.thresholdBtn} onPress={saveThreshold} disabled={savingThreshold} testID="save-threshold">
                {savingThreshold ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.thresholdBtnText}>Save</Text>}
              </TouchableOpacity>
            </View>
            {(payoutInfo?.history || []).slice(0, 6).map((p) => (
              <View key={p.id} style={styles.payoutRow}>
                <Ionicons name={p.status === "paid" ? "checkmark-circle" : p.status === "failed" ? "alert-circle" : "time-outline"} size={15} color={p.status === "failed" ? theme.error : theme.primary} />
                <Text style={styles.payoutDate}>{fmtDay(p.created_at)}</Text>
                <Text style={styles.payoutStatus}>{p.status === "simulated" ? "test" : p.status}</Text>
                <Text style={styles.payoutAmt}>${p.amount.toFixed(2)}</Text>
              </View>
            ))}
          </View>

          <Text style={styles.section}>Subscription tiers</Text>
          <View style={styles.tiersInfoCard}>
            <Text style={styles.tiersInfoText}>
              Fans choose from three set tiers when they subscribe to you. Pricing is the same for every creator.
            </Text>
            {subTiers.map((t) => (
              <View key={t.id} style={styles.tiersInfoRow}>
                <Ionicons name="star" size={15} color={theme.primary} />
                <Text style={styles.tiersInfoName}>{t.name}</Text>
                <Text style={styles.tiersInfoPrice}>${t.price.toFixed(2)}/mo</Text>
              </View>
            ))}
          </View>

          <Text style={styles.section}>Received</Text>
          {(w?.recent || []).length === 0 ? (
            <Text style={styles.empty}>No earnings yet. When people tip or subscribe to you, they'll show here.</Text>
          ) : (
            (w?.recent || []).map((t) => (
              <TouchableOpacity key={t.id} style={styles.txn} activeOpacity={0.6} onPress={() => { setCopied(false); setDetail({ txn: t, direction: "received" }); }} testID={`txn-recv-${t.id}`}>
                <View style={[styles.txnIcon, { backgroundColor: theme.surfaceAlt }]}>
                  <Ionicons name={t.kind === "subscription" ? "star" : "cash"} size={16} color={theme.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.txnName}>{t.from_name}</Text>
                  <Text style={styles.txnKind}>{t.kind === "subscription" ? "Subscription" : "Tip"} · {fmtWhen(t.created_at)}</Text>
                </View>
                <Text style={styles.txnAmt}>+${t.amount.toFixed(2)}</Text>
                <Ionicons name="chevron-forward" size={16} color={theme.textMuted} style={{ marginLeft: 6 }} />
              </TouchableOpacity>
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
              <TouchableOpacity key={t.id} style={styles.txn} activeOpacity={0.6} onPress={() => { setCopied(false); setDetail({ txn: t, direction: "sent" }); }} testID={`txn-sent-${t.id}`}>
                <View style={[styles.txnIcon, { backgroundColor: theme.surfaceAlt }]}>
                  <Ionicons name={t.kind === "subscription" ? "star-outline" : "arrow-up-circle-outline"} size={16} color={theme.textSecondary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.txnName}>To {t.from_name}</Text>
                  <Text style={styles.txnKind}>{t.kind === "subscription" ? "Subscription" : "Tip"} · {fmtWhen(t.created_at)}</Text>
                </View>
                <Text style={styles.txnAmtOut}>-${t.amount.toFixed(2)}</Text>
                <Ionicons name="chevron-forward" size={16} color={theme.textMuted} style={{ marginLeft: 6 }} />
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      )}

      {/* ── Transaction detail ───────────────────────────────────────── */}
      <Modal visible={!!detail} transparent animationType="fade" onRequestClose={() => setDetail(null)}>
        <View style={styles.detailBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setDetail(null)} />
          {detail && (
            <View style={styles.detailCard}>
              <View style={[styles.detailIcon, { backgroundColor: theme.surfaceAlt }]}>
                <Ionicons
                  name={detail.txn.kind === "subscription" ? "star" : "cash"}
                  size={26}
                  color={detail.direction === "received" ? theme.primary : theme.textSecondary}
                />
              </View>
              <Text style={[styles.detailAmount, { color: detail.direction === "received" ? "#22C55E" : theme.textPrimary }]}>
                {detail.direction === "received" ? "+" : "-"}${detail.txn.amount.toFixed(2)}
              </Text>
              <Text style={styles.detailKind}>
                {detail.txn.kind === "subscription" ? "Subscription" : "Tip"} · {detail.direction === "received" ? "Received" : "Sent"}
              </Text>

              <View style={styles.detailDivider} />

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>{detail.direction === "received" ? "From" : "To"}</Text>
                <Text style={styles.detailValue}>{detail.txn.from_name}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Amount</Text>
                <Text style={styles.detailValue}>${detail.txn.amount.toFixed(2)} USD</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>When</Text>
                <Text style={styles.detailValue}>{fmtFull(detail.txn.created_at)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>How</Text>
                <Text style={styles.detailValue}>{sourceLabel(detail.txn.source)}</Text>
              </View>
              <View style={[styles.detailRow, { alignItems: "flex-start" }]}>
                <Text style={styles.detailLabel}>Transaction ID</Text>
                <Text style={[styles.detailValue, styles.detailMono]} selectable numberOfLines={2}>{detail.txn.id}</Text>
              </View>

              <TouchableOpacity
                style={styles.copyBtn}
                onPress={async () => { try { await Clipboard.setStringAsync(detail.txn.id); setCopied(true); } catch {} }}
                testID="copy-txn-id"
              >
                <Ionicons name={copied ? "checkmark" : "copy-outline"} size={15} color={theme.primary} />
                <Text style={styles.copyBtnText}>{copied ? "Copied" : "Copy transaction ID"}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.detailClose} onPress={() => setDetail(null)} testID="txn-close">
                <Text style={styles.detailCloseText}>Close</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>

      {/* ── Top up ───────────────────────────────────────────────────── */}
      <Modal visible={topupOpen} transparent animationType="fade" onRequestClose={() => setTopupOpen(false)}>
        <View style={styles.detailBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setTopupOpen(false)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Top up wallet</Text>
            <Text style={styles.sheetSub}>
              {payEnabled ? "Pay securely with Stripe. Funds appear in your balance after payment." : "Test mode — funds are added instantly."}
            </Text>
            <View style={styles.amountWrap}>
              <Text style={styles.amountDollar}>$</Text>
              <TextInput
                style={styles.amountInput}
                value={topupAmt}
                onChangeText={(t) => setTopupAmt(t.replace(/[^0-9.]/g, ""))}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor={theme.textMuted}
                autoFocus
                testID="topup-amount"
              />
            </View>
            {bal && bal.currency !== "USD" && Number(topupAmt) > 0 ? (
              <Text style={styles.amountConv}>≈ {bal.symbol}{(Number(topupAmt) * bal.rate).toFixed(2)} {bal.currency}</Text>
            ) : null}
            <View style={styles.quickRow}>
              {[10, 25, 50, 100].map((q) => (
                <TouchableOpacity key={q} style={styles.quickChip} onPress={() => setTopupAmt(String(q))} testID={`topup-${q}`}>
                  <Text style={styles.quickText}>${q}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={styles.sheetBtn} onPress={doTopup} disabled={toppingUp} testID="topup-confirm">
              {toppingUp ? <ActivityIndicator color="#fff" size="small" /> : (
                <Text style={styles.sheetBtnText}>{payEnabled ? "Continue to payment" : "Add funds"}</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={styles.detailClose} onPress={() => setTopupOpen(false)}>
              <Text style={styles.detailCloseText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Currency picker ──────────────────────────────────────────── */}
      <Modal visible={curOpen} transparent animationType="fade" onRequestClose={() => setCurOpen(false)}>
        <View style={styles.detailBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setCurOpen(false)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Display currency</Text>
            <Text style={styles.sheetSub}>Balances are shown in this currency. Money is still held in USD.</Text>
            <ScrollView style={{ maxHeight: 340, alignSelf: "stretch" }}>
              {Object.entries(bal?.currencies || {}).map(([code, info]) => {
                const on = (bal?.currency || "USD") === code;
                return (
                  <TouchableOpacity key={code} style={styles.curRow} onPress={() => changeCurrency(code)} testID={`cur-${code}`}>
                    <Text style={styles.curSym}>{info.symbol}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.curCode}>{code}</Text>
                      <Text style={styles.curName}>{info.name}</Text>
                    </View>
                    {on ? <Ionicons name="checkmark-circle" size={20} color={theme.primary} /> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity style={styles.detailClose} onPress={() => setCurOpen(false)}>
              <Text style={styles.detailCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  balanceCard: { backgroundColor: theme.primary, borderRadius: 18, padding: 20, marginBottom: 14 },
  balanceTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  balLabel: { color: "rgba(255,255,255,0.85)", fontSize: 13, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  curChip: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "rgba(255,255,255,0.18)", borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5 },
  curChipText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  balValue: { color: "#fff", fontSize: 40, fontWeight: "900", letterSpacing: -1, marginTop: 8 },
  balUsd: { color: "rgba(255,255,255,0.8)", fontSize: 13, marginTop: 2 },
  balActions: { flexDirection: "row", gap: 10, marginTop: 16 },
  topupBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: "#fff", borderRadius: 12, paddingVertical: 12 },
  topupBtnText: { color: theme.primary, fontWeight: "800", fontSize: 15 },
  sendMoneyBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: "rgba(255,255,255,0.18)", borderRadius: 12, paddingVertical: 12 },
  sendMoneyText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  sheet: { width: "100%", maxWidth: 420, backgroundColor: theme.surface, borderRadius: 20, borderWidth: 1, borderColor: theme.border, padding: 22, alignItems: "center" },
  sheetTitle: { color: theme.textPrimary, fontSize: 19, fontWeight: "900" },
  sheetSub: { color: theme.textMuted, fontSize: 13, textAlign: "center", marginTop: 6, lineHeight: 18 },
  amountWrap: { flexDirection: "row", alignItems: "center", justifyContent: "center", alignSelf: "stretch", marginTop: 18, gap: 4 },
  amountDollar: { color: theme.textPrimary, fontSize: 30, fontWeight: "800" },
  amountInput: { color: theme.textPrimary, fontSize: 40, fontWeight: "900", minWidth: 120, textAlign: "center", ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  amountConv: { color: theme.textMuted, fontSize: 13, marginTop: 4 },
  quickRow: { flexDirection: "row", gap: 8, marginTop: 16, alignSelf: "stretch" },
  quickChip: { flex: 1, backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  quickText: { color: theme.textPrimary, fontSize: 14, fontWeight: "800" },
  sheetBtn: { alignSelf: "stretch", backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 18 },
  sheetBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  curRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  curSym: { color: theme.textPrimary, fontSize: 18, fontWeight: "800", width: 34, textAlign: "center" },
  curCode: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  curName: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
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
  checkAgainBtn: { alignItems: "center", justifyContent: "center", paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: theme.border, marginTop: 2 },
  checkAgainText: { color: theme.primary, fontWeight: "800", fontSize: 14 },
  reqText: { color: "#F59E0B", fontSize: 12.5, fontWeight: "700", lineHeight: 18 },
  freqRow: { flexDirection: "row", gap: 10 },
  freqChip: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingVertical: 12 },
  freqChipOn: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  freqText: { color: theme.textSecondary, fontSize: 14, fontWeight: "700" },
  payoutsHead: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginTop: 24, marginBottom: 10 },
  runLink: { color: theme.primary, fontSize: 13, fontWeight: "700" },
  payoutsCard: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 16, gap: 8 },
  payoutsTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  balanceNum: { color: theme.textPrimary, fontSize: 26, fontWeight: "900", letterSpacing: -0.6 },
  balanceLabel: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
  balanceMeta: { color: theme.textSecondary, fontSize: 12, fontWeight: "600" },
  payoutsNote: { color: theme.textMuted, fontSize: 12, lineHeight: 17 },
  payoutRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  payoutDate: { color: theme.textSecondary, fontSize: 13, flex: 1 },
  payoutStatus: { color: theme.textMuted, fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  payoutAmt: { color: theme.primary, fontSize: 14, fontWeight: "800", width: 70, textAlign: "right" },
  thresholdRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  thresholdLabel: { color: theme.textSecondary, fontSize: 12.5, flex: 1 },
  thresholdInputWrap: { flexDirection: "row", alignItems: "center", backgroundColor: theme.surfaceAlt, borderRadius: 10, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 10, height: 38, width: 84 },
  thresholdInput: { flex: 1, color: theme.textPrimary, fontSize: 14, paddingHorizontal: 2, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  thresholdBtn: { backgroundColor: theme.primary, borderRadius: 10, paddingHorizontal: 14, height: 38, alignItems: "center", justifyContent: "center" },
  thresholdBtnText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  dollar: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  tiersInfoCard: { backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 14 },
  tiersInfoText: { color: theme.textSecondary, fontSize: 13, marginBottom: 10 },
  tiersInfoRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  tiersInfoName: { flex: 1, color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  tiersInfoPrice: { color: theme.primary, fontSize: 14, fontWeight: "800" },
  empty: { color: theme.textMuted, fontSize: 13, paddingVertical: 16 },
  txn: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  txnIcon: { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  txnName: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  txnKind: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
  txnAmt: { color: "#22C55E", fontSize: 15, fontWeight: "800" },
  txnAmtOut: { color: theme.textSecondary, fontSize: 15, fontWeight: "800" },
  sentHeader: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginTop: 24, marginBottom: 10 },
  spentTotal: { color: theme.textMuted, fontSize: 12, fontWeight: "700" },

  detailBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 24 },
  detailCard: { width: "100%", maxWidth: 420, backgroundColor: theme.surface, borderRadius: 20, borderWidth: 1, borderColor: theme.border, padding: 22, alignItems: "center" },
  detailIcon: { width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center" },
  detailAmount: { fontSize: 32, fontWeight: "900", letterSpacing: -0.8, marginTop: 12 },
  detailKind: { color: theme.textMuted, fontSize: 13, fontWeight: "700", marginTop: 2 },
  detailDivider: { alignSelf: "stretch", height: StyleSheet.hairlineWidth, backgroundColor: theme.border, marginVertical: 16 },
  detailRow: { alignSelf: "stretch", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16, paddingVertical: 8 },
  detailLabel: { color: theme.textMuted, fontSize: 13, fontWeight: "600" },
  detailValue: { flex: 1, color: theme.textPrimary, fontSize: 14, fontWeight: "700", textAlign: "right" },
  detailMono: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12, fontWeight: "500" },
  copyBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, alignSelf: "stretch", backgroundColor: theme.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingVertical: 12, marginTop: 16 },
  copyBtnText: { color: theme.primary, fontSize: 14, fontWeight: "800" },
  detailClose: { paddingVertical: 12, marginTop: 4 },
  detailCloseText: { color: theme.textMuted, fontSize: 14, fontWeight: "700" },
});
