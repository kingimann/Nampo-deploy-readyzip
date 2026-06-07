import React, { useRef } from "react";
import { Animated, Pressable, PressableProps, StyleProp, ViewStyle } from "react-native";

/**
 * A Pressable that springs down slightly while pressed and bounces back on
 * release — satisfying tactile feedback for buttons and cards. Uses the core
 * Animated API (native driver) so it works without the Reanimated babel plugin.
 */
type Props = Omit<PressableProps, "style"> & {
  scaleTo?: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

export default function PressableScale({
  scaleTo = 0.96, style, children, onPressIn, onPressOut, ...rest
}: Props) {
  const scale = useRef(new Animated.Value(1)).current;

  const handleIn = (e: any) => {
    Animated.spring(scale, { toValue: scaleTo, useNativeDriver: true, speed: 50, bounciness: 0 }).start();
    onPressIn?.(e);
  };
  const handleOut = (e: any) => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 4, tension: 140 }).start();
    onPressOut?.(e);
  };

  return (
    <Pressable onPressIn={handleIn} onPressOut={handleOut} {...rest}>
      <Animated.View style={[{ transform: [{ scale }] }, style]}>{children}</Animated.View>
    </Pressable>
  );
}
