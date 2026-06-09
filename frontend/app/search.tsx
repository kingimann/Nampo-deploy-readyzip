import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList, Image, ActivityIndicator, Platform, ScrollView,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, PublicUser, Community, Listing, Post, mediaUri } from "@/src/api/client";
import { theme } from "@/src/theme";

const webInput = Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {};

export default function SearchScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<PublicUser[]>([]);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(false);
  const [trending, setTrending] = useState<{ tag: string; count: number }[]>([]);
  const [popReels, setPopReels] = useState<Post[]>([]);
  const [popPosts, setPopPosts] = useState<Post[]>([]);
  const inputRef = useRef<TextInput>(null);
  const runSeq = useRef(0);

  useEffect(() => { const t = setTimeout(() => inputRef.current?.focus(), 250); return () => clearTimeout(t); }, []);
  useEffect(() => {
    api.trendingHashtags().then((r) => setTrending(r.hashtags)).catch(() => {});
    api.popularReels().then(setPopReels).catch(() => {});
    api.popularPosts().then(setPopPosts).catch(() => {});
  }, []);

  const run = useCallback(async (term: string) => {
    const s = term.trim();
    if (!s) { setPeople([]); setCommunities([]); setListings([]); return; }
    // Tag each run so a slower earlier request can't overwrite newer results.
    const seq = ++runSeq.current;
    setLoading(true);
    const [p, c, l] = await Promise.all([
      api.searchUsers(s).catch(() => []),
      api.listCommunities(s).catch(() => []),
      api.listListings({ q: s }).catch(() => []),
    ]);
    if (seq !== runSeq.current) return;  // a newer search superseded this one
    setPeople(p); setCommunities(c); setListings(l);
    setLoading(false);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => run(q), 280);
    return () => clearTimeout(t);
  }, [q, run]);

  const tag = q.trim().replace(/^#/, "").replace(/[^a-zA-Z0-9_]/g, "");
  const hasResults = people.length || communities.length || listings.length;

  type Row =
    | { kind: "header"; label: string }
    | { kind: "person"; item: PublicUser }
    | { kind: "community"; item: Community }
    | { kind: "listing"; item: Listing }
    | { kind: "hashtag"; tag: string };

  const rows: Row[] = [];
  if (tag) rows.push({ kind: "hashtag", tag });
  if (people.length) { rows.push({ kind: "header", label: "People" }); people.forEach((item) => rows.push({ kind: "person", item })); }
  if (communities.length) { rows.push({ kind: "header", label: "Communities" }); communities.forEach((item) => rows.push({ kind: "community", item })); }
  if (listings.length) { rows.push({ kind: "header", label: "Marketplace" }); listings.forEach((item) => rows.push({ kind: "listing", item })); }

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="search-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="search-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={16} color={theme.textMuted} />
          <TextInput
            ref={inputRef}
            style={styles.searchInput}
            value={q}
            onChangeText={setQ}
            placeholder="Search people, communities, marketplace…"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            returnKeyType="search"
            testID="search-input"
          />
          {!!q && (
            <TouchableOpacity onPress={() => setQ("")} testID="search-clear">
              <Ionicons name="close-circle" size={16} color={theme.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {loading && !hasResults ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : !q.trim() ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
          keyboardShouldPersistTaps="handled"
        >
          {trending.length > 0 && (
            <>
              <Text style={styles.section}>Popular hashtags</Text>
              <View style={styles.tagWrap}>
                {trending.map((h) => (
                  <TouchableOpacity
                    key={h.tag}
                    style={styles.tagChip}
                    onPress={() => router.push({ pathname: "/hashtag/[tag]", params: { tag: h.tag } })}
                    testID={`trend-${h.tag}`}
                  >
                    <Text style={styles.tagText}>#{h.tag}</Text>
                    <Text style={styles.tagCount}>{h.count}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}

          {popReels.length > 0 && (
            <>
              <Text style={styles.section}>Popular reels</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.reelStrip}
                keyboardShouldPersistTaps="handled"
              >
                {popReels.map((p) => {
                  const src = p.reposted_post || p;
                  const vid = (src.media || []).find((m) => m.type === "video");
                  const thumb = vid?.thumbnail || mediaUri(vid);
                  return (
                    <TouchableOpacity
                      key={p.id}
                      style={styles.reelCard}
                      onPress={() => router.push({ pathname: "/reels", params: { focus: p.id } })}
                      testID={`pop-reel-${p.id}`}
                    >
                      {thumb ? (
                        <Image source={{ uri: thumb }} style={styles.reelThumb} />
                      ) : (
                        <View style={[styles.reelThumb, styles.reelThumbFallback]}>
                          <Ionicons name="play" size={22} color="#fff" />
                        </View>
                      )}
                      <View style={styles.reelOverlay}>
                        <Ionicons name="heart" size={11} color="#fff" />
                        <Text style={styles.reelStat}>{src.likes_count || 0}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </>
          )}

          {popPosts.length > 0 && (
            <>
              <Text style={styles.section}>Popular posts</Text>
              {popPosts.map((p) => (
                <TouchableOpacity
                  key={p.id}
                  style={styles.row}
                  onPress={() => router.push({ pathname: "/post/[id]", params: { id: p.id } })}
                  testID={`pop-post-${p.id}`}
                >
                  <View style={styles.avatar}>
                    {p.author?.picture ? (
                      <Image source={{ uri: p.author.picture }} style={styles.avatarImg} />
                    ) : (
                      <Text style={styles.avatarInit}>{(p.author?.name?.[0] || "?").toUpperCase()}</Text>
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name} numberOfLines={1}>{p.author?.name}</Text>
                    <Text style={styles.sub} numberOfLines={2}>{p.text || "View post"}</Text>
                    <Text style={styles.postMeta}>♥ {p.likes_count || 0} · {p.replies_count || 0} replies</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
                </TouchableOpacity>
              ))}
            </>
          )}

          <View style={styles.center}><Text style={styles.hint}>Search across the whole site — people, communities, marketplace and hashtags.</Text></View>
        </ScrollView>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r, i) => `${r.kind}-${i}`}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
          ListEmptyComponent={<Text style={styles.empty}>No results for “{q.trim()}”.</Text>}
          renderItem={({ item: r }) => {
            if (r.kind === "header") return <Text style={styles.section}>{r.label}</Text>;
            if (r.kind === "hashtag") return (
              <TouchableOpacity style={styles.row} onPress={() => router.push({ pathname: "/hashtag/[tag]", params: { tag: r.tag } })} testID="search-hashtag">
                <View style={[styles.avatar, { backgroundColor: theme.surfaceAlt }]}><Ionicons name="pricetag" size={18} color={theme.primary} /></View>
                <View style={{ flex: 1 }}><Text style={styles.name}>#{r.tag}</Text><Text style={styles.sub}>See posts with this hashtag</Text></View>
                <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
              </TouchableOpacity>
            );
            if (r.kind === "person") return (
              <TouchableOpacity style={styles.row} onPress={() => router.push({ pathname: "/user/[name]", params: { name: r.item.name } })} testID={`search-user-${r.item.user_id}`}>
                <View style={styles.avatar}>{r.item.picture ? <Image source={{ uri: r.item.picture }} style={styles.avatarImg} /> : <Text style={styles.avatarInit}>{(r.item.name?.[0] || "?").toUpperCase()}</Text>}</View>
                <View style={{ flex: 1 }}><Text style={styles.name} numberOfLines={1}>{r.item.name}</Text>{!!r.item.username && <Text style={styles.sub}>@{r.item.username}</Text>}</View>
                <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
              </TouchableOpacity>
            );
            if (r.kind === "community") return (
              <TouchableOpacity style={styles.row} onPress={() => router.push({ pathname: "/c/[name]", params: { name: r.item.name } })} testID={`search-community-${r.item.id}`}>
                <View style={[styles.avatar, { backgroundColor: r.item.color || theme.surfaceAlt }]}><Ionicons name={(r.item.icon as any) || "people"} size={18} color="#fff" /></View>
                <View style={{ flex: 1 }}><Text style={styles.name} numberOfLines={1}>{r.item.title || r.item.name}</Text><Text style={styles.sub}>{(r.item.member_count || 0)} members</Text></View>
                <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
              </TouchableOpacity>
            );
            return (
              <TouchableOpacity style={styles.row} onPress={() => router.push({ pathname: "/listing/[id]", params: { id: r.item.id } })} testID={`search-listing-${r.item.id}`}>
                <View style={[styles.avatar, { backgroundColor: theme.surfaceAlt }]}><Ionicons name="pricetag-outline" size={18} color={theme.primary} /></View>
                <View style={{ flex: 1 }}><Text style={styles.name} numberOfLines={1}>{r.item.title}</Text><Text style={styles.sub}>{r.item.price > 0 ? `$${r.item.price.toFixed(0)}` : "Free"}</Text></View>
                <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
              </TouchableOpacity>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 36, height: 40, alignItems: "center", justifyContent: "center" },
  searchWrap: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 12, height: 42 },
  searchInput: { flex: 1, color: theme.textPrimary, fontSize: 15, ...webInput },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 30 },
  hint: { color: theme.textMuted, fontSize: 13, textAlign: "center", lineHeight: 19 },
  empty: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingVertical: 40 },
  section: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6 },
  tagWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingTop: 4 },
  tagChip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  tagText: { color: theme.primary, fontSize: 13.5, fontWeight: "800" },
  tagCount: { color: theme.textMuted, fontSize: 11.5, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  avatar: { width: 44, height: 44, borderRadius: 22, overflow: "hidden", backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontSize: 16, fontWeight: "700" },
  name: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  sub: { color: theme.textMuted, fontSize: 12.5, marginTop: 1 },
  postMeta: { color: theme.textMuted, fontSize: 11.5, fontWeight: "700", marginTop: 3 },
  reelStrip: { paddingHorizontal: 16, paddingTop: 4, gap: 10 },
  reelCard: { width: 104, height: 156, borderRadius: 12, overflow: "hidden", backgroundColor: theme.surfaceAlt },
  reelThumb: { width: "100%", height: "100%" },
  reelThumbFallback: { alignItems: "center", justifyContent: "center", backgroundColor: theme.surface },
  reelOverlay: { position: "absolute", left: 6, bottom: 6, flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "rgba(0,0,0,0.45)", borderRadius: 999, paddingHorizontal: 7, paddingVertical: 3 },
  reelStat: { color: "#fff", fontSize: 11, fontWeight: "800" },
});
