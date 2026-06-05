import React from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePathname, useRouter } from "expo-router";
import { useNavBar } from "@/src/context/NavBarContext";
import { theme } from "@/src/theme";

/**
 * Facebook-style customizable bottom nav.
 * - Renders 3-5 shortcuts from useNavBar()
 * - Icons swap outline → filled when active
 * - Labels under icons (Facebook style)
 * - Long-press any tab → opens /customize-nav
 *
 * NOTE: This component is rendered by `<Tabs tabBar={...}>` but it does NOT
 * use React Navigation's tab state. It drives navigation via expo-router so
 * any pathname can be a shortcut (including non-tab routes like /notifications).
 */

const BG = theme.surface;
const DIVIDER = "rgba(0,0,0,0.55)";
const ACTIVE = theme.primary;
const INACTIVE = theme.textMuted;

function isActivePath(pathname: string, shortcut: { route: string; activeOn?: string[] }) {
  const patterns = shortcut.activeOn ?? [shortcut.route];
  // Normalize: strip trailing slashes (except root)
  const p = pathname === "/" ? "/" : pathname.replace(/\/+$/, "");
  return patterns.some((pat) => {
    if (pat === "/") return p === "/";
    if (p === pat) return true;
    if (p.startsWith(pat + "/")) return true;
    return false;
  });
}

export default function LiquidTabBar(_: any) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const { shortcuts } = useNavBar();

  const goCustomize = () => router.push("/customize-nav" as any);

  const renderItem = (s: typeof shortcuts[number]) => {
    const active = isActivePath(pathname || "/", s);
    return (
      <Pressable
        key={s.id}
        onPress={() => { if (!active) router.push(s.route as any); }}
        onLongPress={goCustomize}
        delayLongPress={350}
        android_ripple={{ color: "rgba(255,255,255,0.06)", borderless: false }}
        style={styles.item}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityState={active ? { selected: true } : {}}
        testID={`tab-${s.id}`}
      >
        <Ionicons name={active ? s.iconFilled : s.iconOutline} size={24} color={active ? ACTIVE : INACTIVE} />
        <Text numberOfLines={1} style={[styles.label, { color: active ? ACTIVE : INACTIVE }, active && { fontWeight: "700" }]}>
          {s.label}
        </Text>
      </Pressable>
    );
  };

  // Split the customizable shortcuts evenly around a permanent, non-removable
  // Search button pinned to the centre.
  const mid = Math.ceil(shortcuts.length / 2);
  const left = shortcuts.slice(0, mid);
  const right = shortcuts.slice(mid);
  const searchActive = (pathname || "").replace(/\/+$/, "") === "/search";

  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom, height: 62 + insets.bottom }]}>
      <View style={styles.divider} pointerEvents="none" />
      <View style={styles.row}>
        {left.map(renderItem)}
        <Pressable
          onPress={() => { if (!searchActive) router.push("/search" as any); }}
          android_ripple={{ color: "rgba(255,255,255,0.12)", borderless: true }}
          style={styles.centerItem}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Search the site"
          testID="tab-search"
        >
          <View style={[styles.searchCircle, searchActive && styles.searchCircleActive]}>
            <Ionicons name="search" size={22} color="#fff" />
          </View>
          <Text numberOfLines={1} style={[styles.label, styles.searchLabel, searchActive && { fontWeight: "700" }]}>Search</Text>
        </Pressable>
        {right.map(renderItem)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: BG,
  },
  divider: {
    position: "absolute", top: 0, left: 0, right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: DIVIDER,
  },
  row: {
    flexDirection: "row",
    paddingTop: 6,
    paddingBottom: 4,
  },
  item: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 6,
    gap: 2,
  },
  centerItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingTop: 2,
    gap: 2,
  },
  searchCircle: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: ACTIVE,
    alignItems: "center", justifyContent: "center",
    marginTop: -10,
    shadowColor: ACTIVE, shadowOpacity: 0.45, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
    elevation: 5,
    borderWidth: 3, borderColor: BG,
  },
  searchCircleActive: { backgroundColor: theme.primaryActive ?? ACTIVE },
  searchLabel: { color: ACTIVE, marginTop: -2 },
  label: {
    fontSize: 10.5,
    letterSpacing: 0.1,
    fontWeight: "500",
  },
});
