import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, TextInput, Linking, Platform, Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, RenderService, RenderEnvVar, RenderDeployRec } from "@/src/api/client";
import { useConfirm } from "@/src/context/ConfirmContext";
import { theme } from "@/src/theme";

const errText = (e: any) => String(e?.message || e).replace(/^\d{3}:\s*/, "");
const mask = (v: string) => {
  if (!v) return "—";
  if (v.length <= 4) return "••••";
  return "••••" + v.slice(-4);
};
const fmt = (iso?: string) => { if (!iso) return ""; try { return new Date(iso).toLocaleString(); } catch { return iso; } };
const statusMeta = (s?: string): { label: string; color: string } => {
  if (!s) return { label: "", color: theme.textMuted };
  if (s === "live") return { label: "Deploy live", color: "#22C55E" };
  if (s.includes("fail") || s.includes("cancel")) return { label: "Last deploy failed", color: theme.error };
  if (s.includes("progress") || s.includes("build") || s === "created" || s === "queued") return { label: "Building…", color: "#F59E0B" };
  return { label: s.replace(/_/g, " "), color: theme.textMuted };
};

export default function AdminRenderScreen() {
  const insets = useSafeAreaInsets();
  const confirm = useConfirm();

  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [services, setServices] = useState<RenderService[]>([]);
  const [selfId, setSelfId] = useState<string | undefined>();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);   // `${sid}:${action}`

  const [openEnv, setOpenEnv] = useState<string | null>(null);
  const [envVars, setEnvVars] = useState<Record<string, RenderEnvVar[]>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});   // `${sid}:${key}`
  const [editKey, setEditKey] = useState<string | null>(null);             // `${sid}:${key}`
  const [editVal, setEditVal] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");

  const [openDeploys, setOpenDeploys] = useState<string | null>(null);
  const [deploys, setDeploys] = useState<Record<string, RenderDeployRec[]>>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});   // sid → latest deploy status

  const loadStatus = useCallback(async (sid: string) => {
    try {
      const d = await api.renderDeploys(sid);
      if (d.deploys[0]?.status) setStatuses((m) => ({ ...m, [sid]: d.deploys[0].status! }));
    } catch {}
  }, []);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await api.renderServices();
      setConfigured(r.configured); setServices(r.services); setSelfId(r.self_id);
      r.services.forEach((s) => loadStatus(s.id));   // latest deploy status per service
    } catch (e: any) { setErr(errText(e)); } finally { setLoading(false); }
  }, [loadStatus]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const run = async (sid: string, action: string, fn: () => Promise<any>, after?: () => void) => {
    setBusy(`${sid}:${action}`); setErr(null);
    try { await fn(); after?.(); }
    catch (e: any) { setErr(errText(e)); }
    finally { setBusy(null); }
  };

  const loadEnv = async (sid: string) => {
    try { const r = await api.renderEnvVars(sid); setEnvVars((m) => ({ ...m, [sid]: r.env_vars })); }
    catch (e: any) { setErr(errText(e)); }
  };
  const toggleEnv = (sid: string) => {
    if (openEnv === sid) { setOpenEnv(null); return; }
    setOpenEnv(sid); setEditKey(null); setNewKey(""); setNewVal("");
    if (!envVars[sid]) loadEnv(sid);
  };
  const loadDeploys = async (sid: string) => {
    try { const r = await api.renderDeploys(sid); setDeploys((m) => ({ ...m, [sid]: r.deploys })); }
    catch (e: any) { setErr(errText(e)); }
  };
  const toggleDeploys = (sid: string) => {
    if (openDeploys === sid) { setOpenDeploys(null); return; }
    setOpenDeploys(sid);
    if (!deploys[sid]) loadDeploys(sid);
  };

  const onDeploy = async (s: RenderService, clearCache = false) => {
    const ok = await confirm({
      title: clearCache ? "Clear cache & deploy?" : "Deploy now?",
      message: clearCache
        ? `Wipe the build cache and rebuild “${s.name}” from scratch. Use this when a deploy didn't pick up changes — it's slower but bypasses stale caches.`
        : `Deploy the latest commit of “${s.name}”. This redeploys the service.`,
      confirmLabel: clearCache ? "Clear cache & deploy" : "Deploy",
    });
    if (!ok) return;
    run(s.id, "deploy", () => api.renderTriggerDeploy(s.id, clearCache), () => {
      Alert.alert("Deploy started", clearCache ? "Render is rebuilding from scratch." : "Render is building the latest commit.");
      setOpenDeploys(s.id); loadDeploys(s.id);
      setStatuses((m) => ({ ...m, [s.id]: "build_in_progress" }));
      setTimeout(() => loadStatus(s.id), 8000);
    });
  };
  const onRestart = async (s: RenderService) => {
    if (!(await confirm({ title: "Restart service?", message: `Restart “${s.name}”. Brief downtime while it boots.`, confirmLabel: "Restart" }))) return;
    run(s.id, "restart", () => api.renderRestart(s.id), () => Alert.alert("Restarting", "The service is restarting."));
  };
  const onSuspendToggle = async (s: RenderService) => {
    if (s.suspended) {
      if (!(await confirm({ title: "Resume service?", message: `Bring “${s.name}” back online.`, confirmLabel: "Resume" }))) return;
      run(s.id, "resume", () => api.renderResume(s.id), load);
    } else {
      if (!(await confirm({ title: "Suspend service?", message: `Take “${s.name}” OFFLINE. Users will not be able to reach it until you resume.`, confirmLabel: "Suspend", destructive: true }))) return;
      run(s.id, "suspend", () => api.renderSuspend(s.id), load);
    }
  };

  const onSaveEnv = async (sid: string, key: string) => {
    if (!(await confirm({ title: "Save variable?", message: `Update ${key}. Saving env vars triggers a redeploy.`, confirmLabel: "Save & redeploy" }))) return;
    run(sid, `env:${key}`, () => api.renderSetEnv(sid, key, editVal), () => { setEditKey(null); loadEnv(sid); });
  };
  const onAddEnv = async (sid: string) => {
    const k = newKey.trim();
    if (!k) return;
    if (!(await confirm({ title: "Add variable?", message: `Set ${k}. This triggers a redeploy.`, confirmLabel: "Add & redeploy" }))) return;
    run(sid, "env:new", () => api.renderSetEnv(sid, k, newVal), () => { setNewKey(""); setNewVal(""); loadEnv(sid); });
  };
  const onDeleteEnv = async (sid: string, key: string) => {
    if (!(await confirm({ title: "Delete variable?", message: `Remove ${key}. This triggers a redeploy.`, confirmLabel: "Delete", destructive: true }))) return;
    run(sid, `del:${key}`, () => api.renderDeleteEnv(sid, key), () => loadEnv(sid));
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="admin-render-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="render-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Render</Text>
        <TouchableOpacity onPress={load} style={styles.iconBtn} testID="render-refresh">
          <Ionicons name="refresh" size={20} color={theme.textPrimary} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : !configured ? (
        <View style={styles.setup}>
          <Ionicons name="cloud-offline-outline" size={40} color={theme.textMuted} />
          <Text style={styles.setupTitle}>Render API not connected</Text>
          <Text style={styles.setupText}>
            Set a <Text style={styles.mono}>RENDER_API_KEY</Text> (an owner API token from Render → Account Settings → API Keys) on the backend service, then come back to manage everything here.
          </Text>
          <TouchableOpacity onPress={() => Linking.openURL("https://dashboard.render.com/u/settings#api-keys")}>
            <Text style={styles.link}>Create an API key ↗</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
          {!!err && <Text style={styles.err}>{err}</Text>}
          <Text style={styles.note}>Manage your Render services without leaving the app. Editing env vars and deploying both redeploy the service.</Text>

          {services.map((s) => {
            const envOpen = openEnv === s.id;
            const depOpen = openDeploys === s.id;
            const list = envVars[s.id] || [];
            const deps = deploys[s.id] || [];
            return (
              <View key={s.id} style={styles.card} testID={`render-svc-${s.id}`}>
                <View style={styles.cardTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.svcName}>{s.name}{s.id === selfId ? "  ·  this app" : ""}</Text>
                    <Text style={styles.svcMeta}>{s.type}{s.branch ? `  ·  ${s.branch}` : ""}</Text>
                    {!!statuses[s.id] && (() => { const st = statusMeta(statuses[s.id]); return (
                      <View style={styles.depStatusRow}>
                        <View style={[styles.depStatusDot, { backgroundColor: st.color }]} />
                        <Text style={[styles.depStatusText, { color: st.color }]}>{st.label}</Text>
                      </View>
                    ); })()}
                  </View>
                  <View style={[styles.pill, s.suspended ? styles.pillBad : styles.pillGood]}>
                    <Ionicons name={s.suspended ? "pause-circle" : "checkmark-circle"} size={13} color={s.suspended ? theme.error : "#22C55E"} />
                    <Text style={[styles.pillText, { color: s.suspended ? theme.error : "#22C55E" }]}>{s.suspended ? "Suspended" : "Live"}</Text>
                  </View>
                </View>
                {!!s.url && (
                  <TouchableOpacity onPress={() => Linking.openURL(s.url!)}><Text style={styles.svcUrl} numberOfLines={1}>{s.url}</Text></TouchableOpacity>
                )}

                <View style={styles.actions}>
                  <ActionBtn icon="rocket-outline" label="Deploy" busy={busy === `${s.id}:deploy`} onPress={() => onDeploy(s)} testID={`deploy-${s.id}`} />
                  <ActionBtn icon="reload-outline" label="Restart" busy={busy === `${s.id}:restart`} onPress={() => onRestart(s)} testID={`restart-${s.id}`} />
                  <ActionBtn
                    icon={s.suspended ? "play-outline" : "pause-outline"}
                    label={s.suspended ? "Resume" : "Suspend"}
                    danger={!s.suspended}
                    busy={busy === `${s.id}:suspend` || busy === `${s.id}:resume`}
                    onPress={() => onSuspendToggle(s)}
                    testID={`suspend-${s.id}`}
                  />
                </View>

                <TouchableOpacity style={styles.clearCacheBtn} onPress={() => onDeploy(s, true)} disabled={busy === `${s.id}:deploy`} testID={`deploy-clear-${s.id}`}>
                  <Ionicons name="refresh-circle-outline" size={15} color={theme.textSecondary} />
                  <Text style={styles.clearCacheText}>Clear build cache & deploy</Text>
                </TouchableOpacity>

                <View style={styles.sectionRow}>
                  <TouchableOpacity style={styles.sectionBtn} onPress={() => toggleEnv(s.id)} testID={`env-toggle-${s.id}`}>
                    <Ionicons name="key-outline" size={15} color={theme.primary} />
                    <Text style={styles.sectionBtnText}>Environment variables</Text>
                    <Ionicons name={envOpen ? "chevron-up" : "chevron-down"} size={15} color={theme.textMuted} />
                  </TouchableOpacity>
                </View>

                {envOpen && (
                  <View style={styles.envBox}>
                    {!envVars[s.id] ? (
                      <ActivityIndicator color={theme.primary} size="small" />
                    ) : list.length === 0 ? (
                      <Text style={styles.muted}>No environment variables.</Text>
                    ) : list.map((ev) => {
                      const rk = `${s.id}:${ev.key}`;
                      const isEditing = editKey === rk;
                      const isRevealed = !!revealed[rk];
                      return (
                        <View key={ev.key} style={styles.envItem}>
                          <Text style={styles.envKey} numberOfLines={1}>{ev.key}</Text>
                          {isEditing ? (
                            <>
                              <TextInput style={styles.envInput} value={editVal} onChangeText={setEditVal} autoCapitalize="none" autoCorrect={false} placeholder="value" placeholderTextColor={theme.textMuted} testID={`env-edit-${ev.key}`} />
                              <View style={styles.envBtns}>
                                <TouchableOpacity onPress={() => onSaveEnv(s.id, ev.key)} disabled={busy === `${s.id}:env:${ev.key}`} style={styles.miniBtn}>
                                  {busy === `${s.id}:env:${ev.key}` ? <ActivityIndicator size="small" color={theme.primary} /> : <Text style={styles.miniBtnText}>Save</Text>}
                                </TouchableOpacity>
                                <TouchableOpacity onPress={() => setEditKey(null)} style={styles.miniBtn}><Text style={styles.miniBtnMuted}>Cancel</Text></TouchableOpacity>
                              </View>
                            </>
                          ) : (
                            <View style={styles.envValRow}>
                              <Text style={styles.envVal} numberOfLines={1}>{isRevealed ? (ev.value || "—") : mask(ev.value)}</Text>
                              <TouchableOpacity hitSlop={8} onPress={() => setRevealed((m) => ({ ...m, [rk]: !m[rk] }))} testID={`reveal-${ev.key}`}>
                                <Ionicons name={isRevealed ? "eye-off-outline" : "eye-outline"} size={16} color={theme.textMuted} />
                              </TouchableOpacity>
                              <TouchableOpacity hitSlop={8} onPress={() => { setEditKey(rk); setEditVal(ev.value || ""); }} testID={`edit-${ev.key}`}>
                                <Ionicons name="create-outline" size={16} color={theme.primary} />
                              </TouchableOpacity>
                              <TouchableOpacity hitSlop={8} onPress={() => onDeleteEnv(s.id, ev.key)} testID={`del-${ev.key}`}>
                                <Ionicons name="trash-outline" size={16} color={theme.error} />
                              </TouchableOpacity>
                            </View>
                          )}
                        </View>
                      );
                    })}

                    <View style={styles.addRow}>
                      <TextInput style={[styles.envInput, { flex: 0.42 }]} value={newKey} onChangeText={setNewKey} autoCapitalize="characters" autoCorrect={false} placeholder="NEW_KEY" placeholderTextColor={theme.textMuted} testID={`env-new-key-${s.id}`} />
                      <TextInput style={[styles.envInput, { flex: 0.58 }]} value={newVal} onChangeText={setNewVal} autoCapitalize="none" autoCorrect={false} placeholder="value" placeholderTextColor={theme.textMuted} testID={`env-new-val-${s.id}`} />
                      <TouchableOpacity onPress={() => onAddEnv(s.id)} disabled={!newKey.trim() || busy === `${s.id}:env:new`} style={styles.addBtn} testID={`env-add-${s.id}`}>
                        {busy === `${s.id}:env:new` ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="add" size={18} color="#fff" />}
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                <View style={styles.sectionRow}>
                  <TouchableOpacity style={styles.sectionBtn} onPress={() => toggleDeploys(s.id)} testID={`deploys-toggle-${s.id}`}>
                    <Ionicons name="git-commit-outline" size={15} color={theme.primary} />
                    <Text style={styles.sectionBtnText}>Recent deploys</Text>
                    <Ionicons name={depOpen ? "chevron-up" : "chevron-down"} size={15} color={theme.textMuted} />
                  </TouchableOpacity>
                </View>
                {depOpen && (
                  <View style={styles.envBox}>
                    {!deploys[s.id] ? (
                      <ActivityIndicator color={theme.primary} size="small" />
                    ) : deps.length === 0 ? (
                      <Text style={styles.muted}>No deploys yet.</Text>
                    ) : deps.map((d) => (
                      <View key={d.id} style={styles.depItem}>
                        <View style={[styles.depDot, { backgroundColor: d.status === "live" ? "#22C55E" : d.status && d.status.includes("fail") ? theme.error : theme.textMuted }]} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.depMsg} numberOfLines={1}>{d.commit_message || d.status}</Text>
                          <Text style={styles.depMeta}>{d.status}{d.commit_id ? `  ·  ${d.commit_id}` : ""}  ·  {fmt(d.created_at)}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}

                {!!s.dashboard_url && (
                  <TouchableOpacity onPress={() => Linking.openURL(s.dashboard_url!)} testID={`dash-${s.id}`}>
                    <Text style={styles.link}>Open in Render dashboard ↗</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
          {services.length === 0 && <Text style={styles.muted}>No services found on this Render account.</Text>}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function ActionBtn({ icon, label, onPress, busy, danger, testID }: {
  icon: any; label: string; onPress: () => void; busy?: boolean; danger?: boolean; testID?: string;
}) {
  return (
    <TouchableOpacity style={[styles.actionBtn, danger && styles.actionBtnDanger]} onPress={onPress} disabled={busy} testID={testID}>
      {busy ? <ActivityIndicator size="small" color={danger ? theme.error : theme.primary} /> : (
        <>
          <Ionicons name={icon} size={15} color={danger ? theme.error : theme.primary} />
          <Text style={[styles.actionText, danger && { color: theme.error }]}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

const mono = Platform.OS === "ios" ? "Menlo" : "monospace";
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  setup: { flex: 1, alignItems: "center", justifyContent: "center", padding: 30, gap: 10 },
  setupTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "800", marginTop: 6 },
  setupText: { color: theme.textSecondary, fontSize: 14, lineHeight: 20, textAlign: "center" },
  mono: { fontFamily: mono, color: theme.textPrimary, fontSize: 13 },
  link: { color: theme.primary, fontSize: 13.5, fontWeight: "700", marginTop: 8 },
  note: { color: theme.textMuted, fontSize: 12, lineHeight: 17, marginBottom: 10 },
  err: { color: theme.error, fontSize: 13, marginBottom: 8 },
  card: { backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 14, marginBottom: 12, gap: 8 },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  svcName: { color: theme.textPrimary, fontSize: 15.5, fontWeight: "800" },
  svcMeta: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  svcUrl: { color: theme.primary, fontSize: 12.5, fontFamily: mono },
  pill: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4 },
  pillGood: { backgroundColor: "rgba(34,197,94,0.12)", borderColor: "#22C55E" },
  pillBad: { backgroundColor: "rgba(241,92,109,0.12)", borderColor: theme.error },
  pillText: { fontSize: 11.5, fontWeight: "800" },
  depStatusRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4 },
  depStatusDot: { width: 7, height: 7, borderRadius: 4 },
  depStatusText: { fontSize: 11.5, fontWeight: "700" },
  clearCacheBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 8, borderWidth: 1, borderColor: theme.border, borderRadius: 10, borderStyle: "dashed" },
  clearCacheText: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "700" },
  actions: { flexDirection: "row", gap: 8 },
  actionBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, backgroundColor: theme.surfaceAlt, borderRadius: 10, paddingVertical: 9 },
  actionBtnDanger: { backgroundColor: "rgba(241,92,109,0.10)" },
  actionText: { color: theme.primary, fontSize: 12.5, fontWeight: "800" },
  sectionRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border, paddingTop: 8 },
  sectionBtn: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionBtnText: { flex: 1, color: theme.textPrimary, fontSize: 13.5, fontWeight: "700" },
  envBox: { backgroundColor: theme.surfaceAlt, borderRadius: 10, padding: 10, gap: 8 },
  muted: { color: theme.textMuted, fontSize: 12.5 },
  envItem: { gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border, paddingBottom: 8 },
  envKey: { color: theme.textPrimary, fontSize: 12.5, fontWeight: "700", fontFamily: mono },
  envValRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  envVal: { flex: 1, color: theme.textSecondary, fontSize: 12.5, fontFamily: mono },
  envInput: { backgroundColor: theme.bg, borderWidth: 1, borderColor: theme.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, color: theme.textPrimary, fontSize: 12.5, fontFamily: mono, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  envBtns: { flexDirection: "row", gap: 8, alignSelf: "flex-end" },
  miniBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  miniBtnText: { color: theme.primary, fontSize: 12.5, fontWeight: "800" },
  miniBtnMuted: { color: theme.textMuted, fontSize: 12.5, fontWeight: "700" },
  addRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 },
  addBtn: { width: 38, height: 36, borderRadius: 8, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  depItem: { flexDirection: "row", alignItems: "center", gap: 10 },
  depDot: { width: 8, height: 8, borderRadius: 4 },
  depMsg: { color: theme.textPrimary, fontSize: 12.5, fontWeight: "600" },
  depMeta: { color: theme.textMuted, fontSize: 11, marginTop: 1 },
});
