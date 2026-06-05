import React, { useMemo, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, Image, Platform, Share, ScrollView,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { Stack, useRouter } from "expo-router";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

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

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=10&data=${encodeURIComponent(payLink)}`;

  const copy = async () => { try { await Clipboard.setStringAsync(payLink); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {} };
  const share = async () => { try { await Share.share({ message: `Pay me on Nami: ${payLink}` }); } catch {} };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="pay-qr-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="qr-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>My pay code</Text>
        <TouchableOpacity onPress={() => router.push("/pay-scan")} style={styles.iconBtn} testID="qr-scan">
          <Ionicons name="scan" size={22} color={theme.textPrimary} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30, alignItems: "center" }}>
        <View style={styles.card}>
          <Image source={{ uri: qrUrl }} style={styles.qr} resizeMode="contain" />
          <Text style={styles.name}>{user?.name}</Text>
          {!!user?.username && <Text style={styles.handle}>@{user.username}</Text>}
          {Number(amount) > 0 && <Text style={styles.amountTag}>Requesting ${Number(amount).toFixed(2)}</Text>}
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
  card: { backgroundColor: "#fff", borderRadius: 24, padding: 20, alignItems: "center", gap: 4, marginTop: 8, width: 320, maxWidth: "100%" },
  qr: { width: 240, height: 240 },
  name: { color: "#0b0b0c", fontSize: 18, fontWeight: "800", marginTop: 8 },
  handle: { color: "#1f8f6b", fontSize: 13, fontWeight: "700" },
  amountTag: { color: "#0b0b0c", fontSize: 14, fontWeight: "800", marginTop: 4 },
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
