import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image,
  ActivityIndicator, RefreshControl,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter, Stack } from "expo-router";
import { api, Notification, NetworkActivity } from "@/src/api/client";
import { theme } from "@/src/theme";
import { safeBack } from "@/src/utils/nav";

const ACT_ICON: Record<NetworkActivity["type"], { name: any; color: string }> = {
  like:    { name: "heart",      color: "#EF4444" },
  comment: { name: "chatbubble", color: "#3B82F6" },
  repost:  { name: "repeat",     color: "#22C55E" },
};
const actVerb = (a: NetworkActivity) =>
  a.type === "like" ? `liked a ${a.target_kind}`
  : a.type === "comment" ? `commented on a ${a.target_kind}`
  : `reposted a ${a.target_kind}`;

const ICON: Record<Notification["type"], { name: any; color: string }> = {
  like:          { name: "heart",            color: "#EF4444" },
  repost:        { name: "repeat",           color: "#22C55E" },
  reply:         { name: "chatbubble",       color: "#3B82F6" },
  message:       { name: "mail",             color: "#3B82F6" },
  group_invite:  { name: "people",           color: "#7C3AED" },
  group_message: { name: "chatbubbles",      color: "#7C3AED" },
  follow:        { name: "person-add",       color: "#0EA5E9" },
  poke:          { name: "hand-left",        color: "#F59E0B" },
  call:          { name: "call",             color: "#00A884" },
  support:       { name: "help-buoy",        color: "#06B6D4" },
  money_request:         { name: "cash",        color: "#22C55E" },
  money_received:        { name: "cash",        color: "#22C55E" },
  money_request_paid:    { name: "checkmark-circle", color: "#22C55E" },
  money_request_declined:{ name: "close-circle", color: "#EF4444" },
  money_accepted:        { name: "checkmark-circle", color: "#22C55E" },
  money_declined:        { name: "close-circle", color: "#EF4444" },
};

const VERB: Record<Notification["type"], string> = {
  like: "liked your post",
  repost: "reposted your post",
  reply: "replied to your post",
  message: "sent you a message",
  group_invite: "added you to a group",
  group_message: "messaged a group",
  follow: "followed you",
  poke: "poked you 👈",
  call: "is calling you 📞 — tap to join",
  support: "Support replied to your ticket",
  money_request: "requested money",
  money_received: "sent you money",
  money_request_paid: "paid your request",
  money_request_declined: "declined your request",
  money_accepted: "accepted your money",
  money_declined: "declined your money",
};

export default function NotificationsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<"you" | "activity">("you");
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activity, setActivity] = useState<NetworkActivity[]>([]);
  const [actLoading, setActLoading] = useState(false);
  const [actLoaded, setActLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.listNotifications();
      setItems(r);
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadActivity = useCallback(async () => {
    setActLoading(true);
    try { setActivity(await api.listActivity()); setActLoaded(true); }
    catch {} finally { setActLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const switchTab = (t: "you" | "activity") => {
    setTab(t);
    if (t === "activity" && !actLoaded) loadActivity();
  };

  const onActivityTap = (a: NetworkActivity) => {
    if (!a.post_id) return;
    if (a.target_kind === "video") router.push({ pathname: "/reels", params: { focus: a.post_id } });
    else router.push({ pathname: "/post/[id]", params: { id: a.post_id } });
  };

  const onTap = async (n: Notification) => {
    if (!n.read) {
      try { await api.markNotificationRead(n.id); } catch {}
      setItems((arr) => arr.map((x) => x.id === n.id ? { ...x, read: true } : x));
    }
    if (n.type === "call" && n.conversation_id) {
      // Join the incoming voice call.
      router.push({ pathname: "/call/[id]", params: { id: n.conversation_id, name: n.actor_name || "Call" } });
    } else if (n.type === "support") {
      router.push("/support");
    } else if (n.type.startsWith("money")) {
      router.push("/money");
    } else if (n.conversation_id) {
      router.push({ pathname: "/chat/[id]", params: { id: n.conversation_id } });
    } else if ((n.type === "poke" || n.type === "follow") && n.actor_name) {
      router.push({ pathname: "/user/[name]", params: { name: n.actor_name } });
    } else if (n.post_id) {
      router.push({ pathname: "/(tabs)/feed" });
    }
  };

  const onDelete = async (n: Notification) => {
    setItems((arr) => arr.filter((x) => x.id !== n.id));
    try { await api.deleteNotification(n.id); } catch {}
  };

  const markAll = async () => {
    setItems((arr) => arr.map((x) => ({ ...x, read: true })));
    try { await api.markAllNotificationsRead(); } catch { load(); }
  };

  const fmtTime = (iso: string) => {
    const d = new Date(iso); const now = Date.now();
    const s = Math.floor((now - d.getTime()) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  };

  const unread = items.filter((i) => !i.read).length;

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="notifications-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack("/(tabs)/feed")} style={styles.backBtn} testID="notifications-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Notifications</Text>
        {tab === "you" ? (
          <TouchableOpacity
            onPress={markAll}
            disabled={unread === 0}
            style={[styles.markAllBtn, unread === 0 && { opacity: 0.4 }]}
            testID="mark-all-read"
          >
            <Text style={styles.markAllText}>Mark all read</Text>
          </TouchableOpacity>
        ) : <View style={{ width: 40 }} />}
      </View>

      <View style={styles.tabs}>
        {([["you", "Notifications"], ["activity", "Activity"]] as const).map(([k, label]) => (
          <TouchableOpacity key={k} style={styles.tab} onPress={() => switchTab(k)} testID={`notif-tab-${k}`}>
            <Text style={[styles.tabText, tab === k && styles.tabTextActive]}>{label}</Text>
            {tab === k && <View style={styles.tabUnderline} />}
          </TouchableOpacity>
        ))}
      </View>

      {tab === "activity" ? (
        actLoading && !activity.length ? (
          <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
        ) : (
          <FlatList
            data={activity}
            keyExtractor={(i) => i.id}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadActivity(); }} tintColor={theme.primary} />}
            contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 8 }}
            ListEmptyComponent={
              <View style={styles.empty}>
                <View style={styles.emptyIcon}><Ionicons name="people-outline" size={32} color={theme.textMuted} /></View>
                <Text style={styles.emptyTitle}>No activity yet</Text>
                <Text style={styles.emptySub}>When friends and people you follow like, comment on, or repost posts and videos, you'll see it here.</Text>
              </View>
            }
            renderItem={({ item }) => {
              const ic = ACT_ICON[item.type] || ACT_ICON.like;
              return (
                <TouchableOpacity style={styles.row} onPress={() => onActivityTap(item)} testID={`act-${item.id}`} activeOpacity={0.85}>
                  <View style={styles.avatarWrap}>
                    {item.actor_picture ? (
                      <Image source={{ uri: item.actor_picture }} style={styles.avatarImg} />
                    ) : (
                      <View style={styles.avatarFallback}><Text style={styles.avatarInit}>{(item.actor_name?.[0] || "?").toUpperCase()}</Text></View>
                    )}
                    <View style={[styles.iconChip, { backgroundColor: ic.color }]}><Ionicons name={ic.name} size={10} color="#fff" /></View>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.text} numberOfLines={2}>
                      <Text style={{ fontWeight: "700" }}>{item.actor_name || "Someone"}</Text>
                      <Text>  {actVerb(item)}</Text>
                    </Text>
                    {!!item.text && <Text style={styles.preview} numberOfLines={2}>“{item.text}”</Text>}
                    <Text style={styles.time}>{fmtTime(item.created_at)}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
                </TouchableOpacity>
              );
            }}
          />
        )
      ) : loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={theme.primary}
            />
          }
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 8 }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Ionicons name="notifications-off-outline" size={32} color={theme.textMuted} />
              </View>
              <Text style={styles.emptyTitle}>No notifications yet</Text>
              <Text style={styles.emptySub}>Likes, reposts, replies, messages and group activity will show up here.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const ic = ICON[item.type] || ICON.like;
            return (
              <TouchableOpacity
                style={[styles.row, !item.read && styles.unreadRow]}
                onPress={() => onTap(item)}
                onLongPress={() => onDelete(item)}
                delayLongPress={350}
                testID={`notif-${item.id}`}
                activeOpacity={0.85}
              >
                <View style={styles.avatarWrap}>
                  {item.actor_picture ? (
                    <Image source={{ uri: item.actor_picture }} style={styles.avatarImg} />
                  ) : (
                    <View style={styles.avatarFallback}>
                      <Text style={styles.avatarInit}>
                        {(item.actor_name?.[0] || "?").toUpperCase()}
                      </Text>
                    </View>
                  )}
                  <View style={[styles.iconChip, { backgroundColor: ic.color }]}>
                    <Ionicons name={ic.name} size={10} color="#fff" />
                  </View>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.text} numberOfLines={2}>
                    <Text style={{ fontWeight: "700" }}>{item.actor_name || "Someone"}</Text>
                    <Text>  {VERB[item.type]}</Text>
                  </Text>
                  {!!item.message && (
                    <Text style={styles.preview} numberOfLines={2}>“{item.message}”</Text>
                  )}
                  <Text style={styles.time}>{fmtTime(item.created_at)}</Text>
                </View>
                {!item.read && <View style={styles.dot} />}
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
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, gap: 12,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  title: { color: theme.textPrimary, fontSize: 22, fontWeight: "800", flex: 1 },
  markAllBtn: {
    paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
  },
  markAllText: { color: theme.primary, fontSize: 12, fontWeight: "700" },
  tabs: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  tab: { flex: 1, alignItems: "center", paddingVertical: 11 },
  tabText: { color: theme.textMuted, fontSize: 14.5, fontWeight: "700" },
  tabTextActive: { color: theme.textPrimary, fontWeight: "800" },
  tabUnderline: { position: "absolute", bottom: -StyleSheet.hairlineWidth, height: 2.5, width: 60, borderRadius: 2, backgroundColor: theme.primary },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { paddingTop: 80, alignItems: "center", gap: 10 },
  emptyIcon: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center", marginBottom: 4,
  },
  emptyTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "700" },
  emptySub: { color: theme.textSecondary, fontSize: 13, textAlign: "center", maxWidth: 280 },

  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface, borderRadius: 16,
    borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  unreadRow: { backgroundColor: "#0F1827", borderColor: "#1E3A5F" },
  avatarWrap: { width: 44, height: 44 },
  avatarImg: { width: 44, height: 44, borderRadius: 22 },
  avatarFallback: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: theme.primary, alignItems: "center", justifyContent: "center",
  },
  avatarInit: { color: "#fff", fontSize: 16, fontWeight: "700" },
  iconChip: {
    position: "absolute", bottom: -2, right: -2,
    width: 18, height: 18, borderRadius: 9,
    alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: theme.surface,
  },
  text: { color: theme.textPrimary, fontSize: 14, lineHeight: 19 },
  preview: { color: theme.textSecondary, fontSize: 12, marginTop: 2 },
  time: { color: theme.textMuted, fontSize: 11, marginTop: 4 },
  dot: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: theme.primary,
  },
});
