import React, { useEffect, useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Platform, TextInput, ScrollView, KeyboardAvoidingView, Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "@/src/theme";
import { GLASS } from "@/src/lib/glass";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { useNavBar } from "@/src/context/NavBarContext";
import { getSavedAccounts, removeSavedAccount, needsReauth, getAlwaysAskPassword, SavedAccount } from "@/src/lib/savedAccounts";

type Mode = "signin" | "signup";

export default function LoginScreen() {
  const router = useRouter();
  const { user, loginLocal, registerLocal, applySessionToken } = useAuth();
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
  const [info, setInfo] = useState<string | null>(null);
  // Forgot-password flow
  const [forgot, setForgot] = useState(false);
  const [resetStage, setResetStage] = useState<"request" | "code">("request");
  const [resetVia, setResetVia] = useState<"email" | "sms">("email");
  const [resetEmail, setResetEmail] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  // Two-factor challenge (after a correct password on a 2FA account)
  const [twofa, setTwofa] = useState<{ identifier: string; masked: string } | null>(null);
  const [twofaCode, setTwofaCode] = useState("");
  // Phone OTP login
  const [phoneMode, setPhoneMode] = useState(false);
  const [loginPhone, setLoginPhone] = useState("");
  const [phoneStage, setPhoneStage] = useState<"request" | "code">("request");
  const [phoneCode, setPhoneCode] = useState("");
  // Saved profiles (Facebook-style quick login)
  const [saved, setSaved] = useState<SavedAccount[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [alwaysAsk, setAlwaysAsk] = useState(false);

  useEffect(() => { getSavedAccounts().then(setSaved).catch(() => {}); }, []);
  useEffect(() => { getAlwaysAskPassword().then(setAlwaysAsk).catch(() => {}); }, []);

  const requirePassword = (acc: SavedAccount, msg: string) => {
    setShowForm(true);
    setMode("signin");
    setIdentifier(acc.username || "");
    setPassword("");
    setError(msg);
  };

  const loginWithSaved = async (acc: SavedAccount) => {
    // Security check: with "always ask" on, or after the re-auth window, require
    // the password rather than letting the saved token sign in.
    if (alwaysAsk || needsReauth(acc)) {
      requirePassword(acc, `For your security, please re-enter your password to continue as ${acc.name}.`);
      return;
    }
    setBusy(true); setError(null);
    try {
      // verified=false: a quick login doesn't reset the re-auth clock.
      const ok = await applySessionToken(acc.token, false);
      if (!ok) requirePassword(acc, `Your session for ${acc.name} expired — enter your password to sign back in.`);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setBusy(false); }
  };

  const forgetSaved = async (acc: SavedAccount) => {
    await removeSavedAccount(acc.user_id);
    setSaved((arr) => arr.filter((a) => a.user_id !== acc.user_id));
  };

  const sendResetCode = async () => {
    setBusy(true); setError(null); setInfo(null);
    try {
      if (!resetEmail.trim()) throw new Error(resetVia === "sms" ? "Enter your email, username, or phone" : "Enter your account email");
      if (resetVia === "sms") {
        const r = await api.forgotPasswordSms(resetEmail.trim());
        if (!r.sms_configured && !r.dev_code) {
          setError("SMS isn't set up on this server. Try the email option or ask the site owner to reset your password.");
          return;
        }
        setResetStage("code");
        setInfo(r.dev_code
          ? `SMS isn't configured — your code is ${r.dev_code}.`
          : `If a matching account has a verified phone, a code was texted to ${r.masked_phone || "it"}.`);
      } else {
        const r = await api.forgotPassword(resetEmail.trim());
        if (!r.email_configured) {
          setError("Email isn't set up on this server, so a reset code can't be sent. Try the text option or ask the site owner to reset your password.");
          return;
        }
        setResetStage("code");
        setInfo("If an account exists for that email, a 6-digit code is on its way. Enter it below with a new password.");
      }
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const doReset = async () => {
    setBusy(true); setError(null);
    try {
      if (!resetCode.trim()) throw new Error("Enter the code we sent you");
      if (newPassword.length < 8) throw new Error("Password must be at least 8 characters");
      if (resetVia === "sms") await api.resetPasswordCode(resetEmail.trim(), resetCode.trim(), newPassword);
      else await api.resetPassword(resetEmail.trim(), resetCode.trim(), newPassword);
      setForgot(false); setResetStage("request"); setMode("signin");
      setIdentifier(resetEmail.trim()); setPassword(""); setResetCode(""); setNewPassword("");
      setInfo("Password updated — sign in with your new password.");
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const submitTwofa = async () => {
    setBusy(true); setError(null);
    try {
      if (!twofa) return;
      if (!twofaCode.trim()) throw new Error("Enter the code we texted you");
      const { session_token } = await api.login2fa(twofa.identifier, twofaCode.trim());
      await applySessionToken(session_token);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const sendPhoneLoginCode = async () => {
    setBusy(true); setError(null); setInfo(null);
    try {
      if (!loginPhone.trim()) throw new Error("Enter your phone number (e.g. +14155551234)");
      const r = await api.loginPhoneStart(loginPhone.trim());
      if (!r.exists) throw new Error("No account with a verified phone for that number. Sign in with your password instead.");
      setPhoneStage("code"); setPhoneCode("");
      setInfo(r.dev_code ? `SMS isn't configured — your code is ${r.dev_code}.` : `Code sent to ${r.masked_phone || "your phone"}.`);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const verifyPhoneLogin = async () => {
    setBusy(true); setError(null);
    try {
      if (!phoneCode.trim()) throw new Error("Enter the code we texted you");
      const { session_token } = await api.loginPhoneVerify(loginPhone.trim(), phoneCode.trim());
      await applySessionToken(session_token);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  };

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
        const res = await loginLocal(identifier.trim(), password);
        if (res && "twofa_required" in res) {
          // Account has SMS two-factor on — collect the texted code next.
          setTwofa({ identifier: res.identifier, masked: res.masked_phone });
          setTwofaCode("");
          setInfo(res.dev_code
            ? `SMS isn't configured — your login code is ${res.dev_code}.`
            : `We texted a login code to ${res.masked_phone}.`);
        }
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
    <View style={styles.bg}>
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            <View style={styles.logoBox}>
              <Ionicons name="map" size={32} color="#fff" />
              <Text style={styles.brand}>OkaySpace</Text>
            </View>
            <Text style={styles.tagline}>Sign in to your account</Text>

            <View style={styles.card}>
              {twofa ? (
                <>
                  <Text style={styles.resetTitle}>Two-factor verification</Text>
                  {!!error && (
                    <View style={styles.errorBox} testID="auth-error">
                      <Ionicons name="alert-circle" size={16} color="#FCA5A5" />
                      <Text style={styles.errorText}>{error}</Text>
                    </View>
                  )}
                  {!!info && <Text style={styles.infoText}>{info}</Text>}
                  <Text style={styles.helpText}>Enter the 6-digit code we texted to {twofa.masked}.</Text>
                  <TextInput style={styles.input} placeholder="6-digit code" placeholderTextColor={theme.textMuted} value={twofaCode} onChangeText={(t) => setTwofaCode(t.replace(/[^0-9]/g, ""))} keyboardType="number-pad" maxLength={6} testID="twofa-code" />
                  <TouchableOpacity style={[styles.submitBtn, busy && { opacity: 0.5 }]} onPress={submitTwofa} disabled={busy} testID="twofa-submit">
                    {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Verify & sign in</Text>}
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => { setTwofa(null); setError(null); setInfo(null); setPassword(""); }} testID="twofa-back">
                    <Text style={styles.forgotLink}>← Back to sign in</Text>
                  </TouchableOpacity>
                </>
              ) : phoneMode ? (
                <>
                  <Text style={styles.resetTitle}>Sign in with phone</Text>
                  {!!error && (
                    <View style={styles.errorBox} testID="auth-error">
                      <Ionicons name="alert-circle" size={16} color="#FCA5A5" />
                      <Text style={styles.errorText}>{error}</Text>
                    </View>
                  )}
                  {!!info && <Text style={styles.infoText}>{info}</Text>}
                  {phoneStage === "request" ? (
                    <>
                      <TextInput style={styles.input} placeholder="Phone number (e.g. +14155551234)" placeholderTextColor={theme.textMuted} value={loginPhone} onChangeText={setLoginPhone} keyboardType="phone-pad" autoCapitalize="none" testID="login-phone" />
                      <TouchableOpacity style={[styles.submitBtn, busy && { opacity: 0.5 }]} onPress={sendPhoneLoginCode} disabled={busy} testID="login-phone-send">
                        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Text me a code</Text>}
                      </TouchableOpacity>
                    </>
                  ) : (
                    <>
                      <TextInput style={styles.input} placeholder="6-digit code" placeholderTextColor={theme.textMuted} value={phoneCode} onChangeText={(t) => setPhoneCode(t.replace(/[^0-9]/g, ""))} keyboardType="number-pad" maxLength={6} testID="login-phone-code" />
                      <TouchableOpacity style={[styles.submitBtn, busy && { opacity: 0.5 }]} onPress={verifyPhoneLogin} disabled={busy} testID="login-phone-verify">
                        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Verify & sign in</Text>}
                      </TouchableOpacity>
                    </>
                  )}
                  <TouchableOpacity onPress={() => { setPhoneMode(false); setPhoneStage("request"); setError(null); setInfo(null); }} testID="login-phone-back">
                    <Text style={styles.forgotLink}>← Back to sign in</Text>
                  </TouchableOpacity>
                </>
              ) : forgot ? (
                <>
                  <Text style={styles.resetTitle}>Reset your password</Text>
                  {!!error && (
                    <View style={styles.errorBox} testID="auth-error">
                      <Ionicons name="alert-circle" size={16} color="#FCA5A5" />
                      <Text style={styles.errorText}>{error}</Text>
                    </View>
                  )}
                  {!!info && <Text style={styles.infoText}>{info}</Text>}
                  {resetStage === "request" && (
                    <View style={styles.segRow}>
                      <TouchableOpacity onPress={() => setResetVia("email")} style={[styles.seg, resetVia === "email" && styles.segActive]} testID="reset-via-email">
                        <Text style={[styles.segText, resetVia === "email" && { color: "#fff" }]}>Email</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => setResetVia("sms")} style={[styles.seg, resetVia === "sms" && styles.segActive]} testID="reset-via-sms">
                        <Text style={[styles.segText, resetVia === "sms" && { color: "#fff" }]}>Text (SMS)</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                  {resetStage === "request" ? (
                    <>
                      <TextInput style={styles.input} placeholder={resetVia === "sms" ? "Email, username, or phone" : "Your account email"} placeholderTextColor={theme.textMuted} value={resetEmail} onChangeText={setResetEmail} keyboardType={resetVia === "sms" ? "default" : "email-address"} autoCapitalize="none" testID="reset-email" />
                      <TouchableOpacity style={[styles.submitBtn, busy && { opacity: 0.5 }]} onPress={sendResetCode} disabled={busy} testID="reset-send">
                        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Send reset code</Text>}
                      </TouchableOpacity>
                    </>
                  ) : (
                    <>
                      <TextInput style={styles.input} placeholder="6-digit code" placeholderTextColor={theme.textMuted} value={resetCode} onChangeText={(t) => setResetCode(t.replace(/[^0-9]/g, ""))} keyboardType="number-pad" maxLength={6} testID="reset-code" />
                      <TextInput style={styles.input} placeholder="New password" placeholderTextColor={theme.textMuted} value={newPassword} onChangeText={setNewPassword} secureTextEntry testID="reset-newpw" />
                      <TouchableOpacity style={[styles.submitBtn, busy && { opacity: 0.5 }]} onPress={doReset} disabled={busy} testID="reset-confirm">
                        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Reset password</Text>}
                      </TouchableOpacity>
                    </>
                  )}
                  <TouchableOpacity onPress={() => { setForgot(false); setError(null); setInfo(null); setResetStage("request"); }} testID="reset-back">
                    <Text style={styles.forgotLink}>← Back to sign in</Text>
                  </TouchableOpacity>
                </>
              ) : saved.length > 0 && !showForm ? (
                <>
                  <Text style={styles.resetTitle}>Choose a profile</Text>
                  {!!error && (
                    <View style={styles.errorBox} testID="auth-error">
                      <Ionicons name="alert-circle" size={16} color="#FCA5A5" />
                      <Text style={styles.errorText}>{error}</Text>
                    </View>
                  )}
                  {saved.map((acc) => (
                    <View key={acc.user_id} style={styles.savedRow}>
                      <TouchableOpacity style={styles.savedMain} onPress={() => loginWithSaved(acc)} disabled={busy} testID={`saved-${acc.user_id}`}>
                        <View style={styles.savedAvatar}>
                          {acc.picture
                            ? <Image source={{ uri: acc.picture }} style={{ width: "100%", height: "100%" }} />
                            : <Text style={styles.savedInit}>{(acc.name?.[0] || "?").toUpperCase()}</Text>}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.savedName} numberOfLines={1}>{acc.name}</Text>
                          {!!acc.username && <Text style={styles.savedHandle} numberOfLines={1}>@{acc.username}</Text>}
                        </View>
                        {(alwaysAsk || needsReauth(acc))
                          ? <Ionicons name="lock-closed" size={15} color={theme.textMuted} />
                          : <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />}
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => forgetSaved(acc)} hitSlop={8} style={styles.forgetBtn} testID={`forget-${acc.user_id}`}>
                        <Ionicons name="close" size={16} color={theme.textMuted} />
                      </TouchableOpacity>
                    </View>
                  ))}
                  {busy && <ActivityIndicator color={theme.primary} style={{ marginTop: 4 }} />}
                  <TouchableOpacity style={styles.anotherBtn} onPress={() => { setShowForm(true); setError(null); }} testID="use-another">
                    <Ionicons name="add-circle-outline" size={18} color={theme.primary} />
                    <Text style={styles.anotherText}>Use another account</Text>
                  </TouchableOpacity>
                </>
              ) : (
              <>
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
              {!!info && <Text style={styles.infoText}>{info}</Text>}

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

              {mode === "signin" && (
                <>
                  <TouchableOpacity onPress={() => { setPhoneMode(true); setError(null); setInfo(null); setPhoneStage("request"); }} testID="phone-login-link">
                    <Text style={styles.forgotLink}>Sign in with phone instead</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => { setForgot(true); setError(null); setInfo(null); setResetEmail(identifier.includes("@") ? identifier.trim() : ""); }} testID="forgot-link">
                    <Text style={styles.forgotLink}>Forgot password?</Text>
                  </TouchableOpacity>
                </>
              )}
              </>
              )}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: theme.bg },
  scroll: { flexGrow: 1, padding: 24, justifyContent: "center", gap: 18 },
  logoBox: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  brand: { color: "#fff", fontSize: 32, fontWeight: "800", letterSpacing: -0.5 },
  tagline: { color: theme.textSecondary, fontSize: 14, textAlign: "center" },
  // Frosted-glass card — same surface as the feed cards / bottom pill.
  card: {
    // Cap + centre the form so it doesn't stretch across the whole screen on
    // desktop web. No-op on phones (narrower than maxWidth).
    width: "100%", maxWidth: 420, alignSelf: "center",
    borderRadius: 20, padding: 18, gap: 10,
    ...GLASS,
  },
  tabsRow: { flexDirection: "row", gap: 6, padding: 4, backgroundColor: theme.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: theme.border },
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
    color: "#fff", fontSize: 14, backgroundColor: theme.surfaceAlt,
    borderWidth: 1, borderColor: theme.border, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  submitBtn: { backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 4 },
  submitText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  agreeRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 2, marginTop: 2 },
  agreeText: { flex: 1, color: theme.textSecondary, fontSize: 12.5, lineHeight: 18 },
  link: { color: theme.primary, fontWeight: "700" },
  resetTitle: { color: "#fff", fontSize: 17, fontWeight: "800", textAlign: "center", marginBottom: 2 },
  infoText: { color: theme.primary, fontSize: 12.5, lineHeight: 18, fontWeight: "600" },
  helpText: { color: theme.textSecondary, fontSize: 12.5, lineHeight: 18 },
  forgotLink: { color: theme.primary, fontSize: 13, fontWeight: "700", textAlign: "center", marginTop: 10 },
  segRow: { flexDirection: "row", gap: 6, padding: 4, backgroundColor: theme.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: theme.border },
  seg: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: "center" },
  segActive: { backgroundColor: theme.primary },
  segText: { color: theme.textSecondary, fontWeight: "700", fontSize: 12.5 },
  savedRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  savedMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10 },
  savedAvatar: { width: 44, height: 44, borderRadius: 22, overflow: "hidden", backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  savedInit: { color: "#fff", fontSize: 18, fontWeight: "800" },
  savedName: { color: "#fff", fontSize: 15, fontWeight: "800" },
  savedHandle: { color: theme.textMuted, fontSize: 12.5, marginTop: 1 },
  forgetBtn: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  anotherBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: theme.border, borderStyle: "dashed", marginTop: 4 },
  anotherText: { color: theme.primary, fontSize: 14, fontWeight: "800" },
});

