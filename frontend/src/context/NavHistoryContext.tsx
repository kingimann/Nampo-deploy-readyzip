import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "expo-router";

/**
 * Lightweight browser-style history so a right-edge swipe can go "forward"
 * to a screen you previously backed out of. We track the pathname stack and
 * an index; going back/forward moves the index, a brand-new navigation
 * truncates the forward entries (exactly like a web browser).
 *
 * Only the pathname is tracked — path params live in the pathname itself
 * (e.g. /chat/123), so forward navigation reconstructs them. Extra query
 * params (drafts, focus ids) are intentionally not restored.
 */
type NavHistory = {
  goBack: () => void;
  goForward: () => void;
  canForward: boolean;
};

const Ctx = createContext<NavHistory>({ goBack: () => {}, goForward: () => {}, canForward: false });

export function NavHistoryProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const histRef = useRef<string[]>([]);
  const idxRef = useRef(-1);
  const [canForward, setCanForward] = useState(false);

  useEffect(() => {
    if (!pathname) return;
    const h = histRef.current;
    const i = idxRef.current;
    if (i >= 0 && h[i] === pathname) return; // no change
    if (i > 0 && h[i - 1] === pathname) {
      idxRef.current = i - 1; // went back
    } else if (i < h.length - 1 && h[i + 1] === pathname) {
      idxRef.current = i + 1; // went forward
    } else {
      const base = h.slice(0, i + 1); // new nav: drop forward entries
      base.push(pathname);
      histRef.current = base;
      idxRef.current = base.length - 1;
    }
    setCanForward(idxRef.current < histRef.current.length - 1);
  }, [pathname]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)/feed");
  }, [router]);

  const goForward = useCallback(() => {
    const h = histRef.current;
    const i = idxRef.current;
    if (i < h.length - 1) router.push(h[i + 1] as any);
  }, [router]);

  return <Ctx.Provider value={{ goBack, goForward, canForward }}>{children}</Ctx.Provider>;
}

export const useNavHistory = () => useContext(Ctx);
