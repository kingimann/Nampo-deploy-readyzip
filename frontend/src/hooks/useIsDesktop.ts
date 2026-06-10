import { useEffect, useState } from "react";
import { Platform } from "react-native";

/**
 * True on web when the viewport is at/above the desktop breakpoint.
 *
 * Why not `useWindowDimensions()`? That returns the raw width and re-renders the
 * consumer on EVERY change. On web the reported width can jitter rapidly
 * (sub-pixel rounding, a scrollbar toggling, or a layout/measure feedback) — and
 * when a component only needs the `>= bp` boolean, that jitter drove an infinite
 * re-render loop on the desktop newsfeed. This hook updates state ONLY when the
 * boolean actually flips, so width jitter that stays on one side of the
 * breakpoint causes no re-render.
 */
export function useIsDesktop(bp = 900): boolean {
  const compute = () =>
    Platform.OS === "web" && typeof window !== "undefined"
      ? window.innerWidth >= bp
      : false;
  const [isDesktop, setIsDesktop] = useState<boolean>(compute);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onResize = () => {
      const next = window.innerWidth >= bp;
      setIsDesktop((prev) => (prev === next ? prev : next)); // no-op unless it flips
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [bp]);
  return isDesktop;
}
