import React, { useEffect, useRef } from "react";
import { View, Text, StyleSheet, Pressable, Animated } from "react-native";
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

function TabItem({ s, active, onPress, onLongPress }: {
  s: { id: string; route: string; label: string; iconFilled: any; iconOutline: any };
  active: boolean; onPress: () => void; onLongPress: () => void;
}) {
  const press = useRef(new Animated.Value(1)).current;
  const pop = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(pop, { toValue: active ? 1 : 0, useNativeDriver: true, friction: 6, tension: 140 }).start();
  }, [active, pop]);
  const onIn = () => Animated.spring(press, { toValue: 0.85, useNativeDriver: true, speed: 50, bounciness: 0 }).start();
  const onOut = () => Animated.spring(press, { toValue: 1, useNativeDriver: true, friction: 4, tension: 140 }).start();
  const popScale = pop.interpolate({ inputRange: [0, 1], outputRange: [1, 1.14] });
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      onPressIn={onIn}
      onPressOut={onOut}
      android_ripple={{ color: "rgba(255,255,255,0.06)", borderless: false }}
      style={styles.item}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityState={active ? { selected: true } : {}}
      testID={`tab-${s.id}`}
    >
      <Animated.View style={[styles.itemInner, { transform: [{ scale: press }] }]}>
        <Animated.View style={[styles.iconWrap, active && styles.iconWrapActive, { transform: [{ scale: popScale }] }]}>
          <Ionicons name={active ? s.iconFilled : s.iconOutline} size={24} color={active ? ACTIVE : INACTIVE} />
        </Animated.View>
        <Text numberOfLines={1} style={[styles.label, { color: active ? ACTIVE : INACTIVE }, active && { fontWeight: "700" }]}>
          {s.label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

export default function LiquidTabBar(_: any) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const { shortcuts } = useNavBar();
  const searchScale = useRef(new Animated.Value(1)).current;

  const goCustomize = () => router.push("/customize-nav" as any);

  const renderItem = (s: typeof shortcuts[number]) => {
    const active = isActivePath(pathname || "/", s);
    return (
      <TabItem
        key={s.id}
        s={s}
        active={active}
        onPress={() => { if (!active) router.push(s.route as any); }}
        onLongPress={goCustomize}
      />
    );
  };

  // Split the customizable shortcuts evenly around a permanent, non-removable
  // Search button pinned to the centre.
  const mid = Math.ceil(shortcuts.length / 2);
  const left = shortcuts.slice(0, mid);
  const right = shortcuts.slice(mid);
  const searchActive = (pathname || "").replace(/\/+$/, "") === "/search";

  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom, height: 66 + insets.bottom }]}>
      <View style={styles.divider} pointerEvents="none" />
      <View style={styles.row}>
        {left.map(renderItem)}
        <Pressable
          onPress={() => { if (!searchActive) router.push("/search" as any); }}
          onPressIn={() => Animated.spring(searchScale, { toValue: 0.88, useNativeDriver: true, speed: 50, bounciness: 0 }).start()}
          onPressOut={() => Animated.spring(searchScale, { toValue: 1, useNativeDriver: true, friction: 4, tension: 140 }).start()}
          android_ripple={{ color: "rgba(255,255,255,0.12)", borderless: true }}
          style={styles.centerItem}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Search the site"
          testID="tab-search"
        >
          <Animated.View style={[styles.searchCircle, searchActive && styles.searchCircleActive, { transform: [{ scale: searchScale }] }]}>
            <Ionicons name="search" size={22} color="#fff" />
          </Animated.View>
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
    minHeight: 50,
  },
  itemInner: {
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  iconWrap: {
    paddingHorizontal: 16,
    paddingVertical: 3,
    borderRadius: 16,
  },
  iconWrapActive: {
    backgroundColor: ACTIVE + "22",
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
    fontSize: 11,
    letterSpacing: 0.1,
    fontWeight: "600",
  },
});
