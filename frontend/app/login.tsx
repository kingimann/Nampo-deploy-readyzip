import React, { useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ImageBackground, TouchableOpacity, ActivityIndicator,
  Platform, TextInput, ScrollView, Alert, KeyboardAvoidingView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "@/src/theme";
import { useAuth } from "@/src/context/AuthContext";

const BG_IMAGE =
  "https://images.unsplash.com/photo-1774646598677-cc38cb3cac00?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA1NzR8MHwxfHNlYXJjaHwxfHxhYnN0cmFjdCUyMGRhcmslMjB0b3BvZ3JhcGhpYyUyMG1hcHxlbnwwfHx8fDE3ODA1NTgzMjd8MA&ixlib=rb-4.1.0&q=85";

type Mode = "signin" | "signup";

export default function LoginScreen() {
  const router = useRouter();
  const { user, processSessionId, loginLocal, registerLocal } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [busy, setBusy] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => { if (user) router.replace("/(tabs)"); }, [user, router]);

  const onGoogle = async () => {
    setBusy(true);
    try {
      const redirectUrl = Platform.OS === "web" ? window.location.origin + "/" : Linking.createURL("auth");
      const authUrl = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirectUrl)}`;
      if (Platform.OS === "web") {
        const popup = window.open(authUrl, "_blank", "width=500,height=640,left=200,top=80");
        if (!popup) { window.location.href = authUrl; return; }
        const timer = setInterval(async () => {
          if (popup.closed) { clearInterval(timer); setBusy(false); return; }
          try {
            const url = popup.location.href;
            if (url && url.includes("session_id=")) {
              popup.close();
              clearInterval(timer);
              const params = new URL(url).searchParams;
              const sid = params.get("session_id");
              if (sid) await processSessionId(decodeURIComponent(sid));
              setBusy(false);
            }
          } catch {} // cross-origin — ignore until redirect lands on our origin
        }, 400);
        return;
      }
      const res = await WebBrowser.openAuthSessionAsync(authUrl, redirectUrl);
      if (res.type === "success") {
        const sid = res.url.split("session_id=")[1]?.split("&")[0];
        if (sid) await processSessionId(decodeURIComponent(sid));
      }
    } catch (e) { Alert.alert("Sign in failed", String(e)); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "signin") {
        if (!identifier.trim() || !password) throw new Error("Enter email/username and password");
        await loginLocal(identifier.trim(), password);
      } else {
        if (!email.trim() || !password || !name.trim() || !username.trim())
          throw new Error("All fields required");
        if (password.length < 8) throw new Error("Password must be at least 8 characters");
        await registerLocal(email.trim(), password, name.trim(), username.trim().toLowerCase());
      }
    } catch (e: any) {
      Alert.alert(mode === "signin" ? "Sign in failed" : "Sign up failed", e?.message || String(e));
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
              <Text style={styles.brand}>Atlas</Text>
            </View>
            <Text style={styles.tagline}>Sign in to your account</Text>

            <View style={styles.card}>
              <View style={styles.tabsRow}>
                <TouchableOpacity onPress={() => setMode("signin")} style={[styles.tab, mode === "signin" && styles.tabActive]} testID="tab-signin">
                  <Text style={[styles.tabText, mode === "signin" && { color: "#fff" }]}>Sign in</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setMode("signup")} style={[styles.tab, mode === "signup" && styles.tabActive]} testID="tab-signup">
                  <Text style={[styles.tabText, mode === "signup" && { color: "#fff" }]}>Sign up</Text>
                </TouchableOpacity>
              </View>

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

              <TouchableOpacity style={[styles.submitBtn, busy && { opacity: 0.7 }]} onPress={submit} disabled={busy} testID="submit-btn">
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>{mode === "signin" ? "Sign in" : "Create account"}</Text>}
              </TouchableOpacity>

              <View style={styles.divider}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>or</Text>
                <View style={styles.dividerLine} />
              </View>

              <TouchableOpacity style={styles.googleBtn} onPress={onGoogle} disabled={busy} testID="google-btn">
                <Ionicons name="logo-google" size={18} color="#fff" />
                <Text style={styles.googleText}>Continue with Google</Text>
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
  input: {
    color: "#fff", fontSize: 14, backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  submitBtn: { backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 4 },
  submitText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  divider: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 4 },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.border },
  dividerText: { color: theme.textMuted, fontSize: 11 },
  googleBtn: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8, paddingVertical: 12, borderRadius: 12, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  googleText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
