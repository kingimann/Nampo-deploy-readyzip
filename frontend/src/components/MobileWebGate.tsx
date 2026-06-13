import React from "react";
import { View, Text, StyleSheet, Pressable, Linking, Platform } from "react-native";
import { theme } from "@/src/theme";
import { api } from "@/src/api/client";

/**
 * Mobile-web gate: phone browsers get an "open the app" wall, while desktop web
 * and the native iOS/Android app render normally. The inverse of the old
 * desktop-only gate — here we keep the full website on computers but push phone
 * visitors into the native app (the mobile website isn't a supported surface).
 */

// Where to send phone visitors. Update the store URLs once the app is published.
const APP_DEEP_LINK = "atlas://";   // app scheme (app.json "scheme")
const PLAY_URL = "https://play.google.com/store/apps/details?id=com.okayspace.mobile";
const APP_STORE_URL = "https://apps.apple.com/search?term=okayspace";

function isMobileWeb(): boolean {
  if (Platform.OS !== "web" || typeof navigator === "undefined" || typeof window === "undefined") {
    return false; // native app, or non-browser context → never gated
  }
  const ua = navigator.userAgent || "";
  // Phones (deliberately not tablets/iPads, which get the desktop site).
  const phoneUA = /iPhone|iPod|Android.*Mobile|webOS|BlackBerry|IEMobile|Opera Mini|Windows Phone/i.test(ua);
  // Fallback for phones with an unusual UA: a coarse (touch) pointer + narrow viewport.
  const coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  return phoneUA || (coarse && window.innerWidth < 768);
}

function isAndroidWeb(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "");
}

function MobileWebBlockedScreen() {
  const open = (url: string) => { try { Linking.openURL(url); } catch { /* noop */ } };
  const android = isAndroidWeb();
  return (
    <View style={styles.root}>
      <View style={styles.card}>
        <Text style={styles.brand}>OkaySpace</Text>
        <Text style={styles.title}>Continue in the app</Text>
        <Text style={styles.body}>
          OkaySpace is built for the app on your phone. Get it below to keep going —
          the mobile website isn’t supported. You can still use okayspace.ca on a computer.
        </Text>
        <Pressable style={styles.primary} onPress={() => open(APP_DEEP_LINK)} accessibilityRole="button">
          <Text style={styles.primaryText}>Open the app</Text>
        </Pressable>
        <Pressable
          style={styles.secondary}
          onPress={() => open(android ? PLAY_URL : APP_STORE_URL)}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryText}>{android ? "Get it on Google Play" : "Download on the App Store"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function MobileWebGate({ children }: { children: React.ReactNode }) {
  const [onPhone, setOnPhone] = React.useState<boolean>(isMobileWeb);
  // Admin kill-switch (default ON). Read from public app-config so the gate can be
  // turned off without a redeploy; until it loads we assume ON so the default holds.
  const [gateEnabled, setGateEnabled] = React.useState<boolean>(true);

  React.useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const recompute = () => setOnPhone((prev) => {
      const next = isMobileWeb();
      return prev === next ? prev : next; // only re-render when it actually flips
    });
    recompute();
    window.addEventListener("resize", recompute);
    window.addEventListener("orientationchange", recompute);
    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("orientationchange", recompute);
    };
  }, []);

  React.useEffect(() => {
    if (Platform.OS !== "web") return;
    let alive = true;
    api.getPublicAppConfig()
      .then((c) => { if (alive && c && c.mobile_web_gate === false) setGateEnabled(false); })
      .catch(() => { /* keep default ON on failure */ });
    return () => { alive = false; };
  }, []);

  if (onPhone && gateEnabled) return <MobileWebBlockedScreen />;
  return <>{children}</>;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0A0A0A",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    alignItems: "center",
  },
  brand: {
    color: theme.primary,
    fontSize: 24,
    fontWeight: "900",
    letterSpacing: -0.5,
    marginBottom: 18,
  },
  title: {
    color: theme.textPrimary,
    fontSize: 22,
    fontWeight: "800",
    textAlign: "center",
    marginBottom: 10,
  },
  body: {
    color: theme.textMuted,
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
    marginBottom: 24,
  },
  primary: {
    width: "100%",
    backgroundColor: theme.primary,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
  },
  primaryText: { color: "#04110D", fontSize: 16, fontWeight: "800" },
  secondary: {
    width: "100%",
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 12,
    borderWidth: 1,
    borderColor: "rgba(134,150,160,0.35)",
  },
  secondaryText: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
});
