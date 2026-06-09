import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator, Alert, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, Badge } from "@/src/api/client";
import { theme } from "@/src/theme";
import { useConfirm } from "@/src/context/ConfirmContext";
import UserBadges from "@/src/components/UserBadges";

const COLORS = ["#3B82F6", "#22C55E", "#EAB308", "#EF4444", "#A855F7", "#EC4899", "#F97316", "#14B8A6"];

export default function AdminBadgesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const confirm = useConfirm();
  const [badges, setBadges] = useState<Badge[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [icon, setIcon] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setBadges(await api.listBadges()); } catch {} finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const create = async () => {
    if (!label.trim() || !icon.trim()) { Alert.alert("Missing", "Add a label and an emoji (or image URL)."); return; }
    setBusy(true);
    try {
      await api.adminCreateBadge({ label: label.trim(), icon: icon.trim(), color });
      setLabel(""); setIcon(""); setColor(COLORS[0]);
      await load();
    } catch (e: any) { Alert.alert("Couldn't create", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setBusy(false); }
  };

  const remove = async (b: Badge) => {
    const ok = await confirm({ title: "Delete badge?", message: `Remove "${b.label}" from everyone who has it?`, confirmLabel: "Delete", cancelLabel: "Keep", destructive: true });
    if (!ok) return;
    try { await api.adminDeleteBadge(b.id); await load(); }
    catch (e: any) { Alert.alert("Couldn't delete", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="admin-badges-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="badges-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Custom badges</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
          <Text style={styles.section}>New badge</Text>
          <View style={styles.card}>
            <TextInput style={styles.input} value={label} onChangeText={setLabel} placeholder="Label (e.g. Founder, Staff, VIP)" placeholderTextColor={theme.textMuted} maxLength={40} testID="badge-label" />
            <TextInput style={styles.input} value={icon} onChangeText={setIcon} placeholder="Emoji (e.g. 🏆) or image URL" placeholderTextColor={theme.textMuted} testID="badge-icon" />
            <Text style={styles.colorLabel}>Color (for emoji badges)</Text>
            <View style={styles.colorRow}>
              {COLORS.map((c) => (
                <TouchableOpacity key={c} onPress={() => setColor(c)} style={[styles.colorDot, { backgroundColor: c }, color === c && styles.colorDotOn]} testID={`badge-color-${c}`} />
              ))}
            </View>
            <View style={styles.previewRow}>
              <Text style={styles.previewLabel}>Preview:</Text>
              <Text style={styles.previewName}>Name</Text>
              <UserBadges badges={icon ? [{ id: "preview", icon, color, label }] : []} size={18} />
            </View>
            <TouchableOpacity style={[styles.createBtn, busy && { opacity: 0.6 }]} onPress={create} disabled={busy} testID="badge-create">
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.createText}>Create badge</Text>}
            </TouchableOpacity>
          </View>

          <Text style={styles.section}>All badges</Text>
          {badges.length === 0 ? (
            <Text style={styles.empty}>No badges yet. Create one above, then assign it from Admin → Users.</Text>
          ) : badges.map((b) => (
            <View key={b.id} style={styles.badgeRow}>
              <UserBadges badges={[b]} size={20} />
              <Text style={styles.badgeName} numberOfLines={1}>{b.label || "(no label)"}</Text>
              <TouchableOpacity onPress={() => remove(b)} testID={`badge-del-${b.id}`}>
                <Ionicons name="trash-outline" size={18} color={theme.error} />
              </TouchableOpacity>
            </View>
          ))}
          <Text style={styles.hint}>Assign a badge to a user from Admin → Users → tap a user → "Badges…". Badges show next to their name everywhere, like the verified check.</Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  section: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 18, marginBottom: 10 },
  card: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 14, gap: 10 },
  input: { color: theme.textPrimary, fontSize: 15, backgroundColor: theme.bg, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, paddingVertical: 12, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  colorLabel: { color: theme.textMuted, fontSize: 12, fontWeight: "700", marginTop: 2 },
  colorRow: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  colorDot: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: "transparent" },
  colorDotOn: { borderColor: "#fff" },
  previewRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  previewLabel: { color: theme.textMuted, fontSize: 12.5 },
  previewName: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  createBtn: { backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 4 },
  createText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  empty: { color: theme.textMuted, fontSize: 13, lineHeight: 19 },
  badgeRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  badgeName: { flex: 1, color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  hint: { color: theme.textMuted, fontSize: 12, lineHeight: 17, marginTop: 18 },
});
