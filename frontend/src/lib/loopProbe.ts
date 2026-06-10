import { Platform } from "react-native";

/**
 * TEMPORARY diagnostic for the desktop newsfeed re-render/remount loop.
 *
 * A silent loop (no thrown error → no console output, no error-boundary screen)
 * is invisible. Each probed component calls `loopTick(name)` on every render;
 * if any name exceeds the threshold within a 1s window we surface the culprit
 * loudly — into the browser TAB TITLE (visible even with the console filtered or
 * cleared) and via console.error. Remove once the loop is fixed.
 */
const hits: Record<string, number[]> = {};
let reported = false;

export function loopTick(name: string): void {
  if (Platform.OS !== "web") return;
  const now = Date.now();
  const arr = hits[name] || (hits[name] = []);
  arr.push(now);
  while (arr.length && now - arr[0] > 1000) arr.shift();
  if (arr.length >= 40 && !reported) {
    reported = true;
    try { document.title = `⚠ LOOP: ${name} (${arr.length}/s)`; } catch { /* ignore */ }
    try {
      // eslint-disable-next-line no-console
      console.error(`[LOOP DETECTED] "${name}" re-rendered ${arr.length}× in the last second — this is the source of the "page keeps reloading" loop.`);
    } catch { /* ignore */ }
  }
}

/** Call at the top of a component's render to probe it. */
export function useLoopProbe(name: string): void {
  loopTick(name);
}
