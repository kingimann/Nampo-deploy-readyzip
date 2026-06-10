import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl, Modal, Alert, Platform, Animated, Easing, useWindowDimensions,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter, useLocalSearchParams } from "expo-router";
import { api, Post } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import PostCard from "@/src/components/PostCard";
import AdSlot from "@/src/components/AdSlot";
import FadeIn from "@/src/components/FadeIn";
import PostSkeleton from "@/src/components/PostSkeleton";
import { interleaveAds, isAd } from "@/src/lib/ads";
import PostComposer from "@/src/components/PostComposer";
import RestrictionBanner from "@/src/components/RestrictionBanner";
import StoryTray from "@/src/components/StoryTray";
import CommentsSheet from "@/src/components/CommentsSheet";
import PostPrivacySheet from "@/src/components/PostPrivacySheet";
import ConfirmModal from "@/src/components/ConfirmModal";
import { storage } from "@/src/utils/storage";
import { useLoopProbe } from "@/src/lib/loopProbe";

export const HIDE_STORIES_KEY = "hide_stories";

// Frosted-glass surface — matches the bottom LiquidTabBar so the floating top
// bar reads as the same material (real blur on web, denser fill on native).
const GLASS: any =
  Platform.OS === "web"
    ? {
        backgroundColor: "rgba(31,44,51,0.72)",
        borderWidth: 1,
        borderColor: theme.borderStrong,
        backdropFilter: "blur(22px)",
        WebkitBackdropFilter: "blur(22px)",
      }
    : {
        backgroundColor: theme.surfaceGlass,
        borderWidth: 1,
        borderColor: theme.borderStrong,
      };

type Tab = "home" | "explore";

// Stable FlatList view-tracking config. It MUST be a constant reference — a new
// object each render makes VirtualizedList throw "Changing viewabilityConfig on
// the fly is not supported", and the router's error boundary then reloads the
// route → re-render → new object → throw → reload, in a loop. (Profile has no
// view-tracking, which is why it never reloaded.)
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 60, minimumViewTime: 600 };

export default function FeedScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ compose?: string }>();
  const insets = useSafeAreaInsets();
  // On desktop web the left/right rails provide nav, search, compose &
  // notifications, so the in-column header drops those (X-style minimal header).
  const { width: _winW } = useWindowDimensions();
  const desktopWeb = Platform.OS === "web" && _winW >= 900;
  const [tab, setTab] = useState<Tab>("explore");
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [unreadNotif, setUnreadNotif] = useState(0);
  useFocusEffect(useCallback(() => {
    api.unreadNotificationsCount().then((r) => setUnreadNotif(r.count)).catch(() => {});
  }, []));

  const postingOff = !!user?.posting_disabled;

  // Composer state
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<Post | null>(null);
  const [editing, setEditing] = useState<Post | null>(null);
  const [quoting, setQuoting] = useState<Post | null>(null);
  const [actionPost, setActionPost] = useState<Post | null>(null);

  // Open the composer when arriving with ?compose=1 (e.g. long-pressing the
  // bottom-nav Search button), then clear the param so it doesn't re-open.
  useEffect(() => {
    if (params.compose === "1" && !postingOff) {
      setEditing(null); setReplyTo(null); setQuoting(null); setComposeOpen(true);
      router.setParams({ compose: undefined } as any);
    }
  }, [params.compose, postingOff, router]);
  const [confirmDel, setConfirmDel] = useState<Post | null>(null);
  const [privacyPost, setPrivacyPost] = useState<Post | null>(null);
  const [commentsPost, setCommentsPost] = useState<Post | null>(null);
  const [showStories, setShowStories] = useState(true);
  const viewedRef = useRef<Set<string>>(new Set());
  const _probePrev = useRef<Record<string, unknown>>({});

  // Honor the "hide stories" preference (re-checked on focus so a change in
  // Settings takes effect when returning to the feed).
  useFocusEffect(useCallback(() => {
    let alive = true;
    storage.getItem(HIDE_STORIES_KEY, false).then((h) => { if (alive) setShowStories(!h); });
    return () => { alive = false; };
  }, []));

  const hideStories = useCallback(async () => {
    setShowStories(false);
    await storage.setItem(HIDE_STORIES_KEY, true);
  }, []);

  const onViewable = useRef(({ viewableItems }: any) => {
    for (const v of viewableItems || []) {
      const p = v?.item as Post | undefined;
      if (!p?.id) continue;
      const targetId = p.repost_of || p.id;
      if (viewedRef.current.has(targetId)) continue;
      viewedRef.current.add(targetId);
      api.recordPostView(targetId).catch(() => {});
    }
  }).current;

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = tab === "home" ? await api.homeFeed() : await api.exploreFeed();
      setPosts(data);
    } catch {} finally {
      setLoading(false); setRefreshing(false);
    }
  }, [tab]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // ── Live: poll for new posts and surface an animated "new posts" pill ──
  const listRef = useRef<FlatList>(null);
  const [newCount, setNewCount] = useState(0);
  const postsRef = useRef<Post[]>([]);
  useEffect(() => { postsRef.current = posts; }, [posts]);
  const pillAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(pillAnim, { toValue: newCount > 0 ? 1 : 0, useNativeDriver: true, friction: 7, tension: 80 }).start();
  }, [newCount, pillAnim]);
  useFocusEffect(useCallback(() => {
    if (tab !== "home") { setNewCount(0); return; }
    const poll = setInterval(async () => {
      try {
        const data = await api.homeFeed();
        const have = new Set(postsRef.current.map((p) => p.id));
        // Count every post we don't already have — not just the unbroken prefix
        // of new ids, which miscounts when the feed reorders or inserts a
        // pinned/promoted post above existing ones.
        const n = data.reduce((acc, p) => acc + (have.has(p.id) ? 0 : 1), 0);
        setNewCount(n);
      } catch {}
    }, 25000);
    return () => clearInterval(poll);
  }, [tab]));
  const showNewPosts = () => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    setNewCount(0);
    setRefreshing(true); load();
  };

  // ── Floating top bar that hides on scroll-down and returns on scroll-up,
  //    mirroring the bottom LiquidTabBar. ──
  const [topHidden, setTopHidden] = useState(false);
  const [topBarH, setTopBarH] = useState(112);  // measured; default avoids initial overlap
  const topHide = useRef(new Animated.Value(0)).current;  // 0 = shown, 1 = hidden
  const lastScrollY = useRef(0);
  const onScroll = useCallback((e: any) => {
    const y = e?.nativeEvent?.contentOffset?.y ?? 0;
    const dy = y - lastScrollY.current;
    if (y <= 4) setTopHidden(false);          // at the top → always show
    else if (dy > 6) setTopHidden(true);      // scrolling down → hide
    else if (dy < -6) setTopHidden(false);    // scrolling up → show
    lastScrollY.current = y;
  }, []);
  useEffect(() => {
    Animated.timing(topHide, {
      toValue: topHidden ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [topHidden, topHide]);
  // Never leave it stuck hidden when the feed regains focus.
  useFocusEffect(useCallback(() => { setTopHidden(false); lastScrollY.current = 0; }, []));

  // Apply an authoritative engagement snapshot from the server to a post (and
  // to it wherever it appears as a reposted_post) — keeps counts exact.
  const applyEngagement = (updated: Post) => {
    const e = {
      liked_by_me: updated.liked_by_me, likes_count: updated.likes_count,
      disliked_by_me: updated.disliked_by_me, dislikes_count: updated.dislikes_count,
    };
    setPosts((arr) => arr.map((p) => {
      if (p.id === updated.id) return { ...p, ...e };
      if (p.reposted_post && p.reposted_post.id === updated.id)
        return { ...p, reposted_post: { ...p.reposted_post, ...e } };
      return p;
    }));
  };

  const onLike = async (post: Post) => {
    setPosts((arr) => arr.map((p) => {
      const upd = (q: Post): Post => ({
        ...q,
        liked_by_me: !q.liked_by_me,
        likes_count: q.likes_count + (q.liked_by_me ? -1 : 1),
        disliked_by_me: q.liked_by_me ? q.disliked_by_me : false,
        dislikes_count: (q.dislikes_count || 0) - (!q.liked_by_me && q.disliked_by_me ? 1 : 0),
      });
      if (p.id === post.id) return upd(p);
      if (p.reposted_post && p.reposted_post.id === post.id)
        return { ...p, reposted_post: upd(p.reposted_post) };
      return p;
    }));
    try { applyEngagement(await api.toggleLike(post.id)); } catch { load(); }
  };

  const onDislike = async (post: Post) => {
    setPosts((arr) => arr.map((p) => {
      const upd = (q: Post): Post => {
        const nowDis = !q.disliked_by_me;
        const clearedLike = nowDis && q.liked_by_me;
        return {
          ...q,
          disliked_by_me: nowDis,
          dislikes_count: (q.dislikes_count || 0) + (nowDis ? 1 : -1),
          liked_by_me: nowDis ? false : q.liked_by_me,
          likes_count: q.likes_count - (clearedLike ? 1 : 0),
        };
      };
      if (p.id === post.id) return upd(p);
      if (p.reposted_post && p.reposted_post.id === post.id)
        return { ...p, reposted_post: upd(p.reposted_post) };
      return p;
    }));
    try { applyEngagement(await api.toggleDislike(post.id)); } catch { load(); }
  };

  const onRepost = async (post: Post) => {
    const target = post.repost_of || post.id;
    setPosts((arr) => arr.map((p) => {
      const upd = (q: Post): Post => ({
        ...q,
        reposted_by_me: !q.reposted_by_me,
        reposts_count: (q.reposts_count || 0) + (q.reposted_by_me ? -1 : 1),
      });
      let next = p;
      if (p.id === target) next = upd(next);
      if (next.reposted_post && next.reposted_post.id === target)
        next = { ...next, reposted_post: upd(next.reposted_post) };
      return next;
    }));
    try { await api.toggleRepost(target); } catch { load(); }
  };

  const onBookmark = async (post: Post) => {
    setPosts((arr) => arr.map((p) => {
      const upd = (q: Post): Post => ({
        ...q,
        bookmarked_by_me: !q.bookmarked_by_me,
        bookmarks_count: (q.bookmarks_count || 0) + (q.bookmarked_by_me ? -1 : 1),
      });
      if (p.id === post.id) return upd(p);
      if (p.reposted_post && p.reposted_post.id === post.id)
        return { ...p, reposted_post: upd(p.reposted_post) };
      return p;
    }));
    try { await api.toggleBookmark(post.id); } catch { load(); }
  };

  const onReply = (post: Post) => {
    setEditing(null); setQuoting(null); setReplyTo(post); setComposeOpen(true);
  };

  const onQuote = (post: Post) => {
    setEditing(null); setReplyTo(null); setQuoting(post); setComposeOpen(true);
  };

  const onPollUpdated = (updated: Post) => {
    setPosts((arr) => arr.map((p) => {
      if (p.id === updated.id) return updated;
      if (p.reposted_post && p.reposted_post.id === updated.id)
        return { ...p, reposted_post: updated };
      return p;
    }));
  };

  const onMore = (post: Post) => {
    if (post.user_id !== user?.user_id) return;
    setActionPost(post);
  };

  const onCommented = (postId: string) => {
    setPosts((arr) => arr.map((p) => {
      const bump = (q: Post): Post => ({ ...q, replies_count: (q.replies_count || 0) + 1 });
      if (p.id === postId) return bump(p);
      if (p.reposted_post && p.reposted_post.id === postId)
        return { ...p, reposted_post: bump(p.reposted_post) };
      return p;
    }));
  };

  const doDelete = async (p: Post) => {
    setPosts((arr) => arr.filter((x) => x.id !== p.id));
    try { await api.deletePost(p.id); } catch { load(); }
  };

  const onPosted = (newPost: Post) => {
    // Edit case: replace in place
    if (editing) {
      setPosts((arr) => arr.map((p) => p.id === newPost.id ? newPost : p));
    } else if (!replyTo) {
      // New top-level post: prepend
      setPosts((arr) => [newPost, ...arr]);
    } else {
      // Reply: bump reply count on the parent
      setPosts((arr) => arr.map((p) => {
        const bump = (q: Post): Post => ({ ...q, replies_count: (q.replies_count || 0) + 1 });
        if (p.id === replyTo.id) return bump(p);
        if (p.reposted_post && p.reposted_post.id === replyTo.id)
          return { ...p, reposted_post: bump(p.reposted_post) };
        return p;
      }));
    }
    setReplyTo(null); setEditing(null);
  };

  // DIAGNOSTIC: name which state/input drives the FeedScreen re-render loop.
  const _snap: Record<string, unknown> = {
    winW: _winW, tab, loading, refreshing, topHidden, topBarH, newCount,
    composeOpen, showStories, unreadNotif, userId: user?.user_id ?? null, postsLen: posts.length,
  };
  const _chg = Object.keys(_snap).filter((k) => _probePrev.current[k] !== _snap[k]);
  _probePrev.current = _snap;
  useLoopProbe("FeedScreen", _chg.join(",") || "none");

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="feed-screen">
      {newCount > 0 && (
        <Animated.View
          style={[styles.newPillWrap, { opacity: pillAnim, transform: [{ translateY: pillAnim.interpolate({ inputRange: [0, 1], outputRange: [-16, 0] }) }] }]}
          pointerEvents="box-none"
        >
          <TouchableOpacity style={styles.newPill} onPress={showNewPosts} activeOpacity={0.9} testID="feed-new-posts">
            <Ionicons name="arrow-up" size={14} color="#fff" />
            <Text style={styles.newPillText}>{newCount} new post{newCount === 1 ? "" : "s"}</Text>
          </TouchableOpacity>
        </Animated.View>
      )}

      {loading ? (
        <View style={{ paddingTop: topBarH + 6 }}>
          {[0, 1, 2, 3, 4].map((i) => <PostSkeleton key={i} />)}
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={interleaveAds(posts)}
          keyExtractor={(i) => (isAd(i) ? `ad-${i.__ad}` : i.id)}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={VIEWABILITY_CONFIG}
          onScroll={onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingHorizontal: 12, paddingTop: topBarH + 6, paddingBottom: insets.bottom + 100, gap: 9 }}
          ItemSeparatorComponent={null}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={theme.primary}
            />
          }
          ListHeaderComponent={
            <View>
              {showStories && <StoryTray onHide={hideStories} />}
              <RestrictionBanner kind="posting" style={{ marginHorizontal: 0 }} />
            </View>
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Ionicons name="newspaper-outline" size={32} color={theme.textMuted} />
              </View>
              <Text style={styles.emptyTitle}>No posts yet</Text>
              <Text style={styles.emptySub}>
                {tab === "home"
                  ? "Follow people to see their posts here."
                  : "Be the first to share something."}
              </Text>
            </View>
          }
          renderItem={({ item, index }) => (
            isAd(item) ? <AdSlot placement="feed" index={item.__ad} /> : (
            <FadeIn animateKey={item.id} delay={Math.min(index, 6) * 45}>
            <PostCard
              post={item}
              viewerId={user?.user_id}
              onLike={onLike}
              onDislike={onDislike}
              onRepost={onRepost}
              onQuote={onQuote}
              onReply={onReply}
              onComments={(p) => setCommentsPost(p)}
              onBookmark={onBookmark}
              onMore={onMore}
              onPollUpdated={onPollUpdated}
            />
            </FadeIn>)
          )}
        />
      )}

      {/* Floating frosted top bar — hides on scroll-down, returns on scroll-up,
          mirroring the bottom LiquidTabBar (and sharing its glass material). */}
      <Animated.View
        onLayout={(e) => {
          // Only react to real height changes. On web, ResizeObserver (plus the
          // frosted-glass backdrop) re-fires onLayout with sub-pixel deltas; an
          // unguarded setState here re-renders → re-measures → setState → … an
          // infinite render loop that pins the feed (and looks like the page
          // constantly reloading). Ignoring <1px changes lets it settle.
          const h = e.nativeEvent.layout.height;
          setTopBarH((prev) => (Math.abs(prev - h) > 1 ? h : prev));
        }}
        pointerEvents={topHidden ? "none" : "box-none"}
        style={[
          styles.topBar,
          GLASS,
          desktopWeb && styles.topBarDesktop,
          {
            opacity: topHide.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 0.25, 0] }),
            transform: [{ translateY: topHide.interpolate({ inputRange: [0, 1], outputRange: [0, -(topBarH + insets.top + 14)] }) }],
          },
        ]}
      >
        <View style={styles.header}>
          {!desktopWeb && <SidebarMenuButton />}
          <View style={styles.brandRow}>
            <Text style={styles.title}>{desktopWeb ? "Home" : "Feed"}</Text>
          </View>
          <View style={styles.headerActions}>
            {!desktopWeb && (
              <TouchableOpacity onPress={() => router.push("/search")} style={styles.bellBtn} testID="feed-search" accessibilityRole="button" accessibilityLabel="Search">
                <Ionicons name="search" size={22} color={theme.textPrimary} />
              </TouchableOpacity>
            )}
            {!postingOff && !desktopWeb && (
              <TouchableOpacity
                onPress={() => { setEditing(null); setReplyTo(null); setQuoting(null); setComposeOpen(true); }}
                style={styles.bellBtn}
                testID="feed-compose"
                accessibilityRole="button"
                accessibilityLabel="Create a post"
              >
                <Ionicons name="add-circle" size={26} color={theme.primary} />
              </TouchableOpacity>
            )}
            {!desktopWeb && (
              <TouchableOpacity onPress={() => router.push("/notifications")} style={styles.bellBtn} testID="feed-notifications">
                <Ionicons name="notifications-outline" size={22} color={theme.textPrimary} />
                {unreadNotif > 0 && (
                  <View style={styles.bellBadge}>
                    <Text style={styles.bellBadgeText}>{unreadNotif > 9 ? "9+" : unreadNotif}</Text>
                  </View>
                )}
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => router.push("/messages")} style={styles.bellBtn} testID="feed-messages" accessibilityRole="button" accessibilityLabel="Messages">
              <Ionicons name="chatbubble-ellipses-outline" size={22} color={theme.textPrimary} />
            </TouchableOpacity>
          </View>
        </View>
        <View style={styles.segmentWrap}>
          <View style={styles.segment}>
            {(["explore", "home"] as Tab[]).map((k) => {
              const a = k === tab;
              return (
                <TouchableOpacity
                  key={k}
                  onPress={() => setTab(k)}
                  style={[styles.segmentItem, a && styles.segmentItemActive]}
                  activeOpacity={0.85}
                  testID={`feed-tab-${k}`}
                >
                  <Text style={[styles.segmentText, { color: a ? theme.textPrimary : theme.textMuted }]}>
                    {k === "explore" ? "Explore" : "Following"}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </Animated.View>

      <CommentsSheet
        visible={!!commentsPost}
        post={commentsPost}
        onClose={() => setCommentsPost(null)}
        onCommented={(postId) => onCommented(postId)}
      />

      <PostComposer
        visible={composeOpen}
        onClose={() => { setComposeOpen(false); setReplyTo(null); setEditing(null); setQuoting(null); }}
        onPosted={onPosted}
        replyTo={replyTo}
        editing={editing}
        quoting={quoting}
      />

      {/* Owner long-press menu */}
      <Modal
        visible={!!actionPost}
        transparent
        animationType="fade"
        onRequestClose={() => setActionPost(null)}
      >
        <TouchableOpacity
          style={styles.actionBackdrop}
          activeOpacity={1}
          onPress={() => setActionPost(null)}
        >
          <View style={[styles.actionSheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.actionLabel}>Your post</Text>
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => {
                const p = actionPost!; setActionPost(null);
                setEditing(p); setReplyTo(null); setComposeOpen(true);
              }}
              testID="post-action-edit"
            >
              <Ionicons name="create-outline" size={18} color={theme.primary} />
              <Text style={styles.actionBtnText}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, { marginTop: 6 }]}
              onPress={async () => {
                const p = actionPost!; setActionPost(null);
                try {
                  const u = await api.pinPost(p.id);
                  setPosts((arr) => arr.map((x) => (x.id === u.id ? { ...x, pinned: u.pinned } : x)));
                } catch {}
              }}
              testID="post-action-pin"
            >
              <Ionicons name={actionPost?.pinned ? "pin" : "pin-outline"} size={18} color={theme.primary} />
              <Text style={styles.actionBtnText}>{actionPost?.pinned ? "Unpin from profile" : "Pin to profile"}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, { marginTop: 6 }]}
              onPress={() => { const p = actionPost!; setActionPost(null); setPrivacyPost(p); }}
              testID="post-action-privacy"
            >
              <Ionicons name="lock-closed-outline" size={18} color={theme.primary} />
              <Text style={styles.actionBtnText}>Post privacy</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, { marginTop: 6 }]}
              onPress={() => { setActionPost(null); router.push("/advertise"); }}
              testID="post-action-promote"
            >
              <Ionicons name="megaphone-outline" size={18} color={theme.primary} />
              <Text style={styles.actionBtnText}>Promote</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, { marginTop: 6 }]}
              onPress={() => { const p = actionPost!; setActionPost(null); setConfirmDel(p); }}
              testID="post-action-delete"
            >
              <Ionicons name="trash-outline" size={18} color={theme.error} />
              <Text style={[styles.actionBtnText, { color: theme.error }]}>Delete</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, { marginTop: 6 }]}
              onPress={() => setActionPost(null)}
            >
              <Text style={styles.actionBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <PostPrivacySheet
        post={privacyPost}
        visible={!!privacyPost}
        onClose={() => setPrivacyPost(null)}
        onUpdated={(u) => setPosts((arr) => arr.map((x) => (x.id === u.id ? { ...x, ...u } : x)))}
      />

      <ConfirmModal
        visible={!!confirmDel}
        title="Delete post?"
        message="This can't be undone."
        confirmLabel="Delete"
        destructive
        onCancel={() => setConfirmDel(null)}
        onConfirm={() => { const p = confirmDel; setConfirmDel(null); if (p) doDelete(p); }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  topBar: {
    position: "absolute", top: 6, left: 8, right: 8,
    borderRadius: 24,
    paddingTop: 2,
    zIndex: 40,
    shadowColor: "#000", shadowOpacity: 0.32, shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  // Desktop: a flat, full-width sticky header (no floating rounded pill).
  topBarDesktop: {
    top: 0, left: 0, right: 0, borderRadius: 0,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
    shadowOpacity: 0, elevation: 0,
  },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 14, paddingTop: 8, paddingBottom: 10,
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 2 },
  title: { color: theme.textPrimary, fontSize: 22, fontWeight: "800", letterSpacing: -0.4 },
  bellBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  bellBadge: { position: "absolute", top: 4, right: 4, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: theme.error, alignItems: "center", justifyContent: "center", paddingHorizontal: 4, borderWidth: 1.5, borderColor: theme.bg },
  bellBadgeText: { color: "#fff", fontSize: 9.5, fontWeight: "800" },

  segmentWrap: { paddingHorizontal: 14, paddingBottom: 10 },
  newPillWrap: { position: "absolute", top: 104, left: 0, right: 0, alignItems: "center", zIndex: 50 },
  newPill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.primary, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 4 },
  newPillText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  segment: {
    flexDirection: "row",
    alignSelf: "flex-start",   // shrink to content instead of full width
    backgroundColor: theme.surface,
    borderRadius: 999,
    padding: 3,
    borderWidth: 1, borderColor: theme.border,
  },
  segmentItem: {
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderRadius: 999,
    alignItems: "center", justifyContent: "center",
  },
  segmentItemActive: {
    backgroundColor: theme.surfaceAlt,
  },
  segmentText: { fontSize: 11.5, fontWeight: "700", letterSpacing: 0.1 },

  composeStub: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface, borderRadius: 999,
    borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 14, paddingVertical: 12,
    marginBottom: 4,
  },
  stubAvatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
  },
  stubAvatarInit: { color: "#fff", fontWeight: "800", fontSize: 14 },
  stubText: { flex: 1, color: theme.textMuted, fontSize: 14 },
  stubIconRow: { flexDirection: "row", gap: 6 },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { paddingTop: 60, alignItems: "center", gap: 10 },
  emptyIcon: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  emptyTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "700" },
  emptySub: { color: theme.textSecondary, fontSize: 13, textAlign: "center", maxWidth: 280 },

  fab: {
    position: "absolute", right: 18,
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  fabDisabled: { backgroundColor: theme.surfaceAlt, opacity: 0.6 },

  actionBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end",
  },
  actionSheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingTop: 16, paddingHorizontal: 20,
    borderTopWidth: 1, borderColor: theme.border,
  },
  actionLabel: {
    color: theme.textMuted, fontSize: 11, fontWeight: "800",
    textTransform: "uppercase", letterSpacing: 0.6,
    textAlign: "center", marginBottom: 14,
  },
  actionBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
    backgroundColor: theme.surfaceAlt, borderRadius: 14,
    borderWidth: 1, borderColor: theme.border,
    paddingVertical: 14, paddingHorizontal: 16,
  },
  actionBtnText: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
});
