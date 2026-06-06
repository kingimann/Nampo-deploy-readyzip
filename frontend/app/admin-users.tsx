import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList, Image,
  ActivityIndicator, Modal, Pressable, Platform, Alert, ScrollView,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { api, AdminUser, AdminTxn, Badge } from "@/src/api/client";
import UserBadges from "@/src/components/UserBadges";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import { useConfirm } from "@/src/context/ConfirmContext";

const webInput = Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {};
const SUSPEND_OPTIONS = [
  { label: "1 day", days: 1 },
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
];

export default function AdminUsersScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, refresh } = useAuth() as any;
  const confirm = useConfirm();
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [mod, setMod] = useState<{ user: AdminUser; kind: "ban" | "suspend" } | null>(null);
  const [modReason, setModReason] = useState("");
  const [modDays, setModDays] = useState("7");
  const [modBusy, setModBusy] = useState(false);
  const [walletUser, setWalletUser] = useState<AdminUser | null>(null);
  const [walletVal, setWalletVal] = useState("");
  const [walletBusy, setWalletBusy] = useState(false);
  const [txnUser, setTxnUser] = useState<AdminUser | null>(null);
  const [txnKind, setTxnKind] = useState<"topup" | "received" | "sent" | "cashout">("topup");
  const [txnAmt, setTxnAmt] = useState("");
  const [txnNote, setTxnNote] = useState("");
  const [txnParty, setTxnParty] = useState("");
  const [txnAdjust, setTxnAdjust] = useState(true);
  const [txnBusy, setTxnBusy] = useState(false);
  const [txnDate, setTxnDate] = useState("");
  const [txnTime, setTxnTime] = useState("");
  const [txnEditRef, setTxnEditRef] = useState<string | null>(null);
  // Transactions list (to pick one to edit)
  const [txnListUser, setTxnListUser] = useState<AdminUser | null>(null);
  const [txnList, setTxnList] = useState<AdminTxn[]>([]);
  const [txnListBusy, setTxnListBusy] = useState(false);

  // Badges assignment
  const [badgeUser, setBadgeUser] = useState<AdminUser | null>(null);
  const [allBadges, setAllBadges] = useState<Badge[]>([]);
  const [userBadgeIds, setUserBadgeIds] = useState<Set<string>>(new Set());
  const [badgeBusy, setBadgeBusy] = useState<string | null>(null);

  const openBadges = async (u: AdminUser) => {
    setSel(null); setBadgeUser(u); setAllBadges([]); setUserBadgeIds(new Set());
    try {
      const [defs, pub] = await Promise.all([api.listBadges(), api.getPublicUser(u.user_id)]);
      setAllBadges(defs);
      setUserBadgeIds(new Set((pub.badges || []).map((b) => b.id)));
    } catch (e: any) { Alert.alert("Couldn't load badges", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
  };
  const toggleBadge = async (b: Badge) => {
    if (!badgeUser) return;
    const has = userBadgeIds.has(b.id);
    setBadgeBusy(b.id);
    try {
      await api.adminSetUserBadge(badgeUser.user_id, b.id, has ? "remove" : "add");
      setUserBadgeIds((prev) => { const n = new Set(prev); if (has) n.delete(b.id); else n.add(b.id); return n; });
    } catch (e: any) { Alert.alert("Couldn't update", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setBadgeBusy(null); }
  };

  const pad = (n: number) => String(n).padStart(2, "0");
  const partsFromISO = (iso?: string) => {
    const d = iso ? new Date(iso) : new Date();
    const dd = isNaN(d.getTime()) ? new Date() : d;
    return { date: `${dd.getFullYear()}-${pad(dd.getMonth() + 1)}-${pad(dd.getDate())}`, time: `${pad(dd.getHours())}:${pad(dd.getMinutes())}` };
  };
  const isoFromParts = (date: string, time: string): string | undefined => {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date.trim());
    if (!m) return undefined;
    const tm = /^(\d{1,2}):(\d{1,2})$/.exec((time || "00:00").trim());
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), tm ? Number(tm[1]) : 0, tm ? Number(tm[2]) : 0);
    return isNaN(dt.getTime()) ? undefined : dt.toISOString();
  };

  const openAddTxn = (u: AdminUser) => {
    const p = partsFromISO();
    setTxnEditRef(null); setTxnKind("topup"); setTxnAmt(""); setTxnNote(""); setTxnParty("");
    setTxnAdjust(true); setTxnDate(p.date); setTxnTime(p.time); setTxnUser(u);
  };
  const openEditTxn = (u: AdminUser, t: AdminTxn) => {
    const p = partsFromISO(t.created_at);
    setTxnEditRef(t.ref); setTxnKind(t.kind); setTxnAmt(String(t.amount)); setTxnNote(t.note);
    setTxnParty(t.counterparty); setTxnAdjust(false); setTxnDate(p.date); setTxnTime(p.time);
    setTxnListUser(null); setTxnUser(u);
  };

  const loadTxnList = async (u: AdminUser) => {
    setSel(null); setTxnListUser(u); setTxnList([]); setTxnListBusy(true);
    try { setTxnList((await api.adminListTransactions(u.user_id)).transactions); }
    catch (e: any) { Alert.alert("Couldn't load", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setTxnListBusy(false); }
  };

  const saveTxn = async () => {
    if (!txnUser) return;
    const amt = Math.round((Number(txnAmt) || 0) * 100) / 100;
    if (amt <= 0) { Alert.alert("Enter an amount", "How much was the transaction?"); return; }
    const created_at = isoFromParts(txnDate, txnTime);
    setTxnBusy(true);
    try {
      if (txnEditRef) {
        await api.adminEditTransaction(txnUser.user_id, {
          ref: txnEditRef, amount: amt, note: txnNote.trim(), counterparty: txnParty.trim(),
          created_at, adjust_balance: txnAdjust,
        });
      } else {
        await api.adminAddTransaction(txnUser.user_id, {
          kind: txnKind, amount: amt, note: txnNote.trim() || undefined,
          counterparty: txnParty.trim() || undefined, adjust_balance: txnAdjust, created_at,
        });
      }
      setTxnUser(null);
      Alert.alert(txnEditRef ? "Saved" : "Added", txnEditRef ? "The transaction was updated." : "The transaction was re-added to their history.");
    } catch (e: any) { Alert.alert("Couldn't save", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setTxnBusy(false); }
  };

  const deleteTxn = async () => {
    if (!txnUser || !txnEditRef) return;
    const ok = await confirm({ title: "Delete transaction?", message: "Remove this entry from their history?", confirmLabel: "Delete", cancelLabel: "Keep", destructive: true });
    if (!ok) return;
    setTxnBusy(true);
    try {
      await api.adminDeleteTransaction(txnUser.user_id, txnEditRef, txnAdjust);
      setTxnUser(null);
      Alert.alert("Deleted", "The transaction was removed.");
    } catch (e: any) { Alert.alert("Couldn't delete", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setTxnBusy(false); }
  };

  const saveWallet = async () => {
    if (!walletUser) return;
    setWalletBusy(true);
    try { await api.adminSetWallet(walletUser.user_id, Math.max(0, Number(walletVal) || 0)); setWalletUser(null); }
    catch (e: any) { Alert.alert("Couldn't set balance", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setWalletBusy(false); }
  };

  const openMod = (u: AdminUser, kind: "ban" | "suspend") => { setSel(null); setModReason(""); setModDays("7"); setMod({ user: u, kind }); };
  const submitMod = async () => {
    if (!mod) return;
    setModBusy(true);
    try {
      if (mod.kind === "ban") await api.adminBanUser(mod.user.user_id, modReason.trim());
      else await api.adminSuspendUser(mod.user.user_id, Math.max(0.04, Number(modDays) || 7), modReason.trim());
      setMod(null); load(q);
    } catch (e: any) { Alert.alert("Couldn't apply", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setModBusy(false); }
  };

  const load = useCallback(async (term: string) => {
    setLoading(true);
    try { const r = await api.adminListUsers(term, 100, 0); setUsers(r.users); setTotal(r.total); }
    catch {} finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(q); }, [load]));

  React.useEffect(() => { const t = setTimeout(() => load(q), 300); return () => clearTimeout(t); }, [q, load]);

  const patch = (u: AdminUser, fn: () => Promise<any>, optimistic: Partial<AdminUser>) => async () => {
    setBusy(true);
    setUsers((arr) => arr.map((x) => (x.user_id === u.user_id ? { ...x, ...optimistic } : x)));
    setSel((s) => (s && s.user_id === u.user_id ? { ...s, ...optimistic } : s));
    try { await fn(); } catch (e: any) { Alert.alert("Couldn't update", String(e?.message || e).replace(/^\d{3}:\s*/, "")); load(q); }
    finally { setBusy(false); }
  };

  const verifyMe = async () => {
    if (!user) return;
    try { await api.adminPatchUser(user.user_id, { verified: true }); if (typeof refresh === "function") await refresh(); load(q); }
    catch (e: any) { Alert.alert("Couldn't verify", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
  };

  const confirmRemove = async (u: AdminUser) => {
    if (!(await confirm({ title: "Remove account?", message: `This permanently deletes ${u.name}.`, confirmLabel: "Remove", destructive: true }))) return;
    try { await api.adminRemoveUser(u.user_id); setSel(null); setUsers((arr) => arr.filter((x) => x.user_id !== u.user_id)); }
    catch (e: any) { Alert.alert("Couldn't remove", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
  };

  const RoleTag = ({ role }: { role: string }) =>
    role === "user" ? null : (
      <View style={[styles.tag, role === "admin" ? styles.tagAdmin : styles.tagMod]}>
        <Text style={styles.tagText}>{role.toUpperCase()}</Text>
      </View>
    );

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="admin-users-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="admin-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Admin · Users</Text>
        <TouchableOpacity onPress={() => router.push("/admin-audit")} style={styles.iconBtn} testID="admin-audit-link">
          <Ionicons name="receipt-outline" size={20} color={theme.textPrimary} />
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={theme.textMuted} />
        <TextInput style={styles.searchInput} value={q} onChangeText={setQ} placeholder="Search users" placeholderTextColor={theme.textMuted} autoCapitalize="none" testID="admin-search" />
      </View>

      {!user?.verified && (
        <TouchableOpacity style={styles.verifyMe} onPress={verifyMe} testID="admin-verify-self">
          <Ionicons name="checkmark-circle-outline" size={18} color={theme.primary} />
          <Text style={styles.verifyMeText}>Verify myself</Text>
        </TouchableOpacity>
      )}

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={(u) => u.user_id}
          contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
          ListHeaderComponent={<Text style={styles.count}>{total} user{total === 1 ? "" : "s"}</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.row} onPress={() => setSel(item)} testID={`admin-user-${item.user_id}`}>
              <View style={styles.avatar}>{item.picture ? <Image source={{ uri: item.picture }} style={styles.avatarImg} /> : <Text style={styles.avatarInit}>{(item.name?.[0] || "?").toUpperCase()}</Text>}</View>
              <View style={{ flex: 1 }}>
                <View style={styles.nameRow}>
                  <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                  {item.verified && <Ionicons name="checkmark-circle" size={14} color="#1D9BF0" />}
                  <RoleTag role={item.role} />
                </View>
                <Text style={styles.sub} numberOfLines={1}>{item.email || (item.username ? `@${item.username}` : "")}</Text>
                {(item.banned || item.suspended) && (
                  <Text style={styles.statusBad}>{item.banned ? "Banned" : "Suspended"}</Text>
                )}
              </View>
              <Ionicons name="ellipsis-horizontal" size={18} color={theme.textMuted} />
            </TouchableOpacity>
          )}
          ListEmptyComponent={<Text style={styles.empty}>No users found.</Text>}
        />
      )}

      {/* Per-user actions */}
      <Modal visible={!!sel} transparent animationType="slide" onRequestClose={() => setSel(null)}>
        <View style={styles.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => !busy && setSel(null)} />
          {sel && (
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
              <View style={styles.handle} />
              <Text style={styles.sheetName}>{sel.name}</Text>
              <Text style={styles.sheetSub}>{sel.email}{sel.username ? ` · @${sel.username}` : ""}</Text>

              <Action icon={sel.verified ? "close-circle-outline" : "checkmark-circle-outline"} label={sel.verified ? "Remove verified" : "Verify"} onPress={patch(sel, () => api.adminPatchUser(sel.user_id, { verified: !sel.verified }), { verified: !sel.verified })} />
              <Action icon="shield-half-outline" label={sel.role === "mod" ? "Remove mod" : "Make mod"} onPress={patch(sel, () => api.adminPatchUser(sel.user_id, { role: sel.role === "mod" ? "user" : "mod" }), { role: sel.role === "mod" ? "user" : "mod" })} />
              <Action icon="shield-checkmark-outline" label={sel.role === "admin" ? "Remove admin" : "Make admin"} onPress={patch(sel, () => api.adminPatchUser(sel.user_id, { role: sel.role === "admin" ? "user" : "admin" }), { role: sel.role === "admin" ? "user" : "admin" })} />
              {sel.suspended || sel.banned ? (
                <Action icon="play-circle-outline" label="Lift ban / suspension" onPress={patch(sel, () => api.adminUnbanUser(sel.user_id), { banned: false, suspended: false })} />
              ) : (
                <Action icon="time-outline" label="Suspend…" onPress={() => openMod(sel, "suspend")} />
              )}
              {!sel.banned && <Action icon="ban-outline" label="Ban…" danger onPress={() => openMod(sel, "ban")} />}
              <Action icon="wallet-outline" label="Set wallet balance (USD)…" onPress={() => { const u = sel; setSel(null); setWalletVal(""); setWalletUser(u); }} />
              <Action icon="add-circle-outline" label="Re-add lost transaction…" onPress={() => { const u = sel; openAddTxn(u); }} />
              <Action icon="list-outline" label="View / edit transactions…" onPress={() => loadTxnList(sel)} />
              <Action icon="ribbon-outline" label="Badges…" onPress={() => openBadges(sel)} />
              <Action icon="trash-outline" label="Remove account" danger onPress={() => confirmRemove(sel)} />
              <TouchableOpacity onPress={() => setSel(null)}><Text style={styles.cancel}>Close</Text></TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>

      {/* Ban / suspend with a reason (+ custom duration) */}
      <Modal visible={!!mod} transparent animationType="fade" onRequestClose={() => !modBusy && setMod(null)}>
        <View style={styles.centerBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => !modBusy && setMod(null)} />
          {mod && (
            <View style={styles.suspendCard}>
              <Text style={styles.suspendTitle}>{mod.kind === "ban" ? "Ban" : "Suspend"} {mod.user.name}</Text>

              {mod.kind === "suspend" && (
                <>
                  <Text style={styles.fieldLabel}>Duration</Text>
                  <View style={styles.chipRow}>
                    {SUSPEND_OPTIONS.map((o) => {
                      const on = String(o.days) === modDays;
                      return (
                        <TouchableOpacity key={o.days} style={[styles.chip, on && styles.chipOn]} onPress={() => setModDays(String(o.days))} testID={`susp-${o.days}`}>
                          <Text style={[styles.chipText, on && { color: theme.primary }]}>{o.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  <View style={styles.daysRow}>
                    <Text style={styles.daysLabel}>Custom</Text>
                    <TextInput style={styles.daysInput} value={modDays} onChangeText={(t) => setModDays(t.replace(/[^0-9.]/g, ""))} keyboardType="decimal-pad" testID="susp-custom" />
                    <Text style={styles.daysUnit}>days</Text>
                  </View>
                </>
              )}

              <Text style={styles.fieldLabel}>Reason (shown to the user)</Text>
              <TextInput
                style={styles.reasonInput}
                value={modReason}
                onChangeText={setModReason}
                placeholder={mod.kind === "ban" ? "e.g. Repeated spam / abuse" : "e.g. Temporary cool-down"}
                placeholderTextColor={theme.textMuted}
                multiline
                maxLength={300}
                testID="mod-reason"
              />

              <TouchableOpacity style={[styles.modBtn, mod.kind === "ban" && { backgroundColor: theme.error }, modBusy && { opacity: 0.6 }]} onPress={submitMod} disabled={modBusy} testID="mod-submit">
                {modBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.modBtnText}>{mod.kind === "ban" ? "Ban account" : `Suspend ${Number(modDays) || 7} day${(Number(modDays) || 7) === 1 ? "" : "s"}`}</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setMod(null)}><Text style={styles.cancel}>Cancel</Text></TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>

      <Modal visible={!!walletUser} transparent animationType="fade" onRequestClose={() => !walletBusy && setWalletUser(null)}>
        <View style={styles.centerBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => !walletBusy && setWalletUser(null)} />
          {walletUser && (
            <View style={styles.suspendCard}>
              <Text style={styles.suspendTitle}>Set wallet balance</Text>
              <Text style={styles.fieldLabel}>{walletUser.name}'s spendable wallet balance (USD)</Text>
              <View style={styles.walletInputWrap}>
                <Text style={styles.walletDollar}>$</Text>
                <TextInput
                  style={styles.walletInput}
                  value={walletVal}
                  onChangeText={(t) => setWalletVal(t.replace(/[^0-9.]/g, ""))}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor={theme.textMuted}
                  autoFocus
                  testID="admin-wallet-input"
                />
              </View>
              <TouchableOpacity style={[styles.modBtn, walletBusy && { opacity: 0.6 }]} onPress={saveWallet} disabled={walletBusy} testID="admin-wallet-save">
                {walletBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.modBtnText}>Set balance</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setWalletUser(null)}><Text style={styles.cancel}>Cancel</Text></TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>

      {/* Add or edit a transaction */}
      <Modal visible={!!txnUser} transparent animationType="fade" onRequestClose={() => !txnBusy && setTxnUser(null)}>
        <View style={styles.centerBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => !txnBusy && setTxnUser(null)} />
          {txnUser && (
            <ScrollView style={{ maxHeight: "88%" }} contentContainerStyle={styles.suspendCard} keyboardShouldPersistTaps="handled">
              <Text style={styles.suspendTitle}>{txnEditRef ? "Edit transaction" : "Re-add transaction"}</Text>
              <Text style={styles.fieldLabel}>{txnUser.name}'s history</Text>

              <View style={styles.txnKindRow}>
                {(["topup", "received", "sent", "cashout"] as const).map((k) => (
                  <TouchableOpacity key={k} style={[styles.txnChip, txnKind === k && styles.txnChipOn, !!txnEditRef && txnKind !== k && { opacity: 0.35 }]} onPress={() => { if (!txnEditRef) setTxnKind(k); }} disabled={!!txnEditRef} testID={`txn-kind-${k}`}>
                    <Text style={[styles.txnChipText, txnKind === k && { color: "#fff" }]}>
                      {k === "topup" ? "Top-up" : k === "received" ? "Received" : k === "sent" ? "Sent" : "Cash-out"}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={styles.walletInputWrap}>
                <Text style={styles.walletDollar}>$</Text>
                <TextInput style={styles.walletInput} value={txnAmt} onChangeText={(t) => setTxnAmt(t.replace(/[^0-9.]/g, ""))} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.textMuted} testID="txn-amount" />
              </View>
              {(txnKind === "received" || txnKind === "sent") && (
                <TextInput style={styles.txnInput} value={txnParty} onChangeText={setTxnParty} placeholder={txnKind === "received" ? "From (name)" : "To (name)"} placeholderTextColor={theme.textMuted} testID="txn-party" />
              )}
              <TextInput style={styles.txnInput} value={txnNote} onChangeText={setTxnNote} placeholder="Note (optional)" placeholderTextColor={theme.textMuted} testID="txn-note" />

              <Text style={styles.fieldLabel}>When it happened</Text>
              <View style={styles.txnWhenRow}>
                <TextInput style={[styles.txnInput, { flex: 1.4, marginTop: 0 }]} value={txnDate} onChangeText={setTxnDate} placeholder="YYYY-MM-DD" placeholderTextColor={theme.textMuted} testID="txn-date" />
                <TextInput style={[styles.txnInput, { flex: 1, marginTop: 0 }]} value={txnTime} onChangeText={setTxnTime} placeholder="HH:MM" placeholderTextColor={theme.textMuted} testID="txn-time" />
              </View>

              <TouchableOpacity style={styles.txnToggle} onPress={() => setTxnAdjust((v) => !v)} testID="txn-adjust">
                <Ionicons name={txnAdjust ? "checkbox" : "square-outline"} size={20} color={txnAdjust ? theme.primary : theme.textMuted} />
                <Text style={styles.txnToggleText}>Also {txnEditRef ? "apply the change to" : "update"} wallet balance ({txnKind === "topup" || txnKind === "received" ? "+" : "−"}${(Number(txnAmt) || 0).toFixed(2)})</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[styles.modBtn, txnBusy && { opacity: 0.6 }]} onPress={saveTxn} disabled={txnBusy} testID="txn-save">
                {txnBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.modBtnText}>{txnEditRef ? "Save changes" : "Add to history"}</Text>}
              </TouchableOpacity>
              {txnEditRef && (
                <TouchableOpacity onPress={deleteTxn} disabled={txnBusy} testID="txn-delete"><Text style={[styles.cancel, { color: theme.error }]}>Delete transaction</Text></TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => setTxnUser(null)}><Text style={styles.cancel}>Cancel</Text></TouchableOpacity>
            </ScrollView>
          )}
        </View>
      </Modal>

      {/* Transactions list (pick one to edit) */}
      <Modal visible={!!txnListUser} transparent animationType="fade" onRequestClose={() => setTxnListUser(null)}>
        <View style={styles.centerBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setTxnListUser(null)} />
          {txnListUser && (
            <View style={[styles.suspendCard, { maxHeight: "82%" }]}>
              <Text style={styles.suspendTitle}>Transactions</Text>
              <Text style={styles.fieldLabel}>Tap one to edit · {txnListUser.name}</Text>
              {txnListBusy ? (
                <ActivityIndicator color={theme.primary} style={{ marginVertical: 20 }} />
              ) : txnList.length === 0 ? (
                <Text style={styles.txnEmpty}>No transactions yet.</Text>
              ) : (
                <ScrollView style={{ maxHeight: 360 }}>
                  {txnList.map((t) => (
                    <TouchableOpacity key={t.ref} style={styles.txnRow} onPress={() => openEditTxn(txnListUser, t)} testID={`txn-row-${t.ref}`}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.txnRowTitle} numberOfLines={1}>
                          {t.kind === "topup" ? "Top-up" : t.kind === "cashout" ? "Cash-out" : t.kind === "received" ? `Received${t.counterparty ? ` · ${t.counterparty}` : ""}` : `Sent${t.counterparty ? ` · ${t.counterparty}` : ""}`}
                        </Text>
                        <Text style={styles.txnRowMeta} numberOfLines={1}>{t.created_at ? new Date(t.created_at).toLocaleString() : ""}</Text>
                      </View>
                      <Text style={[styles.txnRowAmt, { color: t.in ? "#16A34A" : theme.textSecondary }]}>{t.in ? "+" : "−"}${t.amount.toFixed(2)}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
              <TouchableOpacity style={[styles.modBtn, { marginTop: 12 }]} onPress={() => { const u = txnListUser; setTxnListUser(null); openAddTxn(u); }} testID="txn-list-add">
                <Text style={styles.modBtnText}>Add a transaction</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setTxnListUser(null)}><Text style={styles.cancel}>Close</Text></TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>
      {/* Assign badges */}
      <Modal visible={!!badgeUser} transparent animationType="fade" onRequestClose={() => setBadgeUser(null)}>
        <View style={styles.centerBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setBadgeUser(null)} />
          {badgeUser && (
            <View style={[styles.suspendCard, { maxHeight: "82%" }]}>
              <Text style={styles.suspendTitle}>Badges</Text>
              <Text style={styles.fieldLabel}>Give {badgeUser.name} custom badges (shown next to their name).</Text>
              {allBadges.length === 0 ? (
                <Text style={styles.txnEmpty}>No badges exist yet. Create some in Settings → Custom badges.</Text>
              ) : (
                <ScrollView style={{ maxHeight: 380 }}>
                  {allBadges.map((b) => {
                    const has = userBadgeIds.has(b.id);
                    return (
                      <TouchableOpacity key={b.id} style={styles.txnRow} onPress={() => toggleBadge(b)} disabled={badgeBusy === b.id} testID={`assign-badge-${b.id}`}>
                        <UserBadges badges={[b]} size={20} />
                        <Text style={[styles.txnRowTitle, { flex: 1 }]} numberOfLines={1}>{b.label || "(no label)"}</Text>
                        {badgeBusy === b.id ? <ActivityIndicator size="small" color={theme.textMuted} /> : (
                          <Ionicons name={has ? "checkmark-circle" : "ellipse-outline"} size={22} color={has ? theme.primary : theme.textMuted} />
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              )}
              <TouchableOpacity onPress={() => setBadgeUser(null)}><Text style={styles.cancel}>Done</Text></TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Action({ icon, label, onPress, danger }: { icon: any; label: string; onPress: () => void; danger?: boolean }) {
  return (
    <TouchableOpacity style={styles.action} onPress={onPress} testID={`action-${label}`}>
      <Ionicons name={icon} size={18} color={danger ? theme.error : theme.textPrimary} />
      <Text style={[styles.actionText, danger && { color: theme.error }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  searchWrap: { flexDirection: "row", alignItems: "center", gap: 8, margin: 12, paddingHorizontal: 12, height: 42, backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border },
  searchInput: { flex: 1, color: theme.textPrimary, fontSize: 15, ...webInput },
  verifyMe: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginHorizontal: 12, marginBottom: 4, paddingVertical: 10, backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.primary },
  verifyMeText: { color: theme.primary, fontSize: 14, fontWeight: "800" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  count: { color: theme.textMuted, fontSize: 12, fontWeight: "700", paddingHorizontal: 16, paddingVertical: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  avatar: { width: 44, height: 44, borderRadius: 22, overflow: "hidden", backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontSize: 16, fontWeight: "700" },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  name: { color: theme.textPrimary, fontSize: 15, fontWeight: "700", flexShrink: 1 },
  sub: { color: theme.textMuted, fontSize: 12.5, marginTop: 1 },
  statusBad: { color: theme.error, fontSize: 11.5, fontWeight: "700", marginTop: 2 },
  tag: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  tagAdmin: { backgroundColor: "rgba(8,143,111,0.18)" },
  tagMod: { backgroundColor: "rgba(124,58,237,0.18)" },
  tagText: { color: theme.primary, fontSize: 9.5, fontWeight: "800" },
  empty: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingVertical: 40 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  centerBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 24 },
  sheet: { backgroundColor: "#0E0E10", borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 10, paddingHorizontal: 16, borderTopWidth: 1, borderColor: theme.border },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 12 },
  sheetName: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  sheetSub: { color: theme.textMuted, fontSize: 12.5, marginTop: 2, marginBottom: 8 },
  action: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  actionText: { color: theme.textPrimary, fontSize: 15, fontWeight: "600" },
  cancel: { color: theme.textMuted, fontSize: 14, fontWeight: "700", textAlign: "center", paddingVertical: 14 },
  walletInputWrap: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.bg, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, height: 52, marginTop: 8 },
  walletDollar: { color: theme.textPrimary, fontSize: 20, fontWeight: "900" },
  walletInput: { flex: 1, color: theme.textPrimary, fontSize: 20, fontWeight: "800", ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  txnKindRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  txnChip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.bg },
  txnChipOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  txnChipText: { color: theme.textSecondary, fontSize: 13, fontWeight: "700" },
  txnInput: { color: theme.textPrimary, fontSize: 14, backgroundColor: theme.bg, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, paddingVertical: 12, marginTop: 8, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  txnToggle: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12 },
  txnToggleText: { flex: 1, color: theme.textSecondary, fontSize: 13, fontWeight: "600" },
  txnWhenRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  txnEmpty: { color: theme.textMuted, fontSize: 13, textAlign: "center", marginVertical: 20 },
  txnRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  txnRowTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  txnRowMeta: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  txnRowAmt: { fontSize: 14.5, fontWeight: "800" },
  suspendCard: { width: "100%", maxWidth: 380, backgroundColor: theme.surface, borderRadius: 18, borderWidth: 1, borderColor: theme.border, padding: 18 },
  suspendTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "800", marginBottom: 8 },
  fieldLabel: { color: theme.textMuted, fontSize: 12, fontWeight: "700", marginTop: 12, marginBottom: 6 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceAlt },
  chipOn: { borderColor: theme.primary, backgroundColor: theme.bg },
  chipText: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "700" },
  daysRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  daysLabel: { color: theme.textMuted, fontSize: 12.5, fontWeight: "700" },
  daysInput: { width: 70, height: 38, borderRadius: 10, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceAlt, color: theme.textPrimary, fontSize: 15, fontWeight: "700", textAlign: "center", ...webInput },
  daysUnit: { color: theme.textMuted, fontSize: 13 },
  reasonInput: { backgroundColor: theme.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 12, paddingVertical: 10, minHeight: 64, color: theme.textPrimary, fontSize: 14, textAlignVertical: "top", ...webInput },
  modBtn: { backgroundColor: theme.primary, borderRadius: 12, height: 48, alignItems: "center", justifyContent: "center", marginTop: 16 },
  modBtnText: { color: "#fff", fontSize: 15, fontWeight: "800" },
});
