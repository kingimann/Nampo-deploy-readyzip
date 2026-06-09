import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { LinearGradient } from "@/src/platform/linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";

/**
 * The cover image for a reel / video.
 *
 * - When `uri` is set, it renders that custom thumbnail.
 * - Otherwise it renders a branded **"OkaySpace"** default cover so a video
 *   never shows a black/empty frame before it loads.
 * - Pass `brand={false}` to fall back to plain black instead of the wordmark
 *   (used for sponsored reels, where a OkaySpace wordmark would be misleading).
 * - `compact` shrinks the wordmark for small grid tiles.
 *
 * It always fills its parent (absolute fill); give the parent a size + overflow
 * hidden. It never captures touches when used as an overlay — wrap it in a
 * `pointerEvents="none"` view at the call site if needed.
 */
export default function ReelPoster({
  uri,
  brand = true,
  compact = false,
  style,
}: {
  uri?: string | null;
  brand?: boolean;
  compact?: boolean;
  style?: any;
}) {
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={[StyleSheet.absoluteFill, style]}
        resizeMode="cover"
      />
    );
  }
  if (!brand) {
    return <View style={[StyleSheet.absoluteFill, styles.black, style]} />;
  }
  return (
    <LinearGradient
      colors={["#103A31", "#0B141A"]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[StyleSheet.absoluteFill, styles.fallback, style]}
    >
      {!compact && (
        <View style={styles.logoCircle}>
          <Ionicons name="play" size={26} color="#fff" style={{ marginLeft: 3 }} />
        </View>
      )}
      <Text style={compact ? styles.brandSm : styles.brand} numberOfLines={1} adjustsFontSizeToFit>
        OkaySpace
      </Text>
      {!compact && <Text style={styles.beta}>BETA</Text>}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  black: { backgroundColor: "#000" },
  fallback: { alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  logoCircle: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
    marginBottom: 12,
  },
  brand: { color: "#fff", fontSize: 24, fontWeight: "900", letterSpacing: -0.5, textAlign: "center" },
  brandSm: { color: "#fff", fontSize: 13, fontWeight: "800", letterSpacing: -0.2, textAlign: "center" },
  beta: {
    color: theme.primaryHover, fontSize: 10, fontWeight: "800",
    letterSpacing: 1.5, marginTop: 5, textTransform: "uppercase",
  },
});
