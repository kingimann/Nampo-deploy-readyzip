import React, { useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import { api } from "@/src/api/client";
import DesktopBlockedScreen from "./DesktopBlockedScreen";

/**
 * OkaySpace is phone-first. When the server `mobile_only` flag is on, desktop/PC
 * browsers are blocked and shown the "open on your phone" screen instead of the
 * app. The native iOS/Android apps and phone browsers are never gated.
 *
 * "PC" = a non-touch (mouse) web client. Phones/tablets are touch devices and
 * always pass, regardless of window size. We fail OPEN: if the config can't be
 * read, we render the app rather than locking everyone out on a network blip.
 */
function isPcWeb(): boolean {
  if (Platform.OS !== "web" || typeof window === "undefined") return false;
  try {
    const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    const touch = "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0;
    return !coarse && !touch;
  } catch {
    return true; // if we can't tell, treat as PC (it's the gated case)
  }
}

export default function MobileOnlyGate({ children }: { children: React.ReactNode }) {
  const pc = useMemo(() => isPcWeb(), []);
  const [state, setState] = useState<"checking" | "blocked" | "allowed">(pc ? "checking" : "allowed");

  useEffect(() => {
    if (!pc) return; // native + phone browsers: always allowed
    let alive = true;
    api
      .getPublicAppConfig()
      .then((cfg: { mobile_only?: boolean }) => { if (alive) setState(cfg?.mobile_only ? "blocked" : "allowed"); })
      .catch(() => { if (alive) setState("allowed"); }); // fail open
    return () => { alive = false; };
  }, [pc]);

  if (state === "blocked") return <DesktopBlockedScreen />;
  // Brief: avoids flashing the whole app on a PC that's about to be blocked.
  if (state === "checking") return null;
  return <>{children}</>;
}
