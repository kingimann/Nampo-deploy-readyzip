import React, { useCallback, useState, useRef } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  Image, useWindowDimensions, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { api, Post } from "@/src/api/client";
import { theme } from "@/src/theme";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";

function Reel({ post, active, screenW, screenH }: { post: Post; active: boolean; screenW: number; screenH: number }) {
  const video = post.media?.find((m) => m.type === "video");
  const image = post.media?.find((m) => m.type === "image");
  const videoUri = video?.base64 || "";
  const player = useVideoPlayer(videoUri || "about:blank", (p) => { p.loop = true; p.muted = false; });
  const router = useRouter();

  React.useEffect(() => {
    if (!videoUri) return;
    if (active) { try { player.play(); } catch {} }
    else { try { player.pause(); } catch {} }
    return () => { try { player.pause(); } catch {} };
  }, [active, player, videoUri]);

  const [liked, setLiked] = useState(post.liked_by_me);
  const [likeCount, setLikeCount] = useState(post.likes_count);

  const onLike = async () => {
    setLiked((v) => !v);
    setLikeCount((n) => n + (liked ? -1 : 1));
    try { await api.toggleLike(post.id); } catch {}
  };
  const onComment = () => router.push({ pathname: "/post/[id]", params: { id: post.id } });
  const onUser = () => router.push({ pathname: "/user/[name]", params: { name: post.author.name } });

  const imageUri = image?.base64 || "";

  return (
    <View style={{ width: screenW, height: screenH, backgroundColor: "#000" }}>
      {videoUri ? (
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          nativeControls={false}
        />
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
      <View style={styles.scrim} />

      <View style={styles.rightCol}>
        <TouchableOpacity style={styles.iconBtn} onPress={onUser}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarLetter}>{(post.author.name?.[0] || "?").toUpperCase()}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconBtn} onPress={onLike}>
          <Ionicons name={liked ? "heart" : "heart-outline"} size={30} color={liked ? "#EF4444" : "#fff"} />
          <Text style={styles.metric}>{likeCount}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconBtn} onPress={onComment}>
          <Ionicons name="chatbubble-outline" size={28} color="#fff" />
          <Text style={styles.metric}>{post.replies_count || 0}</Text>
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
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [items, setItems] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeIdx, setActiveIdx] = useState(0);

  const load = useCallback(async () => {
    try { setItems(await api.reelsFeed()); }
    catch {} finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

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
          getItemLayout={(_, index) => ({ length: screenH, offset: screenH * index, index })}
          renderItem={({ item, index }) => (
            <Reel
              post={item}
              active={index === activeIdx}
              screenW={screenW}
              screenH={screenH}
            />
          )}
        />
      )}
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
