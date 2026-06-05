import React from "react";
import { Image, StyleSheet, TouchableOpacity, Linking } from "react-native";
import { theme } from "@/src/theme";

/** An image/GIF linked in post or comment text, shown inline. Tap = open. */
export default function InlineMedia({ uri, compact }: { uri: string; compact?: boolean }) {
  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={() => Linking.openURL(uri).catch(() => {})}
      testID="inline-media"
    >
      <Image
        source={{ uri }}
        style={[styles.img, compact && styles.compact]}
        resizeMode="contain"
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  img: {
    width: "100%", height: 240, marginTop: 8,
    borderRadius: 12, backgroundColor: theme.surfaceAlt,
    borderWidth: 1, borderColor: theme.border,
  },
  compact: { height: 160, marginTop: 6 },
});
