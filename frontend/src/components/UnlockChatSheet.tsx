import React, { useEffect, useState } from "react";
import {
  View, Text, StyleSheet, Modal, TextInput, TouchableOpacity, ActivityIndicator, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { restoreKey, hasBackup } from "@/src/utils/e2e";
import { theme } from "@/src/theme";

const webInput = Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {};

/**
 * Enter your PIN to unlock the whole chat. Restores the E2E key from the PIN
 * backup and installs it on this device, then onUnlocked() re-runs decryption so
 * every message becomes readable — no need to leave the chat. Used when the
 * device key is missing (new device, or browser site-data was cleared).
 */
export default function UnlockChatSheet({
  visible, onClose, onUnlocked,
}: { visible: boolean; onClose: () => void; onUnlocked: () => void }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setPin(""); setErr(null); setBackup(null);
    hasBackup().then(setBackup).catch(() => setBackup(false));
  }, [visible]);

  const onlyDigits = (t: string) => t.replace(/[^0-9]/g, "").slice(0, 6);

  const unlock = async () => {
    if (!/^\d{4,6}$/.test(pin)) { setErr("Enter your 4–6 digit PIN."); return; }
    setBusy(true); setErr(null);
    try {
      await restoreKey(pin);
      onUnlocked();
      onClose();
    } catch (e: any) {
      const m = String(e?.message || e);
      setErr(/no backup/i.test(m)
        ? "No PIN backup was found for your account."
        : "That PIN didn't match your backup. Try again.");
      if (/no backup/i.test(m)) setBackup(false);
    } finally { setBusy(false); }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 18 }]} testID="unlock-chat-sheet">
          <View style={styles.handle} />
          <View style={styles.iconWrap}><Ionicons name="lock-closed" size={26} color={theme.primary} /></View>
          <Text style={styles.title}>Unlock your messages</Text>

          {backup === false ? (
            <>
              <Text style={styles.body}>
                No PIN backup was found for your account, so the encrypted messages already on this device can't be unlocked. Set a PIN now to protect your messages from here on.
              </Text>
              <TouchableOpacity style={styles.btn} onPress={() => { onClose(); router.push("/encryption-key"); }} testID="unlock-setup">
                <Text style={styles.btnText}>Set up a PIN</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.body}>Enter your PIN to decrypt this chat on this device.</Text>
              <TextInput
                style={[styles.input, webInput]}
                value={pin}
                onChangeText={(t) => setPin(onlyDigits(t))}
                placeholder="4–6 digit PIN"
                placeholderTextColor={theme.textMuted}
                secureTextEntry
                keyboardType="number-pad"
                maxLength={6}
                autoFocus
                onSubmitEditing={unlock}
                testID="unlock-pin"
              />
              {!!err && <Text style={styles.err}>{err}</Text>}
              <TouchableOpacity style={[styles.btn, busy && { opacity: 0.6 }]} onPress={unlock} disabled={busy} testID="unlock-submit">
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Unlock</Text>}
              </TouchableOpacity>
              <Text style={styles.hint}>Restores your encryption key from your PIN backup and decrypts every message in your chats.</Text>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: theme.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, borderColor: theme.border, paddingTop: 10, paddingHorizontal: 18 },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 14 },
  iconWrap: { alignSelf: "center", width: 52, height: 52, borderRadius: 26, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, alignItems: "center", justifyContent: "center", marginBottom: 10 },
  title: { color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center", marginBottom: 8 },
  body: { color: theme.textSecondary, fontSize: 13.5, lineHeight: 19, textAlign: "center", marginBottom: 14 },
  input: { backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, height: 50, color: theme.textPrimary, fontSize: 17, letterSpacing: 4, textAlign: "center", marginBottom: 10 },
  err: { color: theme.error, fontSize: 13, textAlign: "center", marginBottom: 8 },
  btn: { backgroundColor: theme.primary, borderRadius: 14, height: 52, alignItems: "center", justifyContent: "center", marginTop: 2 },
  btnText: { color: "#fff", fontSize: 15.5, fontWeight: "800" },
  hint: { color: theme.textMuted, fontSize: 11.5, lineHeight: 16, textAlign: "center", marginTop: 12 },
});
