import React, { useCallback, useEffect, useState, useRef } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  Image, useWindowDimensions, Platform, RefreshControl, Pressable, Alert, Linking, Animated,
  Modal, KeyboardAvoidingView, TextInput, ScrollView,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, Post, PublicUser, TaggedUser, mediaUri } from "@/src/api/client";
import { pickThumbnailUri } from "@/src/utils/thumbnail";
import { theme } from "@/src/theme";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";
import CommentsSheet from "@/src/components/CommentsSheet";
import ReelVideo from "@/src/components/ReelVideo";
import ReelPoster from "@/src/components/ReelPoster";
import VerifiedBadge from "@/src/components/VerifiedBadge";
import UserBadges from "@/src/components/UserBadges";
import { useAuth } from "@/src/context/AuthContext";

function Reel({ post, active, muted, onToggleMute, onOpenComments, screenW, screenH, myId, onEdited }: {
  post: Post; active: boolean; muted: boolean; onToggleMute: () => void;
  onOpenComments: (p: Post) => void; screenW: number; screenH: number; myId?: string;
  onEdited?: (updated: Post) => void;
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
  // Caption editing (owner only). `caption` is the live, editable text.
  const [caption, setCaption] = useState(content.text || "");
  const [editOpen, setEditOpen] = useState(false);
  const [editText, setEditText] = useState(content.text || "");
  const [editCover, setEditCover] = useState<string | null>(video?.thumbnail || null);
  const [coverBusy, setCoverBusy] = useState(false);
  const [editCommentsOff, setEditCommentsOff] = useState(content.comment_policy === "nobody");
  const [editPlaceName, setEditPlaceName] = useState(content.place_name || "");
  const [editPlaceLng, setEditPlaceLng] = useState<number | null>(content.place_longitude ?? null);
  const [editPlaceLat, setEditPlaceLat] = useState<number | null>(content.place_latitude ?? null);
  const [locBusy, setLocBusy] = useState(false);
  const [editTags, setEditTags] = useState<TaggedUser[]>(content.tagged_users || []);
  const [tagQuery, setTagQuery] = useState("");
  const [tagResults, setTagResults] = useState<PublicUser[]>([]);
  const [tagSearching, setTagSearching] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const isOwner = !!myId && content.user_id === myId;

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
    setCaption(content.text || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id]);

  const pickCover = async () => {
    setCoverBusy(true);
    try {
      const uri = await pickThumbnailUri();
      if (uri) setEditCover(uri);
    } catch (e: any) {
      Alert.alert("Couldn't set cover", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally {
      setCoverBusy(false);
    }
  };

  const useCurrentLocation = async () => {
    setLocBusy(true);
    try {
      let { status } = await Location.getForegroundPermissionsAsync();
      if (status !== "granted") {
        const r = await Location.requestForegroundPermissionsAsync();
        status = r.status;
      }
      if (status !== "granted") {
        Alert.alert("Location off", "Enable location access to tag where this reel was made.");
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      let name = "";
      try {
        const places = await Location.reverseGeocodeAsync({
          latitude: pos.coords.latitude, longitude: pos.coords.longitude,
        });
        const p = places?.[0];
        if (p) name = [p.name, p.city, p.region].filter(Boolean).join(", ");
      } catch {}
      setEditPlaceLng(pos.coords.longitude);
      setEditPlaceLat(pos.coords.latitude);
      if (name) setEditPlaceName(name);
    } catch (e: any) {
      Alert.alert("Couldn't get location", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally {
      setLocBusy(false);
    }
  };
  const clearLocation = () => { setEditPlaceName(""); setEditPlaceLng(null); setEditPlaceLat(null); };

  const addTag = (u: PublicUser) => {
    setEditTags((arr) =>
      arr.find((t) => t.user_id === u.user_id)
        ? arr
        : [...arr, { user_id: u.user_id, name: u.name, username: u.username, picture: u.picture }]
    );
    setTagQuery(""); setTagResults([]);
  };
  const removeTag = (uid: string) => setEditTags((arr) => arr.filter((t) => t.user_id !== uid));

  // Debounced people search for the tag picker (only runs while editing).
  useEffect(() => {
    const q = tagQuery.trim();
    if (!q) { setTagResults([]); return; }
    let alive = true;
    setTagSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.searchUsers(q);
        if (alive) setTagResults(res);
      } catch {} finally {
        if (alive) setTagSearching(false);
      }
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [tagQuery]);

  const openEdit = () => {
    setEditText(caption);
    setEditCover(video?.thumbnail || null);
    setEditCommentsOff(content.comment_policy === "nobody");
    setEditPlaceName(content.place_name || "");
    setEditPlaceLng(content.place_longitude ?? null);
    setEditPlaceLat(content.place_latitude ?? null);
    setEditTags(content.tagged_users || []);
    setTagQuery(""); setTagResults([]);
    setEditOpen(true);
  };

  const saveEdit = async () => {
    setSavingEdit(true);
    try {
      const coverChanged = (editCover || null) !== (video?.thumbnail || null);
      const body: {
        text: string; media?: any[];
        place_name?: string | null; place_longitude?: number | null; place_latitude?: number | null;
        comment_policy?: string; tagged_user_ids?: string[];
      } = { text: editText.trim() };
      // Only resend media when the cover actually changed (a base64 reel's media
      // can be large; text-only edits stay lightweight).
      if (coverChanged) {
        body.media = (content.media || []).map((m) =>
          m.type === "video" ? { ...m, thumbnail: editCover || null } : m
        );
      }
      // Only touch comment_policy when the switch was actually flipped, so we
      // never clobber a granular (followers/friends) policy.
      if (editCommentsOff !== (content.comment_policy === "nobody")) {
        body.comment_policy = editCommentsOff ? "nobody" : "everyone";
      }
      body.place_name = editPlaceName.trim();
      body.place_longitude = editPlaceLng;
      body.place_latitude = editPlaceLat;
      body.tagged_user_ids = editTags.map((t) => t.user_id);
      const updated = await api.editPost(content.id, body);
      setCaption(updated.text || "");
      setEditOpen(false);
      onEdited?.(updated);
    } catch (e: any) {
      Alert.alert("Couldn't save", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally {
      setSavingEdit(false);
    }
  };

  const doReact = async (emoji: string) => {
    setReactOpen(false);
    if (content.locked) return goSub();
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
  // Clear the pending single-tap timer if this row is recycled/unmounted, so it
  // can't fire setPaused on an unmounted component.
  useEffect(() => () => { if (pendingTap.current) clearTimeout(pendingTap.current); }, []);
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

  // Subscriber-only reels: engagement routes to the creator's subscribe sheet.
  const goSub = () => router.push({ pathname: "/user/[name]", params: { name: content.author?.name || "", subscribe: "1" } });
  const onRepost = async () => {
    if (content.locked) return goSub();
    // Derive the count delta from the SAME toggle so a fast double-tap can't read
    // a stale `reposted` and move the count the wrong way.
    setReposted((v) => { setRepostCount((n) => Math.max(0, n + (v ? -1 : 1))); return !v; });
    try { await api.toggleRepost(post.repost_of || post.id); } catch {}
  };
  const onComment = () => { if (content.locked) return goSub(); onOpenComments(content); };
  const onUser = () => router.push({ pathname: "/user/[name]", params: { name: content.author?.name || "" } });
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
      {content.locked ? (
        <View style={[StyleSheet.absoluteFill, styles.reelLock]}>
          <View style={styles.reelLockIcon}><Ionicons name="lock-closed" size={34} color="#F5A623" /></View>
          <Text style={styles.reelLockTitle}>Subscribers-only reel</Text>
          <Text style={styles.reelLockSub}>
            Subscribe to @{content.author?.name} at Tier {content.min_sub_tier || 1}{(content.min_sub_tier || 1) < 3 ? "+" : ""} to watch.
          </Text>
          <TouchableOpacity
            style={styles.reelLockBtn}
            onPress={() => router.push({ pathname: "/user/[name]", params: { name: content.author?.name, subscribe: "1" } })}
            testID={`reel-subscribe-${post.id}`}
          >
            <Ionicons name="star" size={15} color="#fff" />
            <Text style={styles.reelLockBtnText}>Subscribe</Text>
          </TouchableOpacity>
        </View>
      ) : videoUri ? (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={handleTap}
          onLongPress={() => setFastFwd(true)}
          onPressOut={() => setFastFwd(false)}
          delayLongPress={220}
          testID={`reel-tap-${post.id}`}
        >
          <ReelVideo uri={videoUri} active={active} paused={paused} muted={muted} rate={fastFwd ? 2 : rate} poster={video?.thumbnail} />
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
            <Text style={styles.avatarLetter}>{(content.author?.name?.[0] || "?").toUpperCase()}</Text>
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
        {isOwner ? (
          <>
            <TouchableOpacity style={styles.iconBtn} onPress={openEdit} testID={`reel-edit-${post.id}`}>
              <Ionicons name="create-outline" size={25} color="#fff" />
              <Text style={styles.metric}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconBtn} onPress={() => router.push({ pathname: "/advertise", params: { post: content.id } })} testID={`reel-promote-${post.id}`}>
              <Ionicons name="megaphone" size={23} color="#fff" />
              <Text style={styles.metric}>Promote</Text>
            </TouchableOpacity>
          </>
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
            <Text style={styles.repostHintText}>Reposted by @{post.author?.name}</Text>
          </View>
        )}
        <TouchableOpacity style={styles.authorRow} onPress={onUser} activeOpacity={0.8}>
          <Text style={styles.author} numberOfLines={1}>@{content.author?.name}</Text>
          {content.author?.verified && <VerifiedBadge size={15} />}
          <UserBadges badges={content.author?.badges} size={15} />
        </TouchableOpacity>
        {!!content.place_name && (videoUri || imageUri) && (
          <View style={styles.metaRow}>
            <Ionicons name="location" size={13} color="rgba(255,255,255,0.9)" />
            <Text style={styles.metaText} numberOfLines={1}>{content.place_name}</Text>
          </View>
        )}
        {!!content.tagged_users?.length && (videoUri || imageUri) && (
          <TouchableOpacity
            style={styles.metaRow}
            activeOpacity={0.8}
            onPress={() => router.push({ pathname: "/user/[name]", params: { name: content.tagged_users![0].name } })}
          >
            <Ionicons name="pricetag" size={12} color="rgba(255,255,255,0.9)" />
            <Text style={styles.metaText} numberOfLines={1}>
              with {content.tagged_users!.map((t) => "@" + (t.username || t.name)).join(", ")}
            </Text>
          </TouchableOpacity>
        )}
        {!!caption && (videoUri || imageUri) && (
          <TouchableOpacity activeOpacity={0.9} onPress={() => setCaptionOpen((o) => !o)}>
            <Text style={styles.caption} numberOfLines={captionOpen ? undefined : 2}>{caption}</Text>
            {!captionOpen && caption.length > 80 && (
              <Text style={styles.captionMore}>more</Text>
            )}
          </TouchableOpacity>
        )}
      </View>

      <Modal visible={editOpen} transparent animationType="fade" onRequestClose={() => setEditOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.editBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setEditOpen(false)} />
          <View style={styles.editCard}>
            <Text style={styles.editTitle}>Edit reel</Text>
            <ScrollView
              style={{ maxHeight: Math.min(460, screenH * 0.58) }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {!!videoUri && (
                <View style={styles.coverRow}>
                  <View style={styles.coverPreview}>
                    <ReelPoster uri={editCover} compact />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.coverLabel}>Cover</Text>
                    <Text style={styles.coverHint} numberOfLines={1}>
                      {editCover ? "Custom thumbnail" : "Default “OkaySpace” cover"}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={pickCover} disabled={coverBusy} style={styles.coverBtn} testID="reel-edit-cover">
                    {coverBusy
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={styles.coverBtnText}>{editCover ? "Change" : "Add"}</Text>}
                  </TouchableOpacity>
                  {!!editCover && (
                    <TouchableOpacity onPress={() => setEditCover(null)} style={styles.coverClear} testID="reel-edit-cover-clear">
                      <Ionicons name="close" size={16} color="rgba(255,255,255,0.7)" />
                    </TouchableOpacity>
                  )}
                </View>
              )}
              <TextInput
                style={styles.editInput}
                value={editText}
                onChangeText={setEditText}
                placeholder="Write a description…"
                placeholderTextColor="rgba(255,255,255,0.4)"
                multiline
                maxLength={500}
                testID="reel-edit-input"
              />

              {/* Comments */}
              <View style={styles.editToggleRow}>
                <View style={styles.editToggleLabel}>
                  <Ionicons name="chatbubble-ellipses-outline" size={18} color="#fff" />
                  <Text style={styles.editToggleText}>Allow comments</Text>
                </View>
                <TouchableOpacity
                  onPress={() => setEditCommentsOff((v) => !v)}
                  style={[styles.miniToggle, !editCommentsOff && styles.miniToggleOn]}
                  testID="reel-edit-comments"
                >
                  <Text style={[styles.miniToggleText, !editCommentsOff && { color: "#fff" }]}>
                    {editCommentsOff ? "Off" : "On"}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Location */}
              <Text style={styles.editSectionLabel}>Location</Text>
              <View style={styles.locInputRow}>
                <Ionicons name="location-outline" size={16} color="rgba(255,255,255,0.6)" />
                <TextInput
                  style={styles.locInput}
                  value={editPlaceName}
                  onChangeText={setEditPlaceName}
                  placeholder="Add a location"
                  placeholderTextColor="rgba(255,255,255,0.4)"
                  maxLength={120}
                  testID="reel-edit-location-input"
                />
                {!!editPlaceName && (
                  <TouchableOpacity onPress={clearLocation} testID="reel-edit-location-clear">
                    <Ionicons name="close-circle" size={18} color="rgba(255,255,255,0.5)" />
                  </TouchableOpacity>
                )}
              </View>
              <TouchableOpacity onPress={useCurrentLocation} disabled={locBusy} style={styles.locBtn} testID="reel-edit-location-current">
                {locBusy ? (
                  <ActivityIndicator color={theme.primary} size="small" />
                ) : (
                  <>
                    <Ionicons name="navigate" size={14} color={theme.primary} />
                    <Text style={styles.locBtnText}>Use current location</Text>
                  </>
                )}
              </TouchableOpacity>

              {/* Tag people */}
              <Text style={styles.editSectionLabel}>Tag people</Text>
              {editTags.length > 0 && (
                <View style={styles.tagChips}>
                  {editTags.map((t) => (
                    <View key={t.user_id} style={styles.tagChip}>
                      <Text style={styles.tagChipText} numberOfLines={1}>@{t.username || t.name}</Text>
                      <TouchableOpacity onPress={() => removeTag(t.user_id)} testID={`reel-edit-untag-${t.user_id}`}>
                        <Ionicons name="close" size={13} color="#fff" />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              )}
              <View style={styles.locInputRow}>
                <Ionicons name="search" size={15} color="rgba(255,255,255,0.6)" />
                <TextInput
                  style={styles.locInput}
                  value={tagQuery}
                  onChangeText={setTagQuery}
                  placeholder="Search people to tag"
                  placeholderTextColor="rgba(255,255,255,0.4)"
                  autoCapitalize="none"
                  testID="reel-edit-tag-input"
                />
                {tagSearching && <ActivityIndicator color="rgba(255,255,255,0.6)" size="small" />}
              </View>
              {tagResults.filter((u) => !editTags.find((t) => t.user_id === u.user_id)).slice(0, 6).map((u) => (
                <TouchableOpacity key={u.user_id} style={styles.tagResult} onPress={() => addTag(u)} testID={`reel-edit-tag-${u.user_id}`}>
                  <View style={styles.tagAvatar}>
                    {u.picture
                      ? <Image source={{ uri: u.picture }} style={styles.tagAvatarImg} />
                      : <Text style={styles.tagAvatarInit}>{(u.name?.[0] || "?").toUpperCase()}</Text>}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.tagResultName} numberOfLines={1}>{u.name}</Text>
                    {!!u.username && <Text style={styles.tagResultHandle} numberOfLines={1}>@{u.username}</Text>}
                  </View>
                  <Ionicons name="add-circle" size={20} color={theme.primary} />
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={styles.editBtns}>
              <TouchableOpacity onPress={() => setEditOpen(false)} style={styles.editCancel}>
                <Text style={styles.editCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={saveEdit} disabled={savingEdit} style={[styles.editSave, savingEdit && { opacity: 0.6 }]} testID="reel-edit-save">
                <Text style={styles.editSaveText}>{savingEdit ? "Saving…" : "Save"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
        <ReelVideo uri={ad.video_url} active={active} paused={paused} muted={muted} poster={ad.thumbnail} brand={false} />
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
        // Subscribers-only reels have their media stripped — keep them so we
        // can show a paywall instead of silently dropping them.
        if (!src.locked) {
          const uri = mediaUri(src.media?.find((m) => m.type === "video"));
          if (!(uri.startsWith("data:") || uri.startsWith("http"))) return false;
        }
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

  const onReelEdited = useCallback((u: Post) => {
    const merge = (base: any) => ({
      ...base,
      text: u.text, edited_at: u.edited_at, media: u.media,
      place_name: u.place_name, place_longitude: u.place_longitude, place_latitude: u.place_latitude,
      comment_policy: u.comment_policy, tagged_users: u.tagged_users,
    });
    setItems((arr) => arr.map((it) => {
      if (it.id === u.id) return merge(it);
      if (it.reposted_post && it.reposted_post.id === u.id) {
        return { ...it, reposted_post: merge(it.reposted_post) };
      }
      return it;
    }));
  }, []);

  // Tracks which reels have already counted a view/impression this session so we
  // don't double-count. Cleared on scope switch / refresh so re-shown reels can
  // record a fresh impression.
  const recordedViews = useRef<Set<string>>(new Set());
  const switchScope = useCallback((s: "explore" | "following") => {
    setScope((cur) => {
      if (cur === s) return cur;
      setLoading(true); setItems([]); setActiveIdx(0);
      recordedViews.current.clear();
      return s;
    });
  }, []);
  // Pause playback when the screen loses focus (fixes audio bleeding after you leave).
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));
  // Load on mount and when the scope / deep-link focus changes — NOT on every
  // screen focus, which would refetch and reset the scroll position mid-session.
  useEffect(() => { load(); }, [load]);

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
      // Record each view/impression at most once — the threshold re-crosses as a
      // reel re-enters view, which otherwise inflates the count.
      if (it?.id && !recordedViews.current.has(it.id)) {
        recordedViews.current.add(it.id);
        if (it.__ad) api.reelAdEvent(it.id, "impression").catch(() => {});
        else api.recordPostView(it.id).catch(() => {});
      }
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
          keyExtractor={(i) => (i.__ad ? `ad-${i.id}` : i.id)}
          onScrollToIndexFailed={({ index }) => {
            setTimeout(() => { try { listRef.current?.scrollToIndex({ index, animated: false }); } catch {} }, 80);
          }}
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
              onRefresh={() => { setRefreshing(true); recordedViews.current.clear(); load(); }}
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
                onEdited={onReelEdited}
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
  editBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", paddingHorizontal: 22 },
  editCard: { backgroundColor: "#161616", borderRadius: 20, borderWidth: 1, borderColor: "rgba(255,255,255,0.12)", padding: 18 },
  editTitle: { color: "#fff", fontSize: 17, fontWeight: "800", marginBottom: 12 },
  editInput: { color: "#fff", fontSize: 15, lineHeight: 21, minHeight: 90, maxHeight: 200, backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.12)", padding: 12, textAlignVertical: "top", ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  coverRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 14 },
  coverPreview: { width: 50, height: 72, borderRadius: 8, overflow: "hidden", backgroundColor: "#000" },
  coverLabel: { color: "#fff", fontSize: 14, fontWeight: "800" },
  coverHint: { color: "rgba(255,255,255,0.55)", fontSize: 12, marginTop: 2 },
  coverBtn: { backgroundColor: "rgba(255,255,255,0.12)", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9, minWidth: 64, alignItems: "center" },
  coverBtnText: { color: "#fff", fontSize: 13.5, fontWeight: "800" },
  coverClear: { width: 30, height: 30, borderRadius: 15, backgroundColor: "rgba(255,255,255,0.08)", alignItems: "center", justifyContent: "center" },
  editToggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 14 },
  editToggleLabel: { flexDirection: "row", alignItems: "center", gap: 8 },
  editToggleText: { color: "#fff", fontSize: 14.5, fontWeight: "700" },
  miniToggle: { paddingHorizontal: 16, height: 32, borderRadius: 999, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.1)", borderWidth: 1, borderColor: "rgba(255,255,255,0.14)" },
  miniToggleOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  miniToggleText: { color: "rgba(255,255,255,0.75)", fontSize: 13, fontWeight: "800" },
  editSectionLabel: { color: "rgba(255,255,255,0.55)", fontSize: 11.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.6, marginTop: 18, marginBottom: 8 },
  locInputRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.12)", paddingHorizontal: 12, height: 46 },
  locInput: { flex: 1, color: "#fff", fontSize: 15, height: "100%", ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  locBtn: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", marginTop: 8, paddingVertical: 6, paddingHorizontal: 4 },
  locBtnText: { color: theme.primary, fontSize: 13.5, fontWeight: "800" },
  tagChips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  tagChip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.primary, borderRadius: 999, paddingLeft: 12, paddingRight: 8, paddingVertical: 6, maxWidth: 200 },
  tagChipText: { color: "#fff", fontSize: 13, fontWeight: "800", flexShrink: 1 },
  tagResult: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9 },
  tagAvatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  tagAvatarImg: { width: "100%", height: "100%" },
  tagAvatarInit: { color: "#fff", fontSize: 14, fontWeight: "800" },
  tagResultName: { color: "#fff", fontSize: 14.5, fontWeight: "700" },
  tagResultHandle: { color: "rgba(255,255,255,0.55)", fontSize: 12.5, marginTop: 1 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 6 },
  metaText: { color: "rgba(255,255,255,0.92)", fontSize: 13, fontWeight: "600", flexShrink: 1, textShadowColor: "rgba(0,0,0,0.5)", textShadowRadius: 4 },
  editBtns: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 16 },
  editCancel: { paddingHorizontal: 16, paddingVertical: 11 },
  editCancelText: { color: "rgba(255,255,255,0.7)", fontSize: 15, fontWeight: "700" },
  editSave: { backgroundColor: theme.primary, borderRadius: 12, paddingHorizontal: 22, paddingVertical: 11 },
  editSaveText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  reelLock: { alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 40, backgroundColor: "#0b0b0b" },
  reelLockIcon: { width: 72, height: 72, borderRadius: 36, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(245,166,35,0.15)" },
  reelLockTitle: { color: "#fff", fontSize: 19, fontWeight: "800" },
  reelLockSub: { color: "rgba(255,255,255,0.7)", fontSize: 14, lineHeight: 20, textAlign: "center" },
  reelLockBtn: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 8, backgroundColor: "#F5A623", borderRadius: 999, paddingHorizontal: 24, paddingVertical: 12 },
  reelLockBtnText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  caption: { color: "rgba(255,255,255,0.9)", fontSize: 14, marginTop: 6, lineHeight: 20, textShadowColor: "rgba(0,0,0,0.5)", textShadowRadius: 4 },
  captionMore: { color: "rgba(255,255,255,0.65)", fontSize: 13, fontWeight: "700", marginTop: 2 },
});
