import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Image } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api, Ad } from "@/src/api/client";
import { theme } from "@/src/theme";

/**
 * A sponsored-content slot. Drop it anywhere (profiles, communities, groups,
 * marketplace…). Serves a paid promoted post (recording impression/click and
 * crediting the `host` ad revenue), or a house ad nudging the viewer to promote
 * their own content — so the slot is never empty. Includes why/hide/report.
 */
export default function AdSlot({ placement, host, exclude }: { placement: string; host?: string; exclude?: string }) {
  const router = useRouter();
  const [ad, setAd] = useState<Ad | null>(null);
  const [house, setHouse] = useState(false);
  const [menu, setMenu] = useState(false);
  const [why, setWhy] = useState(false);
  const [gone, setGone] = useState(false);

  const fetchAd = async () => {
    try {
      const res = await api.getNextAd(placement, exclude);
      if (!res.ad) { setAd(null); return; }
      setAd(res.ad); setHouse(!!res.house); setMenu(false); setWhy(false);
      if (!res.house && res.ad.post_id) api.adEvent(res.ad.post_id, "impression", host).catch(() => {});
    } catch {}
  };
  useEffect(() => { fetchAd(); /* eslint-disable-next-line */ }, [placement, host, exclude]);

  if (gone || !ad) return null;

  const onPress = () => {
    if (house || !ad.post_id) { router.push("/advertise"); return; }
    api.adEvent(ad.post_id, "click", host).catch(() => {});
    router.push({ pathname: "/post/[id]", params: { id: ad.post_id } });
  };
  const hide = async () => { setGone(true); if (ad.post_id) { try { await api.hideAd(ad.post_id); } catch {} } };
  const report = async () => { setGone(true); if (ad.post_id) { try { await api.reportAd(ad.post_id); } catch {} } };

  return (
    <View style={styles.card}>
      <View style={styles.badgeRow}>
        <Ionicons name={house ? "rocket-outline" : "megaphone"} size={12} color={theme.primary} />
        <Text style={styles.badge}>{house ? "Suggested for you" : "Sponsored"}</Text>
        <View style={{ flex: 1 }} />
        {!house && (
          <TouchableOpacity onPress={() => setMenu((m) => !m)} hitSlop={8} testID="ad-menu">
            <Ionicons name="ellipsis-horizontal" size={16} color={theme.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {menu ? (
        <View style={styles.menu}>
          <TouchableOpacity style={styles.menuItem} onPress={() => { setWhy(true); setMenu(false); }} testID="ad-why">
            <Ionicons name="information-circle-outline" size={16} color={theme.textSecondary} />
            <Text style={styles.menuText}>Why this ad?</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.menuItem} onPress={hide} testID="ad-hide">
            <Ionicons name="eye-off-outline" size={16} color={theme.textSecondary} />
            <Text style={styles.menuText}>Hide this ad</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.menuItem} onPress={report} testID="ad-report">
            <Ionicons name="flag-outline" size={16} color={theme.error} />
            <Text style={[styles.menuText, { color: theme.error }]}>Report ad</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity style={styles.body} onPress={onPress} activeOpacity={0.9} testID="ad-slot">
          {ad.image ? (
            <Image source={{ uri: ad.image }} style={styles.img} resizeMode="cover" />
          ) : (
            <View style={[styles.img, styles.imgPlaceholder]}>
              <Ionicons name={house ? "rocket" : "megaphone-outline"} size={20} color={theme.textMuted} />
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.author} numberOfLines={1}>{ad.author_name}</Text>
            <Text style={styles.text} numberOfLines={2}>{ad.text || "Check this out"}</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
        </TouchableOpacity>
      )}

      {why && (
        <Text style={styles.why}>{ad.reason || "You're seeing this because it's a promoted post."} Tap ••• to hide or report.</Text>
      )}
    </View>
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
  menu: { gap: 2 },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9 },
  menuText: { color: theme.textSecondary, fontSize: 14, fontWeight: "600" },
  why: { color: theme.textMuted, fontSize: 12, lineHeight: 17 },
});
