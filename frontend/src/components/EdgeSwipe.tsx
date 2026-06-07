import React from "react";
import { Platform, StyleSheet, View } from "react-native";
import {
  Gesture,
  GestureDetector,
  PanGestureHandler,
  PanGestureHandlerStateChangeEvent,
  State,
} from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import { useNavHistory } from "@/src/context/NavHistoryContext";
import { theme } from "@/src/theme";

/**
 * Edge-swipe navigation: drag in from the left edge to go back, from the right
 * edge to go forward. A Reanimated handle follows your finger and a chevron
 * grows as you pull; release past the trigger to navigate, otherwise it springs
 * back. Touch only — disabled on web, where the browser owns back/forward.
 *
 * Reanimated drives the handle on the UI thread (needs `react-native-worklets/
 * plugin` in babel.config.js). If anything in the Reanimated path throws, the
 * ErrorBoundary falls back to a plain threshold swipe so navigation still works.
 */

const TRIGGER = 68;   // px of inward drag that fires navigation
const MAX = 110;      // how far the handle travels

function EdgeHandle({ side, onTrigger }: { side: "left" | "right"; onTrigger: () => void }) {
  const drag = useSharedValue(0);
  const dir = side === "left" ? 1 : -1;

  const pan = Gesture.Pan()
    .activeOffsetX(side === "left" ? [12, 9999] : [-9999, -12])
    .failOffsetY([-24, 24])
    .onUpdate((e) => {
      const d = dir * e.translationX;
      drag.value = Math.max(0, Math.min(d, MAX));
    })
    .onEnd((e) => {
      if (dir * e.translationX > TRIGGER) runOnJS(onTrigger)();
      drag.value = withSpring(0, { damping: 18, stiffness: 200 });
    });

  const handleStyle = useAnimatedStyle(() => ({
    opacity: interpolate(drag.value, [0, 18, MAX], [0, 0.9, 1], Extrapolation.CLAMP),
    transform: [
      { translateX: dir * interpolate(drag.value, [0, MAX], [-12, 30], Extrapolation.CLAMP) },
      { scale: interpolate(drag.value, [0, MAX], [0.65, 1.1], Extrapolation.CLAMP) },
    ],
  }));

  return (
    <GestureDetector gesture={pan}>
      <View style={[styles.strip, side === "left" ? styles.left : styles.right]}>
        <Animated.View style={[styles.handle, handleStyle]}>
          <Ionicons name={side === "left" ? "chevron-back" : "chevron-forward"} size={22} color="#fff" />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

function InteractiveEdgeSwipe() {
  const { goBack, goForward, canForward } = useNavHistory();
  return (
    <>
      <EdgeHandle side="left" onTrigger={goBack} />
      {canForward && <EdgeHandle side="right" onTrigger={goForward} />}
    </>
  );
}

/** Plain threshold swipe (JS-thread callbacks) — the safe fallback. */
function ClassicEdgeSwipe() {
  const { goBack, goForward } = useNavHistory();
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
        <View style={[styles.strip, styles.left]} />
      </PanGestureHandler>
      <PanGestureHandler activeOffsetX={[-9999, -14]} failOffsetY={[-22, 22]} onHandlerStateChange={onForward}>
        <View style={[styles.strip, styles.right]} />
      </PanGestureHandler>
    </>
  );
}

class EdgeBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { /* swallow — fall back to the classic swipe */ }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export default function EdgeSwipe() {
  if (Platform.OS === "web") return null;
  return (
    <EdgeBoundary fallback={<ClassicEdgeSwipe />}>
      <InteractiveEdgeSwipe />
    </EdgeBoundary>
  );
}

const styles = StyleSheet.create({
  // Narrow vertical bands at the screen edges, kept clear of the header and
  // bottom bar so they don't shadow back buttons or the tab bar.
  strip: { position: "absolute", top: 96, bottom: 110, width: 30, justifyContent: "center" },
  left: { left: 0, alignItems: "flex-start" },
  right: { right: 0, alignItems: "flex-end" },
  // The pill that follows the finger; starts hidden just off the edge.
  handle: {
    width: 40, height: 40, borderRadius: 20, marginHorizontal: 3,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
});
