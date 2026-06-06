import { useEffect } from "react";
import { Platform } from "react-native";
import { useConfirm } from "@/src/context/ConfirmContext";

/**
 * Web-only: intercepts the browser **Back** button and **keyboard refresh**
 * (F5 / Ctrl+R / ⌘R) and asks for confirmation with an in-app dialog instead of
 * the browser's own popup. (The browser's refresh *toolbar button* and tab-close
 * can't be intercepted without the native beforeunload dialog, so they're left
 * alone by design.)
 */
export default function WebNavGuard() {
  const confirm = useConfirm();

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;

    let busy = false;

    const seed = () => { try { window.history.pushState(null, "", window.location.href); } catch {} };
    seed();

    const onPop = async () => {
      if (busy) return;
      // Cancel this back navigation by re-pushing our state…
      seed();
      busy = true;
      const leave = await confirm({
        title: "Leave this page?",
        message: "Going back will leave what you're doing. Use the in-app navigation to move around.",
        confirmLabel: "Go back",
        cancelLabel: "Stay",
        destructive: true,
      });
      busy = false;
      if (leave) {
        window.removeEventListener("popstate", onPop);
        try { window.history.go(-2); } catch { try { window.history.back(); } catch {} }
      }
    };
    window.addEventListener("popstate", onPop);

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
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onContext);
    };
  }, [confirm]);

  return null;
}
