import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Easing } from "react-native";
import { useFocusEffect } from "expo-router";

/**
 * Drives a floating frosted top bar that slides up + fades out when the user
 * scrolls down a list and returns when they scroll up (or reach the top) —
 * the shared behaviour used by the feed, marketplace, messages, notifications,
 * groups, favorites and profile headers.
 *
 * Usage:
 *   const { topBarH, setTopBarH, onScroll, barStyle, barPointerEvents } = useFloatingHeader();
 *   <Animated.View onLayout={(e)=>setTopBarH(e.nativeEvent.layout.height)}
 *     pointerEvents={barPointerEvents} style={[styles.topBar, GLASS, barStyle(insets.top)]}>…</Animated.View>
 *   <FlatList onScroll={onScroll} scrollEventThrottle={16}
 *     contentContainerStyle={{ paddingTop: topBarH + 12, … }} />
 */
export function useFloatingHeader(defaultHeight = 70) {
  const [topHidden, setTopHidden] = useState(false);
  const [topBarH, setTopBarH] = useState(defaultHeight);
  const topHide = useRef(new Animated.Value(0)).current;
  const lastScrollY = useRef(0);

  const onScroll = useCallback((e: any) => {
    const y = e?.nativeEvent?.contentOffset?.y ?? 0;
    const dy = y - lastScrollY.current;
    if (y <= 4) setTopHidden(false);          // at the top → always show
    else if (dy > 6) setTopHidden(true);      // scrolling down → hide
    else if (dy < -6) setTopHidden(false);    // scrolling up → show
    lastScrollY.current = y;
  }, []);

  useEffect(() => {
    Animated.timing(topHide, {
      toValue: topHidden ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [topHidden, topHide]);

  // Never leave the bar stuck hidden when the screen regains focus.
  useFocusEffect(useCallback(() => { setTopHidden(false); lastScrollY.current = 0; }, []));

  const barStyle = useCallback(
    (insetTop: number) => ({
      opacity: topHide.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 0.25, 0] }),
      transform: [{ translateY: topHide.interpolate({ inputRange: [0, 1], outputRange: [0, -(topBarH + insetTop + 14)] }) }],
    }),
    [topHide, topBarH],
  );

  return {
    topHidden,
    topBarH,
    setTopBarH,
    onScroll,
    barStyle,
    barPointerEvents: (topHidden ? "none" : "box-none") as "none" | "box-none",
  };
}
