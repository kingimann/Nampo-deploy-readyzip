import React, { useEffect, useRef, useState } from "react";
import { View, Text, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";

/**
 * Web-only pull-to-refresh that RELOADS the app.
 *
 * The installed PWA disables the browser's native pull-to-refresh (the app locks
 * the viewport), so there's no way to fetch a new deploy from the home-screen
 * app. Pulling down from the very top (the header/status-bar zone, so it never
 * fights content scrolling) reloads the page to get the latest version.
 */
export default function WebPullToRefresh() {
  const [pull, setPull] = useState(0);
  const pullRef = useRef(0);
  const startY = useRef<number | null>(null);
  const active = useRef(false);
  const THRESHOLD = 85;

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onStart = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      // Engage only from the top zone so we don't interfere with list scrolling.
      if (y < 110) { startY.current = y; active.current = true; }
      else { active.current = false; startY.current = null; }
    };
    const onMove = (e: TouchEvent) => {
      if (!active.current || startY.current == null) return;
      const dy = (e.touches[0]?.clientY ?? 0) - startY.current;
      if (dy > 0) { pullRef.current = Math.min(dy, 120); setPull(pullRef.current); }
    };
    const onEnd = () => {
      if (active.current && pullRef.current >= THRESHOLD) { window.location.reload(); return; }
      active.current = false; startY.current = null; pullRef.current = 0; setPull(0);
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
    };
  }, []);

  if (Platform.OS !== "web" || pull <= 0) return null;
  const ready = pull >= THRESHOLD;
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", top: 0, left: 0, right: 0, alignItems: "center", paddingTop: Math.max(2, pull - 34), zIndex: 99999 } as any}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.surface, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: theme.border, opacity: Math.min(1, pull / 55) }}>
        <Ionicons name={ready ? "arrow-up" : "refresh"} size={15} color={theme.primary} />
        <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "700" }}>{ready ? "Release to update" : "Pull to refresh"}</Text>
      </View>
    </View>
  );
}
