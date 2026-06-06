import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  ActivityIndicator, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, PublicUser } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import UserRow from "@/src/components/UserRow";

type Section = { key: string; title: string; data: PublicUser[] };

export default function PeopleScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user: me } = useAuth();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PublicUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [requests, setRequests] = useState<PublicUser[]>([]);
  const [friends, setFriends] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadLists = useCallback(async () => {
    try {
      const [r, f] = await Promise.all([api.listFriendRequests(), api.listFriends()]);
      setRequests(r);
      setFriends(f);
    } catch {} finally { setLoading(false); }
  }, []);

  useFocusEffect(useCallback(() => { loadLists(); }, [loadLists]));

  const onUserChanged = useCallback((u: PublicUser) => {
    const replace = (arr: PublicUser[]) =>
      arr.map((x) => (x.user_id === u.user_id ? u : x));
    setResults(replace);
    setRequests(replace);
    setFriends(replace);
    if (u.friend_status === "friends" || u.friend_status === "none") {
      loadLists();
    }
  }, [loadLists]);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    const term = q.trim();
    if (!term) { setResults([]); setSearching(false); return; }
    setSearching(true);
    debounce.current = setTimeout(async () => {
      try {
        const r = await api.searchUsers(term);
        setResults(r);
      } catch {} finally { setSearching(false); }
    }, 300);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [q]);

  const sections: Section[] = q.trim()
    ? [{ key: "results", title: "Results", data: results }]
    : [
        ...(requests.length ? [{ key: "requests", title: "Friend requests", data: requests }] : []),
        { key: "friends", title: "Your friends", data: friends },
      ];

  const flat = sections.flatMap((s) => [
    { __header: true, key: s.key, title: s.title } as const,
    ...s.data.map((u) => ({ __header: false as const, user: u, key: `${s.key}-${u.user_id}` })),
  ]);

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="people-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Find friends</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={styles.searchPill}>
        <Ionicons name="search" size={16} color={theme.textSecondary} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search people by name"
          placeholderTextColor={theme.textMuted}
          value={q}
          onChangeText={setQ}
          autoCapitalize="none"
          returnKeyType="search"
          testID="people-search"
        />
        {searching ? (
          <ActivityIndicator size="small" color={theme.primary} />
        ) : !!q && (
          <TouchableOpacity onPress={() => setQ("")} testID="people-search-clear">
            <Ionicons name="close-circle" size={16} color={theme.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {loading && !q.trim() ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={flat}
          keyExtractor={(i) => i.key}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 8 }}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) =>
            item.__header ? (
              <Text style={styles.sectionLabel}>{item.title}</Text>
            ) : (
              <UserRow user={item.user} currentUserId={me?.user_id} onChanged={onUserChanged} />
            )
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons
                name={q.trim() ? "search-outline" : "people-outline"}
                size={42}
                color={theme.textMuted}
              />
              <Text style={styles.emptyText}>
                {q.trim()
                  ? "No people found. Try another name."
                  : "Search for people to follow or add as friends."}
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  searchPill: {
    marginHorizontal: 16, marginTop: 12, marginBottom: 4,
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.surface, borderRadius: 14,
    paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1, borderColor: theme.border,
  },
  searchInput: {
    flex: 1, color: theme.textPrimary, fontSize: 14,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  sectionLabel: {
    color: theme.textMuted, fontSize: 12, fontWeight: "800",
    textTransform: "uppercase", letterSpacing: 0.6,
    marginTop: 8, marginBottom: 2,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center", gap: 12, paddingVertical: 60 },
  emptyText: { color: theme.textMuted, fontSize: 14, textAlign: "center", paddingHorizontal: 40 },
});
