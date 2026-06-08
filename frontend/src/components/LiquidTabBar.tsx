import React, { useEffect, useRef, useState } from "react";
import { View, StyleSheet, Pressable, Animated, Easing, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePathname, useRouter } from "expo-router";
import { useNavBar } from "@/src/context/NavBarContext";
import { theme } from "@/src/theme";

/**
 * Floating, frosted "pill" bottom nav (Threads-style).
 * - Renders the customizable shortcuts from useNavBar() + a permanent centre Search.
 * - Icons swap outline → filled when active. Long-press any tab → /customize-nav.
 * - Hides when the user scrolls DOWN and reappears when scrolling UP. While
 *   hidden, a frosted ＋ circle appears; tapping it brings the pill back.
 *
 * Scroll direction is detected on web with a capture-phase `scroll` listener on
 * window, which catches scrolling from any inner ScrollView/FlatList without
 * having to wire every screen. On native the pill simply stays visible.
 */

const ACTIVE = theme.primary;
const INACTIVE = theme.textMuted;

// Frosted-glass surface (real blur on web; a denser translucent fill on native).
const GLASS: any =
  Platform.OS === "web"
    ? {
        backgroundColor: "rgba(31,44,51,0.72)",
        borderWidth: 1,
        borderColor: theme.borderStrong,
        backdropFilter: "blur(22px)",
        WebkitBackdropFilter: "blur(22px)",
      }
    : {
        backgroundColor: theme.surfaceGlass,
        borderWidth: 1,
        borderColor: theme.borderStrong,
      };

function isActivePath(pathname: string, shortcut: { route: string; activeOn?: string[] }) {
  const patterns = shortcut.activeOn ?? [shortcut.route];
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
  const onIn = () => Animated.spring(press, { toValue: 0.82, useNativeDriver: true, speed: 50, bounciness: 0 }).start();
  const onOut = () => Animated.spring(press, { toValue: 1, useNativeDriver: true, friction: 4, tension: 140 }).start();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      onPressIn={onIn}
      onPressOut={onOut}
      android_ripple={{ color: "rgba(255,255,255,0.08)", borderless: true }}
      style={styles.item}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityState={active ? { selected: true } : {}}
      testID={`tab-${s.id}`}
    >
      <Animated.View style={[styles.iconWrap, active && styles.iconWrapActive, { transform: [{ scale: press }] }]}>
        <Ionicons name={active ? s.iconFilled : s.iconOutline} size={25} color={active ? ACTIVE : INACTIVE} />
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

  // 0 = shown, 1 = hidden. Drives both the pill (slide down) and the ＋ (fade in).
  const [hidden, setHidden] = useState(false);
  const [holding, setHolding] = useState(false);   // long-pressing Search → compose
  const tv = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(tv, {
      toValue: hidden ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [hidden, tv]);

  // Never stay stuck hidden across navigation.
  useEffect(() => { setHidden(false); }, [pathname]);

  // Web: hide on scroll-down, show on scroll-up, from any scroll container.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    let lastY = 0;
    let lastEl: any = null;
    const onScroll = (e: any) => {
      const el = e.target;
      const y = el && typeof el.scrollTop === "number" ? el.scrollTop : (window.scrollY || 0);
      if (el !== lastEl) { lastEl = el; lastY = y; return; }  // new scroller → reset baseline
      const dy = y - lastY;
      if (y <= 6) setHidden(false);            // at the top → always show
      else if (dy > 8) setHidden(true);        // scrolling down → hide
      else if (dy < -8) setHidden(false);      // scrolling up → show
      lastY = y;
    };
    // Capture phase catches non-bubbling scroll events from inner scrollers.
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, []);

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

  const mid = Math.ceil(shortcuts.length / 2);
  const left = shortcuts.slice(0, mid);
  const right = shortcuts.slice(mid);
  const searchActive = (pathname || "").replace(/\/+$/, "") === "/search";

  const lift = 64 + insets.bottom + 18;  // distance to slide the pill fully off-screen
  const translateY = tv.interpolate({ inputRange: [0, 1], outputRange: [0, lift] });
  const pillOpacity = tv.interpolate({ inputRange: [0, 0.6, 1], outputRange: [1, 0.3, 0] });
  const fabOpacity = tv.interpolate({ inputRange: [0, 0.55, 1], outputRange: [0, 0, 1] });
  const fabScale = tv.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });

  return (
    <>
      {/* Floating frosted pill */}
      <Animated.View
        pointerEvents={hidden ? "none" : "box-none"}
        style={[styles.wrap, { bottom: insets.bottom + 8, opacity: pillOpacity, transform: [{ translateY }] }]}
      >
        <View style={[styles.pill, GLASS]}>
          {left.map(renderItem)}
          <Pressable
            onPress={() => { if (!searchActive) router.push("/search" as any); }}
            onLongPress={() => {
              // Hold Search to create: a post on the feed, a listing in the
              // marketplace. No-op on any other screen.
              const p = (pathname || "").replace(/\/+$/, "");
              const onFeed = p === "/feed";
              const onMarket = p === "/marketplace";
              if (!onFeed && !onMarket) return;
              setHolding(true);
              router.push(
                onMarket
                  ? ({ pathname: "/(tabs)/marketplace", params: { create: "1" } } as any)
                  : ({ pathname: "/(tabs)/feed", params: { compose: "1" } } as any),
              );
              setTimeout(() => setHolding(false), 700);
            }}
            delayLongPress={300}
            onPressIn={() => Animated.spring(searchScale, { toValue: 0.88, useNativeDriver: true, speed: 50, bounciness: 0 }).start()}
            onPressOut={() => Animated.spring(searchScale, { toValue: 1, useNativeDriver: true, friction: 4, tension: 140 }).start()}
            android_ripple={{ color: "rgba(255,255,255,0.12)", borderless: true }}
            style={styles.item}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Search the site — hold to create a post"
            testID="tab-search"
          >
            <Animated.View style={[styles.searchCircle, searchActive && styles.searchCircleActive, { transform: [{ scale: searchScale }] }]}>
              <Ionicons name={holding ? "add" : "search"} size={holding ? 26 : 21} color="#fff" />
            </Animated.View>
          </Pressable>
          {right.map(renderItem)}
        </View>
      </Animated.View>

      {/* Frosted ＋ circle shown while the pill is hidden — tap to bring it back. */}
      <Animated.View
        pointerEvents={hidden ? "auto" : "none"}
        style={[styles.fabWrap, { bottom: insets.bottom + 14, opacity: fabOpacity, transform: [{ scale: fabScale }] }]}
      >
        <Pressable
          onPress={() => setHidden(false)}
          android_ripple={{ color: "rgba(255,255,255,0.12)", borderless: true }}
          style={[styles.fab, GLASS]}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Show navigation bar"
          testID="tabbar-peek"
        >
          <Ionicons name="add" size={30} color={theme.textPrimary} />
        </Pressable>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute", left: 0, right: 0,
    alignItems: "center",
  },
  pill: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 8, paddingVertical: 7,
    borderRadius: 36,
    shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  item: {
    paddingHorizontal: 12, paddingVertical: 4,
    alignItems: "center", justifyContent: "center",
  },
  iconWrap: {
    paddingHorizontal: 10, paddingVertical: 7,
    borderRadius: 16,
    alignItems: "center", justifyContent: "center",
  },
  iconWrapActive: { backgroundColor: ACTIVE + "22" },
  searchCircle: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: ACTIVE,
    alignItems: "center", justifyContent: "center",
    marginHorizontal: 2,
    shadowColor: ACTIVE, shadowOpacity: 0.45, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  searchCircleActive: { backgroundColor: theme.primaryActive ?? ACTIVE },
  fabWrap: {
    position: "absolute", right: 16,
  },
  fab: {
    width: 54, height: 54, borderRadius: 27,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 14, shadowOffset: { width: 0, height: 5 },
    elevation: 12,
  },
});
