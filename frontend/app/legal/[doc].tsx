import React from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { theme } from "@/src/theme";

const EFFECTIVE = "June 5, 2026";

const TERMS: { h: string; p: string }[] = [
  { h: "1. Acceptance of Terms", p: "By creating an account or using Nami, you agree to these Terms of Service. If you do not agree, do not use the app." },
  { h: "2. Eligibility", p: "You must be at least 13 years old (or the minimum age of digital consent in your country) to use Nami. You are responsible for keeping your account credentials secure." },
  { h: "3. Your Content", p: "You retain ownership of the content you post. By posting, you grant Nami a non-exclusive, worldwide license to host, display, and distribute that content within the app so the service can function." },
  { h: "4. Acceptable Use", p: "Do not post illegal, harmful, hateful, or infringing content; do not harass others, spam, or attempt to disrupt or abuse the service or its API. We may remove content and suspend accounts that violate these rules." },
  { h: "5. Payments, Tips & Subscriptions", p: "Tips and subscriptions are currently simulated for testing and do not involve real money. When real payments are enabled, additional payment terms will apply and be shown before any charge." },
  { h: "6. Developer API", p: "API keys are tied to your account and must be kept secret. You are responsible for all activity under your keys. We may rate-limit or revoke keys that abuse the service." },
  { h: "7. Termination", p: "You may delete your account at any time. We may suspend or terminate accounts that violate these Terms or the law." },
  { h: "8. Disclaimer & Liability", p: "Nami is provided “as is” without warranties. To the extent permitted by law, we are not liable for indirect or consequential damages arising from your use of the app." },
  { h: "9. Changes", p: "We may update these Terms. When we make material changes we will ask you to review and accept the updated version before continuing to use Nami." },
  { h: "10. Contact", p: "Questions about these Terms can be sent to the app administrator." },
];

const PRIVACY: { h: string; p: string }[] = [
  { h: "1. Information We Collect", p: "Account details you provide (name, username, email, optional phone number), content you create (posts, messages, listings), and basic usage data needed to operate the app." },
  { h: "2. Location", p: "If you use maps, directions, or location-based features, we process your location to show nearby places and routes. You can control location access in your device settings." },
  { h: "3. How We Use Information", p: "To provide and improve the service: authenticate you, deliver your feed and messages, power search and directions, and keep the platform safe." },
  { h: "4. Sharing", p: "We do not sell your personal information. Content you post is visible according to its audience. Media you upload may be served via a content-delivery network." },
  { h: "5. Your Phone Number", p: "A phone number you add is stored on your profile and used for account recovery and, in the future, optional verification. It is not shared publicly." },
  { h: "6. Data Retention", p: "We keep your information while your account is active. When you delete your account, we remove or anonymize your personal data, subject to legal requirements." },
  { h: "7. Security", p: "Passwords are hashed and never stored in plain text. We use reasonable safeguards, but no system is perfectly secure." },
  { h: "8. Your Rights", p: "You can access, update, or delete your information from Settings. Contact the administrator for additional data requests." },
  { h: "9. Changes", p: "We may update this Policy. Material changes will require you to review and accept the updated version before continuing." },
  { h: "10. Contact", p: "Questions about privacy can be sent to the app administrator." },
];

export default function LegalScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { doc } = useLocalSearchParams<{ doc: string }>();
  const isPrivacy = doc === "privacy";
  const sections = isPrivacy ? PRIVACY : TERMS;
  const title = isPrivacy ? "Privacy Policy" : "Terms of Service";

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="legal-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn} testID="legal-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>{title}</Text>
        <View style={{ width: 40 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40 }}>
        <Text style={styles.effective}>Effective {EFFECTIVE}</Text>
        {sections.map((s, i) => (
          <View key={i} style={{ marginTop: 18 }}>
            <Text style={styles.h}>{s.h}</Text>
            <Text style={styles.p}>{s.p}</Text>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  backBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  effective: { color: theme.textMuted, fontSize: 13 },
  h: { color: theme.textPrimary, fontSize: 15.5, fontWeight: "800", marginBottom: 6 },
  p: { color: theme.textSecondary, fontSize: 14, lineHeight: 21 },
});
