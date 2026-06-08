import React, { useEffect, useRef } from "react";
import { Animated, Platform, StyleProp, ViewStyle } from "react-native";

// Keys that have already played their entrance, so FlatList recycling on scroll
// doesn't re-trigger the fade for items the user has already seen.
const _seen = new Set<string>();

/**
 * Fades + gently rises its children on mount. A cheap way to make screens and
 * lists feel alive. Core Animated API (native driver), no Reanimated plugin.
 *
 * Pass `animateKey` (e.g. a post id) in lists so each item animates only the
 * first time it appears, not every time it scrolls back into view.
 */
export default function FadeIn({
  children, style, delay = 0, duration = 320, offset = 10, animateKey,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  delay?: number;
  duration?: number;
  offset?: number;
  animateKey?: string;
}) {
  // On web the native driver isn't available, so these entrance animations run
  // on the JS thread via rAF — a feed full of them janks. Render instantly there.
  const first = Platform.OS === "web" ? false : (animateKey == null ? true : !_seen.has(animateKey));
  const v = useRef(new Animated.Value(first ? 0 : 1)).current;

  useEffect(() => {
    if (animateKey != null) _seen.add(animateKey);
    if (!first) return;
    const anim = Animated.timing(v, { toValue: 1, duration, delay, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [v, duration, delay, first, animateKey]);

  const translateY = v.interpolate({ inputRange: [0, 1], outputRange: [offset, 0] });
  return (
    <Animated.View style={[{ opacity: v, transform: [{ translateY }] }, style]}>
      {children}
    </Animated.View>
  );
}
