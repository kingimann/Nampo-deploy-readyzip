import React, { useState } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  ActivityIndicator, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { useAuth } from "@/src/context/AuthContext";
import { api } from "@/src/api/client";
import { theme } from "@/src/theme";

type Status = { kind: "ok" | "err"; text: string } | null;

export default function AccountScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, refresh } = useAuth();

  // Email
  const [newEmail, setNewEmail] = useState("");
  const [emailPw, setEmailPw] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState<Status>(null);

  // Password
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<Status>(null);

  // Phone
  const [phone, setPhone] = useState(user?.phone || "");
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneMsg, setPhoneMsg] = useState<Status>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");

  // Security / notifications (SMS-backed)
  const [secBusy, setSecBusy] = useState(false);
  const [secMsg, setSecMsg] = useState<Status>(null);
  const [disablePw, setDisablePw] = useState("");
  const [askDisable2fa, setAskDisable2fa] = useState(false);

  const toggle2fa = async (enable: boolean) => {
    setSecMsg(null);
    if (enable && !user?.phone_verified) {
      setSecMsg({ kind: "err", text: "Verify your phone number first to enable two-factor." });
      return;
    }
    if (!enable && !askDisable2fa) { setAskDisable2fa(true); return; }
    setSecBusy(true);
    try {
      await api.setTwofa(enable, enable ? undefined : disablePw);
      await refresh();
      setAskDisable2fa(false); setDisablePw("");
      setSecMsg({ kind: "ok", text: enable ? "Two-factor turned on." : "Two-factor turned off." });
    } catch (e: any) {
      setSecMsg({ kind: "err", text: cleanErr(e) });
    } finally { setSecBusy(false); }
  };

  const toggleSmsNotifs = async (enable: boolean) => {
    setSecMsg(null);
    if (enable && !user?.phone_verified) {
      setSecMsg({ kind: "err", text: "Verify your phone number first to get SMS notifications." });
      return;
    }
    setSecBusy(true);
    try {
      await api.updateMe({ sms_notifications: enable });
      await refresh();
      setSecMsg({ kind: "ok", text: enable ? "SMS notifications on." : "SMS notifications off." });
    } catch (e: any) {
      setSecMsg({ kind: "err", text: cleanErr(e) });
    } finally { setSecBusy(false); }
  };

  const saveEmail = async () => {
    setEmailMsg(null);
    if (!newEmail.trim()) return setEmailMsg({ kind: "err", text: "Enter a new email." });
    if (!emailPw) return setEmailMsg({ kind: "err", text: "Enter your current password to confirm." });
    setEmailBusy(true);
    try {
      await api.changeEmail(emailPw, newEmail.trim());
      await refresh();
      setNewEmail(""); setEmailPw("");
      setEmailMsg({ kind: "ok", text: "Email updated." });
    } catch (e: any) {
      setEmailMsg({ kind: "err", text: cleanErr(e) });
    } finally { setEmailBusy(false); }
  };

  const savePassword = async () => {
    setPwMsg(null);
    if (newPw.length < 8) return setPwMsg({ kind: "err", text: "New password must be at least 8 characters." });
    if (newPw !== confirmPw) return setPwMsg({ kind: "err", text: "New passwords don't match." });
    setPwBusy(true);
    try {
      await api.changePassword(curPw, newPw);
      setCurPw(""); setNewPw(""); setConfirmPw("");
      setPwMsg({ kind: "ok", text: "Password changed." });
    } catch (e: any) {
      setPwMsg({ kind: "err", text: cleanErr(e) });
    } finally { setPwBusy(false); }
  };

  const sendCode = async () => {
    setPhoneMsg(null); setPhoneBusy(true);
    try {
      const r = await api.sendPhoneCode(phone.trim());
      setCodeSent(true);
      if (r.dev_code) { setCode(r.dev_code); setPhoneMsg({ kind: "ok", text: `SMS isn't set up on the server yet — your code is ${r.dev_code}.` }); }
      else setPhoneMsg({ kind: "ok", text: "We texted you a 6-digit code. Enter it below." });
    } catch (e: any) {
      setPhoneMsg({ kind: "err", text: cleanErr(e) });
    } finally { setPhoneBusy(false); }
  };
  const verifyPhone = async () => {
    setPhoneMsg(null); setPhoneBusy(true);
    try {
      await api.verifyPhoneCode(code.trim());
      await refresh();
      setCodeSent(false); setCode("");
      setPhoneMsg({ kind: "ok", text: "Phone number verified ✓" });
    } catch (e: any) {
      setPhoneMsg({ kind: "err", text: cleanErr(e) });
    } finally { setPhoneBusy(false); }
  };
  const removePhone = async () => {
    setPhoneMsg(null); setPhoneBusy(true);
    try {
      await api.setPhone("");
      await refresh();
      setCodeSent(false); setCode(""); setPhone("");
      setPhoneMsg({ kind: "ok", text: "Phone number removed." });
    } catch (e: any) {
      setPhoneMsg({ kind: "err", text: cleanErr(e) });
    } finally { setPhoneBusy(false); }
  };
  const phoneVerified = !!user?.phone_verified && phone.trim() === (user?.phone || "");

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="account-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn} testID="account-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Account & security</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
        {/* Email */}
        <Text style={styles.groupTitle}>Email</Text>
        <View style={styles.group}>
          <Text style={styles.current}>Current: <Text style={styles.currentVal}>{user?.email || "—"}</Text></Text>
          <TextInput
            style={styles.input} placeholder="New email" placeholderTextColor={theme.textMuted}
            value={newEmail} onChangeText={setNewEmail}
            autoCapitalize="none" keyboardType="email-address" autoComplete="email"
            testID="account-new-email"
          />
          <TextInput
            style={styles.input} placeholder="Current password" placeholderTextColor={theme.textMuted}
            value={emailPw} onChangeText={setEmailPw} secureTextEntry testID="account-email-pw"
          />
          {emailMsg && <Text style={emailMsg.kind === "ok" ? styles.ok : styles.err}>{emailMsg.text}</Text>}
          <TouchableOpacity style={[styles.btn, emailBusy && styles.btnDim]} onPress={saveEmail} disabled={emailBusy} testID="account-save-email">
            {emailBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Update email</Text>}
          </TouchableOpacity>
        </View>

        {/* Password */}
        <Text style={styles.groupTitle}>Password</Text>
        <View style={styles.group}>
          <TextInput
            style={styles.input} placeholder="Current password" placeholderTextColor={theme.textMuted}
            value={curPw} onChangeText={setCurPw} secureTextEntry testID="account-cur-pw"
          />
          <TextInput
            style={styles.input} placeholder="New password (min 8 chars)" placeholderTextColor={theme.textMuted}
            value={newPw} onChangeText={setNewPw} secureTextEntry testID="account-new-pw"
          />
          <TextInput
            style={styles.input} placeholder="Confirm new password" placeholderTextColor={theme.textMuted}
            value={confirmPw} onChangeText={setConfirmPw} secureTextEntry testID="account-confirm-pw"
          />
          {pwMsg && <Text style={pwMsg.kind === "ok" ? styles.ok : styles.err}>{pwMsg.text}</Text>}
          <TouchableOpacity style={[styles.btn, pwBusy && styles.btnDim]} onPress={savePassword} disabled={pwBusy} testID="account-save-pw">
            {pwBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Change password</Text>}
          </TouchableOpacity>
        </View>

        {/* Phone */}
        <View style={styles.phoneTitleRow}>
          <Text style={styles.groupTitle}>Phone number</Text>
          {!!user?.phone && (
            <View style={styles.badge}>
              <Ionicons name={user.phone_verified ? "checkmark-circle" : "alert-circle"} size={12} color={user.phone_verified ? "#22C55E" : theme.textMuted} />
              <Text style={[styles.badgeText, user.phone_verified && { color: "#22C55E" }]}>{user.phone_verified ? "Verified" : "Unverified"}</Text>
            </View>
          )}
        </View>
        <View style={styles.group}>
          <TextInput
            style={styles.input} placeholder="+1 555 123 4567" placeholderTextColor={theme.textMuted}
            value={phone} onChangeText={(t) => { setPhone(t); setCodeSent(false); }} keyboardType="phone-pad" autoComplete="tel"
            editable={!codeSent}
            testID="account-phone"
          />

          {codeSent && (
            <TextInput
              style={[styles.input, { marginTop: 10, letterSpacing: 6, textAlign: "center", fontSize: 20, fontWeight: "800" }]}
              placeholder="••••••" placeholderTextColor={theme.textMuted}
              value={code} onChangeText={(t) => setCode(t.replace(/[^0-9]/g, "").slice(0, 6))}
              keyboardType="number-pad" maxLength={6} testID="account-phone-code"
            />
          )}

          <Text style={styles.hint}>{phoneVerified ? "Your number is verified." : "Verify your number with a texted code."}</Text>
          {phoneMsg && <Text style={phoneMsg.kind === "ok" ? styles.ok : styles.err}>{phoneMsg.text}</Text>}

          {phoneVerified ? (
            <TouchableOpacity style={[styles.btn, styles.btnGhost, phoneBusy && styles.btnDim]} onPress={removePhone} disabled={phoneBusy} testID="account-remove-phone">
              {phoneBusy ? <ActivityIndicator color={theme.primary} /> : <Text style={[styles.btnText, { color: theme.primary }]}>Remove phone number</Text>}
            </TouchableOpacity>
          ) : codeSent ? (
            <>
              <TouchableOpacity style={[styles.btn, phoneBusy && styles.btnDim]} onPress={verifyPhone} disabled={phoneBusy || code.length < 6} testID="account-verify-phone">
                {phoneBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Verify</Text>}
              </TouchableOpacity>
              <TouchableOpacity style={styles.linkBtn} onPress={sendCode} disabled={phoneBusy} testID="account-resend-code">
                <Text style={styles.linkText}>Resend code</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity style={[styles.btn, phoneBusy && styles.btnDim]} onPress={phone.trim() ? sendCode : removePhone} disabled={phoneBusy} testID="account-save-phone">
              {phoneBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>{phone.trim() ? "Send verification code" : "Remove phone number"}</Text>}
            </TouchableOpacity>
          )}
        </View>

        {/* Security & SMS (need a verified phone) */}
        <Text style={styles.groupTitle}>Security & SMS</Text>
        <View style={styles.group}>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.toggleTitle}>Two-factor (SMS)</Text>
              <Text style={styles.hint}>Require a texted code when signing in.</Text>
            </View>
            <TouchableOpacity
              onPress={() => toggle2fa(!user?.twofa_enabled)}
              disabled={secBusy}
              testID="account-2fa-toggle"
              style={[styles.switch, user?.twofa_enabled && styles.switchOn]}
            >
              <View style={[styles.knob, user?.twofa_enabled && styles.knobOn]} />
            </TouchableOpacity>
          </View>

          {askDisable2fa && user?.twofa_enabled && (
            <>
              <TextInput
                style={[styles.input, { marginTop: 10 }]}
                placeholder="Current password to turn off" placeholderTextColor={theme.textMuted}
                value={disablePw} onChangeText={setDisablePw} secureTextEntry testID="account-2fa-disable-pw"
              />
              <TouchableOpacity style={[styles.btn, styles.btnGhost, secBusy && styles.btnDim]} onPress={() => toggle2fa(false)} disabled={secBusy} testID="account-2fa-disable">
                {secBusy ? <ActivityIndicator color={theme.primary} /> : <Text style={[styles.btnText, { color: theme.primary }]}>Turn off two-factor</Text>}
              </TouchableOpacity>
            </>
          )}

          <View style={[styles.toggleRow, { marginTop: 14 }]}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.toggleTitle}>SMS notifications</Text>
              <Text style={styles.hint}>Text me about messages, money, and friend requests.</Text>
            </View>
            <TouchableOpacity
              onPress={() => toggleSmsNotifs(!user?.sms_notifications)}
              disabled={secBusy}
              testID="account-sms-toggle"
              style={[styles.switch, user?.sms_notifications && styles.switchOn]}
            >
              <View style={[styles.knob, user?.sms_notifications && styles.knobOn]} />
            </TouchableOpacity>
          </View>

          {!user?.phone_verified && (
            <Text style={[styles.hint, { marginTop: 10 }]}>Verify your phone number above to use these.</Text>
          )}
          {secMsg && <Text style={secMsg.kind === "ok" ? styles.ok : styles.err}>{secMsg.text}</Text>}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function cleanErr(e: any): string {
  const m = String(e?.message || e || "Something went wrong");
  // request() throws "409: That email is already in use" — strip the status prefix.
  return m.replace(/^\d{3}:\s*/, "");
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  backBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },

  groupTitle: {
    color: theme.textMuted, fontSize: 13, fontWeight: "700",
    textTransform: "uppercase", letterSpacing: 0.5,
    marginTop: 24, marginBottom: 10, marginLeft: 6,
  },
  phoneTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingRight: 6 },
  badge: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 14 },
  badgeText: { color: theme.textMuted, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },

  group: {
    backgroundColor: theme.surface, borderRadius: 18,
    borderWidth: 1, borderColor: theme.border,
    padding: 14, gap: 10,
  },
  current: { color: theme.textSecondary, fontSize: 13.5 },
  currentVal: { color: theme.textPrimary, fontWeight: "700" },
  input: {
    backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    color: theme.textPrimary, fontSize: 15,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  hint: { color: theme.textMuted, fontSize: 12.5, lineHeight: 17 },
  toggleRow: { flexDirection: "row", alignItems: "center" },
  toggleTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  switch: {
    width: 48, height: 28, borderRadius: 14, padding: 3,
    backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border,
    justifyContent: "center",
  },
  switchOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff" },
  knobOn: { alignSelf: "flex-end" },
  err: { color: theme.error, fontSize: 13, fontWeight: "600" },
  ok: { color: theme.primary, fontSize: 13, fontWeight: "600" },
  btn: {
    marginTop: 4, paddingVertical: 14, borderRadius: 14,
    backgroundColor: theme.primary, alignItems: "center",
  },
  btnDim: { opacity: 0.6 },
  btnText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  btnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: theme.primary },
  linkBtn: { alignItems: "center", paddingVertical: 10, marginTop: 2 },
  linkText: { color: theme.primary, fontWeight: "700", fontSize: 14 },
});
