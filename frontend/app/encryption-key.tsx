import React, { useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { backupKey, restoreKey, hasBackup } from "@/src/utils/e2e";
import { theme } from "@/src/theme";

const webInput = Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {};

export default function EncryptionKeyScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [backupExists, setBackupExists] = useState<boolean | null>(null);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [restorePass, setRestorePass] = useState("");
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { hasBackup().then(setBackupExists).catch(() => setBackupExists(false)); }, []);

  const onlyDigits = (t: string) => t.replace(/[^0-9]/g, "").slice(0, 6);

  const doBackup = async () => {
    if (!/^\d{4,6}$/.test(pass)) { setMsg({ ok: false, text: "Choose a 4–6 digit PIN." }); return; }
    if (pass !== pass2) { setMsg({ ok: false, text: "PINs don't match." }); return; }
    setBusy("backup"); setMsg(null);
    try {
      await backupKey(pass);
      setBackupExists(true); setPass(""); setPass2("");
      setMsg({ ok: true, text: "Backup saved. Remember your PIN — it can't be recovered." });
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e).replace(/^\d{3}:\s*/, "") || "Backup failed." });
    } finally { setBusy(null); }
  };

  const doRestore = async () => {
    if (!/^\d{4,6}$/.test(restorePass)) { setMsg({ ok: false, text: "Enter your 4–6 digit PIN." }); return; }
    setBusy("restore"); setMsg(null);
    try {
      const ok = await restoreKey(restorePass);
      setRestorePass("");
      if (ok) setMsg({ ok: true, text: "Key restored on this device. Your encrypted chats will decrypt now." });
      else setMsg({ ok: false, text: "That PIN didn't match the backup. Try again." });
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e).replace(/^\d{3}:\s*/, "") || "Couldn't restore." });
    } finally { setBusy(null); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="encryption-key-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="enc-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Encryption key</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
        <View style={styles.intro}>
          <Ionicons name="key" size={18} color={theme.primary} />
          <Text style={styles.introText}>
            Your messages are end-to-end encrypted with a key stored only on this device. Back it up with a 4–6 digit PIN so you can restore your chats on a new device. We never see your PIN or your key.
          </Text>
        </View>

        <Text style={styles.section}>Back up your key</Text>
        {backupExists && (
          <View style={styles.statusRow}>
            <Ionicons name="checkmark-circle" size={16} color="#22C55E" />
            <Text style={styles.statusText}>A backup already exists. Saving again replaces it.</Text>
          </View>
        )}
        <TextInput style={styles.input} value={pass} onChangeText={(t) => setPass(onlyDigits(t))} placeholder="Choose a 4–6 digit PIN" placeholderTextColor={theme.textMuted} secureTextEntry keyboardType="number-pad" maxLength={6} testID="enc-pass" />
        <TextInput style={styles.input} value={pass2} onChangeText={(t) => setPass2(onlyDigits(t))} placeholder="Confirm PIN" placeholderTextColor={theme.textMuted} secureTextEntry keyboardType="number-pad" maxLength={6} testID="enc-pass2" />
        <TouchableOpacity style={[styles.btn, busy === "backup" && { opacity: 0.6 }]} onPress={doBackup} disabled={busy !== null} testID="enc-backup">
          {busy === "backup" ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Back up key</Text>}
        </TouchableOpacity>

        <Text style={styles.section}>Restore on this device</Text>
        <Text style={styles.note}>Enter the PIN you used when backing up. This replaces this device's key.</Text>
        <TextInput style={styles.input} value={restorePass} onChangeText={(t) => setRestorePass(onlyDigits(t))} placeholder="Your 4–6 digit PIN" placeholderTextColor={theme.textMuted} secureTextEntry keyboardType="number-pad" maxLength={6} testID="enc-restore-pass" />
        <TouchableOpacity style={[styles.btn, styles.btnGhost, busy === "restore" && { opacity: 0.6 }]} onPress={doRestore} disabled={busy !== null} testID="enc-restore">
          {busy === "restore" ? <ActivityIndicator color={theme.primary} /> : <Text style={[styles.btnText, { color: theme.primary }]}>Restore key</Text>}
        </TouchableOpacity>

        {msg && <Text style={[styles.msg, { color: msg.ok ? "#22C55E" : theme.error }]}>{msg.text}</Text>}

        <Text style={styles.warn}>If you forget your PIN and lose this device, end-to-end encrypted messages can't be recovered — that's what keeps them private.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  intro: { flexDirection: "row", alignItems: "flex-start", gap: 12, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 14 },
  introText: { flex: 1, color: theme.textSecondary, fontSize: 12.5, lineHeight: 18 },
  section: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 24, marginBottom: 10 },
  note: { color: theme.textMuted, fontSize: 12.5, lineHeight: 18, marginTop: -4, marginBottom: 10 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 10 },
  statusText: { color: theme.textSecondary, fontSize: 12.5 },
  input: { backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, height: 50, color: theme.textPrimary, fontSize: 15, marginBottom: 10, ...webInput },
  btn: { backgroundColor: theme.primary, borderRadius: 14, height: 52, alignItems: "center", justifyContent: "center", marginTop: 4 },
  btnGhost: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  msg: { fontSize: 13, fontWeight: "600", marginTop: 16, textAlign: "center", lineHeight: 19 },
  warn: { color: theme.textMuted, fontSize: 12, lineHeight: 18, marginTop: 24, textAlign: "center" },
});
