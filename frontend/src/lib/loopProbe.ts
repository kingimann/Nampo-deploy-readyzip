import { Platform } from "react-native";

/**
 * TEMPORARY diagnostic for the desktop newsfeed re-render loop.
 *
 * Each probed component calls the probe every render, passing the list of its
 * own inputs that CHANGED since the previous render. We keep a 1s sliding window
 * per component; when one exceeds the threshold we report the keys that changed
 * MOST OFTEN across the window (the persistent driver), not whatever happened to
 * change on the single threshold render. "(parent)" means the component
 * re-rendered with no own-input change — i.e. a parent/provider re-rendered it.
 *
 * The culprit surfaces in the browser TAB TITLE (visible even with the console
 * filtered/cleared) and via console.error. Remove once the loop is fixed.
 */
const events: Record<string, { t: number; keys: string[] }[]> = {};
const reported = new Set<string>();
const summary: string[] = [];

export function loopTick(name: string, changedKeys?: string[]): void {
  if (Platform.OS !== "web") return;
  const now = Date.now();
  const arr = events[name] || (events[name] = []);
  arr.push({ t: now, keys: changedKeys && changedKeys.length ? changedKeys : ["(parent)"] });
  while (arr.length && now - arr[0].t > 1000) arr.shift();
  if (arr.length >= 40 && !reported.has(name)) {
    reported.add(name);
    const tally: Record<string, number> = {};
    for (const e of arr) for (const k of e.keys) tally[k] = (tally[k] || 0) + 1;
    const top = Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, c]) => `${k}×${c}`)
      .join(",");
    summary.push(`${name}{${top}/${arr.length}rps}`);
    try { document.title = `⚠ LOOP: ${summary.join(" | ")}`; } catch { /* ignore */ }
    try {
      // eslint-disable-next-line no-console
      console.error(`[LOOP DETECTED] ${summary.join(" | ")}`);
    } catch { /* ignore */ }
  }
}

/** Call every render. `changedKeys` = this component's inputs that changed since
 *  the last render (empty/undefined ⇒ parent-driven re-render). */
export function useLoopProbe(name: string, changedKeys?: string[]): void {
  loopTick(name, changedKeys);
}
