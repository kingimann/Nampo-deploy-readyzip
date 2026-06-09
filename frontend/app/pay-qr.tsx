import React, { useMemo, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, Image, Platform, Share, ScrollView,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "@/src/platform/linear-gradient";
import * as Clipboard from "@/src/platform/clipboard";
import { Stack, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import QrCode from "@/src/components/QrCode";

const webInput = Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {};
const WEB_ORIGIN =
  Platform.OS === "web" && typeof window !== "undefined" ? window.location.origin : "https://nampo-web.onrender.com";

export default function PayQRScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);

  const payLink = useMemo(() => {
    if (!user) return "";
    const params = new URLSearchParams();
    if (Number(amount) > 0) params.set("amount", String(Number(amount)));
    if (note.trim()) params.set("note", note.trim());
    const qs = params.toString();
    return `${WEB_ORIGIN}/pay/${user.user_id}${qs ? `?${qs}` : ""}`;
  }, [user, amount, note]);

  // Rendered fully on-device (no external service). Any avatar — including an
  // uploaded photo (data URI) — can sit in the centre since we draw it ourselves.

  const copy = async () => { try { await Clipboard.setStringAsync(payLink); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {} };
  const share = async () => { try { await Share.share({ message: `Pay me on OkaySpace: ${payLink}` }); } catch {} };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="pay-qr-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="qr-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>My pay code</Text>
        <TouchableOpacity onPress={() => router.push("/pay-scan")} style={styles.iconBtn} testID="qr-scan">
          <Ionicons name="scan" size={22} color={theme.textPrimary} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30, alignItems: "center" }} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <LinearGradient
            colors={[theme.primaryHover, theme.primary]}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={styles.cardHead}
          >
            <View style={styles.brandRow}>
              <Ionicons name="leaf" size={15} color="#fff" />
              <Text style={styles.brandText}>OkaySpace · Pay</Text>
            </View>
            <View style={styles.avatarRing}>
              {user?.picture ? (
                <Image source={{ uri: user.picture }} style={styles.headAvatar} />
              ) : (
                <Ionicons name="person" size={26} color="#fff" />
              )}
            </View>
            <Text style={styles.name}>{user?.name}</Text>
            {!!user?.username && <Text style={styles.handle}>@{user.username}</Text>}
          </LinearGradient>

          <View style={styles.qrWrap}>
            <QrCode value={payLink} size={232} dark="#075E54" light="#ffffff" logo={user?.picture || undefined} />
          </View>

          {Number(amount) > 0 ? (
            <View style={styles.amountTag}><Text style={styles.amountTagText}>Requesting ${Number(amount).toFixed(2)}</Text></View>
          ) : null}
          <Text style={styles.scanLine}>Scan with any camera to pay</Text>
        </View>

        <Text style={styles.hint}>Have someone scan this with their camera to pay you.</Text>

        <View style={styles.fields}>
          <Text style={styles.label}>Request a specific amount (optional)</Text>
          <View style={styles.amtWrap}>
            <Text style={styles.dollar}>$</Text>
            <TextInput style={styles.amtInput} value={amount} onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ""))} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.textMuted} testID="qr-amount" />
          </View>
          <TextInput style={styles.noteInput} value={note} onChangeText={setNote} placeholder="Note (optional)" placeholderTextColor={theme.textMuted} testID="qr-note" />
        </View>

        <View style={styles.actions}>
          <TouchableOpacity style={styles.actBtn} onPress={copy} testID="qr-copy">
            <Ionicons name={copied ? "checkmark" : "copy-outline"} size={16} color={theme.primary} />
            <Text style={styles.actText}>{copied ? "Copied" : "Copy link"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actBtn, styles.actPrimary]} onPress={share} testID="qr-share">
            <Ionicons name="share-outline" size={16} color="#fff" />
            <Text style={[styles.actText, { color: "#fff" }]}>Share</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  card: { backgroundColor: "#fff", borderRadius: 24, alignItems: "center", marginTop: 8, width: 320, maxWidth: "100%", overflow: "hidden", shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
  cardHead: { alignSelf: "stretch", alignItems: "center", paddingTop: 16, paddingBottom: 22, gap: 2 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 8 },
  brandText: { color: "#fff", fontSize: 12.5, fontWeight: "900", letterSpacing: 0.4, textTransform: "uppercase" },
  avatarRing: { width: 64, height: 64, borderRadius: 32, backgroundColor: "rgba(255,255,255,0.2)", borderWidth: 3, borderColor: "#fff", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  headAvatar: { width: "100%", height: "100%" },
  name: { color: "#fff", fontSize: 18, fontWeight: "900", marginTop: 8 },
  handle: { color: "rgba(255,255,255,0.92)", fontSize: 13, fontWeight: "700" },
  qrWrap: { backgroundColor: "#fff", padding: 16, borderRadius: 20, marginTop: -10, borderWidth: 1, borderColor: "#eef1f0" },
  qr: { width: 232, height: 232 },
  amountTag: { backgroundColor: "#E7F7F1", borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6, marginTop: 12 },
  amountTagText: { color: "#075E54", fontSize: 14, fontWeight: "800" },
  scanLine: { color: "#7a8a85", fontSize: 12.5, fontWeight: "600", marginTop: 10, marginBottom: 18 },
  hint: { color: theme.textMuted, fontSize: 13, textAlign: "center", marginTop: 14, paddingHorizontal: 20 },
  fields: { width: "100%", maxWidth: 420, marginTop: 18 },
  label: { color: theme.textMuted, fontSize: 12, fontWeight: "700", marginBottom: 8 },
  amtWrap: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, height: 52 },
  dollar: { color: theme.textPrimary, fontSize: 20, fontWeight: "900" },
  amtInput: { flex: 1, color: theme.textPrimary, fontSize: 20, fontWeight: "800", ...webInput },
  noteInput: { backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, height: 46, color: theme.textPrimary, fontSize: 14, marginTop: 10, ...webInput },
  actions: { flexDirection: "row", gap: 10, marginTop: 18, width: "100%", maxWidth: 420 },
  actBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, height: 48, borderRadius: 12, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  actPrimary: { backgroundColor: theme.primary, borderColor: theme.primary },
  actText: { color: theme.primary, fontSize: 14, fontWeight: "800" },
});
