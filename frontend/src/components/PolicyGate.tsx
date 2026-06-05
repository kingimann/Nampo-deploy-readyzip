import React, { useState } from "react";
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, ActivityIndicator, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

// Shown to a logged-in user who hasn't agreed to the current Terms / Privacy
// Policy (new users who skipped it, or anyone after a policy update). Blocks the
// app until they accept. A username must be picked first (UsernameGate), so this
// only triggers once the account is otherwise set up.
export default function PolicyGate() {
  const { user, refresh } = useAuth();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  const visible = !!user && !!user.username && !!user.needs_policy_agreement;
  if (!visible) return null;

  const accept = async () => {
    setSaving(true);
    try {
      await api.acceptPolicies();
      await refresh();
    } catch (e: any) {
      Alert.alert("Couldn't save", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setSaving(false); }
  };

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent>
      <View style={[styles.backdrop, { paddingTop: insets.top + 50, paddingBottom: insets.bottom + 20 }]}>
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Ionicons name="document-text" size={26} color={theme.primary} />
          </View>
          <Text style={styles.title}>Review our policies</Text>
          <Text style={styles.subtitle}>
            We've updated our terms. Please review and agree to continue using Nami.
          </Text>

          <View style={styles.links}>
            <TouchableOpacity style={styles.linkRow} onPress={() => router.push("/legal/terms")} testID="gate-open-terms">
              <Ionicons name="reader-outline" size={18} color={theme.primary} />
              <Text style={styles.linkText}>Terms of Service</Text>
              <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
            </TouchableOpacity>
            <View style={styles.sep} />
            <TouchableOpacity style={styles.linkRow} onPress={() => router.push("/legal/privacy")} testID="gate-open-privacy">
              <Ionicons name="lock-closed-outline" size={18} color={theme.primary} />
              <Text style={styles.linkText}>Privacy Policy</Text>
              <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.submit, saving && { opacity: 0.5 }]}
            onPress={accept}
            disabled={saving}
            testID="gate-accept"
          >
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>I agree</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", paddingHorizontal: 22, justifyContent: "flex-start" },
  card: { backgroundColor: theme.surface, borderRadius: 20, borderWidth: 1, borderColor: theme.border, padding: 22, gap: 12 },
  iconWrap: { width: 48, height: 48, borderRadius: 24, backgroundColor: theme.primary + "22", alignItems: "center", justifyContent: "center" },
  title: { color: theme.textPrimary, fontSize: 22, fontWeight: "800" },
  subtitle: { color: theme.textSecondary, fontSize: 14, lineHeight: 20 },
  links: { backgroundColor: theme.surfaceAlt, borderRadius: 14, borderWidth: 1, borderColor: theme.border, marginTop: 4 },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 14 },
  linkText: { flex: 1, color: theme.textPrimary, fontSize: 15, fontWeight: "600" },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: theme.border, marginLeft: 44 },
  submit: { backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 4 },
  submitText: { color: "#fff", fontWeight: "800", fontSize: 15 },
});
