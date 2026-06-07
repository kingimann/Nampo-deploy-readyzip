import React, { useEffect, useRef } from "react";
import { Animated, StyleProp, ViewStyle } from "react-native";

/**
 * Fades + gently rises its children on mount. A cheap way to make screens and
 * lists feel alive. Core Animated API (native driver), no Reanimated plugin.
 */
export default function FadeIn({
  children, style, delay = 0, duration = 320, offset = 10,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  delay?: number;
  duration?: number;
  offset?: number;
}) {
  const v = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.timing(v, { toValue: 1, duration, delay, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [v, duration, delay]);

  const translateY = v.interpolate({ inputRange: [0, 1], outputRange: [offset, 0] });
  return (
    <Animated.View style={[{ opacity: v, transform: [{ translateY }] }, style]}>
      {children}
    </Animated.View>
  );
}
