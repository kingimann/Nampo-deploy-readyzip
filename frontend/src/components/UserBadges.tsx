import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { Badge } from "@/src/api/client";

const isImage = (icon: string) => icon.startsWith("http") || icon.startsWith("data:");

/** Renders a user's custom badges inline (next to their name), like the check. */
export default function UserBadges({ badges, size = 16, style }: { badges?: Badge[]; size?: number; style?: any }) {
  if (!badges || badges.length === 0) return null;
  return (
    <View style={[styles.row, style]}>
      {badges.slice(0, 4).map((b) =>
        isImage(b.icon) ? (
          <Image key={b.id} source={{ uri: b.icon }} style={{ width: size, height: size, borderRadius: 3, marginLeft: 4 }} />
        ) : (
          <Text key={b.id} style={[styles.emoji, { fontSize: size, color: b.color || undefined, marginLeft: 4 }]} accessibilityLabel={b.label}>
            {b.icon}
          </Text>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  emoji: { fontWeight: "900" },
});
