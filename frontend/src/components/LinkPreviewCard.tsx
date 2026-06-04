import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Image, Linking } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinkPreview } from "@/src/api/client";
import { theme } from "@/src/theme";

export default function LinkPreviewCard({ preview }: { preview: LinkPreview }) {
  const host = (() => {
    try { return new URL(preview.url).hostname.replace(/^www\./, ""); }
    catch { return preview.site_name || preview.url; }
  })();
  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.85}
      onPress={() => Linking.openURL(preview.url).catch(() => {})}
    >
      {preview.image ? (
        <Image source={{ uri: preview.image }} style={styles.image} resizeMode="cover" />
      ) : (
        <View style={[styles.image, styles.imagePlaceholder]}>
          <Ionicons name="link" size={28} color={theme.textMuted} />
        </View>
      )}
      <View style={styles.body}>
        <Text style={styles.host} numberOfLines={1}>{host}</Text>
        {!!preview.title && <Text style={styles.title} numberOfLines={2}>{preview.title}</Text>}
        {!!preview.description && <Text style={styles.desc} numberOfLines={2}>{preview.description}</Text>}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 10, borderRadius: 14, overflow: "hidden",
    backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border,
  },
  image: { width: "100%", height: 160, backgroundColor: "#111" },
  imagePlaceholder: { alignItems: "center", justifyContent: "center" },
  body: { padding: 12, gap: 4 },
  host: { color: theme.textMuted, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  title: { color: theme.textPrimary, fontSize: 14, fontWeight: "800" },
  desc: { color: theme.textSecondary, fontSize: 12, lineHeight: 17 },
});
