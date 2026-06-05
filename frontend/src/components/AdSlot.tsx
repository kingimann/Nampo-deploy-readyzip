import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Image } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api, Ad } from "@/src/api/client";
import { theme } from "@/src/theme";

/**
 * A sponsored-content slot. Drop it anywhere (profiles, communities, market…).
 * Fetches one active promoted post, records an impression, and on tap records a
 * click (crediting `host` — the owner of the surface it's shown on — ad revenue)
 * before opening the post. Renders nothing when there's no ad to show.
 */
export default function AdSlot({ placement, host, exclude }: { placement: string; host?: string; exclude?: string }) {
  const router = useRouter();
  const [ad, setAd] = useState<Ad | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { ad } = await api.getNextAd(placement, exclude);
        if (cancelled || !ad) return;
        setAd(ad);
        api.adEvent(ad.post_id, "impression", host).catch(() => {});
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [placement, host, exclude]);

  if (!ad) return null;

  const onPress = () => {
    api.adEvent(ad.post_id, "click", host).catch(() => {});
    router.push({ pathname: "/post/[id]", params: { id: ad.post_id } });
  };

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.9} testID="ad-slot">
      <View style={styles.badgeRow}>
        <Ionicons name="megaphone" size={12} color={theme.primary} />
        <Text style={styles.badge}>Sponsored</Text>
      </View>
      <View style={styles.body}>
        {ad.image ? (
          <Image source={{ uri: ad.image }} style={styles.img} resizeMode="cover" />
        ) : (
          <View style={[styles.img, styles.imgPlaceholder]}>
            <Ionicons name="megaphone-outline" size={20} color={theme.textMuted} />
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.author} numberOfLines={1}>{ad.author_name}</Text>
          <Text style={styles.text} numberOfLines={2}>{ad.text || "Check this out"}</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, padding: 12, gap: 8 },
  badgeRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  badge: { color: theme.primary, fontSize: 10.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  body: { flexDirection: "row", alignItems: "center", gap: 12 },
  img: { width: 54, height: 54, borderRadius: 10, backgroundColor: theme.surfaceAlt },
  imgPlaceholder: { alignItems: "center", justifyContent: "center" },
  author: { color: theme.textPrimary, fontSize: 14, fontWeight: "800" },
  text: { color: theme.textSecondary, fontSize: 13, marginTop: 1 },
});
