import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Image, Modal, Pressable, ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api, Post } from "@/src/api/client";
import { theme } from "@/src/theme";
import MediaGrid from "./MediaGrid";
import RichText from "./RichText";
import LinkPreviewCard from "./LinkPreviewCard";
import EmbedCard from "./EmbedCard";
import InlineMedia from "./InlineMedia";
import { getEmbed, getInlineImage } from "@/src/utils/embeds";
import PollCard from "./PollCard";
import QuoteCard from "./QuoteCard";
import LikersModal from "./LikersModal";
import ShareToChatSheet from "./ShareToChatSheet";
import PostViewersModal from "./PostViewersModal";
import VerifiedBadge from "./VerifiedBadge";
import UserBadges from "./UserBadges";

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
  /** Fired when the card is opened — used for ad-click tracking. */
  onOpen?: (p: Post) => void;
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
  post, viewerId, disableOpen, onLike, onDislike, onRepost, onQuote, onReply, onComments, onBookmark, onMore, onPollUpdated, onOpen,
}: Props) {
  const router = useRouter();
  const [likers, setLikers] = useState<{ open: boolean; kind: "likers" | "reposters" }>({ open: false, kind: "likers" });
  const [shareOpen, setShareOpen] = useState(false);
  const [viewersOpen, setViewersOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);
  // Local copy so an emoji reaction updates instantly regardless of the parent.
  const [localPost, setLocalPost] = useState<Post | null>(null);
  // If this entry is a pure repost (no text, has repost_of), render the original
  // with a "X reposted" banner.
  const isRepost = !!post.repost_of && post.reposted_post;
  const baseDisplay = (isRepost ? post.reposted_post! : post);
  const display = (localPost && localPost.id === baseDisplay.id) ? localPost : baseDisplay;
  const isOwner = !!viewerId && display.user_id === viewerId;
  const hasVideo = (display.media || []).some((m) => m.type === "video");
  const embed = getEmbed(display.text);
  const inlineImg = !embed && !(display.media || []).length ? getInlineImage(display.text) : null;

  const openDetail = () => {
    if (disableOpen) return;
    onOpen?.(display);
    router.push({ pathname: "/post/[id]", params: { id: display.id } });
  };

  // Instagram-style: tapping a video in the feed jumps to the Reels player.
  const openReel = () => {
    router.push({ pathname: "/reels", params: { focus: display.id } });
  };

  // Tapping the avatar or author name opens that user's profile. Tapping your
  // own goes to your profile tab (user search excludes self, so /user/[name]
  // would 404 for you).
  const openAuthorProfile = (e?: any) => {
    e?.stopPropagation?.();
    if (viewerId && display.author?.user_id === viewerId) { router.push("/(tabs)/profile"); return; }
    const name = display.author?.name;
    if (name) router.push({ pathname: "/user/[name]", params: { name } });
  };

  const onCommentPress = () => {
    if (onComments) onComments(display);
    else onReply(display);
  };

  const reportPost = () => setReportOpen(true);
  const submitReport = async (reason: string) => {
    setReporting(true);
    try { await api.reportPost(display.id, reason); setReported(true); }
    catch { setReported(true); }   // one report per user; treat as done
    finally { setReporting(false); }
  };

  // Everyone gets the overflow menu now (Send in DM / Bookmark / Report live here).
  const showMenu = true;
  const onMenuPress = () => setMenuOpen(true);

  // Emoji reactions (unified like/dislike). Optimistic via a local override.
  const QUICK_EMOJIS = ["👍", "❤️", "😂", "🔥", "😮", "😢", "🎉", "👏", "🙏", "👎"];
  const doReact = async (emoji: string) => {
    setReactOpen(false);
    try {
      const updated = await api.reactToPost(display.id, emoji);
      if (!isRepost) setLocalPost(updated);
    } catch {}
  };

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
      {/* The "Sponsored" label is shown only by AdSlot when a post is actually
          displayed as an ad — never on promoted posts in normal streams. */}
      {display.pinned && !isRepost && (
        <View style={styles.repostBanner}>
          <Ionicons name="pin" size={13} color={theme.textMuted} />
          <Text style={styles.repostBannerText} numberOfLines={1}>Pinned</Text>
        </View>
      )}
      <View style={styles.cardTop}>
        <TouchableOpacity
          style={styles.avatar}
          onPress={openAuthorProfile}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          testID={`post-author-avatar-${post.id}`}
        >
          {display.author.picture ? (
            <Image source={{ uri: display.author.picture }} style={styles.avatarImg} />
          ) : (
            <Text style={styles.avatarInit}>
              {(display.author.name?.[0] || "?").toUpperCase()}
            </Text>
          )}
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <TouchableOpacity
              onPress={openAuthorProfile}
              hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
              style={{ flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 6 }}
              testID={`post-author-name-${post.id}`}
            >
              <Text style={styles.author} numberOfLines={1}>{display.author.name}</Text>
              {display.author.verified && <VerifiedBadge size={14} style={{ marginLeft: -2 }} />}
              <UserBadges badges={display.author.badges} size={14} />
            </TouchableOpacity>
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

      {!!display.community_name && (
        <Text style={styles.communityTag}>/{display.community_name}</Text>
      )}
      {!!display.title && (
        <Text style={styles.threadTitle}>{display.title}</Text>
      )}
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

      {embed ? (
        <EmbedCard url={embed.url} aspect={embed.aspect} />
      ) : inlineImg ? (
        <InlineMedia uri={inlineImg} />
      ) : display.link_preview && !display.quoted_post ? (
        <LinkPreviewCard preview={display.link_preview} />
      ) : null}

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
          disabled={display.can_comment === false}
          onPress={(e) => { e.stopPropagation?.(); if (display.can_comment === false) return; onCommentPress(); }}
          testID={`reply-${post.id}`}
        >
          <Ionicons
            name={display.can_comment === false ? "lock-closed-outline" : "chatbubble-outline"}
            size={17}
            color={display.can_comment === false ? theme.textMuted : theme.textSecondary}
          />
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

        {!display.likes_disabled && (
          <>
            {/* Unified reaction button — opens the emoji picker (or removes your
                current reaction with a long-press). */}
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={(e) => { e.stopPropagation?.(); setReactOpen(true); }}
              onLongPress={() => { if (display.my_reaction) doReact(display.my_reaction); else setLikers({ open: true, kind: "likers" }); }}
              delayLongPress={350}
              testID={`react-${post.id}`}
            >
              {display.my_reaction ? (
                <Text style={{ fontSize: 17 }}>{display.my_reaction}</Text>
              ) : (
                <Ionicons name="happy-outline" size={18} color={theme.textSecondary} />
              )}
              {(display.reactions_total ?? display.likes_count) > 0 && (
                <Text style={[styles.actionText, display.my_reaction && { color: theme.primary }]}>
                  {display.reactions_total ?? display.likes_count}
                </Text>
              )}
            </TouchableOpacity>

            {/* Top reaction tallies — tap to react with that emoji. */}
            {(display.reactions || []).slice(0, 3).map((r) => (
              <TouchableOpacity
                key={r.emoji}
                style={[styles.reactChip, display.my_reaction === r.emoji && styles.reactChipMine]}
                onPress={(e) => { e.stopPropagation?.(); doReact(r.emoji); }}
                testID={`react-chip-${post.id}-${r.emoji}`}
              >
                <Text style={{ fontSize: 13 }}>{r.emoji}</Text>
                <Text style={styles.reactChipCount}>{r.count}</Text>
              </TouchableOpacity>
            ))}
          </>
        )}

        {!!display.views_count && display.views_count > 0 && (
          isOwner ? (
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={(e) => { e.stopPropagation?.(); setViewersOpen(true); }}
              testID={`views-${post.id}`}
            >
              <Ionicons name="eye-outline" size={17} color={theme.textMuted} />
              <Text style={styles.actionText}>{display.views_count}</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.actionBtn}>
              <Ionicons name="eye-outline" size={17} color={theme.textMuted} />
              <Text style={styles.actionText}>{display.views_count}</Text>
            </View>
          )
        )}
      </View>

      <LikersModal
        visible={likers.open}
        postId={display.id}
        kind={likers.kind}
        onClose={() => setLikers((s) => ({ ...s, open: false }))}
      />

      <ShareToChatSheet visible={shareOpen} post={display} onClose={() => setShareOpen(false)} />

      <PostViewersModal visible={viewersOpen} postId={display.id} onClose={() => setViewersOpen(false)} />

      {/* Emoji reaction picker */}
      <Modal visible={reactOpen} transparent animationType="fade" onRequestClose={() => setReactOpen(false)}>
        <Pressable style={styles.reportBackdrop} onPress={() => setReactOpen(false)}>
          <Pressable style={styles.reactSheet} onPress={(e) => e.stopPropagation?.()}>
            <Text style={styles.reportTitle}>React</Text>
            <View style={styles.reactGrid}>
              {QUICK_EMOJIS.map((em) => (
                <TouchableOpacity
                  key={em}
                  style={[styles.reactPick, display.my_reaction === em && styles.reactPickMine]}
                  onPress={() => doReact(em)}
                  testID={`react-pick-${em}`}
                >
                  <Text style={{ fontSize: 28 }}>{em}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {!!display.my_reaction && (
              <TouchableOpacity style={styles.reportCancel} onPress={() => doReact(display.my_reaction!)} testID="react-remove">
                <Text style={[styles.reportCancelText, { color: theme.error }]}>Remove my reaction</Text>
              </TouchableOpacity>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Overflow menu — Send in DM / Bookmark / Report (+ owner options) */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.reportBackdrop} onPress={() => setMenuOpen(false)}>
          <Pressable style={styles.reportSheet} onPress={(e) => e.stopPropagation?.()}>
            <TouchableOpacity style={styles.menuRow} onPress={() => { setMenuOpen(false); setShareOpen(true); }} testID={`menu-send-${post.id}`}>
              <Ionicons name="paper-plane-outline" size={20} color={theme.textPrimary} />
              <Text style={styles.menuText}>Send in DM</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuRow} onPress={() => { setMenuOpen(false); onBookmark(display); }} testID={`menu-bookmark-${post.id}`}>
              <Ionicons name={display.bookmarked_by_me ? "bookmark" : "bookmark-outline"} size={20} color={display.bookmarked_by_me ? theme.primary : theme.textPrimary} />
              <Text style={styles.menuText}>{display.bookmarked_by_me ? "Remove bookmark" : "Bookmark"}</Text>
            </TouchableOpacity>
            {isOwner && onMore ? (
              <TouchableOpacity style={styles.menuRow} onPress={() => { setMenuOpen(false); onMore(post); }} testID={`menu-owner-${post.id}`}>
                <Ionicons name="create-outline" size={20} color={theme.textPrimary} />
                <Text style={styles.menuText}>Edit or delete…</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.menuRow} onPress={() => { setMenuOpen(false); reportPost(); }} testID={`menu-report-${post.id}`}>
                <Ionicons name="flag-outline" size={20} color={theme.error} />
                <Text style={[styles.menuText, { color: theme.error }]}>Report post</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.reportCancel} onPress={() => setMenuOpen(false)} testID="menu-cancel">
              <Text style={styles.reportCancelText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={reportOpen} transparent animationType="fade" onRequestClose={() => { setReportOpen(false); setReported(false); }}>
        <View style={styles.reportBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => { if (!reporting) { setReportOpen(false); setReported(false); } }} />
          <View style={styles.reportSheet}>
            {reported ? (
              <View style={{ alignItems: "center", paddingVertical: 8 }}>
                <Ionicons name="checkmark-circle" size={40} color={theme.primary} />
                <Text style={styles.reportThanks}>Thanks — we'll review it.</Text>
                <TouchableOpacity style={styles.reportDone} onPress={() => { setReportOpen(false); setReported(false); }} testID="report-done">
                  <Text style={styles.reportDoneText}>Done</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <Text style={styles.reportTitle}>Report post</Text>
                <Text style={styles.reportSub}>Why are you reporting this?</Text>
                {[
                  { label: "Spam or scam", reason: "spam" },
                  { label: "Inappropriate content", reason: "inappropriate" },
                  { label: "Harassment or bullying", reason: "harassment" },
                  { label: "False information", reason: "misinformation" },
                  { label: "Something else", reason: "other" },
                ].map((o) => (
                  <TouchableOpacity key={o.reason} style={styles.reportOpt} onPress={() => submitReport(o.reason)} disabled={reporting} testID={`report-${o.reason}`}>
                    <Text style={styles.reportOptText}>{o.label}</Text>
                    {reporting ? <ActivityIndicator size="small" color={theme.textMuted} /> : <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />}
                  </TouchableOpacity>
                ))}
                <TouchableOpacity style={styles.reportCancel} onPress={() => setReportOpen(false)} disabled={reporting} testID="report-cancel">
                  <Text style={styles.reportCancelText}>Cancel</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  reportBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  reportSheet: { backgroundColor: theme.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, paddingBottom: 28, gap: 4 },
  reactChip: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: theme.surfaceAlt, borderRadius: 999,
    paddingHorizontal: 8, paddingVertical: 3, marginRight: 4,
    borderWidth: 1, borderColor: "transparent",
  },
  reactChipMine: { borderColor: theme.primary, backgroundColor: "rgba(0,168,132,0.12)" },
  reactChipCount: { color: theme.textSecondary, fontSize: 12, fontWeight: "700" },
  reactSheet: {
    backgroundColor: theme.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 18, paddingBottom: 28, gap: 10,
  },
  reactGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "space-between" },
  reactPick: {
    width: 52, height: 52, borderRadius: 14, alignItems: "center", justifyContent: "center",
    backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: "transparent",
  },
  reactPickMine: { borderColor: theme.primary, backgroundColor: "rgba(0,168,132,0.14)" },
  menuRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 15, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  menuText: { color: theme.textPrimary, fontSize: 15.5, fontWeight: "600" },
  reportTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  reportSub: { color: theme.textMuted, fontSize: 13, marginBottom: 8 },
  reportOpt: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  reportOptText: { color: theme.textPrimary, fontSize: 15, fontWeight: "600" },
  reportCancel: { marginTop: 12, alignItems: "center", paddingVertical: 12 },
  reportCancelText: { color: theme.textSecondary, fontSize: 15, fontWeight: "700" },
  reportThanks: { color: theme.textPrimary, fontSize: 16, fontWeight: "700", marginTop: 10 },
  reportDone: { marginTop: 16, backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 40 },
  reportDoneText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  card: {
    backgroundColor: theme.surface, borderRadius: 18,
    borderWidth: 1, borderColor: theme.border,
    padding: 16, gap: 11,
  },
  repostBanner: {
    flexDirection: "row", alignItems: "center", gap: 6, marginBottom: -2,
  },
  repostBannerText: { color: theme.textMuted, fontSize: 12, fontWeight: "600", flex: 1 },
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
  communityTag: { color: theme.primary, fontSize: 12, fontWeight: "800", marginBottom: 2 },
  threadTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800", lineHeight: 22, marginBottom: 4 },
  placeRow: {
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: theme.surfaceAlt, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 4, alignSelf: "flex-start",
  },
  placeText: { color: theme.textSecondary, fontSize: 11, fontWeight: "600", maxWidth: 200 },
  actionsRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingTop: 12, marginTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border,
  },
  actionBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
  actionText: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "600" },
});
