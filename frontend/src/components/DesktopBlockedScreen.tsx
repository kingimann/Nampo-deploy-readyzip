import React, { useEffect, useState } from "react";
import { View, Text, Image, Pressable, StyleSheet, Linking, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import QRCode from "qrcode";
import { theme } from "@/src/theme";

/**
 * Shown INSTEAD of the app when a desktop/PC browser hits the site while the
 * server `mobile_only` flag is on. OkaySpace is phone-first; this tells PC
 * visitors to open it on their phone (QR + URL) and offers the native apps.
 *
 * Store links aren't published yet — fill these in once the apps are live.
 */
const SITE_URL = "https://okayspace.ca";
const APP_STORE_URL = "https://okayspace.ca"; // TODO: App Store listing when published
const PLAY_STORE_URL = "https://okayspace.ca"; // TODO: Google Play listing when published

export default function DesktopBlockedScreen() {
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    QRCode.toDataURL(SITE_URL, {
      width: 240,
      margin: 1,
      color: { dark: "#0B141A", light: "#FFFFFF" },
    })
      .then(setQr)
      .catch(() => setQr(null));
  }, []);

  const open = (url: string) => { Linking.openURL(url).catch(() => {}); };

  return (
    <View style={styles.root}>
      <View style={styles.card}>
        <View style={styles.brandRow}>
          <View style={styles.brandDot}><Ionicons name="planet" size={22} color="#fff" /></View>
          <Text style={styles.brand}>OkaySpace</Text>
        </View>

        <Text style={styles.title}>OkaySpace is built for your phone</Text>
        <Text style={styles.sub}>
          The full experience lives on mobile. Scan the code or open{" "}
          <Text style={styles.link} onPress={() => open(SITE_URL)}>okayspace.ca</Text>{" "}
          on your phone to get started.
        </Text>

        <View style={styles.qrWrap}>
          {qr ? (
            <Image source={{ uri: qr }} style={styles.qr} />
          ) : (
            <View style={[styles.qr, styles.qrFallback]}>
              <Ionicons name="qr-code-outline" size={48} color={theme.textMuted} />
            </View>
          )}
        </View>
        <Text style={styles.scan}>Scan to open on your phone</Text>

        <View style={styles.stores}>
          <Pressable style={styles.store} onPress={() => open(APP_STORE_URL)} testID="store-ios">
            <Ionicons name="logo-apple" size={20} color="#fff" />
            <View>
              <Text style={styles.storeSmall}>Download on the</Text>
              <Text style={styles.storeBig}>App Store</Text>
            </View>
          </Pressable>
          <Pressable style={styles.store} onPress={() => open(PLAY_STORE_URL)} testID="store-android">
            <Ionicons name="logo-google-playstore" size={20} color="#fff" />
            <View>
              <Text style={styles.storeSmall}>Get it on</Text>
              <Text style={styles.storeBig}>Google Play</Text>
            </View>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    ...(Platform.OS === "web" ? ({ minHeight: "100vh" } as object) : {}),
  },
  card: {
    width: "100%",
    maxWidth: 440,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 24,
    padding: 32,
    alignItems: "center",
    gap: 14,
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 4 },
  brandDot: {
    width: 38, height: 38, borderRadius: 12, backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
  },
  brand: { color: theme.textPrimary, fontSize: 22, fontWeight: "800" },
  title: { color: theme.textPrimary, fontSize: 24, fontWeight: "800", textAlign: "center", lineHeight: 30 },
  sub: { color: theme.textSecondary, fontSize: 15, textAlign: "center", lineHeight: 22, maxWidth: 360 },
  link: { color: theme.primary, fontWeight: "700" },
  qrWrap: {
    marginTop: 10, padding: 12, backgroundColor: "#fff", borderRadius: 16,
  },
  qr: { width: 200, height: 200 },
  qrFallback: { alignItems: "center", justifyContent: "center", backgroundColor: theme.surfaceAlt, borderRadius: 8 },
  scan: { color: theme.textMuted, fontSize: 13, fontWeight: "600" },
  stores: { flexDirection: "row", gap: 12, marginTop: 12, flexWrap: "wrap", justifyContent: "center" },
  store: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#000", borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10,
    borderWidth: 1, borderColor: theme.borderStrong,
  },
  storeSmall: { color: "#cbd5e1", fontSize: 10, lineHeight: 12 },
  storeBig: { color: "#fff", fontSize: 15, fontWeight: "700", lineHeight: 18 },
});
