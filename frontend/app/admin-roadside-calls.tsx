import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, Alert, Platform, Image,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, RoadsideRequest } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
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
  const [note, setNote] = useState("");
  const [place, setPlace] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const num = search.trim() ? Number(search.trim()) : undefined;
      setCalls(await api.adminListRoadsideCalls({ date: date.trim() || undefined, call_number: Number.isFinite(num) ? num : undefined }));
    } catch (e: any) {
      Alert.alert("Couldn't load calls", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setLoading(false); }
  }, [date, search]);

  useFocusEffect(useCallback(() => { if (isAdmin) load(); }, [load, isAdmin]));

  const create = async (isTest: boolean) => {
    setCreating(true);
    try {
      const c = await api.adminCreateRoadsideCall({
        service: svc,
        longitude: lng.trim() ? Number(lng) : DEFAULT_LNG,
        latitude: lat.trim() ? Number(lat) : DEFAULT_LAT,
        place_name: place.trim() || undefined,
        note: note.trim() || undefined,
        is_test: isTest,
      });
      setNote(""); setPlace("");
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
          <TextInput style={styles.input} value={place} onChangeText={setPlace} placeholder="Place / address (optional)" placeholderTextColor={theme.textMuted} />
          <TextInput style={styles.input} value={note} onChangeText={setNote} placeholder="Note (optional)" placeholderTextColor={theme.textMuted} />
          <View style={styles.row2}>
            <TextInput style={[styles.input, { flex: 1 }]} value={lat} onChangeText={setLat} placeholder="Lat (optional)" placeholderTextColor={theme.textMuted} keyboardType="numbers-and-punctuation" />
            <TextInput style={[styles.input, { flex: 1 }]} value={lng} onChangeText={setLng} placeholder="Lng (optional)" placeholderTextColor={theme.textMuted} keyboardType="numbers-and-punctuation" />
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
            <TextInput style={[styles.input, { flex: 1 }]} value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={theme.textMuted} autoCapitalize="none" />
            <TextInput style={[styles.input, { width: 120 }]} value={search} onChangeText={setSearch} placeholder="Call #" placeholderTextColor={theme.textMuted} keyboardType="number-pad" testID="call-search" />
          </View>
          <TouchableOpacity style={[styles.btn, styles.btnSolid]} onPress={load} testID="call-search-go">
            <Ionicons name="search" size={16} color="#fff" />
            <Text style={styles.btnSolidText}>Search</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
        ) : calls.length === 0 ? (
          <Text style={styles.empty}>No calls for {date || "today"}{search ? ` · #${search}` : ""}.</Text>
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
              </View>
              <View style={styles.partyRow}>
                <View style={styles.avatar}>
                  {c.requester?.picture ? <Image source={{ uri: c.requester.picture }} style={styles.avatarImg} /> : <Text style={styles.avatarInit}>{(c.requester?.name?.[0] || "?").toUpperCase()}</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.detailName}>{c.requester?.name || c.requester_id}</Text>
                  {!!c.requester?.phone && <Text style={styles.detailMuted}>📞 {c.requester.phone}</Text>}
                </View>
              </View>
              {!!c.vehicle && <Text style={styles.detail}>🚗 {c.vehicle}</Text>}
              {!!c.place_name && <Text style={styles.detail}>📍 {c.place_name}</Text>}
              <Text style={styles.detailMuted}>{c.latitude.toFixed(5)}, {c.longitude.toFixed(5)}</Text>
              {!!c.dest_name && <Text style={styles.detail}>➡️ {c.dest_name}</Text>}
              {!!c.note && <Text style={styles.detail}>📝 {c.note}</Text>}
              {!!c.helper && <Text style={styles.detail}>🦺 Helper: {c.helper.name}{c.helper.phone ? ` · ${c.helper.phone}` : ""}</Text>}
              <Text style={styles.detailMuted}>Created {fmt(c.created_at)}{c.accepted_at ? ` · Accepted ${fmt(c.accepted_at)}` : ""}{c.completed_at ? ` · Done ${fmt(c.completed_at)}` : ""}</Text>
              {(c.total || 0) > 0 && <Text style={styles.detailMuted}>{c.payment_method} · ${"" + c.total.toFixed(2)}{c.settled ? " · settled" : c.held ? " · held" : ""}</Text>}
            </View>
          ))
        )}
      </ScrollView>
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
  row2: { flexDirection: "row", gap: 10 },
  btn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 12, paddingVertical: 12 },
  btnSolid: { backgroundColor: theme.primary },
  btnSolidText: { color: "#fff", fontSize: 14.5, fontWeight: "800" },
  btnGhost: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border },
  btnGhostText: { color: theme.primary, fontSize: 14.5, fontWeight: "800" },
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
