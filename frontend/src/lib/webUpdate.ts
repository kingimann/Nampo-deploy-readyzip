/**
 * Web-update kill switch.
 *
 * Background: the old installable-PWA build left a service worker that cached
 * the app shell, so some browsers kept serving a stale bundle even after a new
 * deploy (users had to manually unregister the worker). A self-destroying worker
 * neutralizes existing stale clients; this module handles every FUTURE update.
 *
 * The server publishes a `web_build` token in /public/app-config. Each web
 * client remembers the last token it saw. When the server's token changes (a new
 * deploy bumps RENDER_GIT_COMMIT, or an admin bumps it via /admin/web-build), the
 * client unregisters any service worker, clears all caches, and hard-reloads
 * ONCE to pick up the fresh bundle. It re-checks on launch, every 2 minutes, and
 * whenever a backgrounded tab returns to the foreground.
 *
 * Loop safety: the new token is stored BEFORE reloading, so even if a stale shell
 * is somehow re-served after the reload, the token already counts as "seen" and
 * we never reload again for it. A brand-new client just records the baseline and
 * does not reload (it already loaded the latest bundle).
 *
 * Web-only; a no-op on native.
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

/** Drop service workers + caches, then hard-reload. */
async function purgeAndReload(): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof caches !== "undefined" && caches.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
    }
  } catch {
    /* ignore */
  }
  try {
    window.location.reload();
  } catch {
    /* ignore */
  }
}

/** Compare the server token to what we last saw; update if it changed. */
export async function checkWebUpdate(): Promise<void> {
  if (!isWeb()) return;
  const server = await fetchServerBuild();
  if (server === null || server === "") return; // unreachable or not configured
  let seen: string | null = null;
  try {
    seen = localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (seen === null) {
    // First load on this client — record the baseline, don't reload.
    try {
      localStorage.setItem(STORAGE_KEY, server);
    } catch {
      /* ignore */
    }
    return;
  }
  if (seen !== server) {
    // Store the new token FIRST so a re-served stale shell can't loop.
    try {
      localStorage.setItem(STORAGE_KEY, server);
    } catch {
      /* ignore */
    }
    await purgeAndReload();
  }
}

/**
 * Start watching for new web builds: check on start, on a 2-minute interval, and
 * whenever a backgrounded tab returns to the foreground. Returns a cleanup fn.
 */
export function startWebUpdateWatcher(): () => void {
  if (!isWeb()) return () => {};
  // Don't block first paint — defer the initial check a tick.
  const initial = setTimeout(() => {
    checkWebUpdate();
  }, 1500);
  const id = setInterval(checkWebUpdate, 2 * 60 * 1000);
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
