import React, { useCallback, useState, useRef } from "react";
import {
  View, Text, StyleSheet, FlatList, Dimensions, TouchableOpacity, ActivityIndicator,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { api, Post } from "@/src/api/client";
import { theme } from "@/src/theme";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get("window");

function Reel({ post, active }: { post: Post; active: boolean }) {
  const video = post.media?.find((m) => m.type === "video");
  const uri = video?.base64 || "";
  const player = useVideoPlayer(uri, (p) => { p.loop = true; p.muted = false; });
  const router = useRouter();

  React.useEffect(() => {
    if (active) player.play(); else player.pause();
    return () => { try { player.pause(); } catch {} };
  }, [active, player]);

  const onLike = async () => { try { await api.toggleLike(post.id); } catch {} };
  const onComment = () => router.push({ pathname: "/post/[id]", params: { id: post.id } });
  const onUser = () => router.push({ pathname: "/user/[name]", params: { name: post.author.name } });

  return (
    <View style={styles.reel}>
      {uri ? (
        <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: "#000" }]} />
      )}
      <View style={styles.scrim} />
      <View style={styles.rightCol}>
        <TouchableOpacity style={styles.iconBtn} onPress={onUser}>
          <Ionicons name="person-circle" size={32} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconBtn} onPress={onLike}>
          <Ionicons name={post.liked_by_me ? "heart" : "heart-outline"} size={30} color={post.liked_by_me ? "#EF4444" : "#fff"} />
          <Text style={styles.metric}>{post.likes_count}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconBtn} onPress={onComment}>
          <Ionicons name="chatbubble-outline" size={28} color="#fff" />
          <Text style={styles.metric}>{post.replies_count || 0}</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.bottom}>
        <Text style={styles.author}>@{post.author.name}</Text>
        {!!post.text && <Text style={styles.caption} numberOfLines={3}>{post.text}</Text>}
      </View>
    </View>
  );
}

export default function ReelsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
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
          <Ionicons name="videocam-outline" size={42} color={theme.textMuted} />
          <Text style={styles.empty}>No reels yet. Post a video to start the feed!</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={{ itemVisiblePercentThreshold: 80 }}
          renderItem={({ item, index }) => <Reel post={item} active={index === activeIdx} />}
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
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  empty: { color: theme.textMuted, fontSize: 14, textAlign: "center", paddingHorizontal: 40 },
  reel: { width: SCREEN_W, height: SCREEN_H, backgroundColor: "#000" },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.18)" },
  rightCol: {
    position: "absolute", right: 12, bottom: 110,
    alignItems: "center", gap: 18,
  },
  iconBtn: { alignItems: "center", gap: 4 },
  metric: { color: "#fff", fontSize: 12, fontWeight: "700" },
  bottom: {
    position: "absolute", left: 16, right: 90, bottom: 30,
  },
  author: { color: "#fff", fontSize: 16, fontWeight: "800" },
  caption: { color: "#fff", fontSize: 14, marginTop: 6 },
});
