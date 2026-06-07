import React from "react";
import { Platform, StyleSheet, View } from "react-native";
import {
  PanGestureHandler,
  PanGestureHandlerStateChangeEvent,
  State,
} from "react-native-gesture-handler";
import { useNavHistory } from "@/src/context/NavHistoryContext";

/**
 * Edge-swipe navigation: drag in from the left edge to go back, from the
 * right edge to go forward (browser-style). Thin edge strips keep the gesture
 * away from inner horizontal scrollers (reels, carousels) and mid-screen
 * buttons. Touch only — disabled on web, where the browser owns back/forward.
 *
 * Uses the classic PanGestureHandler (JS-thread callbacks) so it works without
 * the Reanimated worklets babel plugin, which this app doesn't configure.
 */
export default function EdgeSwipe() {
  const { goBack, goForward } = useNavHistory();
  if (Platform.OS === "web") return null;

  const onBack = (e: PanGestureHandlerStateChangeEvent) => {
    const n = e.nativeEvent;
    if (n.state === State.END && n.translationX > 55 && Math.abs(n.translationY) < 80) goBack();
  };
  const onForward = (e: PanGestureHandlerStateChangeEvent) => {
    const n = e.nativeEvent;
    if (n.state === State.END && n.translationX < -55 && Math.abs(n.translationY) < 80) goForward();
  };

  return (
    <>
      <PanGestureHandler activeOffsetX={[14, 9999]} failOffsetY={[-22, 22]} onHandlerStateChange={onBack}>
        <View style={[styles.strip, styles.left]}>
          {/* Subtle hint that you can swipe in from the edge to go back. */}
          <View style={styles.handle} pointerEvents="none" />
        </View>
      </PanGestureHandler>
      <PanGestureHandler activeOffsetX={[-9999, -14]} failOffsetY={[-22, 22]} onHandlerStateChange={onForward}>
        <View style={[styles.strip, styles.right]} />
      </PanGestureHandler>
    </>
  );
}

const styles = StyleSheet.create({
  // Narrow vertical bands at the screen edges, kept clear of the header and
  // bottom bar so they don't shadow back buttons or the tab bar.
  strip: { position: "absolute", top: 96, bottom: 110, width: 26 },
  left: { left: 0, justifyContent: "center", alignItems: "flex-start" },
  right: { right: 0 },
  // A faint vertical grabber at the left edge, vertically centered by the strip.
  handle: {
    marginLeft: 2,
    width: 4,
    height: 46,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.16)",
  },
});
