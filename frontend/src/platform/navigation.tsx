/**
 * Navigation seam — react-router-dom implementation (web stack).
 *
 * This replaces the expo-router pass-through. All ~99 call sites import the same
 * names (`useRouter`, `useLocalSearchParams`, `usePathname`, `useFocusEffect`,
 * `Redirect`, plus no-op `Stack`/`Tabs` shims), so the screens are unchanged —
 * the routing is now driven by `src/web/routes.tsx`.
 *
 * Pathnames stay in the existing expo-router style (e.g. `/chat/[id]`,
 * `/(tabs)/feed`); `buildHref` converts them to real URLs:
 *   - fills `[param]` from `params`
 *   - drops `(group)` segments (e.g. `/(tabs)/feed` -> `/feed`)
 *   - appends leftover params as a query string
 *
 * ⚠️ Untested scaffold — verify against a running `vite dev` (see src/web/).
 */
import React, { useEffect } from "react";
import {
  useNavigate,
  useParams,
  useLocation,
  useSearchParams,
  Navigate,
} from "react-router-dom";

type Href = string | { pathname: string; params?: Record<string, any> };

export function buildHref(input: Href): string {
  if (typeof input === "string") return stripGroups(input);
  const params = input.params || {};
  const used = new Set<string>();
  let pathname = (input.pathname || "/").replace(/\[([^\]]+)\]/g, (_m, k: string) => {
    used.add(k);
    return encodeURIComponent(String(params[k] ?? ""));
  });
  pathname = stripGroups(pathname) || "/";
  const qs = Object.entries(params)
    .filter(([k, v]) => !used.has(k) && v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `${pathname}?${qs}` : pathname;
}

/** Remove expo-router group segments: `/(tabs)/feed` -> `/feed`, `/(tabs)` -> `/`. */
function stripGroups(path: string): string {
  const out = path.replace(/\/\([^)]+\)/g, "");
  return out === "" ? "/" : out;
}

/** expo-router's `useRouter()` shape, backed by react-router's navigate. */
export function useRouter() {
  const navigate = useNavigate();
  return {
    push: (to: Href) => navigate(buildHref(to)),
    navigate: (to: Href) => navigate(buildHref(to)),
    replace: (to: Href) => navigate(buildHref(to), { replace: true }),
    back: () => navigate(-1),
    canGoBack: () => true,
    dismiss: () => navigate(-1),
    dismissAll: () => navigate("/"),
    setParams: (_p: Record<string, any>) => {
      /* no-op on web; use query params via push if needed */
    },
  };
}

/**
 * Imperative singleton (used by a couple of call sites outside components).
 * Best-effort via the History API + a popstate event so react-router picks it
 * up. Prefer `useRouter()` inside components.
 */
export const router = {
  push: (to: Href) => historyGo(buildHref(to), false),
  navigate: (to: Href) => historyGo(buildHref(to), false),
  replace: (to: Href) => historyGo(buildHref(to), true),
  back: () => window.history.back(),
};

function historyGo(href: string, replace: boolean) {
  if (replace) window.history.replaceState({}, "", href);
  else window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Merge of path params and query params, like expo-router's hook. */
export function useLocalSearchParams<T = Record<string, string>>(): T {
  const params = useParams();
  const [sp] = useSearchParams();
  return { ...params, ...Object.fromEntries(sp.entries()) } as unknown as T;
}

export function usePathname(): string {
  return useLocation().pathname;
}

/**
 * Run an effect when the screen becomes active. On web each route element
 * mounts/unmounts on navigation, so we re-run on location change. Pass the
 * effect via `useCallback` exactly as with expo-router.
 */
export function useFocusEffect(effect: () => void | (() => void)) {
  const loc = useLocation();
  useEffect(() => {
    const cleanup = effect();
    return typeof cleanup === "function" ? cleanup : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.key, effect]);
}

/** Declarative redirect, mirrors expo-router's `<Redirect href=… />`. */
export function Redirect({ href }: { href: Href }) {
  return <Navigate to={buildHref(href)} replace />;
}

/**
 * No-op shims so the old expo-router `_layout.tsx` files still type-check. They
 * are superseded by `src/web/routes.tsx` + `src/web/RootShell.tsx` and can be
 * deleted in cleanup.
 */
export const Stack: any = () => null;
Stack.Screen = (_: any) => null;
export const Tabs: any = () => null;
Tabs.Screen = (_: any) => null;
