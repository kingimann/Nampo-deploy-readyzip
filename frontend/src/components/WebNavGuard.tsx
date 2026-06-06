import { useEffect } from "react";
import { Platform } from "react-native";
import { useConfirm } from "@/src/context/ConfirmContext";

/**
 * Web-only hardening: confirms **keyboard refresh** (F5 / Ctrl+R / ⌘R) with an
 * in-app dialog, and blocks save / view-source / dev-tools shortcuts and the
 * right-click context menu. It does NOT touch the browser Back button — that's
 * the app's own navigation (expo-router uses browser history).
 */
export default function WebNavGuard() {
  const confirm = useConfirm();

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;

    let busy = false;

    // NOTE: we deliberately do NOT intercept the browser Back button — the app's
    // own navigation (expo-router) is built on browser history, so trapping
    // popstate breaks every in-app back action.

    const onKey = async (e: KeyboardEvent) => {
      const k = (e.key || "").toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      // Block common save / view-source / dev-tools shortcuts.
      if (
        e.key === "F12" ||
        (mod && k === "s") ||                                   // Save page
        (mod && k === "u") ||                                   // View source
        (mod && k === "p") ||                                   // Print
        (mod && e.shiftKey && (k === "i" || k === "j" || k === "c"))  // DevTools
      ) {
        e.preventDefault();
        return;
      }
      // Refresh → in-app confirm.
      const refresh = e.key === "F5" || (mod && (k === "r"));
      if (!refresh || busy) return;
      e.preventDefault();
      busy = true;
      const reload = await confirm({
        title: "Reload the page?",
        message: "You may lose anything you're in the middle of.",
        confirmLabel: "Reload",
        cancelLabel: "Stay",
      });
      busy = false;
      if (reload) window.location.reload();
    };
    window.addEventListener("keydown", onKey);

    // Disable the right-click context menu across the site.
    const onContext = (e: MouseEvent) => { e.preventDefault(); };
    window.addEventListener("contextmenu", onContext);

    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onContext);
    };
  }, [confirm]);

  return null;
}
