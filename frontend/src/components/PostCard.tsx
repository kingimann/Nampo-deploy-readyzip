import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Image, Alert, Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api, Post } from "@/src/api/client";
import { theme } from "@/src/theme";
import MediaGrid from "./MediaGrid";
import RichText from "./RichText";
import LinkPreviewCard from "./LinkPreviewCard";
import PollCard from "./PollCard";
import QuoteCard from "./QuoteCard";
import LikersModal from "./LikersModal";
import ShareToChatSheet from "./ShareToChatSheet";

type Props = {
  post: Post;
  viewerId?: string;
  /** Disable navigating to detail (for the post detail screen header). */
  disableOpen?: boolean;
  onLike: (p: Post) => void;
  onDislike?: (p: Post) => void;
  onRepost: (p: Post) => void;
  onQuote?: (p: Post) => void;
  onReply: (p: Post) => void;
  /** If set, the comment button opens this (Instagram-style sheet) instead of onReply. */
  onComments?: (p: Post) => void;
  onBookmark: (p: Post) => void;
  onMore?: (p: Post) => void;  // owner actions (••• button + long-press)
  onPollUpdated?: (p: Post) => void;
};

export function fmtTime(iso: string) {
  const d = new Date(iso); const now = Date.now();
  const s = Math.floor((now - d.getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return d.toLocaleDateString();
}

export default function PostCard({
  post, viewerId, disableOpen, onLike, onDislike, onRepost, onQuote, onReply, onComments, onBookmark, onMore, onPollUpdated,
}: Props) {
  const router = useRouter();
  const [likers, setLikers] = useState<{ open: boolean; kind: "likers" | "reposters" }>({ open: false, kind: "likers" });
  const [shareOpen, setShareOpen] = useState(false);
  // If this entry is a pure repost (no text, has repost_of), render the original
  // with a "X reposted" banner.
  const isRepost = !!post.repost_of && post.reposted_post;
  const display = (isRepost ? post.reposted_post! : post);
  const isOwner = !!viewerId && display.user_id === viewerId;
  const hasVideo = (display.media || []).some((m) => m.type === "video");

  const openDetail = () => {
    if (disableOpen) return;
    router.push({ pathname: "/post/[id]", params: { id: display.id } });
  };

  // Instagram-style: tapping a video in the feed jumps to the Reels player.
  const openReel = () => {
    router.push({ pathname: "/reels", params: { focus: display.id } });
  };

  const onCommentPress = () => {
    if (onComments) onComments(display);
    else onReply(display);
  };

  const reportPost = () => {
    const doReport = () => { api.reportPost(display.id, "inappropriate").catch(() => {}); };
    if (Platform.OS === "web") {
      // eslint-disable-next-line no-alert
      if (typeof window !== "undefined" && window.confirm("Report this post for review?")) doReport();
    } else {
      Alert.alert("Report post", "Report this post for review?", [
        { text: "Cancel", style: "cancel" },
        { text: "Report", style: "destructive", onPress: doReport },
      ]);
    }
  };

  const showMenu = !isOwner || !!onMore;
  const onMenuPress = () => { if (isOwner) onMore?.(post); else reportPost(); };

  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={disableOpen ? 1 : 0.85}
      onPress={openDetail}
      onLongPress={() => onMore && onMore(post)}
      delayLongPress={400}
      testID={`post-${post.id}`}
    >
      {isRepost && (
        <View style={styles.repostBanner}>
          <Ionicons name="repeat" size={14} color={theme.textMuted} />
          <Text style={styles.repostBannerText} numberOfLines={1}>
            {post.author.name} reposted
          </Text>
        </View>
      )}
      {display.promoted && (
        <View style={styles.sponsoredBanner}>
          <Ionicons name="megaphone" size={13} color={theme.primary} />
          <Text style={styles.sponsoredText}>Sponsored</Text>
        </View>
      )}
      <View style={styles.cardTop}>
        <View style={styles.avatar}>
          {display.author.picture ? (
            <Image source={{ uri: display.author.picture }} style={styles.avatarImg} />
          ) : (
            <Text style={styles.avatarInit}>
              {(display.author.name?.[0] || "?").toUpperCase()}
            </Text>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={styles.author} numberOfLines={1}>{display.author.name}</Text>
            <Text style={styles.dot}>·</Text>
            <Text style={styles.time}>{fmtTime(display.created_at)}</Text>
            {!!display.edited_at && (
              <Text style={styles.time}> · edited</Text>
            )}
          </View>
        </View>
        {showMenu && (
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation?.(); onMenuPress(); }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            testID={`post-more-${post.id}`}
          >
            <Ionicons name="ellipsis-horizontal" size={18} color={theme.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {!!display.text && (
        <RichText text={display.text} style={styles.body} />
      )}

      {display.quoted_post && <QuoteCard post={display.quoted_post} />}

      {display.media && display.media.length > 0 && (
        <MediaGrid
          media={display.media}
          testID={`post-${post.id}`}
          onVideoPress={hasVideo ? openReel : undefined}
        />
      )}

      {display.link_preview && !display.quoted_post && (
        <LinkPreviewCard preview={display.link_preview} />
      )}

      {display.poll && (
        <PollCard
          postId={display.id}
          poll={display.poll}
          onUpdated={(p) => onPollUpdated && onPollUpdated(p)}
        />
      )}

      {display.place_name && (
        <View style={styles.placeRow}>
          <Ionicons name="location" size={12} color={theme.primary} />
          <Text style={styles.placeText} numberOfLines={1}>{display.place_name}</Text>
        </View>
      )}

      <View style={styles.actionsRow}>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={(e) => { e.stopPropagation?.(); onCommentPress(); }}
          testID={`reply-${post.id}`}
        >
          <Ionicons name="chatbubble-outline" size={17} color={theme.textSecondary} />
          <Text style={styles.actionText}>{display.replies_count || 0}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionBtn}
          onPress={(e) => { e.stopPropagation?.(); onRepost(display); }}
          onLongPress={() => onQuote && onQuote(display)}
          delayLongPress={350}
          testID={`repost-${post.id}`}
        >
          <Ionicons
            name="repeat"
            size={17}
            color={display.reposted_by_me ? "#22C55E" : theme.textSecondary}
          />
          <Text style={[styles.actionText, display.reposted_by_me && { color: "#22C55E" }]}>
            {(display.reposts_count || 0) + (display.quotes_count || 0)}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionBtn}
          onPress={(e) => { e.stopPropagation?.(); onLike(display); }}
          onLongPress={() => setLikers({ open: true, kind: "likers" })}
          delayLongPress={350}
          testID={`like-${post.id}`}
        >
          <Ionicons
            name={display.liked_by_me ? "heart" : "heart-outline"}
            size={18}
            color={display.liked_by_me ? "#EF4444" : theme.textSecondary}
          />
          <Text style={[styles.actionText, display.liked_by_me && { color: "#EF4444" }]}>
            {display.likes_count}
          </Text>
        </TouchableOpacity>

        {onDislike && (
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={(e) => { e.stopPropagation?.(); onDislike(display); }}
            testID={`dislike-${post.id}`}
          >
            <Ionicons
              name={display.disliked_by_me ? "thumbs-down" : "thumbs-down-outline"}
              size={17}
              color={display.disliked_by_me ? "#3B82F6" : theme.textSecondary}
            />
            {!!display.dislikes_count && display.dislikes_count > 0 && (
              <Text style={[styles.actionText, display.disliked_by_me && { color: "#3B82F6" }]}>
                {display.dislikes_count}
              </Text>
            )}
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={styles.actionBtn}
          onPress={(e) => { e.stopPropagation?.(); onBookmark(display); }}
          testID={`bookmark-${post.id}`}
        >
          <Ionicons
            name={display.bookmarked_by_me ? "bookmark" : "bookmark-outline"}
            size={17}
            color={display.bookmarked_by_me ? theme.primary : theme.textSecondary}
          />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionBtn}
          onPress={(e) => { e.stopPropagation?.(); setShareOpen(true); }}
          testID={`share-${post.id}`}
        >
          <Ionicons name="paper-plane-outline" size={17} color={theme.textSecondary} />
        </TouchableOpacity>
        {!!display.views_count && display.views_count > 0 && (
          <View style={styles.actionBtn}>
            <Ionicons name="eye-outline" size={17} color={theme.textMuted} />
            <Text style={styles.actionText}>{display.views_count}</Text>
          </View>
        )}
      </View>

      <LikersModal
        visible={likers.open}
        postId={display.id}
        kind={likers.kind}
        onClose={() => setLikers((s) => ({ ...s, open: false }))}
      />

      <ShareToChatSheet visible={shareOpen} post={display} onClose={() => setShareOpen(false)} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.surface, borderRadius: 18,
    borderWidth: 1, borderColor: theme.border,
    padding: 16, gap: 11,
  },
  repostBanner: {
    flexDirection: "row", alignItems: "center", gap: 6, marginBottom: -2,
  },
  repostBannerText: { color: theme.textMuted, fontSize: 12, fontWeight: "600", flex: 1 },
  sponsoredBanner: { flexDirection: "row", alignItems: "center", gap: 5, marginBottom: -2 },
  sponsoredText: { color: theme.primary, fontSize: 11.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 11 },
  avatar: {
    width: 44, height: 44, borderRadius: 22, overflow: "hidden",
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontSize: 18, fontWeight: "700" },
  author: { color: theme.textPrimary, fontSize: 15.5, fontWeight: "800", flexShrink: 1 },
  dot: { color: theme.textMuted, fontSize: 12 },
  time: { color: theme.textMuted, fontSize: 12.5 },
  body: { color: theme.textPrimary, fontSize: 16, lineHeight: 23 },
  placeRow: {
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: theme.surfaceAlt, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 4, alignSelf: "flex-start",
  },
  placeText: { color: theme.textSecondary, fontSize: 11, fontWeight: "600", maxWidth: 200 },
  actionsRow: {
    flexDirection: "row", alignItems: "center", gap: 26,
    paddingTop: 12, marginTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border,
  },
  actionBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
  actionText: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "600" },
});
