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
  { id: "notifications", label: "Notifications", icon: "notifications", route: "/notifications", color: "#EF4444" },
  { id: "reels", label: "Reels", icon: "videocam", route: "/reels", color: "#EC4899" },
  { id: "bookmarks", label: "Bookmarks", icon: "bookmark", route: "/bookmarks", color: "#00A884" },
  { id: "groups", label: "Groups", icon: "people", route: "/(tabs)/groups", color: "#7C3AED" },
  { id: "communities", label: "Communities", icon: "chatbubbles", route: "/communities", color: "#EF4444" },
  { id: "marketplace", label: "Marketplace", icon: "storefront", route: "/(tabs)/marketplace", color: "#F59E0B" },
  { id: "favorites", label: "Saved Places", icon: "location", route: "/(tabs)/favorites", color: "#22C55E" },
  { id: "settings", label: "Settings", icon: "settings", route: "/settings", color: "#64748B" },
  { id: "advertise", label: "Advertise", icon: "megaphone", route: "/advertise", color: "#F97316" },
  { id: "wallet", label: "Wallet", icon: "wallet", route: "/wallet", color: "#10B981" },
  { id: "people", label: "Find People", icon: "person-add", route: "/people", color: "#0EA5E9" },
  { id: "feed", label: "Feed", icon: "home", route: "/(tabs)/feed", color: "#3B82F6" },
  { id: "map", label: "Map", icon: "map", route: "/(tabs)", color: "#14B8A6" },
  { id: "messages", label: "Messages", icon: "chatbubbles", route: "/(tabs)/messages", color: "#06B6D4" },
  { id: "directions", label: "Directions", icon: "navigate", route: "/(tabs)/directions", color: "#8B5CF6" },
  { id: "customize-nav", label: "Customize nav bar", icon: "grid", route: "/customize-nav", color: "#0EA5E9" },
];

export const DEFAULT_SIDEBAR_IDS = [
  "notifications", "reels", "bookmarks", "groups", "marketplace", "favorites", "settings",
];
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
    };
  }
  return ctx;
}
