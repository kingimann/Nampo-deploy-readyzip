import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api, Post } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import PostCard from "@/src/components/PostCard";

/**
 * A sponsored-content slot that renders the ad as a normal post (PostCard) with
 * a "Sponsored" label + why/hide/report controls. Falls back to a house ad
 * (the viewer's own post, or an "Advertise here" CTA) so it's never empty.
 */
export default function AdSlot({ placement, host, exclude }: { placement: string; host?: string; exclude?: string }) {
  const router = useRouter();
  const { user } = useAuth();
  const [post, setPost] = useState<Post | null>(null);
  const [house, setHouse] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [cta, setCta] = useState(false);
  const [menu, setMenu] = useState(false);
  const [why, setWhy] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getNextAd(placement, exclude);
        if (cancelled) return;
        setHouse(!!res.house); setReason(res.reason || null); setCta(!!res.cta);
        setPost(res.post || null);
        if (res.post && !res.house) api.adEvent(res.post.id, "impression", host).catch(() => {});
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [placement, host, exclude]);

  if (gone) return null;

  const recordClick = (p: Post) => { if (!house) api.adEvent(p.id, "click", host).catch(() => {}); };
  const hide = async () => { setGone(true); if (post) { try { await api.hideAd(post.id); } catch {} } };
  const report = async () => { setGone(true); if (post) { try { await api.reportAd(post.id); } catch {} } };

  // Lightweight engagement handlers so the ad behaves like a real post.
  const onLike = (p: Post) => { api.toggleLike(p.id).catch(() => {}); };
  const onRepost = (p: Post) => { api.toggleRepost(p.repost_of || p.id).catch(() => {}); };
  const onBookmark = (p: Post) => { api.toggleBookmark(p.id).catch(() => {}); };
  const onReply = (p: Post) => router.push({ pathname: "/post/[id]", params: { id: p.id } });

  // CTA fallback (viewer has no posts to surface).
  if (!post) {
    if (!cta) return null;
    return (
      <TouchableOpacity style={styles.cta} onPress={() => router.push("/advertise")} testID="ad-cta">
        <Ionicons name="megaphone" size={18} color={theme.primary} />
        <View style={{ flex: 1 }}>
          <Text style={styles.ctaTitle}>Advertise on Nami</Text>
          <Text style={styles.ctaSub}>Promote your posts to reach more people.</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
      </TouchableOpacity>
    );
  }

  return (
    <View testID="ad-slot">
      <View style={styles.labelRow}>
        <Ionicons name={house ? "rocket-outline" : "megaphone"} size={12} color={theme.primary} />
        <Text style={styles.label}>{house ? "Suggested · promote yours" : "Sponsored"}</Text>
        <View style={{ flex: 1 }} />
        {!house && (
          <TouchableOpacity onPress={() => setMenu((m) => !m)} hitSlop={8} testID="ad-menu">
            <Ionicons name="ellipsis-horizontal" size={16} color={theme.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {menu && (
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
      )}
      {why && <Text style={styles.why}>{reason || "You're seeing this because it's a promoted post."}</Text>}

      <PostCard
        post={post}
        viewerId={user?.user_id}
        onLike={onLike}
        onRepost={onRepost}
        onReply={onReply}
        onBookmark={onBookmark}
        onComments={(p) => onReply(p)}
        onOpen={house ? undefined : recordClick}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  labelRow: { flexDirection: "row", alignItems: "center", gap: 5, marginBottom: -4, paddingHorizontal: 2 },
  label: { color: theme.primary, fontSize: 10.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  menu: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 12, marginTop: 6 },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11 },
  menuText: { color: theme.textSecondary, fontSize: 14, fontWeight: "600" },
  why: { color: theme.textMuted, fontSize: 12, lineHeight: 17, marginTop: 6, paddingHorizontal: 2 },
  cta: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, padding: 14 },
  ctaTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "800" },
  ctaSub: { color: theme.textSecondary, fontSize: 13, marginTop: 1 },
});
