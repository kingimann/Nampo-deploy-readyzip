import React, { useCallback, useEffect, useState, useRef } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  Image, useWindowDimensions, Platform, RefreshControl, Pressable, Alert, Linking, Animated,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, Post, mediaUri } from "@/src/api/client";
import { theme } from "@/src/theme";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";
import CommentsSheet from "@/src/components/CommentsSheet";
import ReelVideo from "@/src/components/ReelVideo";
import VerifiedBadge from "@/src/components/VerifiedBadge";
import UserBadges from "@/src/components/UserBadges";
import { useAuth } from "@/src/context/AuthContext";

function Reel({ post, active, muted, onToggleMute, onOpenComments, screenW, screenH, myId }: {
  post: Post; active: boolean; muted: boolean; onToggleMute: () => void;
  onOpenComments: (p: Post) => void; screenW: number; screenH: number; myId?: string;
}) {
  // A repost of a reel carries its media/author/text on reposted_post.
  const isRepost = !!post.repost_of && !!post.reposted_post;
  const content = isRepost ? post.reposted_post! : post;
  const video = content.media?.find((m) => m.type === "video");
  const image = content.media?.find((m) => m.type === "image");
  const videoUri = mediaUri(video);
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [rate, setRate] = useState(1);          // base playback speed
  const [fastFwd, setFastFwd] = useState(false); // hold-to-2x
  const [reactOpen, setReactOpen] = useState(false);
  const [captionOpen, setCaptionOpen] = useState(false);

  // Resume from paused whenever the reel becomes active again.
  React.useEffect(() => { if (active) { setPaused(false); setRate(1); setFastFwd(false); } }, [active]);

  // Unified emoji reactions (replaces like/dislike) — on the original content.
  const [myReaction, setMyReaction] = useState<string | null>(content.my_reaction ?? null);
  const [reactionTotal, setReactionTotal] = useState(content.reactions_total ?? content.likes_count ?? 0);
  const [reposted, setReposted] = useState(!!content.reposted_by_me);
  const [repostCount, setRepostCount] = useState(content.reposts_count || 0);

  // Animated center indicators (Instagram-style): heart burst + mute flash.
  const heartBurst = useRef(new Animated.Value(0)).current;
  const muteFlash = useRef(new Animated.Value(0)).current;
  const muteIcon = useRef<"volume-mute" | "volume-high">("volume-high");

  // Re-sync from props when the FlatList recycles this row for a new reel.
  React.useEffect(() => {
    setMyReaction(content.my_reaction ?? null);
    setReactionTotal(content.reactions_total ?? content.likes_count ?? 0);
    setReposted(!!content.reposted_by_me);
    setRepostCount(content.reposts_count || 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id]);

  const doReact = async (emoji: string) => {
    setReactOpen(false);
    const cur = myReaction;
    const delta = cur === emoji ? -1 : cur ? 0 : 1;
    setMyReaction(cur === emoji ? null : emoji);
    setReactionTotal((n) => Math.max(0, n + delta));
    try {
      const u = await api.reactToPost(content.id, emoji);
      setMyReaction(u.my_reaction ?? null);
      setReactionTotal(u.reactions_total ?? u.likes_count ?? 0);
    } catch {}
  };
  const onHeartTap = () => doReact("❤️");

  const flashHeart = () => {
    heartBurst.setValue(0);
    Animated.sequence([
      Animated.spring(heartBurst, { toValue: 1, useNativeDriver: true, friction: 5, tension: 90 }),
      Animated.timing(heartBurst, { toValue: 0, duration: 350, delay: 250, useNativeDriver: true }),
    ]).start();
  };
  const onDoubleTap = () => {
    if (myReaction !== "❤️") doReact("❤️"); // double-tap always likes, never un-likes
    flashHeart();
  };

  // Single tap = pause/play, double tap = like (Instagram).
  const lastTap = useRef(0);
  const pendingTap = useRef<any>(null);
  const handleTap = () => {
    const now = Date.now();
    if (now - lastTap.current < 280) {
      if (pendingTap.current) { clearTimeout(pendingTap.current); pendingTap.current = null; }
      lastTap.current = 0;
      onDoubleTap();
    } else {
      lastTap.current = now;
      pendingTap.current = setTimeout(() => { setPaused((p) => !p); pendingTap.current = null; }, 280);
    }
  };

  const cycleSpeed = () => {
    const order = [1, 1.5, 2, 0.5];
    setRate((r) => order[(order.indexOf(r) + 1) % order.length]);
  };
  const handleMute = () => {
    muteIcon.current = muted ? "volume-high" : "volume-mute"; // new state after toggle
    onToggleMute();
    muteFlash.setValue(1);
    Animated.timing(muteFlash, { toValue: 0, duration: 650, useNativeDriver: true }).start();
  };

  const onRepost = async () => {
    setReposted((v) => !v);
    setRepostCount((n) => n + (reposted ? -1 : 1));
    try { await api.toggleRepost(post.repost_of || post.id); } catch {}
  };
  const onComment = () => onOpenComments(content);
  const onUser = () => router.push({ pathname: "/user/[name]", params: { name: content.author.name } });
  const onReport = () => {
    const doReport = () => { api.reportPost(post.id, "inappropriate").catch(() => {}); };
    if (Platform.OS === "web") {
      // eslint-disable-next-line no-alert
      if (typeof window !== "undefined" && window.confirm("Report this reel?")) doReport();
    } else {
      Alert.alert("Report reel", "Report this reel for review?", [
        { text: "Cancel", style: "cancel" },
        { text: "Report", style: "destructive", onPress: doReport },
      ]);
    }
  };

  const imageUri = mediaUri(image);

  return (
    <View style={{ width: screenW, height: screenH, backgroundColor: "#000" }}>
      {videoUri ? (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={handleTap}
          onLongPress={() => setFastFwd(true)}
          onPressOut={() => setFastFwd(false)}
          delayLongPress={220}
          testID={`reel-tap-${post.id}`}
        >
          <ReelVideo uri={videoUri} active={active} paused={paused} muted={muted} rate={fastFwd ? 2 : rate} />
          {paused && (
            <View style={styles.centerPlay} pointerEvents="none">
              <Ionicons name="play" size={66} color="rgba(255,255,255,0.92)" />
            </View>
          )}
          {fastFwd && (
            <View style={styles.speedPill} pointerEvents="none">
              <Ionicons name="play-forward" size={14} color="#fff" />
              <Text style={styles.speedPillText}>2x</Text>
            </View>
          )}
          {/* Double-tap heart burst */}
          <Animated.View
            style={[styles.centerPlay, {
              opacity: heartBurst,
              transform: [{ scale: heartBurst.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1.25] }) }],
            }]}
            pointerEvents="none"
          >
            <Ionicons name="heart" size={110} color="rgba(255,255,255,0.92)" />
          </Animated.View>
          {/* Mute/unmute flash */}
          <Animated.View style={[styles.centerPlay, { opacity: muteFlash }]} pointerEvents="none">
            <View style={styles.muteFlashCircle}>
              <Ionicons name={muteIcon.current} size={34} color="#fff" />
            </View>
          </Animated.View>
        </Pressable>
      ) : imageUri ? (
        <Image
          source={{ uri: imageUri }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.textBg]}>
          <View style={styles.textCard}>
            {!!post.place_name && (
              <View style={styles.locationRow}>
                <Ionicons name="location" size={13} color={theme.primary} />
                <Text style={styles.locationText}>{post.place_name}</Text>
              </View>
            )}
            {!!post.text && (
              <Text style={styles.bigText} numberOfLines={8}>{post.text}</Text>
            )}
          </View>
        </View>
      )}
      <View style={styles.scrim} pointerEvents="none" />

      {!!videoUri && (
        <>
          <TouchableOpacity style={styles.muteBtn} onPress={handleMute} testID="reel-mute" activeOpacity={0.85}>
            <Ionicons name={muted ? "volume-mute" : "volume-high"} size={18} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.speedBtn} onPress={cycleSpeed} testID="reel-speed" activeOpacity={0.85}>
            <Text style={styles.speedBtnText}>{rate}x</Text>
          </TouchableOpacity>
        </>
      )}

      <View style={styles.rightCol}>
        <TouchableOpacity style={styles.iconBtn} onPress={onUser}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarLetter}>{(content.author.name?.[0] || "?").toUpperCase()}</Text>
          </View>
        </TouchableOpacity>
        <View>
          {reactOpen && (
            <View style={styles.reactBar}>
              {["❤️", "😂", "😮", "😢", "🔥", "👍", "😡"].map((em) => (
                <TouchableOpacity key={em} onPress={() => doReact(em)} testID={`reel-react-${em}`} style={styles.reactPick}>
                  <Text style={{ fontSize: 26 }}>{em}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={onHeartTap}
            onLongPress={() => setReactOpen((o) => !o)}
            delayLongPress={250}
            testID={`reel-like-${post.id}`}
          >
            {myReaction ? (
              <Text style={{ fontSize: 28 }}>{myReaction}</Text>
            ) : (
              <Ionicons name="heart-outline" size={30} color="#fff" />
            )}
            <Text style={styles.metric}>{reactionTotal}</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={styles.iconBtn} onPress={onComment}>
          <Ionicons name="chatbubble-outline" size={28} color="#fff" />
          <Text style={styles.metric}>{content.replies_count || 0}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconBtn} onPress={onRepost} testID={`reel-repost-${post.id}`}>
          <Ionicons name="repeat" size={28} color={reposted ? "#22C55E" : "#fff"} />
          <Text style={styles.metric}>{repostCount}</Text>
        </TouchableOpacity>
        <View style={styles.iconBtn}>
          <Ionicons name="eye-outline" size={26} color="#fff" />
          <Text style={styles.metric}>{content.views_count || 0}</Text>
        </View>
        {myId && content.user_id === myId ? (
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.push({ pathname: "/advertise", params: { post: content.id } })} testID={`reel-promote-${post.id}`}>
            <Ionicons name="megaphone" size={23} color="#fff" />
            <Text style={styles.metric}>Promote</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.iconBtn} onPress={onReport} testID={`reel-report-${post.id}`}>
            <Ionicons name="flag-outline" size={24} color="#fff" />
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.bottom}>
        {isRepost && (
          <View style={styles.repostHint}>
            <Ionicons name="repeat" size={13} color="rgba(255,255,255,0.85)" />
            <Text style={styles.repostHintText}>Reposted by @{post.author.name}</Text>
          </View>
        )}
        <TouchableOpacity style={styles.authorRow} onPress={onUser} activeOpacity={0.8}>
          <Text style={styles.author} numberOfLines={1}>@{content.author.name}</Text>
          {content.author.verified && <VerifiedBadge size={15} />}
          <UserBadges badges={content.author.badges} size={15} />
        </TouchableOpacity>
        {!!content.text && (videoUri || imageUri) && (
          <TouchableOpacity activeOpacity={0.9} onPress={() => setCaptionOpen((o) => !o)}>
            <Text style={styles.caption} numberOfLines={captionOpen ? undefined : 2}>{content.text}</Text>
            {!captionOpen && content.text.length > 80 && (
              <Text style={styles.captionMore}>more</Text>
            )}
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function AdReel({ ad, active, muted, screenW, screenH, onSkip }: {
  ad: any; active: boolean; muted: boolean; screenW: number; screenH: number; onSkip?: () => void;
}) {
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  React.useEffect(() => { if (active) { setPaused(false); setElapsed(0); } }, [active]);
  React.useEffect(() => {
    if (!active || paused) return;
    const iv = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, [active, paused]);
  const canSkip = elapsed >= 5;
  React.useEffect(() => {
    if (!active || paused) return;
    const dur = Math.max(5, Math.min(60, ad.duration || 15));
    const start = Date.now() - progress * dur * 1000;
    const iv = setInterval(() => {
      const p = Math.min(1, (Date.now() - start) / (dur * 1000));
      setProgress(p);
      if (p >= 1) clearInterval(iv);
    }, 200);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, paused, ad.duration]);

  const onCta = () => {
    api.reelAdEvent(ad.id, "click").catch(() => {});
    if (ad.url) Linking.openURL(ad.url).catch(() => {});
  };

  return (
    <View style={{ width: screenW, height: screenH, backgroundColor: "#000" }}>
      <Pressable style={StyleSheet.absoluteFill} onPress={() => setPaused((p) => !p)}>
        <ReelVideo uri={ad.video_url} active={active} paused={paused} muted={muted} />
        {paused && (
          <View style={styles.centerPlay} pointerEvents="none">
            <Ionicons name="play" size={66} color="rgba(255,255,255,0.92)" />
          </View>
        )}
      </Pressable>
      <View style={styles.adProgressTrack} pointerEvents="none">
        <View style={[styles.adProgressFill, { width: `${Math.round(progress * 100)}%` }]} />
      </View>
      <View style={styles.adBadge} pointerEvents="none">
        <Ionicons name="megaphone" size={11} color="#fff" />
        <Text style={styles.adBadgeText}>Sponsored · {Math.max(5, Math.min(60, ad.duration || 15))}s</Text>
      </View>
      <TouchableOpacity style={styles.adSkip} onPress={() => canSkip && onSkip && onSkip()} disabled={!canSkip} testID={`reel-ad-skip-${ad.id}`}>
        <Text style={styles.adSkipText}>{canSkip ? "Skip" : `Skip in ${Math.max(0, 5 - elapsed)}s`}</Text>
        {canSkip ? <Ionicons name="play-skip-forward" size={14} color="#fff" /> : null}
      </TouchableOpacity>
      <View style={styles.adBottom} pointerEvents="box-none">
        <Text style={styles.adAdvertiser}>{ad.owner_name}</Text>
        <Text style={styles.adHeadline} numberOfLines={2}>{ad.headline}</Text>
        {ad.url ? (
          <TouchableOpacity style={styles.adCta} onPress={onCta} testID={`reel-ad-cta-${ad.id}`}>
            <Text style={styles.adCtaText}>{ad.cta || "Learn more"}</Text>
            <Ionicons name="open-outline" size={15} color="#000" />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

export default function ReelsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scope, setScope] = useState<"explore" | "following">("explore");
  const [activeIdx, setActiveIdx] = useState(0);
  const [muted, setMuted] = useState(false);
  const [focused, setFocused] = useState(true);
  const [commentsPost, setCommentsPost] = useState<Post | null>(null);
  const listRef = useRef<FlatList>(null);
  const skipToNext = useCallback(() => {
    setItems((arr) => {
      const next = Math.min(activeIdx + 1, arr.length - 1);
      try { listRef.current?.scrollToIndex({ index: next, animated: true }); } catch {}
      return arr;
    });
  }, [activeIdx]);

  const load = useCallback(async () => {
    try {
      const list = await api.reelsFeed(focus, scope);
      // Keep only reels with a genuinely playable video (no black screens), de-duped.
      const seen = new Set<string>();
      const valid = list.filter((p) => {
        if (seen.has(p.id)) return false;
        // Reposts of reels carry the video on reposted_post.
        const src = (p.repost_of && p.reposted_post) ? p.reposted_post : p;
        const uri = mediaUri(src.media?.find((m) => m.type === "video"));
        if (!(uri.startsWith("data:") || uri.startsWith("http"))) return false;
        seen.add(p.id);
        return true;
      });
      // Inject a sponsored reel ad a couple of reels in.
      let merged: any[] = valid;
      try {
        const { ad } = await api.serveReelAd();
        if (ad && valid.length >= 1) {
          merged = [...valid];
          merged.splice(Math.min(2, merged.length), 0, { ...ad, __ad: true });
        }
      } catch {}
      // Show whatever's playable. When there's nothing, fall through to the
      // in-screen empty state below — never yank the user off to another tab.
      setItems(merged);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [focus, scope]);

  const switchScope = useCallback((s: "explore" | "following") => {
    setScope((cur) => {
      if (cur === s) return cur;
      setLoading(true); setItems([]); setActiveIdx(0);
      return s;
    });
  }, []);
  // Pause playback when the screen loses focus (fixes audio bleeding after you leave).
  useFocusEffect(useCallback(() => {
    setFocused(true);
    load();
    return () => setFocused(false);
  }, [load]));

  // When opened from a feed video, jump to that reel.
  const focusIndex = focus ? items.findIndex((i) => i.id === focus) : -1;
  useEffect(() => {
    if (focusIndex >= 0) setActiveIdx(focusIndex);
  }, [focusIndex]);

  const onViewable = useRef(({ viewableItems }: any) => {
    if (viewableItems?.length) {
      const idx = viewableItems[0].index ?? 0;
      setActiveIdx(idx);
      const it = viewableItems[0].item as any;
      if (it?.__ad) api.reelAdEvent(it.id, "impression").catch(() => {});
      else if (it?.id) api.recordPostView(it.id).catch(() => {});
    }
  }).current;

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="reels-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.topBar, { paddingTop: insets.top + 4 }]}>
        <SidebarMenuButton light />
        <View style={styles.scopeTabs}>
          <TouchableOpacity onPress={() => switchScope("explore")} style={styles.scopeTab} testID="reels-tab-explore">
            <Text style={[styles.scopeText, scope === "explore" && styles.scopeTextActive]}>Explore</Text>
            {scope === "explore" && <View style={styles.scopeUnderline} />}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => switchScope("following")} style={styles.scopeTab} testID="reels-tab-following">
            <Text style={[styles.scopeText, scope === "following" && styles.scopeTextActive]}>Following</Text>
            {scope === "following" && <View style={styles.scopeUnderline} />}
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn}>
          <Ionicons name="close" size={22} color="#fff" />
        </TouchableOpacity>
      </View>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name={scope === "following" ? "people-outline" : "videocam-outline"} size={52} color={theme.textMuted} />
          <Text style={styles.empty}>{scope === "following" ? "No reels from people you follow." : "No reels yet."}</Text>
          <Text style={[styles.empty, { fontSize: 13, marginTop: 4 }]}>
            {scope === "following" ? "Follow some creators, or check out Explore." : "Post a video to the feed and it'll show up here."}
          </Text>
          {scope === "following" && (
            <TouchableOpacity onPress={() => switchScope("explore")} style={styles.emptyCta} testID="reels-empty-explore">
              <Text style={styles.emptyCtaText}>Go to Explore</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={(i) => i.id}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          snapToInterval={screenH}
          snapToAlignment="start"
          decelerationRate="fast"
          onViewableItemsChanged={onViewable}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor="#fff"
              colors={[theme.primary]}
            />
          }
          getItemLayout={(_, index) => ({ length: screenH, offset: screenH * index, index })}
          initialScrollIndex={focusIndex > 0 ? focusIndex : undefined}
          renderItem={({ item, index }) => (
            item.__ad ? (
              <AdReel ad={item} active={index === activeIdx && focused && !commentsPost} muted={muted} screenW={screenW} screenH={screenH} onSkip={skipToNext} />
            ) : (
              <Reel
                post={item}
                active={index === activeIdx && focused && !commentsPost}
                muted={muted}
                onToggleMute={() => setMuted((m) => !m)}
                onOpenComments={(p) => setCommentsPost(p)}
                screenW={screenW}
                screenH={screenH}
                myId={user?.user_id}
              />
            )
          )}
        />
      )}

      <CommentsSheet
        visible={!!commentsPost}
        post={commentsPost}
        onClose={() => setCommentsPost(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  topBar: {
    position: "absolute", top: 0, left: 0, right: 0, zIndex: 10,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 14, paddingBottom: 12,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center",
  },
  title: { color: "#fff", fontSize: 17, fontWeight: "800" },
  scopeTabs: { flexDirection: "row", alignItems: "center", gap: 22 },
  scopeTab: { alignItems: "center", paddingVertical: 2 },
  scopeText: { color: "rgba(255,255,255,0.6)", fontSize: 16, fontWeight: "700" },
  scopeTextActive: { color: "#fff", fontWeight: "800" },
  scopeUnderline: { marginTop: 3, width: 20, height: 3, borderRadius: 2, backgroundColor: "#fff" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  empty: { color: theme.textMuted, fontSize: 15, textAlign: "center", paddingHorizontal: 40 },
  emptyCta: { marginTop: 14, backgroundColor: theme.primary, borderRadius: 22, paddingHorizontal: 22, paddingVertical: 11 },
  emptyCtaText: { color: "#fff", fontSize: 14, fontWeight: "800" },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.15)" },
  centerPlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  adProgressTrack: { position: "absolute", top: 56, left: 12, right: 12, height: 3, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.25)" },
  adProgressFill: { height: 3, borderRadius: 2, backgroundColor: "#fff" },
  adBadge: { position: "absolute", top: 66, left: 12, flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  adBadgeText: { color: "#fff", fontSize: 11.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.3 },
  adSkip: { position: "absolute", top: 64, right: 12, flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  adSkipText: { color: "#fff", fontSize: 12.5, fontWeight: "800" },
  adBottom: { position: "absolute", left: 14, right: 80, bottom: 90 },
  adAdvertiser: { color: "#fff", fontSize: 14, fontWeight: "800", marginBottom: 4, textShadowColor: "rgba(0,0,0,0.6)", textShadowRadius: 4 },
  adHeadline: { color: "#fff", fontSize: 15, fontWeight: "600", lineHeight: 20, marginBottom: 10, textShadowColor: "rgba(0,0,0,0.6)", textShadowRadius: 4 },
  adCta: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 6, backgroundColor: "#fff", borderRadius: 22, paddingHorizontal: 16, paddingVertical: 9 },
  adCtaText: { color: "#000", fontSize: 14, fontWeight: "800" },
  muteBtn: {
    position: "absolute", right: 16, top: 104,
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center",
    zIndex: 10,
  },
  speedBtn: {
    position: "absolute", right: 16, top: 150,
    minWidth: 38, height: 32, borderRadius: 16, paddingHorizontal: 8,
    backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center",
    zIndex: 10,
  },
  speedBtnText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  speedPill: {
    position: "absolute", top: 70, alignSelf: "center",
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6,
  },
  speedPillText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  muteFlashCircle: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center",
  },
  reactBar: {
    position: "absolute", right: 46, bottom: -6,
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "rgba(20,20,22,0.92)", borderRadius: 999,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.15)",
    paddingHorizontal: 10, paddingVertical: 6,
  },
  reactPick: { paddingHorizontal: 2 },
  textBg: { alignItems: "center", justifyContent: "center", backgroundColor: "#0A0A0A" },
  textCard: {
    width: "80%", padding: 28, borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.1)",
    gap: 12,
  },
  locationRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  locationText: { color: theme.primary, fontSize: 12, fontWeight: "700" },
  bigText: {
    color: "#fff", fontSize: 22, fontWeight: "700", lineHeight: 30, textAlign: "center",
  },
  rightCol: {
    position: "absolute", right: 12, bottom: 110,
    alignItems: "center", gap: 18,
  },
  avatarCircle: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: theme.primary, alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: "#fff",
  },
  avatarLetter: { color: "#fff", fontSize: 18, fontWeight: "800" },
  iconBtn: { alignItems: "center", gap: 4 },
  metric: { color: "#fff", fontSize: 12, fontWeight: "700" },
  bottom: {
    position: "absolute", left: 16, right: 90, bottom: 30,
  },
  repostHint: { flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 6 },
  repostHintText: { color: "rgba(255,255,255,0.85)", fontSize: 12.5, fontWeight: "700", textShadowColor: "rgba(0,0,0,0.5)", textShadowRadius: 4 },
  authorRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  author: { color: "#fff", fontSize: 16, fontWeight: "800", flexShrink: 1, textShadowColor: "rgba(0,0,0,0.5)", textShadowRadius: 4 },
  caption: { color: "rgba(255,255,255,0.9)", fontSize: 14, marginTop: 6, lineHeight: 20, textShadowColor: "rgba(0,0,0,0.5)", textShadowRadius: 4 },
  captionMore: { color: "rgba(255,255,255,0.65)", fontSize: 13, fontWeight: "700", marginTop: 2 },
});
