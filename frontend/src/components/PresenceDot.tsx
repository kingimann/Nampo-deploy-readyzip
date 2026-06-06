import React from "react";
import { View, StyleSheet } from "react-native";
import { theme } from "@/src/theme";

/** A small green dot overlaid on an avatar when the user is online. */
export default function PresenceDot({
  online, size = 12, borderColor = theme.surface, style,
}: { online?: boolean; size?: number; borderColor?: string; style?: any }) {
  if (!online) return null;
  return (
    <View
      style={[
        styles.dot,
        { width: size, height: size, borderRadius: size / 2, borderColor },
        style,
      ]}
    />
  );
}

/** Human-readable presence text, e.g. "Active now" / "Active 5m ago" / "Offline". */
export function presenceLabel(online?: boolean, lastSeen?: string | null): string {
  if (online) return "Active now";
  if (!lastSeen) return "Offline";
  const diff = Date.now() - new Date(lastSeen).getTime();
  if (isNaN(diff)) return "Offline";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Active recently";
  if (mins < 60) return `Active ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Active ${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `Active ${days}d ago`;
  return "Offline";
}

const styles = StyleSheet.create({
  dot: { position: "absolute", right: 0, bottom: 0, backgroundColor: "#22C55E", borderWidth: 2 },
});
