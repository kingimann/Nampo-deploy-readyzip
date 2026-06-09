import React, { useEffect, useState } from "react";
import {
  View, Text, StyleSheet, Modal, TextInput, TouchableOpacity, ActivityIndicator,
  Platform, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

function suggestFrom(user: { email?: string; name?: string }): string {
  const seed = (user.email?.split("@")[0] || user.name || "").toLowerCase();
  return seed.replace(/[^a-z0-9_]/g, "").slice(0, 20);
}

export default function UsernameGate() {
  const { user, refresh } = useAuth();
  const insets = useSafeAreaInsets();
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const visible = !!user && !user.username;

  useEffect(() => {
    if (visible && !value) setValue(suggestFrom(user || {}));
  }, [visible, user, value]);

  useEffect(() => {
    if (!visible || !value) { setAvailable(null); return; }
    if (!USERNAME_RE.test(value)) { setAvailable(false); return; }
    let cancelled = false;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.usernameAvailable(value);
        if (!cancelled) setAvailable(!!r.available);
      } finally { if (!cancelled) setChecking(false); }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [value, visible]);

  if (!visible) return null;

  const valid = USERNAME_RE.test(value) && available === true;

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await api.setUsername(value);
      await refresh();
    } catch (e: any) {
      Alert.alert("Couldn't set username", e?.message || String(e));
    } finally { setSaving(false); }
  };

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent>
      <View style={[styles.backdrop, { paddingTop: insets.top + 60, paddingBottom: insets.bottom }]}>
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Ionicons name="at" size={28} color={theme.primary} />
          </View>
          <Text style={styles.title}>Pick a username</Text>
          <Text style={styles.subtitle}>
            People will use <Text style={{ color: theme.primary, fontWeight: "700" }}>@{value || "your_handle"}</Text> to mention and find you.
          </Text>

          <View style={styles.inputRow}>
            <Text style={styles.atSymbol}>@</Text>
            <TextInput
              style={styles.input}
              value={value}
              onChangeText={(t) => setValue(t.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20))}
              autoCapitalize="none"
              autoFocus
              placeholder="username"
              placeholderTextColor={theme.textMuted}
              testID="username-input"
            />
            {checking
              ? <ActivityIndicator size="small" color={theme.primary} />
              : available === true ? <Ionicons name="checkmark-circle" size={18} color="#22C55E" />
              : available === false ? <Ionicons name="close-circle" size={18} color="#EF4444" />
              : null}
          </View>

          <Text style={styles.hint}>
            3–20 chars · lowercase letters, numbers & underscore only
          </Text>

          <TouchableOpacity
            style={[styles.submit, (!valid || saving) && { opacity: 0.4 }]}
            onPress={save}
            disabled={!valid || saving}
            testID="username-submit"
          >
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Continue</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.85)",
    paddingHorizontal: 22, justifyContent: "flex-start",
  },
  card: {
    backgroundColor: theme.surface, borderRadius: 20,
    borderWidth: 1, borderColor: theme.border,
    padding: 22, gap: 12,
  },
  iconWrap: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: theme.primary + "22",
    alignItems: "center", justifyContent: "center",
  },
  title: { color: theme.textPrimary, fontSize: 22, fontWeight: "800" },
  subtitle: { color: theme.textSecondary, fontSize: 14, lineHeight: 20 },
  inputRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginTop: 4,
  },
  atSymbol: { color: theme.textMuted, fontSize: 16, fontWeight: "700" },
  input: {
    flex: 1, color: theme.textPrimary, fontSize: 16, fontWeight: "600",
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  hint: { color: theme.textMuted, fontSize: 12 },
  submit: {
    backgroundColor: theme.primary, borderRadius: 12,
    paddingVertical: 13, alignItems: "center", marginTop: 4,
  },
  submitText: { color: "#fff", fontWeight: "800", fontSize: 14 },
});
