import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Ionicons } from "@expo/vector-icons";

/**
 * Customizable left sidebar menu — same idea as the bottom nav bar: a catalog
 * of destinations, a persisted user selection, add/remove/reorder.
 */
export type SidebarItem = {
  id: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  route: string;
  color: string;
};

export const SIDEBAR_CATALOG: SidebarItem[] = [
  { id: "reels", label: "Reels", icon: "videocam", route: "/reels", color: "#EC4899" },
  { id: "groups", label: "Groups", icon: "people", route: "/(tabs)/groups", color: "#7C3AED" },
  { id: "communities", label: "Communities", icon: "chatbubbles", route: "/communities", color: "#EF4444" },
  { id: "marketplace", label: "Marketplace", icon: "storefront", route: "/(tabs)/marketplace", color: "#F59E0B" },
  { id: "settings", label: "Settings", icon: "settings", route: "/settings", color: "#64748B" },
  { id: "wallet", label: "Wallet", icon: "wallet", route: "/wallet", color: "#10B981" },
  { id: "feed", label: "Feed", icon: "home", route: "/(tabs)/feed", color: "#3B82F6" },
  { id: "map", label: "Map", icon: "map", route: "/(tabs)", color: "#14B8A6" },
  { id: "messages", label: "Messages", icon: "chatbubbles", route: "/(tabs)/messages", color: "#06B6D4" },
];

export const DEFAULT_SIDEBAR_IDS = [
  "feed", "reels", "groups", "marketplace", "settings",
];
// Items that are always present and can't be removed (only reordered).
export const LOCKED_SIDEBAR_IDS = ["feed", "settings"];
const MIN_ITEMS = 1;
const MAX_ITEMS = 12;
const STORAGE_KEY = "sidebar_menu_v1";

type Ctx = {
  ready: boolean;
  ids: string[];
  items: SidebarItem[];
  add: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  move: (id: string, direction: -1 | 1) => Promise<void>;
  reset: () => Promise<void>;
  canAdd: boolean;
  canRemove: boolean;
  lockedIds: string[];
};

const SidebarMenuContext = createContext<Ctx | null>(null);

function clamp(ids: string[]): string[] {
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    if (!SIDEBAR_CATALOG.find((s) => s.id === id)) continue;
    seen.add(id); valid.push(id);
  }
  // Locked items are always present — inject any that are missing (at the top).
  for (let k = LOCKED_SIDEBAR_IDS.length - 1; k >= 0; k--) {
    const id = LOCKED_SIDEBAR_IDS[k];
    if (!seen.has(id)) { valid.unshift(id); seen.add(id); }
  }
  if (valid.length < MIN_ITEMS) {
    for (const id of DEFAULT_SIDEBAR_IDS) {
      if (valid.length >= MIN_ITEMS) break;
      if (!seen.has(id)) { valid.push(id); seen.add(id); }
    }
  }
  return valid.slice(0, MAX_ITEMS);
}

export function SidebarMenuProvider({ children }: { children: React.ReactNode }) {
  const [ids, setIdsState] = useState<string[]>(DEFAULT_SIDEBAR_IDS);
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
    items: ids
      .map((id) => SIDEBAR_CATALOG.find((s) => s.id === id))
      .filter(Boolean) as SidebarItem[],
    add: async (id) => {
      if (ids.includes(id) || ids.length >= MAX_ITEMS) return;
      await persist([...ids, id]);
    },
    remove: async (id) => {
      if (LOCKED_SIDEBAR_IDS.includes(id)) return;   // permanent items can't be removed
      if (ids.length <= MIN_ITEMS) return;
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
    reset: () => persist(DEFAULT_SIDEBAR_IDS),
    canAdd: ids.length < MAX_ITEMS,
    canRemove: ids.length > MIN_ITEMS,
    lockedIds: LOCKED_SIDEBAR_IDS,
  }), [ids, ready, persist]);

  return <SidebarMenuContext.Provider value={value}>{children}</SidebarMenuContext.Provider>;
}

export function useSidebarMenu(): Ctx {
  const ctx = useContext(SidebarMenuContext);
  if (!ctx) {
    return {
      ready: true,
      ids: DEFAULT_SIDEBAR_IDS,
      items: DEFAULT_SIDEBAR_IDS.map((id) => SIDEBAR_CATALOG.find((s) => s.id === id)!).filter(Boolean),
      add: async () => {},
      remove: async () => {},
      move: async () => {},
      reset: async () => {},
      canAdd: false,
      canRemove: false,
      lockedIds: LOCKED_SIDEBAR_IDS,
    };
  }
  return ctx;
}
