import React, { useCallback, useEffect, useState, useRef } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  Image, useWindowDimensions, Platform, RefreshControl, Pressable, Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { api, Post } from "@/src/api/client";
import { theme } from "@/src/theme";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";
import CommentsSheet from "@/src/components/CommentsSheet";

function Reel({ post, active, muted, onToggleMute, onOpenComments, screenW, screenH }: {
  post: Post; active: boolean; muted: boolean; onToggleMute: () => void;
  onOpenComments: (p: Post) => void; screenW: number; screenH: number;
}) {
  const video = post.media?.find((m) => m.type === "video");
  const image = post.media?.find((m) => m.type === "image");
  const videoUri = video?.base64 || "";
  const player = useVideoPlayer(videoUri || "about:blank", (p) => { p.loop = true; p.muted = muted; });
  const router = useRouter();
  const [paused, setPaused] = useState(false);

  // Play only when this reel is on screen and not manually paused.
  React.useEffect(() => {
    if (!videoUri) return;
    if (active && !paused) { try { player.play(); } catch {} }
    else { try { player.pause(); } catch {} }
    return () => { try { player.pause(); } catch {} };
  }, [active, paused, player, videoUri]);

  // Keep the player's mute in sync with the global toggle.
  React.useEffect(() => { try { player.muted = muted; } catch {} }, [muted, player]);

  // Resume from paused whenever the reel becomes active again.
  React.useEffect(() => { if (active) setPaused(false); }, [active]);

  const [liked, setLiked] = useState(post.liked_by_me);
  const [likeCount, setLikeCount] = useState(post.likes_count);
  const [disliked, setDisliked] = useState(!!post.disliked_by_me);
  const [reposted, setReposted] = useState(!!post.reposted_by_me);
  const [repostCount, setRepostCount] = useState(post.reposts_count || 0);

  const onLike = async () => {
    const nowLiked = !liked;
    setLiked(nowLiked);
    setLikeCount((n) => n + (nowLiked ? 1 : -1));
    if (nowLiked && disliked) setDisliked(false);
    try { await api.toggleLike(post.id); } catch {}
  };
  const onDislike = async () => {
    const nowDis = !disliked;
    setDisliked(nowDis);
    if (nowDis && liked) { setLiked(false); setLikeCount((n) => n - 1); }
    try { await api.toggleDislike(post.id); } catch {}
  };
  const onRepost = async () => {
    setReposted((v) => !v);
    setRepostCount((n) => n + (reposted ? -1 : 1));
    try { await api.toggleRepost(post.repost_of || post.id); } catch {}
  };
  const onComment = () => onOpenComments(post);
  const onUser = () => router.push({ pathname: "/user/[name]", params: { name: post.author.name } });
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

  const imageUri = image?.base64 || "";

  return (
    <View style={{ width: screenW, height: screenH, backgroundColor: "#000" }}>
      {videoUri ? (
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setPaused((p) => !p)} testID={`reel-tap-${post.id}`}>
          <VideoView
            player={player}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            nativeControls={false}
          />
          {paused && (
            <View style={styles.centerPlay} pointerEvents="none">
              <Ionicons name="play" size={66} color="rgba(255,255,255,0.92)" />
            </View>
          )}
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
        <TouchableOpacity style={styles.muteBtn} onPress={onToggleMute} testID="reel-mute" activeOpacity={0.85}>
          <Ionicons name={muted ? "volume-mute" : "volume-high"} size={18} color="#fff" />
        </TouchableOpacity>
      )}

      <View style={styles.rightCol}>
        <TouchableOpacity style={styles.iconBtn} onPress={onUser}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarLetter}>{(post.author.name?.[0] || "?").toUpperCase()}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconBtn} onPress={onLike} testID={`reel-like-${post.id}`}>
          <Ionicons name={liked ? "heart" : "heart-outline"} size={30} color={liked ? "#EF4444" : "#fff"} />
          <Text style={styles.metric}>{likeCount}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconBtn} onPress={onDislike} testID={`reel-dislike-${post.id}`}>
          <Ionicons name={disliked ? "thumbs-down" : "thumbs-down-outline"} size={26} color={disliked ? "#3B82F6" : "#fff"} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconBtn} onPress={onComment}>
          <Ionicons name="chatbubble-outline" size={28} color="#fff" />
          <Text style={styles.metric}>{post.replies_count || 0}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconBtn} onPress={onRepost} testID={`reel-repost-${post.id}`}>
          <Ionicons name="repeat" size={28} color={reposted ? "#22C55E" : "#fff"} />
          <Text style={styles.metric}>{repostCount}</Text>
        </TouchableOpacity>
        <View style={styles.iconBtn}>
          <Ionicons name="eye-outline" size={26} color="#fff" />
          <Text style={styles.metric}>{post.views_count || 0}</Text>
        </View>
        <TouchableOpacity style={styles.iconBtn} onPress={onReport} testID={`reel-report-${post.id}`}>
          <Ionicons name="flag-outline" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      <View style={styles.bottom}>
        <Text style={styles.author}>@{post.author.name}</Text>
        {!!post.text && !(!videoUri && !imageUri) && (
          <Text style={styles.caption} numberOfLines={3}>{post.text}</Text>
        )}
      </View>
    </View>
  );
}

export default function ReelsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [items, setItems] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [muted, setMuted] = useState(false);
  const [focused, setFocused] = useState(true);
  const [commentsPost, setCommentsPost] = useState<Post | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.reelsFeed(focus);
      // Keep only reels with a genuinely playable video (no black screens), de-duped.
      const seen = new Set<string>();
      const valid = list.filter((p) => {
        if (seen.has(p.id)) return false;
        const uri = p.media?.find((m) => m.type === "video")?.base64 || "";
        if (!(uri.startsWith("data:") || uri.startsWith("http"))) return false;
        seen.add(p.id);
        return true;
      });
      // Show whatever's playable. When there's nothing, fall through to the
      // in-screen empty state below — never yank the user off to another tab.
      setItems(valid);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [focus]);
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
      const p = viewableItems[0].item as Post;
      if (p?.id) api.recordPostView(p.id).catch(() => {});
    }
  }).current;

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="reels-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.topBar, { paddingTop: insets.top + 4 }]}>
        <SidebarMenuButton light />
        <Text style={styles.title}>Reels</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="close" size={22} color="#fff" />
        </TouchableOpacity>
      </View>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="videocam-outline" size={52} color={theme.textMuted} />
          <Text style={styles.empty}>No reels yet.</Text>
          <Text style={[styles.empty, { fontSize: 13, marginTop: 4 }]}>Post a video to the feed and it'll show up here.</Text>
        </View>
      ) : (
        <FlatList
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
            <Reel
              post={item}
              active={index === activeIdx && focused && !commentsPost}
              muted={muted}
              onToggleMute={() => setMuted((m) => !m)}
              onOpenComments={(p) => setCommentsPost(p)}
              screenW={screenW}
              screenH={screenH}
            />
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
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  empty: { color: theme.textMuted, fontSize: 15, textAlign: "center", paddingHorizontal: 40 },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.15)" },
  centerPlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  muteBtn: {
    position: "absolute", right: 16, top: 104,
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center",
    zIndex: 10,
  },
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
  author: { color: "#fff", fontSize: 16, fontWeight: "800" },
  caption: { color: "rgba(255,255,255,0.85)", fontSize: 14, marginTop: 6, lineHeight: 20 },
});
