import React, { useState } from "react";
import { Platform, View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";
import QrCode from "@/src/components/QrCode";

const BYPASS_KEY = "nami_allow_desktop";

function isDesktopWeb(): boolean {
  if (Platform.OS !== "web" || typeof navigator === "undefined") return false;
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem(BYPASS_KEY) === "1") return false;
  } catch {}
  const ua = navigator.userAgent || "";
  const mobileUA = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini|Mobile|Silk/i.test(ua);
  const coarse = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;
  const touch = typeof navigator !== "undefined" && (navigator as any).maxTouchPoints > 1;
  // Allowed if it looks like a phone/tablet (mobile UA, touch, or coarse pointer).
  return !(mobileUA || coarse || touch);
}

/** Web-only: blocks desktop browsers and tells the user to open on their phone. */
export default function MobileOnlyGate({ children }: { children: React.ReactNode }) {
  const [blocked, setBlocked] = useState(isDesktopWeb());
  if (!blocked) return <>{children}</>;

  const url = typeof window !== "undefined" ? window.location.origin : "https://nampo-web.onrender.com";
  const allowAnyway = () => {
    try { localStorage.setItem(BYPASS_KEY, "1"); } catch {}
    setBlocked(false);
  };

  return (
    <View style={styles.root}>
      <View style={styles.card}>
        <Ionicons name="phone-portrait-outline" size={48} color={theme.primary} />
        <Text style={styles.title}>Nami is made for mobile</Text>
        <Text style={styles.sub}>Open this site on your phone to continue. Scan the code below to jump straight there.</Text>
        <View style={styles.qrWrap}>
          <QrCode value={url} size={180} dark="#0b141a" light="#ffffff" />
        </View>
        <Text style={styles.url}>{url.replace(/^https?:\/\//, "")}</Text>
        <TouchableOpacity onPress={allowAnyway} testID="desktop-continue">
          <Text style={styles.bypass}>Continue on desktop anyway</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center", padding: 24 },
  card: { width: "100%", maxWidth: 420, backgroundColor: theme.surface, borderRadius: 22, borderWidth: 1, borderColor: theme.border, padding: 30, alignItems: "center" },
  title: { color: theme.textPrimary, fontSize: 22, fontWeight: "900", marginTop: 14, textAlign: "center" },
  sub: { color: theme.textSecondary, fontSize: 14, lineHeight: 20, textAlign: "center", marginTop: 8 },
  qrWrap: { backgroundColor: "#fff", padding: 14, borderRadius: 16, marginTop: 22 },
  url: { color: theme.primary, fontSize: 14, fontWeight: "800", marginTop: 14 },
  bypass: { color: theme.textMuted, fontSize: 12.5, fontWeight: "600", marginTop: 22, textDecorationLine: "underline" },
});
