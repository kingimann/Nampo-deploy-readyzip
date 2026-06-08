import { useEffect, useState } from "react";
import { Platform } from "react-native";

/**
 * Height (px) the on-screen keyboard overlaps the layout viewport on web.
 *
 * iOS Safari doesn't resize the layout viewport for the keyboard and
 * `KeyboardAvoidingView` is a no-op on web, so bottom sheets / modals (which are
 * position:fixed) end up behind the keyboard. Use this to offset them up.
 * Returns 0 on native — use KeyboardAvoidingView there.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const onChange = () => {
      const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setHeight(overlap > 80 ? overlap : 0); // ignore browser toolbars / small bars
    };
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
    onChange();
    return () => {
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
    };
  }, []);
  return height;
}
