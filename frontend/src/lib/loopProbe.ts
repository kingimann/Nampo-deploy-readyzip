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
const reported = new Set<string>();
const summary: string[] = [];

export function loopTick(name: string, detail?: string): void {
  if (Platform.OS !== "web") return;
  const now = Date.now();
  const arr = hits[name] || (hits[name] = []);
  arr.push(now);
  while (arr.length && now - arr[0] > 1000) arr.shift();
  // Report each component once (so a child winning the race can't hide the
  // real driver's detail), and accumulate them all into the title.
  if (arr.length >= 40 && !reported.has(name)) {
    reported.add(name);
    summary.push(`${name}[${detail || "?"}]`);
    try { document.title = `⚠ LOOP: ${summary.join(" | ")}`; } catch { /* ignore */ }
    try {
      // eslint-disable-next-line no-console
      console.error(`[LOOP DETECTED] ${name} re-rendered ${arr.length}×/s — changing: ${detail || "?"}. All so far: ${summary.join(" | ")}`);
    } catch { /* ignore */ }
  }
}

/** Call at the top of a component's render to probe it. `detail` names the
 *  input(s) that changed since the last render, to identify the loop driver. */
export function useLoopProbe(name: string, detail?: string): void {
  loopTick(name, detail);
}
