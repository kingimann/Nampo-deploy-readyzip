import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator, Image, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, PublicUser } from "@/src/api/client";
import { theme } from "@/src/theme";

const webInput = Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {};
// Keep only digits + a single dot + 2 decimals, so a malformed (or QR-supplied)
// value like "1.2.3" / "1e9" can't seed the amount field.
function cleanAmount(s?: string): string {
  let t = (s || "").replace(/[^0-9.]/g, "");
  const i = t.indexOf(".");
  if (i >= 0) t = t.slice(0, i + 1) + t.slice(i + 1).replace(/\./g, "");
  const m = t.match(/^(\d*)(\.\d{0,2})?/);
  return m ? m[1] + (m[2] || "") : "";
}
const MAX_PAY = 100000;

export default function PayScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id, amount: amtParam, note: noteParam } = useLocalSearchParams<{ id: string; amount?: string; note?: string }>();
  const [target, setTarget] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [security, setSecurity] = useState<{ is_set: boolean; question?: string | null } | null>(null);
  const [amount, setAmount] = useState(cleanAmount(amtParam));
  const [note, setNote] = useState((noteParam || "").slice(0, 200));
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [u, s] = await Promise.all([api.getPublicUser(id), api.getMoneySecurity().catch(() => null)]);
      setTarget(u); setSecurity(s as any);
    } catch (e: any) { setMsg({ ok: false, text: "Couldn't find that person." }); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const pay = async () => {
    if (!target || busy) return;
    const amt = Number(amount) || 0;
    if (!isFinite(amt) || amt <= 0) { setMsg({ ok: false, text: "Enter an amount." }); return; }
    if (amt > MAX_PAY) { setMsg({ ok: false, text: `Amount can't exceed $${MAX_PAY.toLocaleString()}.` }); return; }
    if (!security?.is_set) { setMsg({ ok: false, text: "Set up your transfer security question in Money first." }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.sendMoney({ to_user_id: target.user_id, amount: amt, note, answer });
      setMsg({ ok: true, text: `Sent $${amt.toFixed(2)} to ${target.name}. They'll get a notification to accept it.` });
      setTimeout(() => { if (router.canGoBack()) safeBack(); else router.replace("/money"); }, 1400);
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e).replace(/^\d{3}:\s*/, "") || "Payment failed." });
    } finally { setBusy(false); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="pay-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => { if (router.canGoBack()) safeBack(); else router.replace("/money"); }} style={styles.iconBtn} testID="pay-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Pay</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : !target ? (
        <View style={styles.center}><Text style={styles.err}>{msg?.text || "User not found."}</Text></View>
      ) : (
        <View style={{ padding: 16, paddingBottom: insets.bottom + 20 }}>
          <View style={styles.who}>
            <View style={styles.avatar}>{target.picture ? <Image source={{ uri: target.picture }} style={styles.avatarImg} /> : <Text style={styles.avatarInit}>{(target.name?.[0] || "?").toUpperCase()}</Text>}</View>
            <Text style={styles.name}>{target.name}</Text>
            {!!target.username && <Text style={styles.handle}>@{target.username}</Text>}
          </View>

          <View style={styles.amtWrap}>
            <Text style={styles.dollar}>$</Text>
            <TextInput style={styles.amtInput} value={amount} onChangeText={(t) => setAmount(cleanAmount(t))} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.textMuted} autoFocus testID="pay-amount" />
          </View>
          <TextInput style={styles.noteInput} value={note} onChangeText={setNote} placeholder="What's it for? (optional)" placeholderTextColor={theme.textMuted} testID="pay-note" />

          {security?.is_set ? (
            <>
              <Text style={styles.qLabel}>{security.question}</Text>
              <TextInput style={styles.input} value={answer} onChangeText={setAnswer} placeholder="Your security answer" placeholderTextColor={theme.textMuted} secureTextEntry testID="pay-answer" />
            </>
          ) : (
            <Text style={styles.warn}>Set up your transfer security question in Money before sending.</Text>
          )}

          {msg && <Text style={[styles.msg, { color: msg.ok ? "#22C55E" : theme.error }]}>{msg.text}</Text>}

          <TouchableOpacity style={[styles.payBtn, busy && { opacity: 0.6 }]} onPress={pay} disabled={busy} testID="pay-submit">
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.payBtnText}>Pay {amount ? `$${(Number(amount) || 0).toFixed(2)}` : ""}</Text>}
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 30 },
  err: { color: theme.textMuted, fontSize: 14 },
  who: { alignItems: "center", marginBottom: 18 },
  avatar: { width: 72, height: 72, borderRadius: 36, overflow: "hidden", backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontSize: 28, fontWeight: "800" },
  name: { color: theme.textPrimary, fontSize: 20, fontWeight: "800", marginTop: 10 },
  handle: { color: theme.primary, fontSize: 14, fontWeight: "700", marginTop: 2 },
  amtWrap: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 16, height: 60 },
  dollar: { color: theme.textPrimary, fontSize: 26, fontWeight: "900" },
  amtInput: { flex: 1, color: theme.textPrimary, fontSize: 26, fontWeight: "800", ...webInput },
  noteInput: { backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, height: 48, color: theme.textPrimary, fontSize: 14, marginTop: 10, ...webInput },
  qLabel: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "700", marginTop: 14, marginBottom: 6 },
  input: { backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, height: 48, color: theme.textPrimary, fontSize: 15, ...webInput },
  warn: { color: "#F59E0B", fontSize: 12.5, marginTop: 14, lineHeight: 18 },
  msg: { fontSize: 13, fontWeight: "600", marginTop: 14, textAlign: "center", lineHeight: 19 },
  payBtn: { backgroundColor: theme.primary, borderRadius: 14, height: 52, alignItems: "center", justifyContent: "center", marginTop: 18 },
  payBtnText: { color: "#fff", fontSize: 16, fontWeight: "800" },
});
