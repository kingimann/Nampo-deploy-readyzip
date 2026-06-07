import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Ionicons } from "@expo/vector-icons";

/**
 * Facebook-style customizable nav bar.
 *
 * - A static catalog defines every "shortcut" the user can add to the bar.
 * - The user selects between 3 and 5 shortcuts. Their selection is persisted
 *   in AsyncStorage and provided through context to the tab bar + customize
 *   screen.
 */

export type NavShortcut = {
  id: string;
  label: string;
  iconOutline: keyof typeof Ionicons.glyphMap;
  iconFilled: keyof typeof Ionicons.glyphMap;
  /**
   * Pathname pushed when the shortcut is tapped. We use raw strings (not the
   * typed Href map) so non-tab routes work too.
   */
  route: string;
  /**
   * Pathnames that should count as "active" for this shortcut. Defaults to
   * [route]. Useful for grouping (e.g. /post/[id] activates the feed tab).
   */
  activeOn?: string[];
};

export const NAV_CATALOG: NavShortcut[] = [
  {
    id: "feed", label: "Home",
    iconOutline: "home-outline", iconFilled: "home",
    route: "/feed",
    activeOn: ["/feed", "/post", "/user", "/hashtag"],
  },
  {
    id: "map", label: "Map",
    iconOutline: "map-outline", iconFilled: "map",
    route: "/",
    activeOn: ["/", "/directions", "/eta", "/place", "/guide", "/g"],
  },
  {
    id: "messages", label: "Chat",
    iconOutline: "chatbubbles-outline", iconFilled: "chatbubbles",
    route: "/messages",
    activeOn: ["/messages", "/chat"],
  },
  {
    id: "groups", label: "Groups",
    iconOutline: "people-outline", iconFilled: "people",
    route: "/groups",
    activeOn: ["/groups", "/group"],
  },
  {
    id: "marketplace", label: "Market",
    iconOutline: "storefront-outline", iconFilled: "storefront",
    route: "/marketplace",
  },
  {
    id: "reels", label: "Reels",
    iconOutline: "play-circle-outline", iconFilled: "play-circle",
    route: "/reels",
  },
  {
    id: "profile", label: "You",
    iconOutline: "person-outline", iconFilled: "person",
    route: "/profile",
  },
];

export const DEFAULT_NAV_IDS = ["feed", "map", "messages", "groups"];
const MIN_TABS = 3;
const MAX_TABS = 4;
const STORAGE_KEY = "nav_bar_tabs_v1";

type Ctx = {
  ready: boolean;
  ids: string[];
  shortcuts: NavShortcut[];
  setIds: (ids: string[]) => Promise<void>;
  add: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  move: (id: string, direction: -1 | 1) => Promise<void>;
  reset: () => Promise<void>;
  canAdd: boolean;
  canRemove: boolean;
};

const NavBarContext = createContext<Ctx | null>(null);

function clamp(ids: string[]): string[] {
  // Dedupe, drop unknowns, clamp length
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    if (!NAV_CATALOG.find((s) => s.id === id)) continue;
    seen.add(id); valid.push(id);
  }
  if (valid.length < MIN_TABS) {
    for (const id of DEFAULT_NAV_IDS) {
      if (valid.length >= MIN_TABS) break;
      if (!seen.has(id)) { valid.push(id); seen.add(id); }
    }
  }
  return valid.slice(0, MAX_TABS);
}

export function NavBarProvider({ children }: { children: React.ReactNode }) {
  const [ids, setIdsState] = useState<string[]>(DEFAULT_NAV_IDS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) setIdsState(clamp(parsed));
        }
      } catch {} finally { setReady(true); }
    })();
  }, []);

  const persist = useCallback(async (next: string[]) => {
    const cleaned = clamp(next);
    setIdsState(cleaned);
    try { await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned)); } catch {}
  }, []);

  const value = useMemo<Ctx>(() => ({
    ready,
    ids,
    shortcuts: ids
      .map((id) => NAV_CATALOG.find((s) => s.id === id))
      .filter(Boolean) as NavShortcut[],
    setIds: (next) => persist(next),
    add: async (id) => {
      if (ids.includes(id)) return;
      if (ids.length >= MAX_TABS) return;
      await persist([...ids, id]);
    },
    remove: async (id) => {
      if (ids.length <= MIN_TABS) return;
      await persist(ids.filter((x) => x !== id));
    },
    move: async (id, direction) => {
      const i = ids.indexOf(id);
      if (i < 0) return;
      const j = i + direction;
      if (j < 0 || j >= ids.length) return;
      const next = [...ids];
      [next[i], next[j]] = [next[j], next[i]];
      await persist(next);
    },
    reset: () => persist(DEFAULT_NAV_IDS),
    canAdd: ids.length < MAX_TABS,
    canRemove: ids.length > MIN_TABS,
  }), [ids, ready, persist]);

  return <NavBarContext.Provider value={value}>{children}</NavBarContext.Provider>;
}

export function useNavBar(): Ctx {
  const ctx = useContext(NavBarContext);
  if (!ctx) {
    // Fallback so the hook can be called outside the provider during HMR.
    return {
      ready: true,
      ids: DEFAULT_NAV_IDS,
      shortcuts: DEFAULT_NAV_IDS.map((id) => NAV_CATALOG.find((s) => s.id === id)!).filter(Boolean),
      setIds: async () => {},
      add: async () => {},
      remove: async () => {},
      move: async () => {},
      reset: async () => {},
      canAdd: false,
      canRemove: false,
    };
  }
  return ctx;
}
