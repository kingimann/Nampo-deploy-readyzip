import React, { useEffect, useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView,
  ActivityIndicator, Image, Modal, KeyboardAvoidingView, Platform, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { api, Post, PostMedia, mediaUri } from "@/src/api/client";
import { cloudinaryEnabled, uploadToCloudinary } from "@/src/api/cloudinary";
import { pickThumbnailUri } from "@/src/utils/thumbnail";
import ReelPoster from "@/src/components/ReelPoster";
import { theme } from "@/src/theme";

type Props = {
  visible: boolean;
  onClose: () => void;
  onPosted: (post: Post) => void;
  /** If set, opens in reply mode and submits with `parent_id`. */
  replyTo?: Post | null;
  /** If set, opens in edit mode and submits PATCH. */
  editing?: Post | null;
  /** If set, opens in quote mode and submits with `quote_of`. */
  quoting?: Post | null;
  /** If set, posts into this group. */
  groupId?: string | null;
};

const MAX_MEDIA = 4;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // mirrors the backend per-item limit
const TEXT_MAX = 500;
const COMMENT_POLICIES = [
  { k: "everyone", label: "Everyone", icon: "earth-outline" },
  { k: "followers", label: "Followers", icon: "people-outline" },
  { k: "friends", label: "Friends", icon: "people-circle-outline" },
  { k: "nobody", label: "No one", icon: "lock-closed-outline" },
] as const;
const POLL_DURATIONS: { label: string; hours: number }[] = [
  { label: "1 hour", hours: 1 },
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 24 * 3 },
  { label: "7 days", hours: 24 * 7 },
];

export default function PostComposer({
  visible, onClose, onPosted, replyTo, editing, quoting, groupId,
}: Props) {
  const insets = useSafeAreaInsets();
  // On mobile web the on-screen keyboard overlaps fixed content (RN's
  // KeyboardAvoidingView only acts on iOS native). Track how much the keyboard
  // covers via visualViewport and lift the sheet's bottom above it; it returns
  // to 0 when the keyboard closes so the toolbar drops back down.
  const [kbInset, setKbInset] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || !(window as any).visualViewport) return;
    const vv = (window as any).visualViewport;
    const onResize = () => {
      const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKbInset(overlap > 60 ? overlap : 0);  // ignore browser chrome; only a real keyboard
    };
    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", onResize);
    onResize();
    return () => { vv.removeEventListener("resize", onResize); vv.removeEventListener("scroll", onResize); };
  }, []);
  const [text, setText] = useState("");
  const [media, setMedia] = useState<PostMedia[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [showPoll, setShowPoll] = useState(false);
  const [linkVidOpen, setLinkVidOpen] = useState(false);
  const [linkVidUrl, setLinkVidUrl] = useState("");

  const [resolvingLink, setResolvingLink] = useState(false);
  const addVideoLink = async () => {
    let u = linkVidUrl.trim();
    if (!/^https?:\/\//i.test(u)) { Alert.alert("Invalid link", "Paste a video link starting with https://"); return; }
    if (media.length >= MAX_MEDIA) { Alert.alert("Limit reached", `You can attach up to ${MAX_MEDIA} files.`); return; }
    u = u.replace(/\.gifv(\?|$)/i, ".mp4$1");                  // imgur .gifv → playable .mp4
    // YouTube / TikTok / Vimeo can't be reels — they belong in the post text as an
    // inline embed, not as a video reel.
    if (/youtube\.com|youtu\.be|tiktok\.com|vimeo\.com/i.test(u)) {
      Alert.alert("Not a reel", "YouTube, TikTok and Vimeo links can't be reels — just paste the link into your post and it'll play inline in the feed.");
      return;
    }
    let direct = u;
    let thumb: string | null = null;
    const base = u.split("?")[0].toLowerCase();
    const alreadyDirect = /\.(mp4|webm|mov|m4v|ogg)$/.test(base) || u.toLowerCase().includes("cloudinary.com");
    if (!alreadyDirect) {
      // Resolve page links (imgur/streamable/etc.) to a direct video URL.
      setResolvingLink(true);
      try {
        const r = await api.resolveVideoLink(u);
        if (r.embed) {
          setResolvingLink(false);
          Alert.alert("Not a reel", "That link plays in its own player and can't be a reel — paste it into your post text to embed it in the feed.");
          return;
        }
        direct = r.url; thumb = r.thumbnail || null;
      } catch (e: any) {
        setResolvingLink(false);
        Alert.alert("Couldn't load that video", String(e?.message || e).replace(/^\d{3}:\s*/, "") || "Try a direct .mp4 link.");
        return;
      }
      setResolvingLink(false);
    }
    setMedia((arr) => [...arr, { type: "video", url: direct, thumbnail: thumb } as any].slice(0, MAX_MEDIA));
    setLinkVidUrl(""); setLinkVidOpen(false);
  };
  const [pollOptions, setPollOptions] = useState<string[]>(["", ""]);
  const [pollHours, setPollHours] = useState(24);
  const [likesOff, setLikesOff] = useState(false);
  const [commentPolicy, setCommentPolicy] = useState<"everyone" | "followers" | "friends" | "nobody">("everyone");
  const [subTier, setSubTier] = useState(0); // 0 = public; 1-3 = subscribers-only
  const [privacyOpen, setPrivacyOpen] = useState(false);

  // Privacy controls only make sense for a brand-new top-level (non-group) post.
  const showPrivacy = !editing && !replyTo && !quoting && !groupId;

  useEffect(() => {
    if (visible) {
      if (editing) {
        setText(editing.text || "");
        setMedia(editing.media || []);
      } else {
        setText(""); setMedia([]);
      }
      setShowPoll(false);
      setPollOptions(["", ""]);
      setPollHours(24);
      setLikesOff(false);
      setCommentPolicy("everyone");
      setSubTier(0);
    }
  }, [visible, editing]);

  const pickMedia = async () => {
    if (media.length >= MAX_MEDIA) {
      Alert.alert("Limit reached", `You can attach up to ${MAX_MEDIA} files.`);
      return;
    }
    try {
      // Web doesn't gate behind permission popup.
      if (Platform.OS !== "web") {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          if (!perm.canAskAgain) {
            Alert.alert(
              "Photos access needed",
              "Enable photo library access in Settings to attach media.",
            );
          }
          return;
        }
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"] as any,
        allowsMultipleSelection: true,
        selectionLimit: MAX_MEDIA - media.length,
        quality: 0.7,
        base64: true,
        videoMaxDuration: 30,
      });
      if (result.canceled) return;
      // Reading a video into base64 can take a few seconds — show a spinner.
      setProcessing(true);
      const toAdd: PostMedia[] = [];
      const useCloud = cloudinaryEnabled();
      for (const a of result.assets || []) {
        const isVideo = a.type === "video";

        // Preferred path: push the file straight to the Cloudinary CDN and store
        // only its URL — no size cap, and the DB/feed stay lightweight.
        if (useCloud) {
          try {
            const up = await uploadToCloudinary(a.uri, isVideo ? "video" : "image");
            toAdd.push({
              type: isVideo ? "video" : "image",
              url: up.url,
              thumbnail: up.thumbnail || null,
              width: up.width ?? a.width ?? null,
              height: up.height ?? a.height ?? null,
            });
            continue;
          } catch (err) {
            const msg = String((err as Error)?.message || err);
            if (/too large|file size|maximum is/i.test(msg)) {
              Alert.alert(
                isVideo ? "Video too large" : "File too large",
                isVideo
                  ? "This clip is over your upload limit. Try a shorter or lower-resolution video (a 15–30s clip usually works)."
                  : "Please pick a smaller file.",
              );
            } else if (/network|failed to fetch|timeout/i.test(msg)) {
              Alert.alert("Upload failed", "Couldn't reach the upload server. Check your connection and try again.");
            } else {
              Alert.alert("Upload failed", msg);
            }
            continue;
          }
        }

        // Fallback path (no Cloudinary configured): embed as a base64 data URI,
        // bounded by the per-item size cap.
        let uri = a.uri;
        if (isVideo) {
          try {
            const res = await fetch(a.uri);
            const blob = await res.blob();
            uri = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result as string);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
          } catch {
            Alert.alert("Couldn't attach video", "This video could not be read. Try a shorter clip.");
            continue;
          }
        } else if (a.base64) {
          uri = `data:image/jpeg;base64,${a.base64}`;
        }
        if (uri.length > MAX_MEDIA_BYTES) {
          const mb = (uri.length / (1024 * 1024)).toFixed(0);
          Alert.alert(
            isVideo ? "Video too large" : "Image too large",
            isVideo
              ? `This clip is ~${mb}MB; the limit is 25MB. Pick a shorter or lower-resolution clip (≈15–20s).`
              : "Please pick a smaller image.",
          );
          continue;
        }
        toAdd.push({
          type: isVideo ? "video" : "image",
          base64: uri,
          width: a.width || null,
          height: a.height || null,
        });
      }
      if (toAdd.length) setMedia((arr) => [...arr, ...toAdd].slice(0, MAX_MEDIA));
    } catch (e) {
      Alert.alert("Couldn't attach media", String(e));
    } finally {
      setProcessing(false);
    }
  };

  const takePhoto = async () => {
    if (media.length >= MAX_MEDIA) return;
    if (Platform.OS === "web") {
      Alert.alert("Camera unavailable", "Use the photo library instead.");
      return;
    }
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const r = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"] as any,
      quality: 0.7,
      base64: true,
    });
    if (r.canceled) return;
    const a = r.assets?.[0];
    if (a?.base64) {
      setMedia((arr) =>
        [...arr, { type: "image", base64: `data:image/jpeg;base64,${a.base64}` }].slice(0, MAX_MEDIA),
      );
    }
  };

  const pickCover = async () => {
    setCoverBusy(true);
    try {
      const uri = await pickThumbnailUri();
      if (uri) setMedia((arr) => arr.map((m) => (m.type === "video" ? { ...m, thumbnail: uri } : m)));
    } catch (e: any) {
      Alert.alert("Couldn't set cover", String(e?.message || e));
    } finally {
      setCoverBusy(false);
    }
  };
  const removeCover = () =>
    setMedia((arr) => arr.map((m) => (m.type === "video" ? { ...m, thumbnail: null } : m)));

  const submit = async () => {
    const t = text.trim();
    const validPoll = showPoll && pollOptions.filter((o) => o.trim()).length >= 2;
    if (!t && media.length === 0 && !quoting && !validPoll) return;
    setSubmitting(true);
    try {
      let p: Post;
      if (editing) {
        p = await api.editPost(editing.id, { text: t, media });
      } else if (groupId) {
        p = await api.createGroupPost(groupId, {
          text: t || undefined,
          parent_id: replyTo?.id,
          quote_of: quoting?.id,
          media: media.length ? media : undefined,
          poll: validPoll ? {
            options: pollOptions.map((o) => o.trim()).filter(Boolean),
            duration_hours: pollHours,
          } : undefined,
        });
      } else {
        p = await api.createPost({
          text: t || undefined,
          parent_id: replyTo?.id,
          quote_of: quoting?.id,
          media: media.length ? media : undefined,
          poll: validPoll ? {
            options: pollOptions.map((o) => o.trim()).filter(Boolean),
            duration_hours: pollHours,
          } : undefined,
          ...(showPrivacy ? { likes_disabled: likesOff, comment_policy: commentPolicy, min_sub_tier: subTier } : {}),
        });
      }
      onPosted(p);
      onClose();
    } catch (e: any) {
      Alert.alert("Couldn't post", String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  const remaining = TEXT_MAX - text.length;
  const hasVideo = media.some((m) => m.type === "video");
  const videoThumb = media.find((m) => m.type === "video")?.thumbnail || null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.backdrop}
      >
        <View style={[styles.sheet, { paddingBottom: kbInset > 0 ? kbInset + 8 : insets.bottom + 16, paddingTop: insets.top + 12 }]}>
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} testID="composer-close">
              <Ionicons name="close" size={26} color={theme.textPrimary} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>
              {editing ? "Edit post" : quoting ? "Quote post" : replyTo ? "Reply" : "New post"}
            </Text>
            <TouchableOpacity
              onPress={submit}
              disabled={submitting || processing || (!text.trim() && media.length === 0 && !quoting && !(showPoll && pollOptions.filter((o) => o.trim()).length >= 2))}
              style={[
                styles.postBtn,
                (submitting || processing || (!text.trim() && media.length === 0 && !quoting && !(showPoll && pollOptions.filter((o) => o.trim()).length >= 2))) && { opacity: 0.4 },
              ]}
              testID="composer-submit"
            >
              {submitting
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.postBtnText}>{editing ? "Save" : quoting ? "Quote" : replyTo ? "Reply" : "Post"}</Text>}
            </TouchableOpacity>
          </View>

          {!!replyTo && (
            <View style={styles.replyTo}>
              <Text style={styles.replyToLabel}>Replying to <Text style={{ color: theme.primary }}>@{replyTo.author.name}</Text></Text>
              {!!replyTo.text && <Text style={styles.replyToText} numberOfLines={2}>{replyTo.text}</Text>}
            </View>
          )}

          {!!quoting && (
            <View style={styles.replyTo}>
              <Text style={styles.replyToLabel}>Quoting <Text style={{ color: theme.primary }}>@{quoting.author.name}</Text></Text>
              {!!quoting.text && <Text style={styles.replyToText} numberOfLines={3}>{quoting.text}</Text>}
            </View>
          )}

          <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={(s) => setText(s.slice(0, TEXT_MAX))}
              placeholder={replyTo ? "Post your reply" : media.some((m) => m.type === "video") ? "Add a description for your reel…" : "What's happening?"}
              placeholderTextColor={theme.textMuted}
              multiline
              autoFocus
              testID="composer-text"
            />

            {(media.length > 0 || processing) && (
              <View style={styles.mediaRow}>
                {processing && (
                  <View style={styles.mediaChip}>
                    <View style={[StyleSheet.absoluteFill, styles.processingTile]}>
                      <ActivityIndicator color={theme.primary} />
                      <Text style={styles.processingText}>Processing…</Text>
                    </View>
                  </View>
                )}
                {media.map((m, idx) => (
                  <View key={idx} style={styles.mediaChip}>
                    {m.type === "video" ? (
                      <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
                        <Ionicons name="videocam" size={22} color={theme.textSecondary} />
                      </View>
                    ) : (
                      <Image
                        source={{ uri: mediaUri(m) }}
                        style={StyleSheet.absoluteFill}
                        resizeMode="cover"
                      />
                    )}
                    {m.type === "video" && (
                      <View style={styles.videoBadge}>
                        <Ionicons name="play" size={12} color="#fff" />
                      </View>
                    )}
                    <TouchableOpacity
                      style={styles.removeBtn}
                      onPress={() => setMedia((a) => a.filter((_, i) => i !== idx))}
                    >
                      <Ionicons name="close" size={14} color="#fff" />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            {hasVideo && (
              <View style={styles.coverRow}>
                <View style={styles.coverPreview}>
                  <ReelPoster uri={videoThumb} compact />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.coverTitle}>Reel cover</Text>
                  <Text style={styles.coverSub} numberOfLines={1}>
                    {videoThumb ? "Custom thumbnail" : "Default “Nami Social” cover"}
                  </Text>
                </View>
                <TouchableOpacity onPress={pickCover} disabled={coverBusy} style={styles.coverBtn} testID="composer-cover">
                  {coverBusy
                    ? <ActivityIndicator color={theme.primary} size="small" />
                    : <Text style={styles.coverBtnText}>{videoThumb ? "Change" : "Add cover"}</Text>}
                </TouchableOpacity>
                {!!videoThumb && (
                  <TouchableOpacity onPress={removeCover} style={styles.coverClear} testID="composer-cover-clear">
                    <Ionicons name="close" size={16} color={theme.textMuted} />
                  </TouchableOpacity>
                )}
              </View>
            )}

            {showPoll && (
              <View style={styles.pollBuilder}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={styles.pollTitle}>Poll</Text>
                  <TouchableOpacity onPress={() => setShowPoll(false)}>
                    <Ionicons name="close-circle" size={18} color={theme.textMuted} />
                  </TouchableOpacity>
                </View>
                {pollOptions.map((opt, idx) => (
                  <View key={idx} style={styles.pollOptRow}>
                    <TextInput
                      placeholder={`Choice ${idx + 1}`}
                      placeholderTextColor={theme.textMuted}
                      value={opt}
                      onChangeText={(v) =>
                        setPollOptions((arr) => arr.map((o, i) => i === idx ? v.slice(0, 60) : o))
                      }
                      style={styles.pollOptInput}
                      maxLength={60}
                    />
                    {pollOptions.length > 2 && (
                      <TouchableOpacity
                        onPress={() => setPollOptions((arr) => arr.filter((_, i) => i !== idx))}
                      >
                        <Ionicons name="remove-circle-outline" size={20} color={theme.textMuted} />
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
                {pollOptions.length < 4 && (
                  <TouchableOpacity
                    style={styles.pollAddBtn}
                    onPress={() => setPollOptions((arr) => [...arr, ""])}
                  >
                    <Ionicons name="add" size={16} color={theme.primary} />
                    <Text style={styles.pollAddText}>Add choice</Text>
                  </TouchableOpacity>
                )}
                <View style={styles.pollDurationRow}>
                  <Text style={styles.pollLabel}>Duration:</Text>
                  {POLL_DURATIONS.map((d) => (
                    <TouchableOpacity
                      key={d.hours}
                      onPress={() => setPollHours(d.hours)}
                      style={[styles.durationChip, pollHours === d.hours && styles.durationChipActive]}
                    >
                      <Text style={[styles.durationChipText, pollHours === d.hours && { color: "#fff" }]}>
                        {d.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
          </ScrollView>

          <View style={styles.toolbar}>
            <View style={{ flexDirection: "row", gap: 6 }}>
              <TouchableOpacity
                onPress={pickMedia}
                disabled={media.length >= MAX_MEDIA || processing}
                style={[styles.toolBtn, (media.length >= MAX_MEDIA || processing) && { opacity: 0.3 }]}
                testID="composer-attach"
              >
                {processing
                  ? <ActivityIndicator color={theme.primary} size="small" />
                  : <Ionicons name="image-outline" size={22} color={theme.primary} />}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={takePhoto}
                disabled={media.length >= MAX_MEDIA}
                style={[styles.toolBtn, media.length >= MAX_MEDIA && { opacity: 0.3 }]}
                testID="composer-camera"
              >
                <Ionicons name="camera-outline" size={22} color={theme.primary} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setLinkVidOpen(true)}
                disabled={media.length >= MAX_MEDIA}
                style={[styles.toolBtn, media.length >= MAX_MEDIA && { opacity: 0.3 }]}
                testID="composer-video-link"
              >
                <Ionicons name="link" size={22} color={theme.primary} />
              </TouchableOpacity>
              {!editing && !replyTo && !quoting && (
                <TouchableOpacity
                  onPress={() => setShowPoll((v) => !v)}
                  style={[styles.toolBtn, showPoll && { backgroundColor: theme.primary, borderColor: theme.primary }]}
                  testID="composer-poll"
                >
                  <Ionicons name="bar-chart" size={22} color={showPoll ? "#fff" : theme.primary} />
                </TouchableOpacity>
              )}
              {showPrivacy && (
                <TouchableOpacity
                  onPress={() => setPrivacyOpen(true)}
                  style={styles.audienceBtn}
                  testID="composer-privacy"
                >
                  <Ionicons name={(COMMENT_POLICIES.find((p) => p.k === commentPolicy)?.icon as any) || "earth-outline"} size={16} color={theme.primary} />
                  <Text style={styles.audienceText} numberOfLines={1}>
                    {subTier > 0 ? `Tier ${subTier}+` : COMMENT_POLICIES.find((p) => p.k === commentPolicy)?.label}
                  </Text>
                  {subTier > 0 && <Ionicons name="star" size={13} color="#F5A623" />}
                  {likesOff && <Ionicons name="heart-dislike-outline" size={14} color={theme.textMuted} />}
                </TouchableOpacity>
              )}
            </View>
            <Text style={[styles.counter, remaining < 20 && { color: "#F59E0B" }, remaining < 0 && { color: "#EF4444" }]}>
              {remaining}
            </Text>
          </View>

          {submitting && (
            <View style={styles.uploadingOverlay} testID="composer-uploading">
              <ActivityIndicator color={theme.primary} size="large" />
              <Text style={styles.uploadingText}>
                {media.some((m) => m.type === "video") ? "Uploading video…" : "Posting…"}
              </Text>
            </View>
          )}
        </View>

        {/* Audience & likes — one button opens this sheet. */}
        <Modal visible={privacyOpen} transparent animationType="fade" onRequestClose={() => setPrivacyOpen(false)}>
          <View style={styles.pBackdrop}>
            <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setPrivacyOpen(false)} />
            <View style={styles.pCard}>
              <Text style={styles.pTitle}>Post settings</Text>
              <View style={styles.pRow}>
                <View style={styles.pLabelWrap}>
                  <Ionicons name="heart-outline" size={17} color={theme.textSecondary} />
                  <Text style={styles.pLabel}>Likes</Text>
                </View>
                <TouchableOpacity style={[styles.toggle, !likesOff && styles.toggleOn]} onPress={() => setLikesOff((v) => !v)} testID="composer-likes-toggle">
                  <Text style={[styles.toggleText, !likesOff && { color: "#fff" }]}>{likesOff ? "Off" : "On"}</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.pSection}>Who can comment</Text>
              {COMMENT_POLICIES.map((o) => {
                const on = commentPolicy === o.k;
                return (
                  <TouchableOpacity key={o.k} style={styles.pOpt} onPress={() => setCommentPolicy(o.k)} testID={`composer-comment-${o.k}`}>
                    <Ionicons name={o.icon as any} size={18} color={on ? theme.primary : theme.textMuted} />
                    <Text style={[styles.pOptLabel, on && { color: theme.primary }]}>{o.label}</Text>
                    <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={20} color={on ? theme.primary : theme.textMuted} />
                  </TouchableOpacity>
                );
              })}
              <Text style={styles.pSection}>Subscribers only</Text>
              {[
                { lvl: 0, label: "Everyone (public)" },
                { lvl: 1, label: "Tier 1 subscribers & up" },
                { lvl: 2, label: "Tier 2 subscribers & up" },
                { lvl: 3, label: "Tier 3 subscribers only" },
              ].map((o) => {
                const on = subTier === o.lvl;
                return (
                  <TouchableOpacity key={o.lvl} style={styles.pOpt} onPress={() => setSubTier(o.lvl)} testID={`composer-tier-${o.lvl}`}>
                    <Ionicons name={o.lvl === 0 ? "earth-outline" : "star"} size={18} color={on ? theme.primary : (o.lvl === 0 ? theme.textMuted : "#F5A623")} />
                    <Text style={[styles.pOptLabel, on && { color: theme.primary }]}>{o.label}</Text>
                    <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={20} color={on ? theme.primary : theme.textMuted} />
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity style={styles.pDone} onPress={() => setPrivacyOpen(false)} testID="composer-privacy-done">
                <Text style={styles.pDoneText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        <Modal visible={linkVidOpen} transparent animationType="fade" onRequestClose={() => setLinkVidOpen(false)}>
          <View style={styles.vlBackdrop}>
            <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setLinkVidOpen(false)} />
            <View style={styles.vlCard}>
              <Text style={styles.vlTitle}>Add a video by link</Text>
              <Text style={styles.vlSub}>Paste a direct video link (e.g. an i.imgur.com/…mp4 link). It plays inline like an upload — great for reels.</Text>
              <View style={styles.vlInputWrap}>
                <Ionicons name="link" size={16} color={theme.textMuted} />
                <TextInput
                  style={styles.vlInput}
                  value={linkVidUrl}
                  onChangeText={setLinkVidUrl}
                  placeholder="https://i.imgur.com/abc.mp4"
                  placeholderTextColor={theme.textMuted}
                  autoCapitalize="none"
                  keyboardType="url"
                  autoFocus
                  testID="composer-video-link-input"
                />
              </View>
              <TouchableOpacity style={[styles.vlBtn, resolvingLink && { opacity: 0.7 }]} onPress={addVideoLink} disabled={resolvingLink} testID="composer-video-link-add">
                {resolvingLink ? <ActivityIndicator color="#fff" /> : <Text style={styles.vlBtnText}>Add video</Text>}
              </TouchableOpacity>
              <TouchableOpacity style={styles.vlCancel} onPress={() => setLinkVidOpen(false)}>
                <Text style={styles.vlCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: {
    flex: 1, backgroundColor: theme.bg, paddingHorizontal: 16,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
  },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
  },
  headerTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  postBtn: {
    backgroundColor: theme.primary, paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: 999,
  },
  postBtnText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  replyTo: {
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
  },
  replyToLabel: { color: theme.textMuted, fontSize: 12 },
  replyToText: { color: theme.textSecondary, fontSize: 13, marginTop: 4 },
  input: {
    color: theme.textPrimary, fontSize: 17, lineHeight: 23,
    minHeight: 120, paddingTop: 12, paddingBottom: 4,
    textAlignVertical: "top",
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  mediaRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8, paddingBottom: 12 },
  coverRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surfaceAlt, borderRadius: 14,
    borderWidth: 1, borderColor: theme.border,
    padding: 10, marginBottom: 12,
  },
  coverPreview: { width: 44, height: 62, borderRadius: 8, overflow: "hidden", backgroundColor: "#000" },
  coverTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "800" },
  coverSub: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  coverBtn: {
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9, minWidth: 64, alignItems: "center",
  },
  coverBtnText: { color: theme.primary, fontSize: 13.5, fontWeight: "800" },
  coverClear: { width: 30, height: 30, borderRadius: 15, backgroundColor: theme.surface, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.border },
  processingTile: { backgroundColor: theme.surfaceAlt, alignItems: "center", justifyContent: "center", gap: 6 },
  processingText: { color: theme.textSecondary, fontSize: 11, fontWeight: "600" },
  uploadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(10,10,10,0.78)",
    alignItems: "center", justifyContent: "center", gap: 12,
  },
  uploadingText: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  mediaChip: {
    width: 88, height: 88, borderRadius: 12, overflow: "hidden",
    backgroundColor: theme.surface, position: "relative",
  },
  removeBtn: {
    position: "absolute", top: 4, right: 4,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center", justifyContent: "center",
  },
  videoBadge: {
    position: "absolute", bottom: 4, left: 4,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
    backgroundColor: "rgba(0,0,0,0.6)",
    flexDirection: "row", alignItems: "center", gap: 4,
  },
  toolbar: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
  },
  toolBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: "center", justifyContent: "center",
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
  },
  counter: { color: theme.textMuted, fontSize: 13, fontWeight: "700" },
  vlBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 26 },
  vlCard: { width: "100%", maxWidth: 400, backgroundColor: theme.surface, borderRadius: 20, borderWidth: 1, borderColor: theme.border, padding: 22 },
  vlTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "900" },
  vlSub: { color: theme.textMuted, fontSize: 13, lineHeight: 18, marginTop: 6, marginBottom: 14 },
  vlInputWrap: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: theme.bg, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 12, height: 48 },
  vlInput: { flex: 1, color: theme.textPrimary, fontSize: 15, height: "100%", ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  vlBtn: { backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 14 },
  vlBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  vlCancel: { alignItems: "center", paddingVertical: 10, marginTop: 2 },
  vlCancelText: { color: theme.textMuted, fontWeight: "700", fontSize: 14 },
  pollBuilder: {
    marginTop: 10, padding: 12, borderRadius: 14,
    borderWidth: 1, borderColor: theme.border,
    backgroundColor: theme.surfaceAlt, gap: 8,
  },
  pollTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "800" },
  pollOptRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  pollOptInput: {
    flex: 1, color: theme.textPrimary, fontSize: 14,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  pollAddBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    alignSelf: "flex-start", paddingVertical: 4, paddingHorizontal: 8,
  },
  pollAddText: { color: theme.primary, fontSize: 13, fontWeight: "700" },
  pollDurationRow: {
    flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 4,
  },
  pollLabel: { color: theme.textMuted, fontSize: 12, fontWeight: "700", marginRight: 4 },
  durationChip: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999,
    borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface,
  },
  durationChipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  durationChipText: { color: theme.textSecondary, fontSize: 11, fontWeight: "700" },
  audienceBtn: {
    flexDirection: "row", alignItems: "center", gap: 5, maxWidth: 150,
    height: 40, paddingHorizontal: 12, borderRadius: 20,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
  },
  audienceText: { color: theme.primary, fontSize: 13, fontWeight: "700", flexShrink: 1 },
  toggle: { paddingHorizontal: 14, height: 32, borderRadius: 999, alignItems: "center", justifyContent: "center", backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  toggleOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  toggleText: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "800" },
  pBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 24 },
  pCard: { width: "100%", maxWidth: 420, backgroundColor: theme.surface, borderRadius: 18, borderWidth: 1, borderColor: theme.border, padding: 18 },
  pTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800", marginBottom: 10 },
  pRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8 },
  pLabelWrap: { flexDirection: "row", alignItems: "center", gap: 8 },
  pLabel: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  pSection: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 14, marginBottom: 4 },
  pOpt: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  pOptLabel: { flex: 1, color: theme.textPrimary, fontSize: 15, fontWeight: "600" },
  pDone: { marginTop: 16, height: 48, borderRadius: 12, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  pDoneText: { color: "#fff", fontSize: 15, fontWeight: "800" },
});
