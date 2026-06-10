/**
 * Web build tracker.
 *
 * NOTE: auto-reload is DISABLED. An earlier version of this module hard-reloaded
 * the page (`location.reload()`) whenever the server's `web_build` token changed,
 * to push new deploys to open tabs. That turned out to be too dangerous as a
 * default: if a browser can READ localStorage but not WRITE it (read-only/quota/
 * privacy states), the new token never persists, so every check sees a mismatch
 * and reloads again — an unbreakable refresh loop (and the reload-budget guard
 * couldn't persist its timestamp either). Because a reload always lands back on
 * the home/feed tab, it looked feed-specific.
 *
 * This module now only RECORDS the latest build token. It never reloads the page.
 * A safe "update available — tap to refresh" prompt can be layered on later
 * without the page ever reloading itself. Web-only; a no-op on native.
 */
import { Platform } from "react-native";

import { BASE_URL } from "@/src/api/client";

const STORAGE_KEY = "okayspace_web_build";

function isWeb(): boolean {
  return (
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    typeof localStorage !== "undefined"
  );
}

/** Fetch the server's current web_build token, bypassing any HTTP/SW cache. */
async function fetchServerBuild(): Promise<string | null> {
  try {
    const res = await fetch(
      `${BASE_URL}/api/public/app-config?_=${Date.now()}`,
      { cache: "no-store", headers: { "Cache-Control": "no-cache" } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const wb = (data && data.web_build) || "";
    return typeof wb === "string" ? wb.trim() : "";
  } catch {
    return null;
  }
}

/**
 * Record the latest build token. Never reloads — just keeps a breadcrumb so a
 * newer build can be surfaced via a (future) non-intrusive prompt.
 */
export async function checkWebUpdate(): Promise<void> {
  if (!isWeb()) return;
  const server = await fetchServerBuild();
  if (server === null || server === "") return;
  let seen: string | null = null;
  try {
    seen = localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (seen !== server) {
    try {
      // eslint-disable-next-line no-console
      if (seen) console.info(`[okayspace] newer web build available (${seen} → ${server}); refresh when convenient`);
      localStorage.setItem(STORAGE_KEY, server);
    } catch {
      /* ignore — never throw, never reload */
    }
  }
}

/**
 * Keep the recorded build token current (on launch, every 5 min, and on
 * tab-foreground). Does NOT reload. Returns a cleanup fn. No-op on native.
 */
export function startWebUpdateWatcher(): () => void {
  if (!isWeb()) return () => {};
  const initial = setTimeout(() => {
    checkWebUpdate();
  }, 1500);
  const id = setInterval(checkWebUpdate, 5 * 60 * 1000);
  const onVisible = () => {
    if (document.visibilityState === "visible") checkWebUpdate();
  };
  try {
    document.addEventListener("visibilitychange", onVisible);
  } catch {
    /* ignore */
  }
  return () => {
    clearTimeout(initial);
    clearInterval(id);
    try {
      document.removeEventListener("visibilitychange", onVisible);
    } catch {
      /* ignore */
    }
  };
}
