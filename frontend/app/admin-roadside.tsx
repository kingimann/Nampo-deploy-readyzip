import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Image,
  Modal, Pressable, Alert, Platform, TextInput, KeyboardAvoidingView,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, RoadsideAdminVerification } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

export default function AdminRoadsideScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const isStaff = user?.role === "admin" || user?.role === "mod";
  const [items, setItems] = useState<RoadsideAdminVerification[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<RoadsideAdminVerification | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try { setItems(await api.adminRoadsideVerifications("pending")); } catch {} finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { if (isStaff) load(); }, [load, isStaff]));
  useEffect(() => { if (user && !isStaff) router.replace("/"); }, [user, isStaff, router]);

  const decide = async (v: RoadsideAdminVerification, approve: boolean, why?: string) => {
    setBusyId(v.id);
    try {
      await api.decideRoadsideVerification(v.id, approve, why);
      setItems((arr) => arr.filter((x) => x.id !== v.id));
      setRejecting(null); setReason("");
    } catch (e: any) {
      Alert.alert("Couldn't save", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setBusyId(null); }
  };

  if (!isStaff) {
    return (
      <SafeAreaView edges={["top"]} style={styles.root}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.center}>
          {user == null ? <ActivityIndicator color={theme.primary} /> : (
            <>
              <Ionicons name="lock-closed-outline" size={34} color={theme.textMuted} />
              <Text style={styles.empty}>Admins and moderators only.</Text>
            </>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="admin-roadside-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack("/settings")} style={styles.iconBtn}><Ionicons name="chevron-back" size={24} color={theme.textPrimary} /></TouchableOpacity>
        <Text style={styles.title}>Roadside verifications</Text>
        {user?.role === "admin" ? (
          <TouchableOpacity onPress={() => router.push("/admin-roadside-calls")} style={styles.iconBtn} testID="open-roadside-calls">
            <Ionicons name="call-outline" size={20} color={theme.primary} />
          </TouchableOpacity>
        ) : <View style={{ width: 40 }} />}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}>
          <Text style={styles.note}>These reach manual review only when the AI verifier is unavailable. Approving sets the member as roadside-verified; the documents are deleted on decision.</Text>
          {items.length === 0 ? (
            <View style={styles.center}><Ionicons name="checkmark-done-outline" size={38} color={theme.textMuted} /><Text style={styles.empty}>Nothing waiting for review.</Text></View>
          ) : items.map((v) => (
            <View key={v.id} style={styles.card}>
              <View style={styles.userRow}>
                <View style={styles.avatar}>
                  {v.user.picture ? <Image source={{ uri: v.user.picture }} style={styles.avatarImg} /> : <Text style={styles.avatarInit}>{(v.user.name?.[0] || "?").toUpperCase()}</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name} numberOfLines={1}>{v.user.name}</Text>
                  <Text style={styles.meta} numberOfLines={1}>{v.user.email || v.user_id}</Text>
                </View>
              </View>
              {!!v.vehicle && <Text style={styles.vehicle}>🚗 {v.vehicle}</Text>}
              {!!v.note && <Text style={styles.meta}>{v.note}</Text>}
              <View style={styles.docRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.docCap}>Insurance</Text>
                  {v.insurance_photo
                    ? <TouchableOpacity onPress={() => setLightbox(v.insurance_photo!)}><Image source={{ uri: v.insurance_photo }} style={styles.doc} /></TouchableOpacity>
                    : <View style={[styles.doc, styles.docMissing]}><Text style={styles.meta}>—</Text></View>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.docCap}>Ownership</Text>
                  {v.ownership_photo
                    ? <TouchableOpacity onPress={() => setLightbox(v.ownership_photo!)}><Image source={{ uri: v.ownership_photo }} style={styles.doc} /></TouchableOpacity>
                    : <View style={[styles.doc, styles.docMissing]}><Text style={styles.meta}>—</Text></View>}
                </View>
              </View>
              <View style={styles.actions}>
                <TouchableOpacity style={[styles.btn, styles.reject]} onPress={() => { setRejecting(v); setReason(""); }} disabled={busyId === v.id}>
                  <Text style={styles.rejectText}>Reject</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, styles.approve]} onPress={() => decide(v, true)} disabled={busyId === v.id}>
                  <Text style={styles.approveText}>{busyId === v.id ? "…" : "Approve"}</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      <Modal visible={!!lightbox} transparent animationType="fade" onRequestClose={() => setLightbox(null)}>
        <Pressable style={styles.lightbox} onPress={() => setLightbox(null)}>
          {!!lightbox && <Image source={{ uri: lightbox }} style={styles.lightboxImg} resizeMode="contain" />}
        </Pressable>
      </Modal>

      <Modal visible={!!rejecting} transparent animationType="fade" onRequestClose={() => setRejecting(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.rejectBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setRejecting(null)} />
          <View style={styles.rejectCard}>
            <Text style={styles.rejectTitle}>Reject verification</Text>
            <TextInput
              style={styles.rejectInput} value={reason} onChangeText={setReason} multiline
              placeholder="Reason (shown to the member)" placeholderTextColor={theme.textMuted}
            />
            <View style={styles.actions}>
              <TouchableOpacity style={[styles.btn, styles.reject]} onPress={() => setRejecting(null)}><Text style={styles.rejectText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.btn, styles.approve, { backgroundColor: theme.error }]} onPress={() => rejecting && decide(rejecting, false, reason.trim() || undefined)}>
                <Text style={styles.approveText}>Reject</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 50 },
  empty: { color: theme.textMuted, fontSize: 14 },
  note: { color: theme.textMuted, fontSize: 12.5, lineHeight: 18, marginBottom: 14 },
  card: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 16, padding: 14, marginBottom: 14, gap: 8 },
  userRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontSize: 16, fontWeight: "800" },
  name: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  meta: { color: theme.textMuted, fontSize: 12.5, marginTop: 1 },
  vehicle: { color: theme.textSecondary, fontSize: 13.5, fontWeight: "600" },
  docRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  docCap: { color: theme.textMuted, fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 5 },
  doc: { width: "100%", height: 120, borderRadius: 10, backgroundColor: theme.surfaceAlt },
  docMissing: { alignItems: "center", justifyContent: "center" },
  actions: { flexDirection: "row", gap: 10, marginTop: 6 },
  btn: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  approve: { backgroundColor: theme.primary },
  approveText: { color: "#fff", fontSize: 14.5, fontWeight: "800" },
  reject: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border },
  rejectText: { color: theme.textSecondary, fontSize: 14.5, fontWeight: "800" },
  lightbox: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)", alignItems: "center", justifyContent: "center" },
  lightboxImg: { width: "94%", height: "80%" },
  rejectBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", paddingHorizontal: 24 },
  rejectCard: { backgroundColor: theme.surface, borderRadius: 18, borderWidth: 1, borderColor: theme.border, padding: 18 },
  rejectTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "800", marginBottom: 12 },
  rejectInput: { color: theme.textPrimary, fontSize: 14.5, minHeight: 80, backgroundColor: theme.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: theme.border, padding: 12, textAlignVertical: "top", ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
});
