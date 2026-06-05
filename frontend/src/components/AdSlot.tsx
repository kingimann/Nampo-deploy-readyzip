import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api, Post } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import PostCard from "@/src/components/PostCard";

/**
 * A sponsored-content slot that renders a *real* promoted post (one that
 * actually counts — i.e. a billable campaign) as a normal PostCard with a
 * single "Sponsored" label + why/hide/report controls. House/"suggested"
 * filler and the advertise CTA are not shown — empty slots render nothing.
 */
export default function AdSlot({ placement, host, index }: { placement: string; host?: string; index?: number }) {
  const router = useRouter();
  const { user } = useAuth();
  const [post, setPost] = useState<Post | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [why, setWhy] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getNextAd(placement, index);
        if (cancelled) return;
        // Only surface genuine sponsored posts that count — skip house ads/CTA.
        if (res.post && !res.house) {
          setReason(res.reason || null);
          setPost(res.post);
          api.adEvent(res.post.id, "impression", host).catch(() => {});
        } else {
          setPost(null);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [placement, host, index]);

  if (gone || !post) return null;

  const recordClick = (p: Post) => { api.adEvent(p.id, "click", host).catch(() => {}); };
  const hide = async () => { setGone(true); if (post) { try { await api.hideAd(post.id); } catch {} } };
  const report = async () => { setGone(true); if (post) { try { await api.reportAd(post.id); } catch {} } };

  // Lightweight engagement handlers so the ad behaves like a real post.
  const onLike = (p: Post) => { api.toggleLike(p.id).catch(() => {}); };
  const onRepost = (p: Post) => { api.toggleRepost(p.repost_of || p.id).catch(() => {}); };
  const onBookmark = (p: Post) => { api.toggleBookmark(p.id).catch(() => {}); };
  const onReply = (p: Post) => router.push({ pathname: "/post/[id]", params: { id: p.id } });

  return (
    <View testID="ad-slot">
      <View style={styles.labelRow}>
        <Ionicons name="megaphone" size={12} color={theme.primary} />
        <Text style={styles.label}>Sponsored</Text>
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={() => setMenu((m) => !m)} hitSlop={8} testID="ad-menu">
          <Ionicons name="ellipsis-horizontal" size={16} color={theme.textMuted} />
        </TouchableOpacity>
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
        hideSponsoredLabel
        onLike={onLike}
        onRepost={onRepost}
        onReply={onReply}
        onBookmark={onBookmark}
        onComments={(p) => onReply(p)}
        onOpen={recordClick}
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
});
