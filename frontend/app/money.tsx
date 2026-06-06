import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Modal,
  ActivityIndicator, Image, FlatList, Pressable, Platform, Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { api, MoneyRequest, PublicUser, WalletBalance } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

const webInput = Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {};

const TRANSFER_STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending", color: "#D97706" },
  accepted: { label: "Completed", color: "#16A34A" },
  declined: { label: "Declined", color: theme.error },
  reversed: { label: "Reversed", color: theme.error },
  cancelled: { label: "Cancelled", color: theme.textMuted },
};
const fmtDay = (iso?: string | null) => {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }); } catch { return ""; }
};

export default function MoneyScreen() {
  const router = useRouter();
  const { user } = useAuth() as any;
  const isAdmin = user?.role === "admin";
  const insets = useSafeAreaInsets();
  const [security, setSecurity] = useState<{ is_set: boolean; question?: string | null } | null>(null);
  const [reqs, setReqs] = useState<{ incoming: MoneyRequest[]; outgoing: MoneyRequest[] }>({ incoming: [], outgoing: [] });
  const [transfers, setTransfers] = useState<{ incoming: MoneyRequest[]; outgoing: MoneyRequest[] }>({ incoming: [], outgoing: [] });
  const [loading, setLoading] = useState(true);

  // Send / request flow
  const [flow, setFlow] = useState<null | "send" | "request">(null);
  const [recipient, setRecipient] = useState<PublicUser | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Pay a request
  const [payReq, setPayReq] = useState<MoneyRequest | null>(null);
  const [payAnswer, setPayAnswer] = useState("");
  const [payBusy, setPayBusy] = useState(false);
  const [payMsg, setPayMsg] = useState<string | null>(null);

  // Security setup
  const [secOpen, setSecOpen] = useState(false);
  const [secQ, setSecQ] = useState("");
  const [secA, setSecA] = useState("");
  const [secCur, setSecCur] = useState("");
  const [secBusy, setSecBusy] = useState(false);
  const [secMsg, setSecMsg] = useState<string | null>(null);

  const [bal, setBal] = useState<WalletBalance | null>(null);
  const [feeCents, setFeeCents] = useState(0);
  const [history, setHistory] = useState<MoneyRequest[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const load = useCallback(async () => {
    try {
      const [s, r, t] = await Promise.all([api.getMoneySecurity(), api.listMoneyRequests(), api.listMoneyTransfers()]);
      setSecurity(s); setReqs(r); setTransfers(t);
    } catch {} finally { setLoading(false); }
    try { setBal(await api.getWalletBalance()); } catch {}
    try { setFeeCents((await api.getPaymentsConfig()).transaction_fee_cents || 0); } catch {}
    try { setHistory((await api.transferHistory()).transfers); } catch {}
  }, []);
  const acceptTransfer = async (t: MoneyRequest) => { try { await api.acceptMoneyTransfer(t.id); await load(); } catch (e: any) { Alert.alert("Not yet", String(e?.message || e).replace(/^\d{3}:\s*/, "")); } };
  const declineTransfer = async (t: MoneyRequest) => { try { await api.declineMoneyTransfer(t.id); await load(); } catch {} };
  const reverseTransfer = async (t: MoneyRequest) => {
    const run = async () => { try { await api.reverseMoneyTransfer(t.id); await load(); } catch (e: any) { Alert.alert("Couldn't reverse", String(e?.message || e).replace(/^\d{3}:\s*/, "")); } };
    if (Platform.OS === "web") { if (typeof window !== "undefined" && window.confirm(`Reverse the $${t.amount.toFixed(2)} you sent ${t.other_user.name}? You'll be refunded.`)) run(); }
    else Alert.alert("Reverse transfer?", `Reverse the $${t.amount.toFixed(2)} you sent ${t.other_user.name}? You'll be refunded.`, [{ text: "Cancel", style: "cancel" }, { text: "Reverse", style: "destructive", onPress: run }]);
  };
  // Re-render periodically so the reversal countdown stays current.
  const [, setTick] = useState(0);
  useEffect(() => { const i = setInterval(() => setTick((x) => x + 1), 20000); return () => clearInterval(i); }, []);
  const minsLeft = (iso?: string | null) => {
    if (!iso) return 0;
    try { return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 60000)); } catch { return 0; }
  };
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openFlow = (f: "send" | "request") => {
    setFlow(f); setRecipient(null); setAmount(""); setNote(""); setAnswer(""); setMsg(null);
  };

  const submitFlow = async () => {
    if (!recipient) { setMsg("Pick someone first."); return; }
    const amt = Number(amount) || 0;
    if (amt <= 0) { setMsg("Enter an amount."); return; }
    setBusy(true); setMsg(null);
    try {
      if (flow === "send") {
        if (!security?.is_set) { setBusy(false); setFlow(null); setSecOpen(true); return; }
        await api.sendMoney({ to_user_id: recipient.user_id, amount: amt, note, answer });
        setMsg(`Sent $${amt.toFixed(2)} to ${recipient.name} — they'll get a notification to accept it.`);
      } else {
        await api.requestMoney({ to_user_id: recipient.user_id, amount: amt, note });
        setMsg(`Requested $${amt.toFixed(2)} from ${recipient.name}.`);
      }
      await load();
      setTimeout(() => { setFlow(null); setMsg(null); }, 1100);
    } catch (e: any) {
      setMsg(String(e?.message || e).replace(/^\d{3}:\s*/, "") || "Something went wrong.");
    } finally { setBusy(false); }
  };

  const doPay = async () => {
    if (!payReq) return;
    if (!security?.is_set) { setPayReq(null); setSecOpen(true); return; }
    setPayBusy(true); setPayMsg(null);
    try {
      await api.payMoneyRequest(payReq.id, payAnswer);
      setPayReq(null); setPayAnswer(""); await load();
    } catch (e: any) {
      setPayMsg(String(e?.message || e).replace(/^\d{3}:\s*/, "") || "Payment failed.");
    } finally { setPayBusy(false); }
  };

  const saveSecurity = async () => {
    if (!secQ.trim() || !secA.trim()) { setSecMsg("Enter a question and answer."); return; }
    setSecBusy(true); setSecMsg(null);
    try {
      await api.setMoneySecurity({ question: secQ.trim(), answer: secA.trim(), current_answer: secCur.trim() || undefined });
      setSecOpen(false); setSecQ(""); setSecA(""); setSecCur(""); await load();
    } catch (e: any) {
      setSecMsg(String(e?.message || e).replace(/^\d{3}:\s*/, "") || "Couldn't save.");
    } finally { setSecBusy(false); }
  };

  const declineReq = async (r: MoneyRequest) => { try { await api.declineMoneyRequest(r.id); await load(); } catch {} };
  const cancelReq = async (r: MoneyRequest) => { try { await api.cancelMoneyRequest(r.id); await load(); } catch {} };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="money-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="money-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Money</Text>
        <View style={{ flexDirection: "row" }}>
          <TouchableOpacity onPress={() => router.push("/pay-scan")} style={styles.iconBtn} testID="money-scan">
            <Ionicons name="scan-outline" size={22} color={theme.textPrimary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push("/pay-qr")} style={styles.iconBtn} testID="money-qr">
            <Ionicons name="qr-code-outline" size={22} color={theme.textPrimary} />
          </TouchableOpacity>
        </View>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
          <View style={styles.actions}>
            <TouchableOpacity style={styles.bigBtn} onPress={() => openFlow("send")} testID="money-send-btn">
              <Ionicons name="arrow-up-circle" size={20} color="#fff" />
              <Text style={styles.bigBtnText}>Send money</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.bigBtn, styles.bigBtnGhost]} onPress={() => openFlow("request")} testID="money-request-btn">
              <Ionicons name="arrow-down-circle" size={20} color={theme.primary} />
              <Text style={[styles.bigBtnText, { color: theme.primary }]}>Request money</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.secRow} onPress={() => { setSecMsg(null); setSecOpen(true); }} testID="money-security">
            <Ionicons name="shield-checkmark-outline" size={18} color={security?.is_set ? "#22C55E" : theme.textMuted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.secTitle}>Transfer security question</Text>
              <Text style={styles.secSub}>{security?.is_set ? "Set — required before sending money" : "Not set up — required to send money"}</Text>
            </View>
            <Text style={styles.secAction}>{security?.is_set ? "Change" : "Set up"}</Text>
          </TouchableOpacity>

          {transfers.incoming.length > 0 && (
            <>
              <Text style={styles.section}>Money sent to you</Text>
              {transfers.incoming.map((t) => {
                const wait = minsLeft(t.claimable_at);
                return (
                  <View key={t.id} style={styles.reqRow}>
                    <Avatar u={t.other_user} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.reqName} numberOfLines={1}>{t.other_user.name}</Text>
                      <Text style={styles.reqMeta}>sent ${t.amount.toFixed(2)}{t.note ? ` · ${t.note}` : ""}</Text>
                      {wait > 0 ? <Text style={styles.holdMeta}>Available in {wait} min</Text> : null}
                    </View>
                    {wait > 0 ? (
                      <View style={[styles.payBtn, { opacity: 0.5 }]}><Ionicons name="time-outline" size={16} color="#fff" /></View>
                    ) : (
                      <TouchableOpacity style={styles.payBtn} onPress={() => acceptTransfer(t)} testID={`accept-${t.id}`}>
                        <Text style={styles.payBtnText}>Accept</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity style={styles.declineBtn} onPress={() => declineTransfer(t)} testID={`decline-tx-${t.id}`}>
                      <Ionicons name="close" size={16} color={theme.textMuted} />
                    </TouchableOpacity>
                  </View>
                );
              })}
            </>
          )}

          {transfers.outgoing.filter((t) => t.status === "pending").length > 0 && (
            <>
              <Text style={styles.section}>Money you sent (reversible)</Text>
              {transfers.outgoing.filter((t) => t.status === "pending").map((t) => {
                const wait = minsLeft(t.claimable_at);
                return (
                  <View key={t.id} style={styles.reqRow}>
                    <Avatar u={t.other_user} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.reqName} numberOfLines={1}>To {t.other_user.name}</Text>
                      <Text style={styles.reqMeta}>${t.amount.toFixed(2)}{t.note ? ` · ${t.note}` : ""}</Text>
                      <Text style={styles.holdMeta}>{wait > 0 ? `Reversible for ${wait} more min` : "Awaiting them to accept"}</Text>
                    </View>
                    <TouchableOpacity style={styles.reverseBtn} onPress={() => reverseTransfer(t)} testID={`reverse-${t.id}`}>
                      <Ionicons name="arrow-undo" size={14} color={theme.error} />
                      <Text style={styles.reverseText}>Reverse</Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
            </>
          )}

          <Text style={styles.section}>Requests for you</Text>
          {reqs.incoming.length === 0 ? (
            <Text style={styles.empty}>No pending requests.</Text>
          ) : reqs.incoming.map((r) => (
            <View key={r.id} style={styles.reqRow}>
              <Avatar u={r.other_user} />
              <View style={{ flex: 1 }}>
                <Text style={styles.reqName} numberOfLines={1}>{r.other_user.name}</Text>
                <Text style={styles.reqMeta}>asks ${r.amount.toFixed(2)}{r.note ? ` · ${r.note}` : ""}</Text>
              </View>
              <TouchableOpacity style={styles.payBtn} onPress={() => { setPayMsg(null); setPayAnswer(""); setPayReq(r); }} testID={`pay-${r.id}`}>
                <Text style={styles.payBtnText}>Pay</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.declineBtn} onPress={() => declineReq(r)} testID={`decline-${r.id}`}>
                <Ionicons name="close" size={16} color={theme.textMuted} />
              </TouchableOpacity>
            </View>
          ))}

          <Text style={styles.section}>Your requests</Text>
          {reqs.outgoing.length === 0 ? (
            <Text style={styles.empty}>You haven't requested money from anyone.</Text>
          ) : reqs.outgoing.map((r) => (
            <View key={r.id} style={styles.reqRow}>
              <Avatar u={r.other_user} />
              <View style={{ flex: 1 }}>
                <Text style={styles.reqName} numberOfLines={1}>{r.other_user.name}</Text>
                <Text style={styles.reqMeta}>${r.amount.toFixed(2)} · {r.status}</Text>
              </View>
              {r.status === "pending" && (
                <TouchableOpacity style={styles.declineBtn} onPress={() => cancelReq(r)} testID={`cancel-${r.id}`}>
                  <Ionicons name="trash-outline" size={16} color={theme.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          ))}

          <TouchableOpacity style={styles.historyHead} onPress={() => setShowHistory((v) => !v)} testID="toggle-history">
            <Text style={[styles.section, { marginBottom: 0 }]}>Transfer history</Text>
            <Ionicons name={showHistory ? "chevron-up" : "chevron-down"} size={18} color={theme.textMuted} />
          </TouchableOpacity>
          {showHistory ? (
            history.length === 0 ? (
              <Text style={styles.empty}>No transfers yet.</Text>
            ) : history.map((t) => {
              const st = TRANSFER_STATUS[t.status] || { label: t.status, color: theme.textMuted };
              const out = t.direction === "outgoing";
              return (
                <View key={t.id} style={styles.histRow}>
                  <Avatar u={t.other_user} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.reqName} numberOfLines={1}>{out ? "To" : "From"} {t.other_user.name}</Text>
                    <Text style={styles.reqMeta}>{fmtDay(t.resolved_at || t.created_at)}{t.note ? ` · ${t.note}` : ""}</Text>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={[styles.histAmt, { color: out ? theme.textSecondary : "#16A34A" }]}>{out ? "-" : "+"}${t.amount.toFixed(2)}</Text>
                    <Text style={[styles.histStatus, { color: st.color }]}>{st.label}</Text>
                  </View>
                </View>
              );
            })
          ) : null}
        </ScrollView>
      )}

      {/* Send / Request flow */}
      <Modal visible={!!flow} transparent animationType="slide" onRequestClose={() => setFlow(null)}>
        <View style={styles.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => !busy && setFlow(null)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 18 }]}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>{flow === "send" ? "Send money" : "Request money"}</Text>

            <TouchableOpacity style={styles.recipientRow} onPress={() => setPickerOpen(true)} testID="money-pick-recipient">
              {recipient ? <Avatar u={recipient} /> : <View style={styles.avatarFallback}><Ionicons name="person" size={18} color={theme.textMuted} /></View>}
              <Text style={styles.recipientText}>{recipient ? recipient.name : "Choose someone"}</Text>
              <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
            </TouchableOpacity>

            <View style={styles.amtWrap}>
              <Text style={styles.dollar}>$</Text>
              <TextInput style={styles.amtInput} value={amount} onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ""))} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.textMuted} testID="money-amount" />
            </View>
            {flow === "send" && !isAdmin && feeCents > 0 && Number(amount) > 0 ? (
              <Text style={styles.feeHint}>
                ${(Number(amount) || 0).toFixed(2)} to them + ${(feeCents / 100).toFixed(2)} fee = ${((Number(amount) || 0) + feeCents / 100).toFixed(2)} total
              </Text>
            ) : null}
            {flow === "send" && bal ? (
              <TouchableOpacity onPress={() => { setFlow(null); router.push("/wallet"); }} testID="money-balance">
                <Text style={styles.balHint}>
                  Wallet balance: {bal.symbol}{bal.display.toFixed(2)}{bal.currency !== "USD" ? ` (${bal.currency})` : ""} · Top up
                </Text>
              </TouchableOpacity>
            ) : null}
            <TextInput style={styles.noteInput} value={note} onChangeText={setNote} placeholder="What's it for? (optional)" placeholderTextColor={theme.textMuted} testID="money-note" />

            {flow === "send" && security?.is_set && (
              <View style={styles.secAnswerWrap}>
                <Text style={styles.qLabel}>{security.question}</Text>
                <TextInput style={styles.input} value={answer} onChangeText={setAnswer} placeholder="Your answer" placeholderTextColor={theme.textMuted} secureTextEntry testID="money-answer" />
              </View>
            )}
            {flow === "send" && !security?.is_set && (
              <Text style={styles.warn}>You'll be asked to set a security question before sending.</Text>
            )}
            {msg && <Text style={styles.flowMsg}>{msg}</Text>}

            <TouchableOpacity style={[styles.submitBtn, busy && { opacity: 0.6 }]} onPress={submitFlow} disabled={busy} testID="money-submit">
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>{flow === "send" ? "Send" : "Request"}</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Recipient picker */}
      <RecipientPicker visible={pickerOpen} onClose={() => setPickerOpen(false)} onPick={(u) => { setRecipient(u); setPickerOpen(false); }} />

      {/* Pay a request */}
      <Modal visible={!!payReq} transparent animationType="fade" onRequestClose={() => setPayReq(null)}>
        <View style={styles.centerBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => !payBusy && setPayReq(null)} />
          {payReq && (
            <View style={styles.payCard}>
              <Text style={styles.payTitle}>Pay {payReq.other_user.name} ${payReq.amount.toFixed(2)}</Text>
              {security?.is_set ? (
                <>
                  <Text style={styles.qLabel}>{security.question}</Text>
                  <TextInput style={styles.input} value={payAnswer} onChangeText={setPayAnswer} placeholder="Your answer" placeholderTextColor={theme.textMuted} secureTextEntry testID="pay-answer" />
                </>
              ) : (
                <Text style={styles.warn}>Set a security question first to pay.</Text>
              )}
              {payMsg && <Text style={styles.flowMsg}>{payMsg}</Text>}
              <TouchableOpacity style={[styles.submitBtn, payBusy && { opacity: 0.6 }]} onPress={doPay} disabled={payBusy} testID="pay-submit">
                {payBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Pay ${payReq.amount.toFixed(2)}</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setPayReq(null)}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>

      {/* Security setup */}
      <Modal visible={secOpen} transparent animationType="slide" onRequestClose={() => setSecOpen(false)}>
        <View style={styles.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => !secBusy && setSecOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 18 }]}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Transfer security question</Text>
            <Text style={styles.sheetSub}>You'll answer this every time you send money. Keep it memorable and private.</Text>
            {security?.is_set && (
              <>
                <Text style={styles.qLabel}>Current answer</Text>
                <TextInput style={styles.input} value={secCur} onChangeText={setSecCur} placeholder="Current answer" placeholderTextColor={theme.textMuted} secureTextEntry testID="sec-current" />
              </>
            )}
            <Text style={styles.qLabel}>Question</Text>
            <TextInput style={styles.input} value={secQ} onChangeText={setSecQ} placeholder="e.g. First pet's name" placeholderTextColor={theme.textMuted} testID="sec-question" />
            <Text style={styles.qLabel}>Answer</Text>
            <TextInput style={styles.input} value={secA} onChangeText={setSecA} placeholder="Answer (not case-sensitive)" placeholderTextColor={theme.textMuted} secureTextEntry testID="sec-answer" />
            {secMsg && <Text style={styles.flowMsg}>{secMsg}</Text>}
            <TouchableOpacity style={[styles.submitBtn, secBusy && { opacity: 0.6 }]} onPress={saveSecurity} disabled={secBusy} testID="sec-save">
              {secBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Save</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Avatar({ u }: { u: { name: string; picture?: string | null } }) {
  return (
    <View style={styles.avatar}>
      {u.picture ? <Image source={{ uri: u.picture }} style={{ width: "100%", height: "100%" }} />
        : <Text style={styles.avatarInit}>{(u.name?.[0] || "?").toUpperCase()}</Text>}
    </View>
  );
}

function RecipientPicker({ visible, onClose, onPick }: { visible: boolean; onClose: () => void; onPick: (u: PublicUser) => void }) {
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState("");
  const [friends, setFriends] = useState<PublicUser[]>([]);
  const [results, setResults] = useState<PublicUser[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => { if (visible) { setQ(""); setResults([]); api.listFriends().then(setFriends).catch(() => {}); } }, [visible]);
  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      try { setResults(await api.searchUsers(q.trim())); } catch {} finally { setSearching(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const data = q.trim() ? results : friends;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 18, maxHeight: "80%" }]}>
          <View style={styles.handle} />
          <Text style={styles.sheetTitle}>Choose someone</Text>
          <View style={styles.searchWrap}>
            <Ionicons name="search" size={16} color={theme.textMuted} />
            <TextInput style={styles.searchInput} value={q} onChangeText={setQ} placeholder="Search people" placeholderTextColor={theme.textMuted} testID="recipient-search" />
            {searching && <ActivityIndicator size="small" color={theme.primary} />}
          </View>
          <FlatList
            data={data}
            keyExtractor={(i) => i.user_id}
            ListEmptyComponent={<Text style={styles.empty}>{q.trim() ? "No matches." : "No friends yet — search above."}</Text>}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.pickRow} onPress={() => onPick(item)} testID={`pick-${item.user_id}`}>
                <Avatar u={item} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.reqName} numberOfLines={1}>{item.name}</Text>
                  {!!item.username && <Text style={styles.reqMeta}>@{item.username}</Text>}
                </View>
              </TouchableOpacity>
            )}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  actions: { flexDirection: "row", gap: 10 },
  bigBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: theme.primary, borderRadius: 16, height: 56 },
  bigBtnGhost: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  bigBtnText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  secRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 14, marginTop: 14 },
  secTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  secSub: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  secAction: { color: theme.primary, fontSize: 13, fontWeight: "800" },
  section: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 24, marginBottom: 10 },
  empty: { color: theme.textMuted, fontSize: 13, paddingVertical: 10 },
  reqRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12, marginBottom: 8 },
  reqName: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  reqMeta: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  holdMeta: { color: "#D97706", fontSize: 11.5, fontWeight: "700", marginTop: 2 },
  reverseBtn: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderColor: theme.error, borderRadius: 10, paddingHorizontal: 12, height: 36 },
  reverseText: { color: theme.error, fontSize: 13, fontWeight: "800" },
  historyHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  histRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  histAmt: { fontSize: 15, fontWeight: "800" },
  histStatus: { fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.3, marginTop: 2 },
  payBtn: { backgroundColor: theme.primary, borderRadius: 10, paddingHorizontal: 16, height: 36, alignItems: "center", justifyContent: "center" },
  payBtnText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  declineBtn: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.surfaceAlt },
  avatar: { width: 42, height: 42, borderRadius: 21, overflow: "hidden", backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  avatarFallback: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center", backgroundColor: theme.surfaceAlt },
  avatarInit: { color: "#fff", fontSize: 16, fontWeight: "700" },

  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  centerBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 24 },
  sheet: { backgroundColor: "#0E0E10", borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 10, paddingHorizontal: 18, borderTopWidth: 1, borderColor: theme.border },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 14 },
  sheetTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  sheetSub: { color: theme.textMuted, fontSize: 12.5, marginTop: 2, marginBottom: 8, lineHeight: 18 },
  recipientRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12, marginTop: 14 },
  recipientText: { flex: 1, color: theme.textPrimary, fontSize: 15, fontWeight: "600" },
  amtWrap: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 16, height: 56, marginTop: 12 },
  dollar: { color: theme.textPrimary, fontSize: 22, fontWeight: "900" },
  amtInput: { flex: 1, color: theme.textPrimary, fontSize: 22, fontWeight: "800", ...webInput },
  noteInput: { backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, height: 48, color: theme.textPrimary, fontSize: 14, marginTop: 10, ...webInput },
  secAnswerWrap: { marginTop: 12 },
  qLabel: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "700", marginTop: 12, marginBottom: 6 },
  input: { backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, height: 48, color: theme.textPrimary, fontSize: 15, ...webInput },
  warn: { color: "#F59E0B", fontSize: 12.5, marginTop: 12, lineHeight: 18 },
  flowMsg: { color: theme.primary, fontSize: 13, fontWeight: "600", marginTop: 12, textAlign: "center" },
  balHint: { color: theme.textMuted, fontSize: 12.5, fontWeight: "600", textAlign: "center", marginTop: 8 },
  feeHint: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "700", textAlign: "center", marginTop: 8 },
  submitBtn: { backgroundColor: theme.primary, borderRadius: 14, height: 52, alignItems: "center", justifyContent: "center", marginTop: 16 },
  submitText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  cancelText: { color: theme.textMuted, fontSize: 14, fontWeight: "700", textAlign: "center", marginTop: 10, paddingVertical: 6 },
  payCard: { width: "100%", maxWidth: 420, backgroundColor: theme.surface, borderRadius: 20, borderWidth: 1, borderColor: theme.border, padding: 20 },
  payTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800", textAlign: "center" },
  searchWrap: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 12, height: 44, marginTop: 12, marginBottom: 8 },
  searchInput: { flex: 1, color: theme.textPrimary, fontSize: 15, ...webInput },
  pickRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
});
