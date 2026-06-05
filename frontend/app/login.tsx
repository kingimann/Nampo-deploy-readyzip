import React, { useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ImageBackground, TouchableOpacity, ActivityIndicator,
  Platform, TextInput, ScrollView, KeyboardAvoidingView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "@/src/theme";
import { useAuth } from "@/src/context/AuthContext";
import { useNavBar } from "@/src/context/NavBarContext";

const BG_IMAGE =
  "https://images.unsplash.com/photo-1774646598677-cc38cb3cac00?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA1NzR8MHwxfHNlYXJjaHwxfHxhYnN0cmFjdCUyMGRhcmslMjB0b3BvZ3JhcGhpYyUyMG1hcHxlbnwwfHx8fDE3ODA1NTgzMjd8MA&ixlib=rb-4.1.0&q=85";

type Mode = "signin" | "signup";

export default function LoginScreen() {
  const router = useRouter();
  const { user, loginLocal, registerLocal } = useAuth();
  const { shortcuts, ready: navReady } = useNavBar();
  const [mode, setMode] = useState<Mode>("signin");
  const [busy, setBusy] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Land on the first item in the user's customized nav bar (not always the map).
  useEffect(() => {
    if (user && navReady) {
      const first = shortcuts[0]?.route || "/(tabs)";
      router.replace(first as any);
    }
  }, [user, navReady, shortcuts, router]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "signin") {
        if (!identifier.trim() || !password) throw new Error("Enter email/username and password");
        await loginLocal(identifier.trim(), password);
      } else {
        if (!email.trim() || !password || !name.trim() || !username.trim())
          throw new Error("All fields required");
        if (password.length < 8) throw new Error("Password must be at least 8 characters");
        if (!agreed) throw new Error("Please agree to the Terms of Service and Privacy Policy");
        await registerLocal(email.trim(), password, name.trim(), username.trim().toLowerCase());
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setBusy(false); }
  };

  return (
    <ImageBackground source={{ uri: BG_IMAGE }} style={styles.bg}>
      <View style={styles.overlay} />
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            <View style={styles.logoBox}>
              <Ionicons name="map" size={32} color="#fff" />
              <Text style={styles.brand}>Nami App</Text>
            </View>
            <Text style={styles.tagline}>Sign in to your account</Text>

            <View style={styles.card}>
              <View style={styles.tabsRow}>
                <TouchableOpacity onPress={() => { setMode("signin"); setError(null); }} style={[styles.tab, mode === "signin" && styles.tabActive]} testID="tab-signin">
                  <Text style={[styles.tabText, mode === "signin" && { color: "#fff" }]}>Sign in</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setMode("signup"); setError(null); }} style={[styles.tab, mode === "signup" && styles.tabActive]} testID="tab-signup">
                  <Text style={[styles.tabText, mode === "signup" && { color: "#fff" }]}>Sign up</Text>
                </TouchableOpacity>
              </View>

              {!!error && (
                <View style={styles.errorBox} testID="auth-error">
                  <Ionicons name="alert-circle" size={16} color="#FCA5A5" />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              {mode === "signup" && (
                <>
                  <TextInput style={styles.input} placeholder="Full name" placeholderTextColor={theme.textMuted} value={name} onChangeText={setName} maxLength={80} testID="reg-name" />
                  <TextInput style={styles.input} placeholder="Username" placeholderTextColor={theme.textMuted} value={username} onChangeText={(t) => setUsername(t.toLowerCase().replace(/[^a-z0-9_]/g, ""))} autoCapitalize="none" maxLength={20} testID="reg-username" />
                  <TextInput style={styles.input} placeholder="Email" placeholderTextColor={theme.textMuted} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" testID="reg-email" />
                </>
              )}
              {mode === "signin" && (
                <TextInput style={styles.input} placeholder="Email or username" placeholderTextColor={theme.textMuted} value={identifier} onChangeText={setIdentifier} autoCapitalize="none" testID="in-identifier" />
              )}
              <TextInput style={styles.input} placeholder="Password" placeholderTextColor={theme.textMuted} value={password} onChangeText={setPassword} secureTextEntry testID="in-password" />

              {mode === "signup" && (
                <TouchableOpacity style={styles.agreeRow} onPress={() => setAgreed((a) => !a)} activeOpacity={0.7} testID="agree-toggle">
                  <Ionicons name={agreed ? "checkbox" : "square-outline"} size={20} color={agreed ? theme.primary : theme.textMuted} />
                  <Text style={styles.agreeText}>
                    I agree to the{" "}
                    <Text style={styles.link} onPress={() => router.push("/legal/terms")}>Terms of Service</Text>
                    {" "}and{" "}
                    <Text style={styles.link} onPress={() => router.push("/legal/privacy")}>Privacy Policy</Text>.
                  </Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity style={[styles.submitBtn, (busy || (mode === "signup" && !agreed)) && { opacity: 0.5 }]} onPress={submit} disabled={busy || (mode === "signup" && !agreed)} testID="submit-btn">
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>{mode === "signin" ? "Sign in" : "Create account"}</Text>}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.6)" },
  scroll: { flexGrow: 1, padding: 24, justifyContent: "center", gap: 18 },
  logoBox: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  brand: { color: "#fff", fontSize: 32, fontWeight: "800", letterSpacing: -0.5 },
  tagline: { color: "#cbd5e1", fontSize: 14, textAlign: "center" },
  card: {
    backgroundColor: "rgba(10,10,10,0.85)", borderRadius: 20,
    borderWidth: 1, borderColor: theme.border, padding: 18, gap: 10,
  },
  tabsRow: { flexDirection: "row", gap: 6, padding: 4, backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: "center" },
  tabActive: { backgroundColor: theme.primary },
  tabText: { color: theme.textSecondary, fontWeight: "700", fontSize: 13 },
  errorBox: {
    flexDirection: "row", alignItems: "flex-start", gap: 8,
    backgroundColor: "rgba(220,38,38,0.15)", borderWidth: 1, borderColor: "rgba(248,113,113,0.5)",
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
  },
  errorText: { flex: 1, color: "#FCA5A5", fontSize: 13, lineHeight: 18, fontWeight: "600" },
  input: {
    color: "#fff", fontSize: 14, backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  submitBtn: { backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 4 },
  submitText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  agreeRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 2, marginTop: 2 },
  agreeText: { flex: 1, color: theme.textSecondary, fontSize: 12.5, lineHeight: 18 },
  link: { color: theme.primary, fontWeight: "700" },
});

