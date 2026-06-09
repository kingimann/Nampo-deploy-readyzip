import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, Image, TouchableOpacity, TextInput,
  Pressable, Animated, ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { VideoView, useVideoPlayer } from "@/src/platform/video";
import { api, Story, StoryViewer } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

const IMAGE_DURATION_MS = 5000;

export default function StoryViewerScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [stories, setStories] = useState<Story[]>([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [viewers, setViewers] = useState<StoryViewer[]>([]);
  const [showViewers, setShowViewers] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  // Live mirror of `progress` so a paused segment resumes instead of restarting.
  const progressVal = useRef(0);

  const isOwn = user?.user_id === userId;
  const current = stories[idx];
  const player = useVideoPlayer(
    current?.type === "video" ? current.media_base64 : "",
    (p) => { p.loop = false; p.muted = false; }
  );

  useEffect(() => {
    (async () => {
      if (!userId) return;
      try {
        const list = await api.listUserStories(userId);
        setStories(list);
      } catch {} finally { setLoading(false); }
    })();
  }, [userId]);

  const advance = useCallback(() => {
    setIdx((i) => {
      if (i + 1 >= stories.length) {
        safeBack();
        return i;
      }
      return i + 1;
    });
  }, [stories.length, router]);

  // Keep progressVal in sync with the animated value (JS-driven, so this fires).
  useEffect(() => {
    const id = progress.addListener(({ value }) => { progressVal.current = value; });
    return () => progress.removeListener(id);
  }, [progress]);

  // New segment: reset the bar, clear any stale pause, (re)load the media.
  // Keyed on the story id only so pause/resume doesn't restart progress.
  useEffect(() => {
    if (!current) return;
    progress.setValue(0);
    progressVal.current = 0;
    setPaused(false);
    if (current.type === "video") {
      // expo-video keeps the same player instance across segments, so the
      // source must be swapped explicitly or every video shows the first one.
      try { player.replace(current.media_base64); player.play(); } catch {}
    } else {
      try { player.pause(); } catch {}
    }
  }, [current?.id]);

  // Record a view exactly once per segment (never for your own story).
  useEffect(() => {
    if (!current || isOwn) return;
    api.viewStory(current.id).catch(() => {});
  }, [current?.id, isOwn]);

  // Drive the progress bar + auto-advance. Pausing stops the timer in place;
  // resuming continues for the remaining duration rather than restarting.
  useEffect(() => {
    if (!current) return;
    animRef.current?.stop();
    if (paused) return;
    const dur = current.type === "video"
      ? Math.min(current.duration_ms || 15000, 15000)
      : IMAGE_DURATION_MS;
    const remaining = Math.max(0, dur * (1 - progressVal.current));
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: remaining,
      useNativeDriver: false,
    });
    animRef.current = anim;
    anim.start(({ finished }) => { if (finished) advance(); });
    return () => { anim.stop(); };
  }, [current?.id, idx, paused, advance]);

  // Pause/resume video playback alongside the progress timer.
  useEffect(() => {
    if (current?.type !== "video") return;
    try { paused ? player.pause() : player.play(); } catch {}
  }, [paused, current?.type, player]);

  const onLeftTap = () => setIdx((i) => Math.max(0, i - 1));
  const onRightTap = advance;

  const sendReply = async () => {
    if (!current || !reply.trim()) return;
    setSending(true);
    try {
      await api.replyToStory(current.id, reply.trim());
      setReply("");
      Alert.alert("Reply sent", "Opened a chat with " + current.user_name);
    } catch (e: any) {
      Alert.alert("Couldn't send", e?.message || "Try again");
    } finally { setSending(false); }
  };

  const deleteStory = () => {
    if (!current) return;
    const delId = current.id;
    Alert.alert("Delete this story?", "It will disappear immediately.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
        try {
          await api.deleteStory(delId);
          // Compute the next index off the filtered array, not the stale length.
          setStories((arr) => {
            const next = arr.filter((s) => s.id !== delId);
            if (next.length === 0) safeBack();
            else setIdx((i) => Math.min(i, next.length - 1));
            return next;
          });
        } catch (e: any) { Alert.alert("Failed", e?.message || "Try again"); }
      }},
    ]);
  };

  const openViewers = async () => {
    if (!current || !isOwn) return;
    try {
      const v = await api.listStoryViewers(current.id);
      setViewers(v);
      setShowViewers(true);
      setPaused(true);
    } catch {}
  };

  if (loading) {
    return (
      <View style={styles.root}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator color="#fff" style={{ marginTop: 100 }} />
      </View>
    );
  }
  if (!current) {
    return (
      <View style={styles.root}>
        <Stack.Screen options={{ headerShown: false }} />
        <TouchableOpacity style={{ flex: 1, justifyContent: "center", alignItems: "center" }} onPress={() => safeBack()}>
          <Text style={{ color: "#fff" }}>No stories. Tap to close.</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Media */}
      {current.type === "image" ? (
        <Image source={{ uri: current.media_base64 }} style={styles.media} resizeMode="contain" />
      ) : (
        <VideoView player={player} style={styles.media} contentFit="contain" nativeControls={false} />
      )}

      {/* Tap zones (left/right) + hold-to-pause */}
      <Pressable
        style={styles.leftZone}
        onPress={onLeftTap}
        onPressIn={() => setPaused(true)}
        onPressOut={() => setPaused(false)}
      />
      <Pressable
        style={styles.rightZone}
        onPress={onRightTap}
        onPressIn={() => setPaused(true)}
        onPressOut={() => setPaused(false)}
      />

      {/* Top: progress bars + header */}
      <SafeAreaView edges={["top"]} style={styles.topWrap} pointerEvents="box-none">
        <View style={styles.progressRow}>
          {stories.map((_, i) => (
            <View key={i} style={styles.progressTrack}>
              <Animated.View
                style={[
                  styles.progressFill,
                  {
                    width: i < idx ? "100%" : i === idx
                      ? progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] })
                      : "0%",
                  },
                ]}
              />
            </View>
          ))}
        </View>
        <View style={styles.headerRow}>
          <View style={styles.avatar}>
            {current.user_picture
              ? <Image source={{ uri: current.user_picture }} style={styles.avatarImg} />
              : <Text style={styles.avatarInit}>{current.user_name?.[0]?.toUpperCase() || "?"}</Text>}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.userName}>{current.user_name}</Text>
            <Text style={styles.userTime}>{relativeTime(current.created_at)}</Text>
          </View>
          {isOwn && (
            <TouchableOpacity onPress={deleteStory} style={styles.headerBtn} testID="delete-story">
              <Ionicons name="trash" size={20} color="#fff" />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => safeBack()} style={styles.headerBtn} testID="close-story">
            <Ionicons name="close" size={24} color="#fff" />
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* Caption */}
      {!!current.caption && (
        <View style={[styles.caption, { bottom: insets.bottom + (isOwn ? 80 : 110) }]}>
          <Text style={styles.captionText}>{current.caption}</Text>
        </View>
      )}

      {/* Bottom bar */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={[styles.bottomWrap, { paddingBottom: insets.bottom + 10 }]}
        pointerEvents="box-none"
      >
        {isOwn ? (
          <TouchableOpacity style={styles.viewersBtn} onPress={openViewers} testID="viewers-btn">
            <Ionicons name="eye" size={18} color="#fff" />
            <Text style={styles.viewersText}>Viewers · {current.view_count}</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.replyRow}>
            <TextInput
              style={styles.replyInput}
              placeholder={`Reply to ${current.user_name}…`}
              placeholderTextColor="rgba(255,255,255,0.7)"
              value={reply}
              onChangeText={setReply}
              onFocus={() => setPaused(true)}
              onBlur={() => setPaused(false)}
              testID="story-reply-input"
            />
            <TouchableOpacity
              onPress={sendReply}
              disabled={!reply.trim() || sending}
              style={[styles.sendBtn, (!reply.trim() || sending) && { opacity: 0.5 }]}
              testID="story-reply-send"
            >
              {sending ? <ActivityIndicator color="#fff" /> : <Ionicons name="send" size={18} color="#fff" />}
            </TouchableOpacity>
          </View>
        )}
      </KeyboardAvoidingView>

      {/* Viewers sheet */}
      {showViewers && (
        <Pressable
          style={styles.viewersSheetWrap}
          onPress={() => { setShowViewers(false); setPaused(false); }}
        >
          <View style={[styles.viewersSheet, { paddingBottom: insets.bottom + 14 }]} onStartShouldSetResponder={() => true}>
            <View style={styles.viewersHeader}>
              <Text style={styles.viewersTitle}>Seen by {viewers.length}</Text>
              <TouchableOpacity onPress={() => { setShowViewers(false); setPaused(false); }}>
                <Ionicons name="close" size={22} color={theme.textPrimary} />
              </TouchableOpacity>
            </View>
            {viewers.length === 0 ? (
              <Text style={{ color: theme.textMuted, textAlign: "center", paddingVertical: 30 }}>No viewers yet.</Text>
            ) : viewers.map((v) => (
              <View key={v.user_id} style={styles.viewerRow}>
                <View style={styles.smallAvatar}>
                  {v.picture
                    ? <Image source={{ uri: v.picture }} style={styles.avatarImg} />
                    : <Text style={styles.smallAvatarInit}>{v.name?.[0]?.toUpperCase() || "?"}</Text>}
                </View>
                <Text style={{ color: theme.textPrimary, flex: 1 }}>{v.name}</Text>
                <Text style={{ color: theme.textMuted, fontSize: 12 }}>{relativeTime(v.viewed_at)}</Text>
              </View>
            ))}
          </View>
        </Pressable>
      )}
    </View>
  );
}

function relativeTime(iso: string) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  media: { ...StyleSheet.absoluteFillObject, backgroundColor: "#000" },
  leftZone: { position: "absolute", top: 100, bottom: 100, left: 0, width: "30%" },
  rightZone: { position: "absolute", top: 100, bottom: 100, right: 0, width: "70%" },

  topWrap: { position: "absolute", top: 0, left: 0, right: 0 },
  progressRow: { flexDirection: "row", gap: 4, paddingHorizontal: 10, paddingTop: 8 },
  progressTrack: { flex: 1, height: 3, backgroundColor: "rgba(255,255,255,0.25)", borderRadius: 2, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: "#fff" },

  headerRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 10, gap: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18, overflow: "hidden", backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontWeight: "800" },
  userName: { color: "#fff", fontWeight: "700", fontSize: 14 },
  userTime: { color: "rgba(255,255,255,0.75)", fontSize: 11, marginTop: 1 },
  headerBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },

  caption: { position: "absolute", left: 16, right: 16 },
  captionText: { color: "#fff", fontSize: 15, backgroundColor: "rgba(0,0,0,0.45)", padding: 10, borderRadius: 10, textAlign: "center" },

  bottomWrap: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 14 },
  viewersBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 24, paddingVertical: 12,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.2)",
  },
  viewersText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  replyRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  replyInput: {
    flex: 1, color: "#fff", fontSize: 14,
    paddingHorizontal: 18, paddingVertical: 12,
    backgroundColor: "rgba(0,0,0,0.4)", borderRadius: 24,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.3)",
  },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },

  viewersSheetWrap: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  viewersSheet: { backgroundColor: theme.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 16 },
  viewersHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  viewersTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  viewerRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  smallAvatar: { width: 36, height: 36, borderRadius: 18, overflow: "hidden", backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  smallAvatarInit: { color: "#fff", fontWeight: "800" },
});
