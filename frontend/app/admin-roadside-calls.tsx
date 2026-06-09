import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, Alert, Platform, Image, Modal, Pressable,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, RoadsideRequest } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { pickImages } from "@/src/utils/thumbnail";
import { theme } from "@/src/theme";

const SERVICES = [
  { key: "tow", label: "Tow" },
  { key: "lockout", label: "Lockout" },
  { key: "battery", label: "Battery" },
  { key: "tire", label: "Tire" },
  { key: "gas", label: "Gas" },
];
// Sensible default drop point for admin-created calls (downtown Toronto) when
// no coordinates are typed.
const DEFAULT_LNG = -79.3832;
const DEFAULT_LAT = 43.6532;

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default function AdminRoadsideCallsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [date, setDate] = useState(todayStr());
  const [search, setSearch] = useState("");
  const [calls, setCalls] = useState<RoadsideRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // Create form
  const [svc, setSvc] = useState("tow");
  const [callerName, setCallerName] = useState("");
  const [note, setNote] = useState("");
  const [place, setPlace] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [vYear, setVYear] = useState("");
  const [vMake, setVMake] = useState("");
  const [vModel, setVModel] = useState("");
  const [vColor, setVColor] = useState("");
  const [vPlate, setVPlate] = useState("");
  const [price, setPrice] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const addPhotos = async () => {
    if (photos.length >= 6) return;
    setPicking(true);
    try {
      const added = await pickImages(6 - photos.length);
      if (added.length) setPhotos((p) => [...p, ...added].slice(0, 6));
    } catch (e: any) {
      Alert.alert("Couldn't add photos", String(e?.message || e));
    } finally { setPicking(false); }
  };

  const runSearch = async (d: string, n: string) => {
    setLoading(true);
    try {
      const num = n.trim() ? Number(n.trim()) : undefined;
      setCalls(await api.adminListRoadsideCalls({ date: d.trim() || undefined, call_number: Number.isFinite(num) ? num : undefined }));
    } catch (e: any) {
      Alert.alert("Couldn't load calls", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setLoading(false); }
  };
  const load = useCallback(() => runSearch(date, search), [date, search]);
  // Search across all days (no call number required).
  const showRecent = () => { setDate(""); setSearch(""); runSearch("", ""); };

  useFocusEffect(useCallback(() => { if (isAdmin) load(); }, [load, isAdmin]));

  const deleteOne = (c: RoadsideRequest) => {
    Alert.alert("Erase this call?", `Call #${c.call_number ?? "—"} (${c.service}) will be permanently removed.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Erase", style: "destructive", onPress: async () => {
        try { await api.adminDeleteRoadsideCall(c.id); setCalls((arr) => arr.filter((x) => x.id !== c.id)); }
        catch (e: any) { Alert.alert("Couldn't erase", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
      } },
    ]);
  };
  const eraseAll = (testOnly: boolean) => {
    const scope = date.trim() ? `on ${date.trim()}` : "across all days";
    const what = testOnly ? `all test calls ${scope}` : `ALL calls ${scope}`;
    Alert.alert(`Erase ${what}?`, "This permanently removes the matching calls.", [
      { text: "Cancel", style: "cancel" },
      { text: "Erase", style: "destructive", onPress: async () => {
        try {
          const params: { date?: string; all?: boolean; test_only?: boolean } = {};
          if (date.trim()) params.date = date.trim(); else params.all = true;
          if (testOnly) params.test_only = true;
          const r = await api.adminEraseRoadsideCalls(params);
          Alert.alert("Done", `Erased ${r.deleted} call${r.deleted === 1 ? "" : "s"}.`);
          load();
        } catch (e: any) { Alert.alert("Couldn't erase", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
      } },
    ]);
  };

  const create = async (isTest: boolean) => {
    setCreating(true);
    try {
      const priceNum = price.trim() ? Number(price.replace(/[^0-9.]/g, "")) : undefined;
      const c = await api.adminCreateRoadsideCall({
        service: svc,
        longitude: lng.trim() ? Number(lng) : DEFAULT_LNG,
        latitude: lat.trim() ? Number(lat) : DEFAULT_LAT,
        place_name: place.trim() || undefined,
        note: note.trim() || undefined,
        is_test: isTest,
        caller_name: callerName.trim() || undefined,
        vehicle_year: vYear.trim() || undefined,
        vehicle_make: vMake.trim() || undefined,
        vehicle_model: vModel.trim() || undefined,
        vehicle_color: vColor.trim() || undefined,
        vehicle_plate: vPlate.trim() || undefined,
        photos: photos.length ? photos : undefined,
        price: Number.isFinite(priceNum) ? priceNum : undefined,
      });
      setNote(""); setPlace(""); setCallerName("");
      setVYear(""); setVMake(""); setVModel(""); setVColor(""); setVPlate("");
      setPrice(""); setPhotos([]);
      Alert.alert(isTest ? "Test call created" : "Call created", `Assigned call #${c.call_number ?? "?"}.`);
      // Make sure we're viewing today so the new call shows.
      setDate(todayStr()); setSearch("");
      load();
    } catch (e: any) {
      Alert.alert("Couldn't create call", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setCreating(false); }
  };

  if (!isAdmin) {
    return (
      <SafeAreaView edges={["top"]} style={styles.root}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.center}>
          {user == null ? <ActivityIndicator color={theme.primary} /> : (
            <>
              <Ionicons name="lock-closed-outline" size={34} color={theme.textMuted} />
              <Text style={styles.empty}>Admins only.</Text>
            </>
          )}
        </View>
      </SafeAreaView>
    );
  }

  const fmt = (s?: string | null) => (s ? new Date(s).toLocaleString() : "—");

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="admin-roadside-calls-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack("/admin-roadside")} style={styles.iconBtn}><Ionicons name="chevron-back" size={24} color={theme.textPrimary} /></TouchableOpacity>
        <Text style={styles.title}>Roadside calls</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }} keyboardShouldPersistTaps="handled">
        {/* Create */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Create a call</Text>
          <View style={styles.chipRow}>
            {SERVICES.map((s) => (
              <TouchableOpacity key={s.key} onPress={() => setSvc(s.key)} style={[styles.chip, svc === s.key && styles.chipOn]} testID={`svc-${s.key}`}>
                <Text style={[styles.chipText, svc === s.key && { color: "#fff" }]}>{s.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TextInput style={styles.input} value={callerName} onChangeText={setCallerName} placeholder="Caller name (optional)" placeholderTextColor={theme.textMuted} />
          <TextInput style={styles.input} value={place} onChangeText={setPlace} placeholder="Place / address (optional)" placeholderTextColor={theme.textMuted} />

          <Text style={styles.fieldLabel}>Vehicle</Text>
          <View style={styles.row2}>
            <TextInput style={[styles.input, { width: 84 }]} value={vYear} onChangeText={setVYear} placeholder="Year" placeholderTextColor={theme.textMuted} keyboardType="number-pad" />
            <TextInput style={[styles.input, styles.flexInput]} value={vMake} onChangeText={setVMake} placeholder="Make" placeholderTextColor={theme.textMuted} />
            <TextInput style={[styles.input, styles.flexInput]} value={vModel} onChangeText={setVModel} placeholder="Model" placeholderTextColor={theme.textMuted} />
          </View>
          <View style={styles.row2}>
            <TextInput style={[styles.input, styles.flexInput]} value={vColor} onChangeText={setVColor} placeholder="Color" placeholderTextColor={theme.textMuted} />
            <TextInput style={[styles.input, styles.flexInput]} value={vPlate} onChangeText={setVPlate} placeholder="Plate" placeholderTextColor={theme.textMuted} autoCapitalize="characters" />
          </View>

          <TextInput style={[styles.input, { minHeight: 64, textAlignVertical: "top" }]} value={note} onChangeText={setNote} placeholder="Comments / notes (optional)" placeholderTextColor={theme.textMuted} multiline />

          <View style={styles.row2}>
            <TextInput style={[styles.input, styles.flexInput]} value={price} onChangeText={(t) => setPrice(t.replace(/[^0-9.]/g, ""))} placeholder="$ Price (optional)" placeholderTextColor={theme.textMuted} keyboardType="decimal-pad" />
            <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={addPhotos} disabled={picking || photos.length >= 6} testID="add-photos">
              <Ionicons name="image-outline" size={16} color={theme.primary} />
              <Text style={styles.btnGhostText}>{picking ? "…" : `Photos${photos.length ? ` (${photos.length})` : ""}`}</Text>
            </TouchableOpacity>
          </View>
          {photos.length > 0 && (
            <View style={styles.photoRow}>
              {photos.map((p, i) => (
                <View key={i} style={styles.photoThumb}>
                  <Image source={{ uri: p }} style={StyleSheet.absoluteFill} />
                  <TouchableOpacity style={styles.photoX} onPress={() => setPhotos((arr) => arr.filter((_, j) => j !== i))}>
                    <Ionicons name="close" size={12} color="#fff" />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          <View style={styles.row2}>
            <TextInput style={[styles.input, styles.flexInput]} value={lat} onChangeText={setLat} placeholder="Lat (optional)" placeholderTextColor={theme.textMuted} keyboardType="numbers-and-punctuation" />
            <TextInput style={[styles.input, styles.flexInput]} value={lng} onChangeText={setLng} placeholder="Lng (optional)" placeholderTextColor={theme.textMuted} keyboardType="numbers-and-punctuation" />
          </View>
          <View style={styles.row2}>
            <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => create(true)} disabled={creating} testID="create-test-call">
              <Ionicons name="flask-outline" size={16} color={theme.primary} />
              <Text style={styles.btnGhostText}>{creating ? "…" : "Test call"}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnSolid]} onPress={() => create(false)} disabled={creating} testID="create-real-call">
              <Ionicons name="add" size={18} color="#fff" />
              <Text style={styles.btnSolidText}>{creating ? "…" : "Real call"}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Search */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Find calls</Text>
          <View style={styles.row2}>
            <TextInput style={[styles.input, styles.flexInput]} value={date} onChangeText={setDate} placeholder="YYYY-MM-DD (blank = all)" placeholderTextColor={theme.textMuted} autoCapitalize="none" />
            <TextInput style={[styles.input, { width: 96 }]} value={search} onChangeText={setSearch} placeholder="Call #" placeholderTextColor={theme.textMuted} keyboardType="number-pad" testID="call-search" />
          </View>
          <View style={styles.row2}>
            <TouchableOpacity style={[styles.btn, styles.btnSolid]} onPress={load} testID="call-search-go">
              <Ionicons name="search" size={16} color="#fff" />
              <Text style={styles.btnSolidText}>Search</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={showRecent} testID="call-recent">
              <Ionicons name="time-outline" size={16} color={theme.primary} />
              <Text style={styles.btnGhostText}>Recent (all)</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.row2}>
            <TouchableOpacity style={[styles.btn, styles.btnDangerGhost]} onPress={() => eraseAll(true)} testID="erase-test">
              <Ionicons name="flask-outline" size={15} color={theme.error} />
              <Text style={styles.btnDangerText}>Erase test</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnDanger]} onPress={() => eraseAll(false)} testID="erase-all">
              <Ionicons name="trash-outline" size={15} color="#fff" />
              <Text style={styles.btnSolidText}>Erase all</Text>
            </TouchableOpacity>
          </View>
        </View>

        {loading ? (
          <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
        ) : calls.length === 0 ? (
          <Text style={styles.empty}>No calls{date.trim() ? ` for ${date.trim()}` : ""}{search ? ` · #${search}` : ""}.</Text>
        ) : (
          calls.map((c) => (
            <View key={c.id} style={styles.callCard} testID={`call-${c.id}`}>
              <View style={styles.callTop}>
                <View style={styles.numBadge}><Text style={styles.numText}>#{c.call_number ?? "—"}</Text></View>
                <Text style={styles.callSvc}>{c.service.toUpperCase()}</Text>
                {c.is_test && <View style={styles.testTag}><Text style={styles.testTagText}>TEST</Text></View>}
                <View style={{ flex: 1 }} />
                <View style={[styles.statusTag, c.status === "open" && { backgroundColor: theme.primary + "22" }]}>
                  <Text style={styles.statusText}>{c.status}</Text>
                </View>
                <TouchableOpacity onPress={() => deleteOne(c)} hitSlop={8} style={styles.delBtn} testID={`call-del-${c.id}`}>
                  <Ionicons name="trash-outline" size={16} color={theme.error} />
                </TouchableOpacity>
              </View>
              <View style={styles.partyRow}>
                <View style={styles.avatar}>
                  {c.requester?.picture ? <Image source={{ uri: c.requester.picture }} style={styles.avatarImg} /> : <Text style={styles.avatarInit}>{((c.caller_name || c.requester?.name)?.[0] || "?").toUpperCase()}</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.detailName}>{c.caller_name || c.requester?.name || c.requester_id}</Text>
                  {!!c.requester?.phone && <Text style={styles.detailMuted}>📞 {c.requester.phone}</Text>}
                </View>
              </View>
              {!!c.vehicle && <Text style={styles.detail}>🚗 {c.vehicle}</Text>}
              {!!c.place_name && <Text style={styles.detail}>📍 {c.place_name}</Text>}
              <Text style={styles.detailMuted}>{c.latitude.toFixed(5)}, {c.longitude.toFixed(5)}</Text>
              {!!c.dest_name && <Text style={styles.detail}>➡️ {c.dest_name}</Text>}
              {!!c.note && <Text style={styles.detail}>📝 {c.note}</Text>}
              {(c.photos || []).length > 0 && (
                <View style={styles.photoRow}>
                  {(c.photos || []).map((p, i) => (
                    <TouchableOpacity key={i} onPress={() => setLightbox(p)}>
                      <Image source={{ uri: p }} style={styles.callPhoto} />
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              {!!c.helper && <Text style={styles.detail}>🦺 Helper: {c.helper.name}{c.helper.phone ? ` · ${c.helper.phone}` : ""}</Text>}
              <Text style={styles.detailMuted}>Created {fmt(c.created_at)}{c.accepted_at ? ` · Accepted ${fmt(c.accepted_at)}` : ""}{c.completed_at ? ` · Done ${fmt(c.completed_at)}` : ""}</Text>
              {(c.total || 0) > 0 && <Text style={styles.detailMuted}>{c.payment_method} · ${"" + c.total.toFixed(2)}{c.settled ? " · settled" : c.held ? " · held" : ""}</Text>}
            </View>
          ))
        )}
      </ScrollView>

      <Modal visible={!!lightbox} transparent animationType="fade" onRequestClose={() => setLightbox(null)}>
        <Pressable style={styles.lightbox} onPress={() => setLightbox(null)}>
          {!!lightbox && <Image source={{ uri: lightbox }} style={styles.lightboxImg} resizeMode="contain" />}
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  center: { alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 40 },
  empty: { color: theme.textMuted, fontSize: 14, textAlign: "center", paddingVertical: 20 },
  card: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 16, padding: 14, marginBottom: 14, gap: 10 },
  cardTitle: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border },
  chipOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  chipText: { color: theme.textSecondary, fontSize: 13, fontWeight: "700" },
  input: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, color: theme.textPrimary, fontSize: 14, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  // minWidth:0 lets a flexed input shrink on web (otherwise it overflows the row).
  flexInput: { flex: 1, minWidth: 0 },
  fieldLabel: { color: theme.textMuted, fontSize: 11.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4, marginTop: 2 },
  photoRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 2 },
  photoThumb: { width: 64, height: 64, borderRadius: 10, overflow: "hidden", backgroundColor: theme.surfaceAlt },
  photoX: { position: "absolute", top: 2, right: 2, width: 20, height: 20, borderRadius: 10, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center" },
  callPhoto: { width: 76, height: 76, borderRadius: 10, backgroundColor: theme.surfaceAlt },
  lightbox: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)", alignItems: "center", justifyContent: "center" },
  lightboxImg: { width: "94%", height: "80%" },
  row2: { flexDirection: "row", gap: 10 },
  btn: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 8 },
  btnSolid: { backgroundColor: theme.primary },
  btnSolidText: { color: "#fff", fontSize: 14.5, fontWeight: "800" },
  btnGhost: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border },
  btnGhostText: { color: theme.primary, fontSize: 14.5, fontWeight: "800" },
  btnDanger: { backgroundColor: theme.error },
  btnDangerGhost: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.error + "66" },
  btnDangerText: { color: theme.error, fontSize: 14.5, fontWeight: "800" },
  delBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(239,68,68,0.12)" },
  callCard: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 16, padding: 14, marginBottom: 12, gap: 6 },
  callTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  numBadge: { backgroundColor: theme.primary, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  numText: { color: "#fff", fontSize: 14, fontWeight: "900" },
  callSvc: { color: theme.textPrimary, fontSize: 13, fontWeight: "800", letterSpacing: 0.4 },
  testTag: { backgroundColor: "#F59E0B22", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  testTagText: { color: "#F59E0B", fontSize: 10, fontWeight: "900" },
  statusTag: { backgroundColor: theme.surfaceAlt, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { color: theme.textSecondary, fontSize: 11, fontWeight: "800", textTransform: "uppercase" },
  partyRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 2 },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontSize: 14, fontWeight: "800" },
  detailName: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  detail: { color: theme.textSecondary, fontSize: 13, lineHeight: 18 },
  detailMuted: { color: theme.textMuted, fontSize: 12, lineHeight: 17 },
});
