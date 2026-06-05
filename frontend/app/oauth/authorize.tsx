import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Image, Platform, Linking } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { api, OAuthApp } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

const SCOPE_LABELS: Record<string, string> = {
  profile: "Your name, username and profile picture",
  email: "Your email address",
};

export default function OAuthConsent() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const params = useLocalSearchParams<{ client_id?: string; redirect_uri?: string; scope?: string; state?: string }>();
  const [app, setApp] = useState<OAuthApp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);

  const scopes = (params.scope || "profile").split(" ").filter(Boolean);

  const load = useCallback(async () => {
    if (!params.client_id) { setErr("Missing client_id"); setChecking(false); return; }
    try { setApp(await api.getOAuthApp(params.client_id)); }
    catch (e: any) { setErr(String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setChecking(false); }
  }, [params.client_id]);
  useEffect(() => { load(); }, [load]);

  // Require login first, then return to this consent screen.
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  const go = (url: string) => {
    if (Platform.OS === "web" && typeof window !== "undefined") window.location.href = url;
    else Linking.openURL(url);
  };

  const decide = async (approve: boolean) => {
    if (!params.client_id || !params.redirect_uri) return;
    setBusy(true);
    try {
      const { redirect_url } = await api.oauthAuthorize({
        client_id: params.client_id, redirect_uri: params.redirect_uri,
        scope: params.scope, state: params.state, approve,
      });
      go(redirect_url);
    } catch (e: any) {
      setErr(String(e?.message || e).replace(/^\d{3}:\s*/, ""));
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} testID="oauth-consent">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.card}>
        {checking || loading ? (
          <ActivityIndicator color={theme.primary} />
        ) : err ? (
          <Text style={styles.err}>{err}</Text>
        ) : (
          <>
            <View style={styles.logoRow}>
              <View style={styles.logo}><Ionicons name="map" size={22} color="#fff" /></View>
              <Ionicons name="swap-horizontal" size={18} color={theme.textMuted} />
              <View style={styles.appLogo}><Ionicons name="cube" size={20} color={theme.primary} /></View>
            </View>
            <Text style={styles.title}>{app?.name || "An app"} wants to sign you in with Nami</Text>
            <Text style={styles.sub}>Signed in as <Text style={{ color: theme.textPrimary, fontWeight: "700" }}>{user?.name}</Text></Text>

            <View style={styles.scopeBox}>
              <Text style={styles.scopeHead}>This will share:</Text>
              {scopes.map((s) => (
                <View key={s} style={styles.scopeRow}>
                  <Ionicons name="checkmark-circle" size={16} color={theme.primary} />
                  <Text style={styles.scopeText}>{SCOPE_LABELS[s] || s}</Text>
                </View>
              ))}
            </View>

            <TouchableOpacity style={[styles.approve, busy && { opacity: 0.6 }]} onPress={() => decide(true)} disabled={busy} testID="oauth-approve">
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.approveText}>Continue as {user?.name}</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => decide(false)} disabled={busy} testID="oauth-deny">
              <Text style={styles.deny}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.fine}>You can revoke access anytime. Only continue if you trust this app.</Text>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center", padding: 22 },
  card: { width: "100%", maxWidth: 400, backgroundColor: theme.surface, borderRadius: 20, borderWidth: 1, borderColor: theme.border, padding: 24, gap: 14, alignItems: "center" },
  logoRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  logo: { width: 44, height: 44, borderRadius: 12, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  appLogo: { width: 40, height: 40, borderRadius: 12, backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, alignItems: "center", justifyContent: "center" },
  title: { color: theme.textPrimary, fontSize: 19, fontWeight: "800", textAlign: "center", lineHeight: 25 },
  sub: { color: theme.textMuted, fontSize: 13 },
  scopeBox: { alignSelf: "stretch", backgroundColor: theme.surfaceAlt, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 14, gap: 8 },
  scopeHead: { color: theme.textMuted, fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  scopeRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  scopeText: { color: theme.textSecondary, fontSize: 14, flex: 1 },
  approve: { alignSelf: "stretch", backgroundColor: theme.primary, borderRadius: 14, paddingVertical: 14, alignItems: "center" },
  approveText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  deny: { color: theme.textMuted, fontSize: 14, fontWeight: "600", paddingVertical: 4 },
  fine: { color: theme.textMuted, fontSize: 11.5, textAlign: "center", lineHeight: 16 },
  err: { color: theme.error, fontSize: 14, textAlign: "center" },
});
