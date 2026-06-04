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

  return (
    <View
      style={[
        styles.bar,
        { paddingBottom: insets.bottom, height: 62 + insets.bottom },
      ]}
    >
      <View style={styles.divider} pointerEvents="none" />
      <View style={styles.row}>
        {shortcuts.map((s) => {
          const active = isActivePath(pathname || "/", s);
          return (
            <Pressable
              key={s.id}
              onPress={() => {
                if (!active) router.push(s.route as any);
              }}
              onLongPress={goCustomize}
              delayLongPress={350}
              android_ripple={{ color: "rgba(255,255,255,0.06)", borderless: false }}
              style={styles.item}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityState={active ? { selected: true } : {}}
              testID={`tab-${s.id}`}
            >
              <Ionicons
                name={active ? s.iconFilled : s.iconOutline}
                size={24}
                color={active ? ACTIVE : INACTIVE}
              />
              <Text
                numberOfLines={1}
                style={[
                  styles.label,
                  { color: active ? ACTIVE : INACTIVE },
                  active && { fontWeight: "700" },
                ]}
              >
                {s.label}
              </Text>
            </Pressable>
          );
        })}
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
  label: {
    fontSize: 10.5,
    letterSpacing: 0.1,
    fontWeight: "500",
  },
});
