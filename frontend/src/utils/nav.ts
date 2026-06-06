import { router } from "expo-router";

/**
 * Go back when there's somewhere to go back to; otherwise navigate to a sensible
 * fallback route. This fixes back/close (X) buttons that silently do nothing
 * when the navigation history is empty — which happens on a cold-start deep
 * link, a directly-opened web URL, or after `router.replace` reset the stack.
 */
export function safeBack(fallback: string = "/(tabs)/feed") {
  try {
    // expo-router's imperative router exposes canGoBack() on the singleton.
    if ((router as any).canGoBack && (router as any).canGoBack()) {
      router.back();
      return;
    }
  } catch {}
  try { router.replace(fallback as any); } catch {}
}
