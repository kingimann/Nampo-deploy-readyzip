import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, RefreshControl, Image, Alert, Linking, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import * as Location from "expo-location";
import { safeBack } from "@/src/utils/nav";
import { api, RoadsideRequest, RoadsideService, RoadsideParty } from "@/src/api/client";
import { theme } from "@/src/theme";

const SERVICE_META: Record<RoadsideService, { label: string; icon: any; desc: string }> = {
  tow:     { label: "Tow",                icon: "car-sport",        desc: "Vehicle needs towing to a shop or home" },
  lockout: { label: "Lockout",            icon: "key",              desc: "Locked out — keys inside the car" },
  battery: { label: "Battery boost",      icon: "battery-charging", desc: "Dead battery — needs a jump start" },
  tire:    { label: "Tire change / flat", icon: "disc",             desc: "Flat tire — swap to spare or repair" },
};
const SERVICE_ORDER: RoadsideService[] = ["tow", "lockout", "battery", "tire"];

const STATUS_META: Record<string, { label: string; color: string }> = {
  open:      { label: "Searching for help", color: theme.warning },
  accepted:  { label: "Help is on the way", color: theme.primary },
  completed: { label: "Completed",          color: theme.success },
  cancelled: { label: "Cancelled",          color: theme.textMuted },
};

export default function RoadsideScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<"request" | "nearby">("request");
  const [active, setActive] = useState<RoadsideRequest | null>(null);
  const [helping, setHelping] = useState<RoadsideRequest | null>(null);
  const [nearby, setNearby] = useState<RoadsideRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [noLocation, setNoLocation] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // New-request form
  const [service, setService] = useState<RoadsideService | null>(null);
  const [coords, setCoords] = useState<[number, number] | null>(null);
  const [placeName, setPlaceName] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [note, setNote] = useState("");
  const [locating, setLocating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const detect = useCallback(async (prompt: boolean): Promise<{ coords: [number, number]; name: string } | null> => {
    setLocating(true);
    try {
      let { status } = await Location.getForegroundPermissionsAsync();
      if (status !== "granted") {
        if (!prompt) return null;
        const r = await Location.requestForegroundPermissionsAsync();
        status = r.status;
      }
      if (status !== "granted") return null;
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const c: [number, number] = [pos.coords.longitude, pos.coords.latitude];
      let name = "";
      try {
        const places = await Location.reverseGeocodeAsync({ latitude: c[1], longitude: c[0] });
        const p = places?.[0];
        if (p) name = [p.name, p.street, p.city, p.region].filter(Boolean).join(", ");
      } catch {}
      return { coords: c, name };
    } catch {
      return null;
    } finally {
      setLocating(false);
    }
  }, []);

  const loadNearby = useCallback(async (c: [number, number] | null) => {
    if (!c) { setNearby([]); setNoLocation(true); return; }
    setNoLocation(false);
    try {
      setNearby(await api.roadsideNearby({ lng: c[0], lat: c[1], radius_km: 80 }));
    } catch { setNearby([]); }
  }, []);

  const load = useCallback(async () => {
    try {
      const [a, h] = await Promise.all([api.roadsideActive(), api.roadsideHelping()]);
      setActive(a); setHelping(h);
    } catch {}
    // Silently use location if already granted (don't prompt on load).
    const loc = await detect(false);
    if (loc) {
      setCoords(loc.coords);
      setPlaceName((prev) => prev || loc.name);
      await loadNearby(loc.coords);
    } else {
      await loadNearby(null);
    }
    setLoading(false);
    setRefreshing(false);
  }, [detect, loadNearby]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const useMyLocation = async () => {
    const loc = await detect(true);
    if (!loc) { Alert.alert("Location needed", "Enable location access so helpers can find you."); return; }
    setCoords(loc.coords);
    setPlaceName(loc.name);
    setNoLocation(false);
    loadNearby(loc.coords);
  };

  const submit = async () => {
    if (!service) { setErr("Choose what you need help with."); return; }
    if (!coords) { setErr("Set your location so a helper can reach you."); return; }
    setErr(null); setSubmitting(true);
    try {
      const r = await api.createRoadside({
        service,
        longitude: coords[0],
        latitude: coords[1],
        place_name: placeName.trim() || undefined,
        vehicle: vehicle.trim() || undefined,
        note: note.trim() || undefined,
      });
      setActive(r);
      setService(null); setVehicle(""); setNote("");
    } catch (e: any) {
      setErr(String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally {
      setSubmitting(false);
    }
  };

  const cancelReq = (r: RoadsideRequest) => {
    const go = async () => {
      setBusyId(r.id);
      try { await api.cancelRoadside(r.id); setActive(null); } catch (e: any) { Alert.alert("Couldn't cancel", String(e?.message || e)); } finally { setBusyId(null); }
    };
    if (Platform.OS === "web") { if (typeof window !== "undefined" && window.confirm("Cancel this roadside request?")) go(); }
    else Alert.alert("Cancel request", "Cancel this roadside request?", [
      { text: "Keep", style: "cancel" },
      { text: "Cancel request", style: "destructive", onPress: go },
    ]);
  };

  const complete = async (r: RoadsideRequest, clear: () => void) => {
    setBusyId(r.id);
    try { await api.completeRoadside(r.id); clear(); } catch (e: any) { Alert.alert("Couldn't complete", String(e?.message || e)); } finally { setBusyId(null); }
  };

  const accept = async (r: RoadsideRequest) => {
    setBusyId(r.id);
    try {
      const updated = await api.acceptRoadside(r.id);
      setHelping(updated);
      setNearby((arr) => arr.filter((x) => x.id !== r.id));
      setTab("request");
    } catch (e: any) {
      Alert.alert("Couldn't accept", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
      loadNearby(coords);
    } finally {
      setBusyId(null);
    }
  };

  const messageUser = async (uid: string, name?: string) => {
    try {
      const conv = await api.getOrCreateConversation(uid);
      router.push({ pathname: "/chat/[id]", params: { id: conv.id, name: name || "Member" } });
    } catch {}
  };
  const callUser = (phone?: string | null) => { if (phone) Linking.openURL(`tel:${phone}`).catch(() => {}); };

  // ── Party row (avatar + name + contact buttons) ──
  const PartyRow = ({ p, role }: { p?: RoadsideParty | null; role: string }) => {
    if (!p) return null;
    return (
      <View style={styles.partyRow}>
        <View style={styles.avatar}>
          {p.picture ? <Image source={{ uri: p.picture }} style={styles.avatarImg} />
            : <Text style={styles.avatarInit}>{(p.name?.[0] || "?").toUpperCase()}</Text>}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.partyName} numberOfLines={1}>{p.name}</Text>
          <Text style={styles.partyRole}>{role}</Text>
        </View>
        <TouchableOpacity style={styles.contactBtn} onPress={() => messageUser(p.user_id, p.name)} testID={`rs-msg-${p.user_id}`}>
          <Ionicons name="chatbubble-ellipses" size={18} color="#fff" />
        </TouchableOpacity>
        {!!p.phone && (
          <TouchableOpacity style={[styles.contactBtn, { backgroundColor: theme.success }]} onPress={() => callUser(p.phone)} testID={`rs-call-${p.user_id}`}>
            <Ionicons name="call" size={18} color="#fff" />
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const ServicePill = ({ svc, small }: { svc: RoadsideService; small?: boolean }) => {
    const m = SERVICE_META[svc];
    return (
      <View style={[styles.svcPill, small && { paddingVertical: 4 }]}>
        <Ionicons name={m.icon} size={small ? 13 : 15} color={theme.primary} />
        <Text style={styles.svcPillText}>{m.label}</Text>
      </View>
    );
  };

  const StatusBadge = ({ status }: { status: string }) => {
    const m = STATUS_META[status] || STATUS_META.open;
    return (
      <View style={[styles.statusBadge, { backgroundColor: m.color + "22", borderColor: m.color }]}>
        <Text style={[styles.statusText, { color: m.color }]}>{m.label}</Text>
      </View>
    );
  };

  // ── Active request card (the viewer is the requester) ──
  const ActiveCard = ({ r }: { r: RoadsideRequest }) => (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <ServicePill svc={r.service} />
        <StatusBadge status={r.status} />
      </View>
      {!!r.place_name && (
        <View style={styles.metaLine}><Ionicons name="location" size={14} color={theme.textMuted} /><Text style={styles.metaText} numberOfLines={2}>{r.place_name}</Text></View>
      )}
      {!!r.vehicle && (
        <View style={styles.metaLine}><Ionicons name="car-outline" size={14} color={theme.textMuted} /><Text style={styles.metaText}>{r.vehicle}</Text></View>
      )}
      {!!r.note && (
        <View style={styles.metaLine}><Ionicons name="document-text-outline" size={14} color={theme.textMuted} /><Text style={styles.metaText}>{r.note}</Text></View>
      )}
      {r.status === "open" && (
        <Text style={styles.hint}>We're letting nearby members know. You'll be notified the moment someone accepts.</Text>
      )}
      {r.status === "accepted" && <PartyRow p={r.helper} role="Helper on the way" />}
      <View style={styles.cardActions}>
        {r.status === "accepted" && (
          <TouchableOpacity style={[styles.actBtn, styles.actPrimary]} onPress={() => complete(r, () => setActive(null))} disabled={busyId === r.id} testID="rs-complete">
            <Text style={styles.actPrimaryText}>{busyId === r.id ? "…" : "Mark resolved"}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={[styles.actBtn, styles.actGhost]} onPress={() => cancelReq(r)} disabled={busyId === r.id} testID="rs-cancel">
          <Text style={styles.actGhostText}>Cancel request</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // ── Helping card (the viewer accepted someone else's request) ──
  const HelpingCard = ({ r }: { r: RoadsideRequest }) => (
    <View style={[styles.card, { borderColor: theme.primary + "66" }]}>
      <View style={styles.cardHead}>
        <View style={styles.helpingTag}><Ionicons name="navigate" size={13} color={theme.primary} /><Text style={styles.helpingTagText}>You're helping</Text></View>
        <ServicePill svc={r.service} small />
      </View>
      <PartyRow p={r.requester} role="Stranded member" />
      {!!r.place_name && (
        <View style={styles.metaLine}><Ionicons name="location" size={14} color={theme.textMuted} /><Text style={styles.metaText} numberOfLines={2}>{r.place_name}</Text></View>
      )}
      {!!r.vehicle && (
        <View style={styles.metaLine}><Ionicons name="car-outline" size={14} color={theme.textMuted} /><Text style={styles.metaText}>{r.vehicle}</Text></View>
      )}
      {!!r.note && (
        <View style={styles.metaLine}><Ionicons name="document-text-outline" size={14} color={theme.textMuted} /><Text style={styles.metaText}>{r.note}</Text></View>
      )}
      <View style={styles.cardActions}>
        <TouchableOpacity
          style={[styles.actBtn, styles.actPrimary]}
          onPress={() => { if (r.latitude != null) Linking.openURL(Platform.select({ ios: `maps://?daddr=${r.latitude},${r.longitude}`, default: `https://www.google.com/maps/dir/?api=1&destination=${r.latitude},${r.longitude}` }) as string).catch(() => {}); }}
          testID="rs-navigate"
        >
          <Text style={styles.actPrimaryText}>Navigate</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.actBtn, styles.actGhost]} onPress={() => complete(r, () => setHelping(null))} disabled={busyId === r.id} testID="rs-helper-complete">
          <Text style={styles.actGhostText}>{busyId === r.id ? "…" : "Mark resolved"}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="roadside-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack("/")} style={styles.iconBtn} testID="roadside-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Roadside help</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.tabs}>
        {(["request", "nearby"] as const).map((t) => (
          <TouchableOpacity key={t} style={[styles.tab, tab === t && styles.tabOn]} onPress={() => setTab(t)} testID={`roadside-tab-${t}`}>
            <Text style={[styles.tabText, tab === t && styles.tabTextOn]}>{t === "request" ? "Get help" : "Help others"}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} />}
        >
          {tab === "request" ? (
            <>
              {helping && <HelpingCard r={helping} />}
              {active ? (
                <ActiveCard r={active} />
              ) : (
                <>
                  <Text style={styles.sectionLabel}>What do you need?</Text>
                  <View style={styles.svcGrid}>
                    {SERVICE_ORDER.map((k) => {
                      const m = SERVICE_META[k];
                      const on = service === k;
                      return (
                        <TouchableOpacity key={k} style={[styles.svcCard, on && styles.svcCardOn]} onPress={() => setService(k)} testID={`rs-svc-${k}`}>
                          <View style={[styles.svcIcon, on && { backgroundColor: theme.primary }]}>
                            <Ionicons name={m.icon} size={22} color={on ? "#fff" : theme.primary} />
                          </View>
                          <Text style={[styles.svcLabel, on && { color: theme.primary }]}>{m.label}</Text>
                          <Text style={styles.svcDesc} numberOfLines={2}>{m.desc}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <Text style={styles.sectionLabel}>Your location</Text>
                  <TouchableOpacity style={styles.locBtn} onPress={useMyLocation} disabled={locating} testID="rs-use-location">
                    {locating ? <ActivityIndicator color={theme.primary} size="small" /> : <Ionicons name="navigate" size={16} color={theme.primary} />}
                    <Text style={styles.locBtnText}>{coords ? "Update to current location" : "Use my current location"}</Text>
                  </TouchableOpacity>
                  <TextInput
                    style={styles.input}
                    placeholder="Address or landmark (so they can find you)"
                    placeholderTextColor={theme.textMuted}
                    value={placeName}
                    onChangeText={setPlaceName}
                    testID="rs-place"
                  />

                  <Text style={styles.sectionLabel}>Vehicle (optional)</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="e.g. Red Honda Civic · plate ABC-123"
                    placeholderTextColor={theme.textMuted}
                    value={vehicle}
                    onChangeText={setVehicle}
                    maxLength={120}
                    testID="rs-vehicle"
                  />

                  <Text style={styles.sectionLabel}>Notes (optional)</Text>
                  <TextInput
                    style={[styles.input, styles.textarea]}
                    placeholder="Anything that helps — e.g. which tire is flat, are you somewhere safe…"
                    placeholderTextColor={theme.textMuted}
                    value={note}
                    onChangeText={setNote}
                    maxLength={500}
                    multiline
                    testID="rs-note"
                  />

                  {!!err && <Text style={styles.err}>{err}</Text>}
                  <TouchableOpacity
                    style={[styles.submit, (!service || !coords || submitting) && { opacity: 0.5 }]}
                    onPress={submit}
                    disabled={!service || !coords || submitting}
                    testID="rs-submit"
                  >
                    {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Request help</Text>}
                  </TouchableOpacity>
                  <Text style={styles.disclaimer}>Roadside help is provided by other members, not a professional service. Stay somewhere safe while you wait. For emergencies, call your local emergency number.</Text>
                </>
              )}
            </>
          ) : (
            <>
              {noLocation ? (
                <View style={styles.empty}>
                  <Ionicons name="location-outline" size={36} color={theme.textMuted} />
                  <Text style={styles.emptyText}>Enable location to see nearby members who need a hand.</Text>
                  <TouchableOpacity style={styles.locBtn} onPress={useMyLocation} testID="rs-enable-location">
                    <Ionicons name="navigate" size={16} color={theme.primary} />
                    <Text style={styles.locBtnText}>Use my location</Text>
                  </TouchableOpacity>
                </View>
              ) : nearby.length === 0 ? (
                <View style={styles.empty}>
                  <Ionicons name="checkmark-done-outline" size={36} color={theme.textMuted} />
                  <Text style={styles.emptyText}>No one needs roadside help near you right now.</Text>
                </View>
              ) : (
                nearby.map((r) => {
                  const m = SERVICE_META[r.service];
                  return (
                    <View key={r.id} style={styles.card}>
                      <View style={styles.cardHead}>
                        <ServicePill svc={r.service} />
                        {r.distance_km != null && <Text style={styles.dist}>{r.distance_km} km away</Text>}
                      </View>
                      <PartyRow p={r.requester} role="Needs a hand" />
                      {!!r.place_name && (
                        <View style={styles.metaLine}><Ionicons name="location" size={14} color={theme.textMuted} /><Text style={styles.metaText} numberOfLines={2}>{r.place_name}</Text></View>
                      )}
                      {!!r.vehicle && (
                        <View style={styles.metaLine}><Ionicons name="car-outline" size={14} color={theme.textMuted} /><Text style={styles.metaText}>{r.vehicle}</Text></View>
                      )}
                      {!!r.note && (
                        <View style={styles.metaLine}><Ionicons name="document-text-outline" size={14} color={theme.textMuted} /><Text style={styles.metaText} numberOfLines={3}>{r.note}</Text></View>
                      )}
                      <TouchableOpacity style={[styles.actBtn, styles.actPrimary, { marginTop: 12 }]} onPress={() => accept(r)} disabled={busyId === r.id} testID={`rs-accept-${r.id}`}>
                        <Text style={styles.actPrimaryText}>{busyId === r.id ? "…" : `Accept & help (${m.label})`}</Text>
                      </TouchableOpacity>
                    </View>
                  );
                })
              )}
            </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  tabs: { flexDirection: "row", paddingHorizontal: 14, gap: 8, paddingVertical: 10 },
  tab: { flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: 999, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  tabOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  tabText: { color: theme.textSecondary, fontSize: 14, fontWeight: "800" },
  tabTextOn: { color: "#fff" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  sectionLabel: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 16, marginBottom: 10 },
  svcGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  svcCard: { width: "47.5%", flexGrow: 1, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 16, padding: 14 },
  svcCardOn: { borderColor: theme.primary, backgroundColor: theme.primary + "12" },
  svcIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: theme.primary + "1f", alignItems: "center", justifyContent: "center", marginBottom: 10 },
  svcLabel: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  svcDesc: { color: theme.textMuted, fontSize: 12, marginTop: 3, lineHeight: 16 },

  locBtn: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", backgroundColor: theme.primary + "1a", borderWidth: 1, borderColor: theme.primary + "55", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11 },
  locBtnText: { color: theme.primary, fontSize: 14, fontWeight: "800" },
  input: { color: theme.textPrimary, fontSize: 14.5, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginTop: 10, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  textarea: { minHeight: 90, textAlignVertical: "top" },
  err: { color: theme.error, fontSize: 13, marginTop: 12 },
  submit: { backgroundColor: theme.primary, borderRadius: 14, paddingVertical: 15, alignItems: "center", marginTop: 18 },
  submitText: { color: "#fff", fontSize: 15.5, fontWeight: "800" },
  disclaimer: { color: theme.textMuted, fontSize: 11.5, lineHeight: 16, marginTop: 14, textAlign: "center" },

  card: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 18, padding: 16, marginBottom: 14 },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  svcPill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.primary + "1f", borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  svcPillText: { color: theme.primary, fontSize: 13, fontWeight: "800" },
  statusBadge: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  statusText: { fontSize: 11.5, fontWeight: "800" },
  dist: { color: theme.textMuted, fontSize: 12.5, fontWeight: "700" },
  metaLine: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8 },
  metaText: { flex: 1, color: theme.textSecondary, fontSize: 13.5, lineHeight: 19 },
  hint: { color: theme.textMuted, fontSize: 13, lineHeight: 18, marginTop: 12 },

  partyRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 12, backgroundColor: theme.surfaceAlt, borderRadius: 14, padding: 10 },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontSize: 17, fontWeight: "800" },
  partyName: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  partyRole: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
  contactBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },

  cardActions: { flexDirection: "row", gap: 10, marginTop: 14 },
  actBtn: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  actPrimary: { backgroundColor: theme.primary },
  actPrimaryText: { color: "#fff", fontSize: 14.5, fontWeight: "800" },
  actGhost: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border },
  actGhostText: { color: theme.textSecondary, fontSize: 14.5, fontWeight: "800" },

  helpingTag: { flexDirection: "row", alignItems: "center", gap: 6 },
  helpingTagText: { color: theme.primary, fontSize: 13.5, fontWeight: "900" },

  empty: { alignItems: "center", gap: 12, paddingVertical: 50 },
  emptyText: { color: theme.textMuted, fontSize: 14, textAlign: "center", paddingHorizontal: 30, lineHeight: 20 },
});
