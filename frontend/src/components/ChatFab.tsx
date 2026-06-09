import React, { useCallback, useState } from "react";
import { StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { theme } from "@/src/theme";
import { storage } from "@/src/utils/storage";
import BouncyPressable from "@/src/components/BouncyPressable";

export const CHAT_FAB_SIDE_KEY = "chat_fab_side"; // "left" | "right"

/**
 * Floating chat button (like the compose FAB). Tap opens Chat; long-press flips
 * it between the bottom-left and bottom-right corners. The side is remembered
 * and can also be set in Settings → Privacy. When on the right it sits above
 * the compose FAB so the two don't overlap.
 */
export default function ChatFab() {
  const router = useRouter();
  const [side, setSide] = useState<"left" | "right">("right");

  useFocusEffect(useCallback(() => {
    let alive = true;
    storage.getItem(CHAT_FAB_SIDE_KEY, "right").then((v) => {
      if (alive) setSide(v === "left" ? "left" : "right");
    });
    return () => { alive = false; };
  }, []));

  const flip = async () => {
    const next = side === "right" ? "left" : "right";
    setSide(next);
    await storage.setItem(CHAT_FAB_SIDE_KEY, next);
  };

  return (
    <BouncyPressable
      style={[styles.fab, side === "right" ? { right: 18, bottom: 90 } : { left: 18, bottom: 20 }]}
      onPress={() => router.push("/(tabs)/messages")}
      onLongPress={flip}
      delayLongPress={350}
      testID="chat-fab"
      accessibilityLabel="Open chat (long-press to move sides)"
    >
      <Ionicons name="chatbubbles" size={22} color={theme.primary} />
    </BouncyPressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: theme.surfaceAlt,
    borderWidth: 1.5, borderColor: theme.primary,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
});
