import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Platform, Linking, Alert, Share, Modal,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "@/src/platform/clipboard";
import { Stack, useFocusEffect, useRouter, useLocalSearchParams } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, WalletSummary, WalletTxn, WalletBalance, Topup } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import { GLASS } from "@/src/lib/glass";
import { stripeTopup, stripeCardTopup } from "@/src/lib/stripeEmbed";
import { useConfirm } from "@/src/context/ConfirmContext";

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
  if (src === "transfer") return "Wallet transfer";
  return "Test mode";
}
function fmtTopup(iso: string) {
  try {
    return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return ""; }
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
const DISABLED_REASONS: Record<string, string> = {
  "requirements.pending_verification": "Stripe is reviewing the details you submitted — usually a few minutes, up to a day.",
  "requirements.past_due": "Stripe needs more information before it can enable payouts.",
  "requirements.currently_due": "Stripe needs more information before it can enable payouts.",
  under_review: "Stripe is reviewing your account.",
  listed: "Your account is under review by Stripe.",
  "rejected.fraud": "Stripe rejected this account (suspected fraud). Contact Stripe support.",
  "rejected.terms_of_service": "Stripe rejected this account (terms of service). Contact Stripe support.",
  "rejected.listed": "Stripe rejected this account. Contact Stripe support.",
  "rejected.other": "Stripe rejected this account. Contact Stripe support.",
  platform_paused: "Payouts are paused for this account.",
  other: "Stripe needs a little more before enabling payouts.",
};
function disabledReasonLabel(r: string): string {
  return DISABLED_REASONS[r] || "Stripe is finishing verification.";
}
const TOPUP_STATUS: Record<string, { label: string; icon: string; color: string; bg: string }> = {
  completed: { label: "Completed", icon: "checkmark-circle", color: "#16A34A", bg: "rgba(22,163,74,0.12)" },
  processing: { label: "Processing", icon: "time-outline", color: "#D97706", bg: "rgba(217,119,6,0.12)" },
  failed: { label: "Failed", icon: "close-circle", color: "#DC2626", bg: "rgba(220,38,38,0.12)" },
  cancelled: { label: "Cancelled", icon: "ban-outline", color: "#9CA3AF", bg: "rgba(156,163,175,0.12)" },
};

export default function WalletScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const confirm = useConfirm();
  const { user, refresh } = useAuth() as any;
  const [w, setW] = useState<WalletSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [subTiers, setSubTiers] = useState<{ id: string; name: string; price: number }[]>([]);
  const [detail, setDetail] = useState<{ txn: WalletTxn; direction: "received" | "sent" } | null>(null);
  const [copied, setCopied] = useState(false);
  const [payEnabled, setPayEnabled] = useState(false);
  const [cashoutMin, setCashoutMin] = useState(20);
  const [cashoutFee, setCashoutFee] = useState(2);
  const [payout, setPayout] = useState<{ connected: boolean; payouts_enabled: boolean; details_submitted: boolean } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [payoutInfo, setPayoutInfo] = useState<Awaited<ReturnType<typeof api.getPayouts>> | null>(null);
  const [runningPayout, setRunningPayout] = useState(false);
  const [threshold, setThreshold] = useState("");
  const [freqPickerOpen, setFreqPickerOpen] = useState(false);
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [bal, setBal] = useState<WalletBalance | null>(null);
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupAmt, setTopupAmt] = useState("");
  const [toppingUp, setToppingUp] = useState(false);
  const [curOpen, setCurOpen] = useState(false);
  const [topups, setTopups] = useState<Topup[]>([]);
  const [topupDetail, setTopupDetail] = useState<Topup | null>(null);
  const [cashoutOpen, setCashoutOpen] = useState(false);
  const [cashoutAmt, setCashoutAmt] = useState("");
  const [cashingOut, setCashingOut] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getWallet();
      setW(data);
    } catch {} finally { setLoading(false); }
    try { setBal(await api.getWalletBalance()); } catch {}
    try { setTopups((await api.getTopups()).topups); } catch {}
    try { const { tiers } = await api.getSubscriptionTiers(); setSubTiers(tiers); } catch {}
    // Payment/payout status (Stripe) — harmless when Stripe is off.
    try {
      const cfg = await api.getPaymentsConfig();
      setPayEnabled(cfg.enabled);
      if (cfg.cashout_min != null) setCashoutMin(cfg.cashout_min);
      if (cfg.cashout_fee != null) setCashoutFee(cfg.cashout_fee);
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

  // Safety net: once per visit, reconcile any paid top-up that a missed webhook
  // never credited (recovers funds even without a session_id in the URL).
  const syncedRef = useRef(false);
  useEffect(() => {
    if (syncedRef.current) return;
    syncedRef.current = true;
    (async () => { try { const r = await api.syncTopups(); if (r.credited > 0) await load(); } catch {} })();
  }, [load]);

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
    const next = Math.max(0, Number(threshold) || 0);
    const current = Number(payoutInfo?.threshold ?? user?.payout_threshold ?? 0) || 0;
    if (next === current) { Alert.alert("No change", "That's already your minimum payout balance."); return; }
    const ok = await confirm({
      title: "Change minimum payout balance?",
      message: `Set the minimum to $${next.toFixed(2)}? You can only change this once a month — after saving it'll be locked for 30 days.`,
      confirmLabel: "Change it",
      cancelLabel: "Keep current",
    });
    if (!ok) return;
    setSavingThreshold(true);
    try {
      await api.updateMe({ payout_threshold: next });
      if (typeof refresh === "function") await refresh();
      await load();
      Alert.alert("Saved", "Your minimum payout balance was updated and is now locked for 30 days.");
    } catch (e: any) {
      Alert.alert("Couldn't change minimum", String(e?.message || e).replace(/^\d{3}:\s*/, "") || "Try again later.");
    } finally { setSavingThreshold(false); }
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

  // Identity verification is now a fully in-app form (no Stripe screen).
  const setupPayouts = async () => { router.push("/verify-payouts"); };

  const addPayoutMethod = () => {
    if (!payout?.account_id) { router.push("/verify-payouts"); return; }
    router.push("/add-card");
  };

  const freqLockedUntil = payoutInfo?.frequency_locked_until || null;
  const thresholdLockedUntil = payoutInfo?.threshold_locked_until || null;
  const changeFrequency = async (f: "weekly" | "biweekly" | "monthly") => {
    if ((user?.payout_frequency || "weekly") === f) return;
    if (freqLockedUntil) {
      Alert.alert("Locked for now", `You can change your payout frequency once a month. You can change it again on ${new Date(freqLockedUntil).toLocaleDateString()}.`);
      return;
    }
    const label = f === "weekly" ? "Weekly" : f === "biweekly" ? "Bi-weekly" : "Monthly";
    const ok = await confirm({
      title: "Change payout frequency?",
      message: `Set payouts to ${label}? You can only change this once a month — after this you won't be able to change it again for 30 days.`,
      confirmLabel: "Change",
      cancelLabel: "Keep current",
    });
    if (!ok) return;
    try {
      await api.updateMe({ payout_frequency: f });
      if (typeof refresh === "function") await refresh();
      await load();
    } catch (e: any) {
      Alert.alert("Couldn't change", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    }
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
      // Inline card field on web when live; falls back to embedded/hosted checkout.
      const credited = payEnabled ? await stripeCardTopup(amt) : await stripeTopup(amt);
      setTopupOpen(false); setTopupAmt("");
      await load();   // refresh balance + show the new top-up (processing/completed)
      void credited;
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

  const [cancelingTopup, setCancelingTopup] = useState(false);
  const cancelTopup = async (t: Topup) => {
    setCancelingTopup(true);
    try { await api.cancelTopup(t.id); setTopupDetail(null); await load(); }
    catch (e: any) { Alert.alert("Couldn't cancel", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setCancelingTopup(false); }
  };
  const resumingRef = useRef(false);
  const resumeTopup = async (t: Topup) => {
    if (resumingRef.current) return;   // a double-tap would cancel twice + open two checkouts
    resumingRef.current = true;
    setTopupDetail(null);
    try {
      await api.cancelTopup(t.id);           // close the stale session first
      const credited = await stripeTopup(t.amount);  // start a fresh checkout for the same amount
      if (credited) await load();
    } catch (e: any) {
      Alert.alert("Couldn't resume", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { resumingRef.current = false; }
  };

  const doCashout = async () => {
    if (cashingOut) return;
    const amt = Math.round((Number(cashoutAmt) || 0) * 100) / 100;
    if (!isFinite(amt) || amt <= 0) { Alert.alert("Enter an amount", "How much would you like to cash out?"); return; }
    if (amt < cashoutMin) { Alert.alert("Below minimum", `The minimum cash-out is $${cashoutMin.toFixed(0)}. A $${cashoutFee.toFixed(0)} fee applies.`); return; }
    const balNow = bal?.balance ?? w?.balance ?? 0;
    if (amt > balNow + 1e-9) { Alert.alert("Not enough balance", `You can cash out up to $${balNow.toFixed(2)}.`); return; }
    setCashingOut(true);
    try {
      const r = await api.cashoutToCard(amt);
      setCashoutOpen(false); setCashoutAmt("");
      await load();
      const local = r.currency && r.currency !== "USD" && r.local_amount != null
        ? ` (${r.local_amount.toFixed(2)} ${r.currency})` : "";
      Alert.alert("On its way", `$${r.amount.toFixed(2)}${local} is being sent to your debit card after a $${(r.fee ?? cashoutFee).toFixed(2)} fee. Instant payouts usually arrive within minutes.`);
    } catch (e: any) {
      Alert.alert("Cash out failed", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setCashingOut(false); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="wallet-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => { if (router.canGoBack()) safeBack(); else router.replace("/(tabs)/profile"); }} style={styles.iconBtn} testID="wallet-back">
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
              ${(bal?.balance ?? w?.balance ?? 0).toFixed(2)}
            </Text>
            {bal && bal.currency !== "USD" ? (
              <Text style={styles.balUsd}>≈ {bal.symbol}{bal.display.toFixed(2)} {bal.currency} · spend &amp; tips are in USD</Text>
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
            {payout?.payouts_enabled ? (() => {
              const balNow = bal?.balance ?? w?.balance ?? 0;
              const onHold = !!payout?.hold_until && new Date(payout.hold_until) > new Date();
              const cashoutDisabled = onHold || !payout?.has_debit_card || balNow < cashoutMin;
              const reason = onHold
                ? `Cash-out is paused for your security until ${new Date(payout.hold_until).toLocaleDateString()} — 7 business days after changing direct deposit.`
                : !payout?.has_debit_card
                ? "Add a debit card in Manage payouts to cash out."
                : balNow < cashoutMin ? `Minimum cash-out is $${cashoutMin.toFixed(0)}.` : "";
              return (
                <>
                  <TouchableOpacity
                    style={[styles.cashoutBtn, cashoutDisabled && { opacity: 0.5 }]}
                    onPress={() => { setCashoutAmt(String(balNow)); setCashoutOpen(true); }}
                    disabled={cashoutDisabled}
                    testID="wallet-cashout"
                  >
                    <Ionicons name="flash" size={16} color={theme.primary} />
                    <Text style={styles.cashoutBtnText}>Cash out to debit card</Text>
                  </TouchableOpacity>
                  {cashoutDisabled && reason ? <Text style={styles.cashoutHint}>{reason}</Text> : null}
                </>
              );
            })() : null}
          </View>

          {payEnabled && !payout?.payouts_enabled && ((bal?.balance ?? w?.balance ?? 0) > 0 || (w?.total_earned ?? 0) > 0) ? (
            <TouchableOpacity style={styles.cashoutBanner} onPress={setupPayouts} disabled={connecting} testID="wallet-cashout-nudge">
              <Ionicons name="alert-circle" size={20} color="#D97706" />
              <View style={{ flex: 1 }}>
                <Text style={styles.cashoutTitle}>Set up Stripe to cash out</Text>
                <Text style={styles.cashoutSub}>You have a balance to withdraw. Connect Stripe payouts to transfer it to your bank.</Text>
              </View>
              {connecting ? <ActivityIndicator color="#D97706" size="small" /> : <Ionicons name="chevron-forward" size={18} color="#D97706" />}
            </TouchableOpacity>
          ) : null}

          {topups.length > 0 && (
            <>
              <Text style={styles.section}>Top-ups</Text>
              <View style={styles.topupsCard}>
                {topups.slice(0, 8).map((t, i, arr) => {
                  const st = TOPUP_STATUS[t.status] || TOPUP_STATUS.completed;
                  return (
                    <TouchableOpacity key={t.id} activeOpacity={0.6} style={[styles.topupRow, i === arr.length - 1 && styles.topupRowLast]} onPress={() => { setCopied(false); setTopupDetail(t); }} testID={`topup-${t.id}`}>
                      <View style={[styles.topupIcon, { backgroundColor: st.bg }]}>
                        <Ionicons name={st.icon as any} size={18} color={st.color} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.topupTitle}>Wallet top-up</Text>
                        <Text style={styles.topupMeta}>{fmtTopup(t.created_at)}{t.source === "test" ? " · test" : ""}</Text>
                      </View>
                      <View style={styles.topupRight}>
                        <Text style={[styles.topupAmt, t.status === "failed" && styles.topupAmtFailed]}>+${t.amount.toFixed(2)}</Text>
                        <View style={[styles.statusPill, { backgroundColor: st.bg }]}>
                          <Text style={[styles.statusText, { color: st.color }]}>{st.label}</Text>
                        </View>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={theme.textMuted} style={{ marginLeft: 4 }} />
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}

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
          {(() => {
            const cur = (user?.payout_frequency || "weekly");
            const label = cur === "weekly" ? "Weekly" : cur === "biweekly" ? "Bi-weekly" : "Monthly";
            return (
              <TouchableOpacity
                style={[styles.freqDropdown, !!freqLockedUntil && { opacity: 0.6 }]}
                onPress={() => setFreqPickerOpen(true)}
                disabled={!!freqLockedUntil}
                testID="freq-dropdown"
              >
                <Ionicons name="time-outline" size={16} color={theme.textMuted} />
                <Text style={styles.freqDropdownText}>{label}</Text>
                <Ionicons name="chevron-down" size={18} color={theme.textMuted} />
              </TouchableOpacity>
            );
          })()}
          <Text style={styles.freqNote}>
            {freqLockedUntil
              ? `You can change your payout frequency again on ${new Date(freqLockedUntil).toLocaleDateString()}.`
              : "You can change your payout frequency once a month."}
          </Text>

          <Modal visible={freqPickerOpen} transparent animationType="fade" onRequestClose={() => setFreqPickerOpen(false)}>
            <TouchableOpacity style={styles.freqPickBackdrop} activeOpacity={1} onPress={() => setFreqPickerOpen(false)}>
              <View style={styles.freqPickCard}>
                <Text style={styles.freqPickTitle}>Payout frequency</Text>
                {(["weekly", "biweekly", "monthly"] as const).map((f) => {
                  const on = (user?.payout_frequency || "weekly") === f;
                  const label = f === "weekly" ? "Weekly" : f === "biweekly" ? "Bi-weekly" : "Monthly";
                  return (
                    <TouchableOpacity
                      key={f}
                      style={styles.freqPickRow}
                      onPress={() => { setFreqPickerOpen(false); if (!on) changeFrequency(f); }}
                      testID={`freq-${f}`}
                    >
                      <Text style={[styles.freqPickText, on && { color: theme.primary, fontWeight: "800" }]}>{label}</Text>
                      {on && <Ionicons name="checkmark" size={18} color={theme.primary} />}
                    </TouchableOpacity>
                  );
                })}
              </View>
            </TouchableOpacity>
          </Modal>

          <Text style={styles.section}>Getting paid</Text>
          {payEnabled ? (() => {
            const verifying = !!payout?.connected && !!payout?.details_submitted && !payout?.payouts_enabled;
            const due = payout?.requirements_due || [];
            const eventually = payout?.requirements_eventually || [];
            const pending = payout?.requirements_pending || [];
            const needsBank = verifying && (!payout?.has_external_account || [...due, ...eventually].some((r) => r.includes("external_account")));
            const transfers = payout?.capabilities?.transfers;          // active | pending | inactive
            const plat = payout?.platform;
            const platformNotReady = !!plat && (!plat.charges_enabled || (plat.requirements_due?.length ?? 0) > 0);
            // The single most useful reason it isn't finishing yet.
            let reasonLine = "";
            if (due.length) reasonLine = "Stripe still needs: " + due.slice(0, 4).map(prettyReq).join(", ") + ".";
            else if (eventually.length) reasonLine = "To turn on payouts, add: " + eventually.slice(0, 4).map(prettyReq).join(", ") + ".";
            else if (platformNotReady) reasonLine = "Your OkaySpace Stripe (platform) account isn't fully activated yet. Finish business verification in your Stripe Dashboard — until then payouts stay off for every creator.";
            else if (transfers === "pending") reasonLine = "Stripe is still activating the transfers capability on your account — this is a review on Stripe's side and usually clears within a day.";
            else if (transfers === "inactive") reasonLine = "Stripe hasn't activated transfers on your account. Tap Update details to finish, or check your Stripe Dashboard.";
            else if (payout?.disabled_reason) reasonLine = disabledReasonLabel(payout.disabled_reason);
            else if (pending.length) reasonLine = "Stripe is verifying your information — this can take a few minutes to a day.";
            const dotColor = payout?.payouts_enabled ? "#22C55E" : verifying ? "#F59E0B" : theme.textMuted;
            const statusText = payout?.payouts_enabled ? "Payouts active"
              : needsBank ? "Add a payout method"
              : verifying ? "Verifying with Stripe"
              : payout?.connected ? "Setup incomplete" : "Not set up";
            const subText = payout?.payouts_enabled
              ? "Tips and subscriptions are paid out to your connected account via Stripe."
              : needsBank
                ? "Stripe has your details but needs a bank account or debit card before payouts can turn on."
                : verifying
                  ? "You've submitted your details — Stripe is verifying them. This can take a few minutes, then payouts turn on automatically."
                  : "Connect a bank account or card with Stripe to receive real payouts. Until then, payments run in test mode.";
            const btnText = payout?.payouts_enabled ? "Manage payouts"
              : needsBank ? "Add bank / debit card"
              : verifying ? "Update details"
              : payout?.connected ? "Finish setup" : "Set up payouts";
            return (
            <View style={styles.payoutCard}>
              <View style={styles.payoutHead}>
                <View style={[styles.payoutDot, { backgroundColor: dotColor }]} />
                <Text style={styles.payoutStatus}>{statusText}</Text>
              </View>
              <Text style={styles.payoutSub}>{subText}</Text>
              {!payout?.payouts_enabled && reasonLine ? (
                <Text style={styles.reqText}>{reasonLine}</Text>
              ) : null}
              {!payout?.payouts_enabled && (payout?.disabled_reason || transfers) ? (
                <Text style={styles.reasonCode}>
                  Stripe status: {payout?.disabled_reason || "—"}{transfers ? ` · transfers: ${transfers}` : ""}{platformNotReady ? " · platform: setup needed" : ""}
                </Text>
              ) : null}
              <TouchableOpacity style={styles.payoutBtn} onPress={payout?.payouts_enabled ? () => setManageOpen(true) : setupPayouts} disabled={connecting} testID="wallet-setup-payouts">
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
                <Text style={styles.balanceMeta}>{payoutInfo?.frequency === "weekly" ? "Weekly" : payoutInfo?.frequency === "biweekly" ? "Bi-weekly" : "Monthly"}</Text>
                <Text style={styles.balanceMeta}>next: {fmtDay(payoutInfo?.next_payout)}</Text>
              </View>
            </View>
            <Text style={styles.payoutsNote}>Paid out automatically on your schedule once you've connected payouts. ${(payoutInfo?.total_paid_out ?? 0).toFixed(2)} paid so far.</Text>
            <View style={styles.thresholdRow}>
              <Text style={styles.thresholdLabel}>Hold until balance reaches</Text>
              <View style={[styles.thresholdInputWrap, !!thresholdLockedUntil && { opacity: 0.5 }]}>
                <Text style={styles.dollar}>$</Text>
                <TextInput
                  style={styles.thresholdInput}
                  value={threshold}
                  onChangeText={(t) => setThreshold(t.replace(/[^0-9.]/g, ""))}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  placeholderTextColor={theme.textMuted}
                  editable={!thresholdLockedUntil}
                  testID="payout-threshold"
                />
              </View>
              <TouchableOpacity
                style={[styles.thresholdBtn, (savingThreshold || !!thresholdLockedUntil) && { opacity: 0.5 }]}
                onPress={saveThreshold}
                disabled={savingThreshold || !!thresholdLockedUntil}
                testID="save-threshold"
              >
                {savingThreshold ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.thresholdBtnText}>Save</Text>}
              </TouchableOpacity>
            </View>
            <Text style={styles.payoutsNote}>
              {thresholdLockedUntil
                ? `Locked — you can change your minimum payout balance again on ${new Date(thresholdLockedUntil).toLocaleDateString()}.`
                : "The minimum payout balance can only be changed once a month."}
            </Text>
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

          <TouchableOpacity style={styles.allActivityBtn} onPress={() => router.push("/activity")} activeOpacity={0.7} testID="wallet-all-activity">
            <Ionicons name="list" size={17} color={theme.primary} />
            <Text style={styles.allActivityText}>View all activity</Text>
            <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
          </TouchableOpacity>

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
              {detail.txn.message ? (
                <View style={[styles.detailRow, { alignItems: "flex-start" }]}>
                  <Text style={styles.detailLabel}>Message</Text>
                  <Text style={styles.detailValue}>{detail.txn.message}</Text>
                </View>
              ) : null}
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

      {/* ── Top-up detail ────────────────────────────────────────────── */}
      <Modal visible={!!topupDetail} transparent animationType="fade" onRequestClose={() => setTopupDetail(null)}>
        <View style={styles.detailBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setTopupDetail(null)} />
          {topupDetail && (() => {
            const st = TOPUP_STATUS[topupDetail.status] || TOPUP_STATUS.completed;
            return (
              <View style={styles.detailCard}>
                <View style={[styles.detailIcon, { backgroundColor: st.bg }]}>
                  <Ionicons name={st.icon as any} size={26} color={st.color} />
                </View>
                <Text style={[styles.detailAmount, { color: topupDetail.status === "failed" ? theme.textMuted : "#16A34A" }]}>
                  +${topupDetail.amount.toFixed(2)}
                </Text>
                <Text style={styles.detailKind}>Wallet top-up</Text>
                <View style={[styles.statusPill, { backgroundColor: st.bg, marginTop: 8 }]}>
                  <Text style={[styles.statusText, { color: st.color }]}>{st.label}</Text>
                </View>

                <View style={styles.detailDivider} />

                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Amount</Text>
                  <Text style={styles.detailValue}>${topupDetail.amount.toFixed(2)} USD</Text>
                </View>
                {bal && bal.currency !== "USD" ? (
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>In {bal.currency}</Text>
                    <Text style={styles.detailValue}>{bal.symbol}{(topupDetail.amount * bal.rate).toFixed(2)}</Text>
                  </View>
                ) : null}
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Status</Text>
                  <Text style={[styles.detailValue, { color: st.color }]}>{st.label}</Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Method</Text>
                  <Text style={styles.detailValue}>{topupDetail.source === "stripe" ? "Card · Stripe" : "Test mode"}</Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Started</Text>
                  <Text style={styles.detailValue}>{fmtFull(topupDetail.created_at)}</Text>
                </View>
                {topupDetail.completed_at ? (
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>{topupDetail.status === "failed" ? "Failed" : "Completed"}</Text>
                    <Text style={styles.detailValue}>{fmtFull(topupDetail.completed_at)}</Text>
                  </View>
                ) : null}
                <View style={[styles.detailRow, { alignItems: "flex-start" }]}>
                  <Text style={styles.detailLabel}>Reference</Text>
                  <Text style={[styles.detailValue, styles.detailMono]} selectable numberOfLines={2}>{topupDetail.id}</Text>
                </View>

                {topupDetail.status === "processing" ? (
                  <>
                    <Text style={styles.topupHint}>You left checkout before finishing. Resume to pay, or cancel this payment.</Text>
                    <TouchableOpacity style={styles.sheetBtn} onPress={() => resumeTopup(topupDetail)} testID="topup-resume">
                      <Text style={styles.sheetBtnText}>Resume payment</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.cancelTopupBtn} onPress={() => cancelTopup(topupDetail)} disabled={cancelingTopup} testID="topup-cancel">
                      {cancelingTopup ? <ActivityIndicator color={theme.error} size="small" /> : <Text style={styles.cancelTopupText}>Cancel payment</Text>}
                    </TouchableOpacity>
                  </>
                ) : null}

                <TouchableOpacity
                  style={styles.copyBtn}
                  onPress={async () => { try { await Clipboard.setStringAsync(topupDetail.id); setCopied(true); } catch {} }}
                  testID="copy-topup-id"
                >
                  <Ionicons name={copied ? "checkmark" : "copy-outline"} size={15} color={theme.primary} />
                  <Text style={styles.copyBtnText}>{copied ? "Copied" : "Copy reference"}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.detailClose} onPress={() => setTopupDetail(null)} testID="topup-close">
                  <Text style={styles.detailCloseText}>Close</Text>
                </TouchableOpacity>
              </View>
            );
          })()}
        </View>
      </Modal>

      {/* ── Manage payouts (inline forms only) ───────────────────────── */}
      <Modal visible={manageOpen} transparent animationType="fade" onRequestClose={() => setManageOpen(false)}>
        <View style={styles.detailBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setManageOpen(false)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Manage payouts</Text>
            <Text style={styles.sheetSub}>Set up where you get paid. Everything is entered right here in the app.</Text>

            <View style={styles.mpMethod}>
              <Ionicons name="flash" size={20} color={theme.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.mpMethodTitle}>Debit card · instant cash-out</Text>
                <Text style={styles.mpMethodSub}>
                  {payout?.debit_card?.last4 ? `${payout.debit_card.brand || "Card"} •••• ${payout.debit_card.last4}` : "Not set up yet"}
                </Text>
              </View>
              <TouchableOpacity onPress={() => { setManageOpen(false); addPayoutMethod(); }} testID="mp-card">
                <Text style={styles.mpAction}>{payout?.debit_card?.last4 ? "Change" : "Add"}</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.mpMethod}>
              <Ionicons name="business" size={20} color={theme.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.mpMethodTitle}>Direct deposit · bank account</Text>
                <Text style={styles.mpMethodSub}>
                  {payout?.bank_account?.last4 ? `${payout.bank_account.bank || "Bank"} •••• ${payout.bank_account.last4}` : "Not set up yet"}
                </Text>
              </View>
              <TouchableOpacity onPress={() => { setManageOpen(false); router.push("/add-bank"); }} testID="mp-bank">
                <Text style={styles.mpAction}>{payout?.bank_account?.last4 ? "Change" : "Add"}</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.holdBanner}>
              <Ionicons name="shield-checkmark-outline" size={16} color="#F5A623" />
              <Text style={styles.holdBannerText}>
                For your security, changing your bank account or debit card pauses cash-out and sending money for 7 business days.
              </Text>
            </View>

            <TouchableOpacity style={styles.detailClose} onPress={() => setManageOpen(false)}>
              <Text style={styles.detailCloseText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Cash out to debit card ───────────────────────────────────── */}
      <Modal visible={cashoutOpen} transparent animationType="fade" onRequestClose={() => setCashoutOpen(false)}>
        <View style={styles.detailBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setCashoutOpen(false)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Cash out</Text>
            <Text style={styles.sheetSub}>Instantly sent to your debit card — usually arrives within minutes. Minimum ${cashoutMin.toFixed(0)}, with a ${cashoutFee.toFixed(0)} flat fee.</Text>
            <View style={styles.amountWrap}>
              <Text style={styles.amountDollar}>$</Text>
              <TextInput
                style={styles.amountInput}
                value={cashoutAmt}
                onChangeText={(t) => setCashoutAmt(t.replace(/[^0-9.]/g, ""))}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor={theme.textMuted}
                autoFocus
                testID="cashout-amount"
              />
            </View>
            <TouchableOpacity style={styles.quickChip} onPress={() => setCashoutAmt(String(bal?.balance ?? w?.balance ?? ""))} testID="cashout-all">
              <Text style={styles.quickText}>All · ${(bal?.balance ?? w?.balance ?? 0).toFixed(2)}</Text>
            </TouchableOpacity>
            {(Number(cashoutAmt) || 0) >= cashoutMin ? (
              <Text style={styles.cashoutNet}>You'll receive ${((Number(cashoutAmt) || 0) - cashoutFee).toFixed(2)} after the ${cashoutFee.toFixed(0)} fee.</Text>
            ) : (
              <Text style={styles.cashoutNet}>Minimum cash-out is ${cashoutMin.toFixed(0)}.</Text>
            )}
            <TouchableOpacity style={styles.sheetBtn} onPress={doCashout} disabled={cashingOut} testID="cashout-confirm">
              {cashingOut ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.sheetBtnText}>Cash out to debit card</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.detailClose} onPress={() => setCashoutOpen(false)}>
              <Text style={styles.detailCloseText}>Cancel</Text>
            </TouchableOpacity>
          </View>
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
  balanceCard: { backgroundColor: theme.primary, borderRadius: 20, padding: 22 },
  balanceTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  balLabel: { color: "rgba(255,255,255,0.85)", fontSize: 13, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  curChip: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "rgba(255,255,255,0.18)", borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5 },
  curChipText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  balValue: { color: "#fff", fontSize: 42, fontWeight: "900", letterSpacing: -1, marginTop: 10 },
  balUsd: { color: "rgba(255,255,255,0.8)", fontSize: 13, marginTop: 2 },
  balActions: { flexDirection: "row", gap: 10, marginTop: 20 },
  topupBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: "#fff", borderRadius: 12, paddingVertical: 12 },
  topupBtnText: { color: theme.primary, fontWeight: "800", fontSize: 15 },
  sendMoneyBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: "rgba(255,255,255,0.18)", borderRadius: 12, paddingVertical: 12 },
  sendMoneyText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  cashoutBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: "#fff", borderRadius: 12, paddingVertical: 11, marginTop: 10 },
  cashoutBtnText: { color: theme.primary, fontWeight: "800", fontSize: 14.5 },
  sheet: { width: "100%", maxWidth: 420, ...GLASS, borderRadius: 20, borderWidth: 1, borderColor: theme.border, padding: 22, alignItems: "center" },
  sheetTitle: { color: theme.textPrimary, fontSize: 19, fontWeight: "900" },
  sheetSub: { color: theme.textMuted, fontSize: 13, textAlign: "center", marginTop: 6, lineHeight: 18 },
  freqNote: { color: theme.textMuted, fontSize: 12, marginTop: 8, lineHeight: 16 },
  freqDropdown: { flexDirection: "row", alignItems: "center", gap: 8, ...GLASS, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13 },
  freqDropdownText: { flex: 1, color: theme.textPrimary, fontSize: 14.5, fontWeight: "700" },
  freqPickBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", paddingHorizontal: 28 },
  freqPickCard: { width: "100%", ...GLASS, borderRadius: 18, borderWidth: 1, borderColor: theme.border, paddingVertical: 8, paddingHorizontal: 6 },
  freqPickTitle: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 6 },
  freqPickRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 14, borderRadius: 12 },
  freqPickText: { color: theme.textPrimary, fontSize: 15, fontWeight: "600" },
  holdBanner: { flexDirection: "row", alignItems: "flex-start", gap: 8, backgroundColor: "rgba(245,166,35,0.10)", borderWidth: 1, borderColor: "rgba(245,166,35,0.4)", borderRadius: 12, padding: 12, marginBottom: 12 },
  holdBannerText: { flex: 1, color: theme.textSecondary, fontSize: 12.5, lineHeight: 18 },
  cashoutNet: { color: theme.textSecondary, fontSize: 12.5, textAlign: "center", marginTop: 10 },
  cashoutHint: { color: theme.textMuted, fontSize: 12, textAlign: "center", marginTop: 7 },
  mpMethod: { flexDirection: "row", alignItems: "center", gap: 12, alignSelf: "stretch", backgroundColor: theme.surfaceAlt, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 14, marginTop: 12 },
  mpMethodTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  mpMethodSub: { color: theme.textMuted, fontSize: 12.5, marginTop: 2 },
  mpAction: { color: theme.primary, fontSize: 14, fontWeight: "800" },
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
  totalCard: { ...GLASS, borderRadius: 18, borderWidth: 1, borderColor: theme.border, padding: 22, alignItems: "center", gap: 4, marginTop: 20 },
  totalLabel: { color: theme.textMuted, fontSize: 13, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  totalValue: { color: theme.textPrimary, fontSize: 40, fontWeight: "900", letterSpacing: -1 },
  totalSub: { color: theme.textMuted, fontSize: 12, textAlign: "center", marginTop: 4 },
  statsRow: { flexDirection: "row", gap: 10, marginTop: 16 },
  statCard: { flex: 1, ...GLASS, borderRadius: 14, borderWidth: 1, borderColor: theme.border, paddingVertical: 16, paddingHorizontal: 10, alignItems: "center", gap: 5 },
  statNum: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  statLabel: { color: theme.textMuted, fontSize: 11, textAlign: "center" },
  section: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 26, marginBottom: 12 },
  allActivityBtn: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 22, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 14, ...GLASS, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border },
  allActivityText: { flex: 1, color: theme.textPrimary, fontSize: 14.5, fontWeight: "700" },
  payoutCard: { ...GLASS, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 16, gap: 10 },
  payoutHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  payoutDot: { width: 9, height: 9, borderRadius: 5 },
  payoutStatus: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  payoutSub: { color: theme.textSecondary, fontSize: 13, lineHeight: 19 },
  payoutBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 12, marginTop: 2 },
  payoutBtnText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  checkAgainBtn: { alignItems: "center", justifyContent: "center", paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: theme.border, marginTop: 2 },
  checkAgainText: { color: theme.primary, fontWeight: "800", fontSize: 14 },
  reqText: { color: "#F59E0B", fontSize: 12.5, fontWeight: "700", lineHeight: 18 },
  reasonCode: { color: theme.textMuted, fontSize: 11, fontWeight: "600" },
  cashoutBanner: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "rgba(217,119,6,0.12)", borderWidth: 1, borderColor: "rgba(217,119,6,0.4)", borderRadius: 14, padding: 14, marginTop: 14 },
  cashoutTitle: { color: "#D97706", fontSize: 14.5, fontWeight: "800" },
  cashoutSub: { color: theme.textSecondary, fontSize: 12.5, marginTop: 2, lineHeight: 17 },
  topupsCard: { ...GLASS, borderRadius: 16, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 16 },
  topupRow: { flexDirection: "row", alignItems: "center", gap: 13, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  topupRowLast: { borderBottomWidth: 0 },
  topupIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  topupTitle: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  topupMeta: { color: theme.textMuted, fontSize: 12.5, marginTop: 2 },
  topupRight: { alignItems: "flex-end", gap: 5 },
  topupAmt: { color: "#16A34A", fontSize: 15.5, fontWeight: "800" },
  topupAmtFailed: { color: theme.textMuted, textDecorationLine: "line-through" },
  statusPill: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { fontSize: 10.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.3 },
  topupHint: { color: theme.textMuted, fontSize: 12.5, textAlign: "center", marginTop: 14, lineHeight: 18 },
  cancelTopupBtn: { alignSelf: "stretch", alignItems: "center", paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: theme.error, marginTop: 8 },
  cancelTopupText: { color: theme.error, fontWeight: "800", fontSize: 14 },
  freqRow: { flexDirection: "row", gap: 10 },
  freqChip: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, ...GLASS, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingVertical: 12 },
  freqChipOn: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  freqText: { color: theme.textSecondary, fontSize: 14, fontWeight: "700" },
  payoutsHead: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginTop: 24, marginBottom: 10 },
  runLink: { color: theme.primary, fontSize: 13, fontWeight: "700" },
  payoutsCard: { ...GLASS, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 16, gap: 8 },
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
  tiersInfoCard: { ...GLASS, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 14 },
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
  detailCard: { width: "100%", maxWidth: 420, ...GLASS, borderRadius: 20, borderWidth: 1, borderColor: theme.border, padding: 22, alignItems: "center" },
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
