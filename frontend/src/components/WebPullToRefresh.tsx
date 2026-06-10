import React, { useEffect, useRef, useState } from "react";
import { View, Text, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";

/**
 * Web-only pull-to-refresh that RELOADS the app.
 *
 * The installed PWA disables the browser's native pull-to-refresh (the app locks
 * the viewport), so there's no way to fetch a new deploy from the home-screen
 * app. Dragging down from ANYWHERE on the screen — as long as the content under
 * your finger is scrolled to the top — reloads the page to get the latest
 * version, exactly like a normal scrolling page.
 *
 * The trigger distance is ADAPTIVE: starting a pull low on the screen (e.g. at
 * the bottom nav bar) leaves little room to drag down, so we require much less
 * travel there; up top we use the full distance to avoid accidental reloads.
 * Mostly-horizontal swipes are ignored so carousels/tabs still work.
 */
export default function WebPullToRefresh() {
  const [pull, setPull] = useState(0);
  const [ready, setReady] = useState(false);
  const pullRef = useRef(0);
  const startY = useRef<number | null>(null);
  const startX = useRef<number | null>(null);
  const threshRef = useRef(56);
  const active = useRef(false);
  const BASE = 56;   // normal pull distance (when there's plenty of room below)
  const MIN = 30;    // minimum when starting near the very bottom of the screen

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    // Touch-only gesture — never attach on desktop (mouse) so it can't trigger
    // a reload there.
    const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    // Only the INSTALLED PWA (standalone display mode) disables the browser's
    // own pull-to-refresh, so only there do we need to provide our own. In a
    // normal browser tab this gesture is redundant AND, on touch-capable
    // laptops, can misfire window.location.reload() — the "page keeps
    // reloading" some users hit. Gate it to standalone so a regular tab is
    // never reloaded by it.
    const standalone =
      (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) ||
      (navigator as any).standalone === true;
    if (!coarse || !standalone) return;
    const viewportH = () =>
      (window.visualViewport?.height || window.innerHeight || 800);
    // True when the scroll container under the finger is already at the top, so a
    // downward pull is an overscroll (refresh intent) rather than normal scroll.
    // Non-scrollable regions (like the bottom nav bar) fall through to `true`.
    const atScrollTop = (el: any): boolean => {
      let n = el;
      while (n && n !== document.body && n !== document.documentElement) {
        try {
          const oy = getComputedStyle(n).overflowY;
          if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 2) {
            return (n.scrollTop || 0) <= 0;
          }
        } catch {}
        n = n.parentElement;
      }
      return true;
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      // Engage whenever the scroll container under the finger is at the very top,
      // regardless of WHERE on the screen the drag starts.
      if (atScrollTop(e.target as any)) {
        const y = t?.clientY ?? 0;
        startY.current = y;
        startX.current = t?.clientX ?? 0;
        active.current = true;
        // How far down can the finger physically travel from here? Require less
        // travel when starting low so a pull from the bottom nav bar registers.
        const roomBelow = viewportH() - y;
        threshRef.current = Math.max(MIN, Math.min(BASE, roomBelow - 24));
      } else { active.current = false; startY.current = null; }
    };
    const onMove = (e: TouchEvent) => {
      if (!active.current || startY.current == null) return;
      const t = e.touches[0];
      const dy = (t?.clientY ?? 0) - startY.current;
      const dx = (t?.clientX ?? 0) - (startX.current ?? 0);
      // Only treat clearly-downward, vertical-dominant drags as a pull, so
      // horizontal swipes (carousels, tab swipes) aren't hijacked.
      if (dy > 0 && dy > Math.abs(dx)) {
        pullRef.current = Math.min(dy, 130);
        setPull(pullRef.current);
        setReady(pullRef.current >= threshRef.current);
      }
    };
    const onEnd = () => {
      if (active.current && pullRef.current >= threshRef.current) {
        try { sessionStorage.setItem("okayspace_refreshed", "1"); } catch {}
        window.location.reload();
        return;
      }
      active.current = false; startY.current = null; pullRef.current = 0;
      setPull(0); setReady(false);
    };
    // Capture phase so list/touchable children can't swallow the gesture before
    // we see it (the reason the pull often didn't register).
    const opts = { passive: true, capture: true } as any;
    window.addEventListener("touchstart", onStart, opts);
    window.addEventListener("touchmove", onMove, opts);
    window.addEventListener("touchend", onEnd, opts);
    window.addEventListener("touchcancel", onEnd, opts);
    return () => {
      window.removeEventListener("touchstart", onStart, opts);
      window.removeEventListener("touchmove", onMove, opts);
      window.removeEventListener("touchend", onEnd, opts);
      window.removeEventListener("touchcancel", onEnd, opts);
    };
  }, []);

  if (Platform.OS !== "web" || pull <= 0) return null;
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", top: 0, left: 0, right: 0, alignItems: "center", paddingTop: Math.max(2, pull - 34), zIndex: 99999 } as any}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.surface, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: theme.border, opacity: Math.min(1, pull / 40) }}>
        <Ionicons name={ready ? "arrow-up" : "refresh"} size={15} color={theme.primary} />
        <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "700" }}>{ready ? "Release to refresh" : "Pull to refresh"}</Text>
      </View>
    </View>
  );
}
