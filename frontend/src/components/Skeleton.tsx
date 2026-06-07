import React, { useEffect, useRef } from "react";
import { Animated, StyleProp, ViewStyle } from "react-native";
import { theme } from "@/src/theme";

/**
 * A single shimmering placeholder block (pulsing opacity). Core Animated API
 * (native driver), no Reanimated plugin. Compose several to build skeletons.
 */
export default function Skeleton({ style }: { style?: StyleProp<ViewStyle> }) {
  const pulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 750, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 750, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [pulse]);
  return (
    <Animated.View
      style={[{ backgroundColor: theme.surfaceAlt, borderRadius: 8, opacity: pulse }, style]}
    />
  );
}
