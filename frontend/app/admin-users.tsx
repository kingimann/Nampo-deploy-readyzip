import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList, Image,
  ActivityIndicator, Modal, Pressable, Platform, Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { api, AdminUser } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

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

  const confirmRemove = (u: AdminUser) => {
    const doIt = async () => {
      try { await api.adminRemoveUser(u.user_id); setSel(null); setUsers((arr) => arr.filter((x) => x.user_id !== u.user_id)); }
      catch (e: any) { Alert.alert("Couldn't remove", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    };
    if (Platform.OS === "web") { if (typeof window !== "undefined" && window.confirm(`Remove ${u.name}'s account? This deletes it.`)) doIt(); }
    else Alert.alert("Remove account?", `This permanently deletes ${u.name}.`, [{ text: "Cancel", style: "cancel" }, { text: "Remove", style: "destructive", onPress: doIt }]);
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
        <View style={{ width: 40 }} />
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
