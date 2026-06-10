import React, { useEffect, useState } from "react";
import {
  View, Text, StyleSheet, Pressable, ScrollView, Platform, Image, TextInput,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePathname, useRouter } from "expo-router";
import { theme } from "@/src/theme";
import { useAuth } from "@/src/context/AuthContext";
import { useSidebar } from "@/src/context/SidebarContext";
import { api, LeaderboardEntry } from "@/src/api/client";
import { useIsDesktop } from "@/src/hooks/useIsDesktop";

// Below this width we keep the mobile layout untouched. At/above it (desktop
// web only) we render website chrome: a left nav rail, a centred content column,
// and a right rail the same width as the left — instead of full-bleed mobile UI.
const DESKTOP_BP = 900;
const RAIL_W = 244;
const CONTENT_MAX = 760;

type Item = {
  label: string;
  route: string;
  icon: keyof typeof Ionicons.glyphMap;     // filled name; outline = `${icon}-outline`
  activeOn?: string[];
};

const ITEMS: Item[] = [
  { label: "Home", route: "/feed", icon: "home", activeOn: ["/feed", "/post", "/user", "/hashtag"] },
  { label: "Map", route: "/", icon: "map", activeOn: ["/", "/directions", "/place", "/guide", "/g", "/eta"] },
  { label: "Reels", route: "/reels", icon: "play-circle" },
  { label: "Marketplace", route: "/marketplace", icon: "storefront", activeOn: ["/marketplace", "/listing", "/seller", "/business", "/my-marketplace", "/my-listings", "/shop"] },
  { label: "Groups", route: "/groups", icon: "people", activeOn: ["/groups", "/group"] },
  { label: "Communities", route: "/communities", icon: "planet", activeOn: ["/communities", "/c"] },
  { label: "Notifications", route: "/notifications", icon: "notifications" },
  { label: "Profile", route: "/profile", icon: "person", activeOn: ["/profile"] },
];

// Routes that use the FULL desktop width (no centred column / right rail), e.g.
// the map needs all the space it can get.
const FULL_BLEED = ["/", "/directions"];

// Right rail — trending hashtags + top members. Same width as the left nav rail.
function RightRail() {
  const router = useRouter();
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [leaders, setLeaders] = useState<LeaderboardEntry[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    let alive = true;
    api.trendingHashtags().then((r) => { if (alive) setTags((r.hashtags || []).slice(0, 6)); }).catch(() => {});
    api.pointsLeaderboard().then((r) => { if (alive) setLeaders((r.leaders || []).slice(0, 5)); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Submitting takes you to the full search screen (which shows live results),
  // carrying the typed query so it picks up where you left off.
  const submitSearch = () => {
    const s = q.trim();
    router.push(s ? { pathname: "/search", params: { q: s } } : "/search");
  };

  return (
    <ScrollView style={styles.right} contentContainerStyle={{ paddingVertical: 16, gap: 14 }} showsVerticalScrollIndicator={false}>
      <View style={styles.searchBox}>
        <Ionicons name="search" size={16} color={theme.textMuted} />
        <TextInput
          style={[styles.searchInput, Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null]}
          value={q}
          onChangeText={setQ}
          onSubmitEditing={submitSearch}
          placeholder="Search"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          returnKeyType="search"
          testID="rail-search"
        />
      </View>

      {tags.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Trending</Text>
          {tags.map((t) => (
            <Pressable key={t.tag} style={styles.cardRow} onPress={() => router.push({ pathname: "/hashtag/[tag]", params: { tag: t.tag } })} testID={`trend-${t.tag}`}>
              <Text style={styles.tagText} numberOfLines={1}>#{t.tag}</Text>
              <Text style={styles.cardMeta}>{t.count} post{t.count === 1 ? "" : "s"}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {leaders.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Top members</Text>
          {leaders.map((u) => (
            <Pressable key={u.user_id} style={styles.personRow} onPress={() => router.push(u.username ? { pathname: "/[username]", params: { username: u.username } } : { pathname: "/user/[name]", params: { name: u.name } })} testID={`top-${u.user_id}`}>
              <Image source={{ uri: u.picture || "https://api.dicebear.com/7.x/initials/png?seed=" + encodeURIComponent(u.name) }} style={styles.personAvatar} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.personName} numberOfLines={1}>{u.name}</Text>
                <Text style={styles.cardMeta} numberOfLines={1}>{u.points.toLocaleString()} pts</Text>
              </View>
              <Text style={styles.rank}>#{u.rank}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => router.push("/leaderboard")} testID="right-leaderboard-all">
            <Text style={styles.seeAll}>See leaderboard</Text>
          </Pressable>
        </View>
      )}

      <Text style={styles.footer}>OkaySpace · okayspace.ca</Text>
    </ScrollView>
  );
}

export default function DesktopShell({ children }: { children: React.ReactNode }) {
  // Stable breakpoint boolean, not raw width — width jitter on web drove a loop.
  const atDesktop = useIsDesktop(DESKTOP_BP);
  const { user } = useAuth();
  const pathname = usePathname() || "/";
  const router = useRouter();
  const sidebar = useSidebar();

  const desktop = atDesktop && !!user;
  if (!desktop) return <>{children}</>;

  const fullBleed = FULL_BLEED.includes(pathname);

  const isActive = (it: Item) => {
    const ons = it.activeOn || [it.route];
    return ons.some((p) =>
      p === "/" ? pathname === "/" : (pathname === p || pathname.startsWith(p + "/")),
    );
  };

  return (
    <View style={styles.row}>
      <View style={styles.rail}>
        <Pressable style={styles.brandRow} onPress={() => router.push("/feed")}>
          <View style={styles.brandDot}><Ionicons name="planet" size={18} color="#fff" /></View>
          <Text style={styles.brand}>OkaySpace</Text>
        </Pressable>
        <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
          {ITEMS.map((it) => {
            // Your own profile uses the vanity URL (okayspace.ca/<username>) so
            // the address bar shows your handle, not the generic /profile tab.
            const vanity = it.route === "/profile" && user?.username ? `/${user.username}` : null;
            const target = vanity || it.route;
            const active = isActive(it) || (!!vanity && pathname === vanity);
            return (
              <Pressable
                key={it.route}
                style={[styles.navItem, active && styles.navItemActive]}
                onPress={() => router.push(target as any)}
                testID={`desktop-nav-${it.label.toLowerCase()}`}
              >
                <Ionicons
                  name={(active ? it.icon : (`${it.icon}-outline` as keyof typeof Ionicons.glyphMap))}
                  size={24}
                  color={active ? theme.primary : theme.textPrimary}
                />
                <Text style={[styles.navText, active && { color: theme.primary, fontWeight: "800" }]}>{it.label}</Text>
              </Pressable>
            );
          })}
          <Pressable style={styles.navItem} onPress={() => router.push("/settings")} testID="desktop-nav-settings">
            <Ionicons name="settings-outline" size={24} color={theme.textPrimary} />
            <Text style={styles.navText}>Settings</Text>
          </Pressable>
          <Pressable style={styles.navItem} onPress={() => sidebar.setOpen(true)} testID="desktop-nav-more">
            <Ionicons name="menu" size={24} color={theme.textPrimary} />
            <Text style={styles.navText}>More</Text>
          </Pressable>
        </ScrollView>

        <Pressable style={styles.postBtn} onPress={() => router.push("/feed?compose=1" as any)} testID="desktop-post">
          <Ionicons name="create-outline" size={18} color="#fff" />
          <Text style={styles.postBtnText}>Post</Text>
        </Pressable>

        <Pressable style={styles.account} onPress={() => router.push((user?.username ? `/${user.username}` : "/profile") as any)} testID="desktop-account">
          <Image source={{ uri: user?.picture || "https://api.dicebear.com/7.x/initials/png?seed=" + encodeURIComponent(user?.name || "U") }} style={styles.accountAvatar} />
          <View style={{ flex: 1 }}>
            <Text style={styles.accountName} numberOfLines={1}>{user?.name || "You"}</Text>
            {!!user?.username && <Text style={styles.accountHandle} numberOfLines={1}>@{user.username}</Text>}
          </View>
        </Pressable>
      </View>

      {fullBleed ? (
        // Full-bleed pages (map) use all remaining width.
        <View style={{ flex: 1 }}>{children}</View>
      ) : (
        <>
          <View style={styles.contentWrap}>
            <View style={styles.content}>{children}</View>
          </View>
          <RightRail />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: "row", backgroundColor: theme.bg, justifyContent: "center" },
  rail: {
    width: RAIL_W, flexGrow: 0, flexShrink: 0, flexBasis: RAIL_W,
    paddingHorizontal: 12, paddingVertical: 16,
    borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: theme.border,
    backgroundColor: theme.bg,
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, marginBottom: 14 },
  brandDot: { width: 32, height: 32, borderRadius: 16, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  brand: { color: theme.textPrimary, fontSize: 19, fontWeight: "900" },
  navItem: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 12, paddingVertical: 11, borderRadius: 999, marginBottom: 2 },
  navItemActive: { backgroundColor: theme.surfaceAlt },
  navText: { color: theme.textPrimary, fontSize: 16, fontWeight: "600" },
  postBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: theme.primary, borderRadius: 999, paddingVertical: 13, marginTop: 10 },
  postBtnText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  account: { flexDirection: "row", alignItems: "center", gap: 10, padding: 8, borderRadius: 999, marginTop: 8 },
  accountAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: theme.surfaceAlt },
  accountName: { color: theme.textPrimary, fontSize: 14, fontWeight: "800" },
  accountHandle: { color: theme.textMuted, fontSize: 12.5 },
  // The page content sits in a fixed reading column. It must NOT flex-grow, or
  // it balloons to fill the middle and centres a narrow column inside itself —
  // leaving big empty gutters between the nav and the content. With a bounded
  // width the three columns form one group that `row`'s justifyContent:center
  // centres, so the content sits flush against both rails.
  contentWrap: { width: CONTENT_MAX, flexGrow: 0, flexShrink: 1, alignItems: "center" },
  content: {
    flex: 1, width: "100%", maxWidth: CONTENT_MAX,
    borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: theme.border,
    borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.border,
  },
  // Right rail — same width as the left nav rail. A ScrollView defaults to
  // flex-grow, which let it expand wider than the left View; pin it like the
  // rail so the two stay identical.
  right: {
    width: RAIL_W, flexGrow: 0, flexShrink: 0, flexBasis: RAIL_W,
    paddingHorizontal: 12,
    borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.border,
    backgroundColor: theme.bg,
  },
  // Search bar at the top of the right rail — full rail width, so it lines up
  // with the left nav (both rails are RAIL_W).
  searchBox: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    borderRadius: 999, paddingHorizontal: 14, height: 42,
  },
  searchInput: { flex: 1, color: theme.textPrimary, fontSize: 14, paddingVertical: 0 },
  card: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 14, gap: 2 },
  cardTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "800", marginBottom: 6 },
  cardRow: { paddingVertical: 7 },
  tagText: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  cardMeta: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
  personRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 7 },
  personAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: theme.surfaceAlt },
  personName: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  rank: { color: theme.textMuted, fontSize: 13, fontWeight: "800" },
  seeAll: { color: theme.primary, fontSize: 13, fontWeight: "700", paddingTop: 8 },
  footer: { color: theme.textMuted, fontSize: 12, paddingHorizontal: 4, paddingTop: 4 },
});
