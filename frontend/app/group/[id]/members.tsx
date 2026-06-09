import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  Image, Alert, SectionList,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, Group } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

type Member = {
  user_id: string; name: string; username?: string | null;
  picture?: string | null; role: string; joined_at: string;
};
type Request = {
  user_id: string; name: string; username?: string | null;
  picture?: string | null; created_at: string;
};

export default function MembersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);

  const isOwner = !!group && user?.user_id === group.owner_id;
  const myRole = group?.my_role ?? "member";
  const canModerate = myRole === "owner" || myRole === "admin";

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [g, m] = await Promise.all([
        api.getGroup(id),
        api.listGroupMembers(id).catch(() => []),
      ]);
      setGroup(g);
      setMembers(m);
      if (g.my_role === "owner" || g.my_role === "admin") {
        api.listJoinRequests(id).then(setRequests).catch(() => setRequests([]));
      } else {
        setRequests([]);
      }
    } catch {} finally { setLoading(false); }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const promote = (m: Member) => {
    if (!group) return;
    Alert.alert("Make admin?", `${m.name} will be able to remove members.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Make admin", onPress: async () => {
        try { await api.promoteMember(group.id, m.user_id); await load(); }
        catch (e: any) { Alert.alert("Failed", e?.message || "Try again"); }
      }},
    ]);
  };
  const demote = (m: Member) => {
    if (!group) return;
    Alert.alert("Remove admin role?", `${m.name} will become a regular member.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Demote", onPress: async () => {
        try { await api.demoteMember(group.id, m.user_id); await load(); }
        catch (e: any) { Alert.alert("Failed", e?.message || "Try again"); }
      }},
    ]);
  };
  const kick = (m: Member) => {
    if (!group) return;
    Alert.alert("Remove from group?", `${m.name} will be removed.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: async () => {
        try { await api.kickMember(group.id, m.user_id); await load(); }
        catch (e: any) { Alert.alert("Failed", e?.message || "Try again"); }
      }},
    ]);
  };
  const approve = async (r: Request) => {
    if (!group) return;
    try { await api.approveJoinRequest(group.id, r.user_id); await load(); }
    catch (e: any) { Alert.alert("Failed", e?.message || "Try again"); }
  };
  const reject = async (r: Request) => {
    if (!group) return;
    try { await api.rejectJoinRequest(group.id, r.user_id); await load(); }
    catch (e: any) { Alert.alert("Failed", e?.message || "Try again"); }
  };

  const onMemberActions = (m: Member) => {
    if (!canModerate) return;
    if (m.role === "owner") return;
    const isAdmin = m.role === "admin";
    const opts: { label: string; onPress: () => void; destructive?: boolean }[] = [];
    if (isOwner) {
      opts.push(
        isAdmin
          ? { label: "Remove admin role", onPress: () => demote(m) }
          : { label: "Make admin", onPress: () => promote(m) }
      );
    }
    // Admins can kick non-admins; owners can kick anyone except owner
    if (isOwner || (myRole === "admin" && !isAdmin)) {
      opts.push({ label: "Remove from group", onPress: () => kick(m), destructive: true });
    }
    if (opts.length === 0) return;
    Alert.alert(m.name, undefined, [
      ...opts.map((o) => ({ text: o.label, onPress: o.onPress, style: (o.destructive ? "destructive" : "default") as any })),
      { text: "Cancel", style: "cancel" as any },
    ]);
  };

  if (loading || !group) {
    return (
      <SafeAreaView style={styles.root}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator color={theme.primary} style={{ marginTop: 60 }} />
      </SafeAreaView>
    );
  }

  const sections = [
    ...(canModerate && requests.length > 0
      ? [{ title: `Pending requests (${requests.length})`, kind: "request" as const, data: requests }]
      : []),
    { title: `Members (${members.length})`, kind: "member" as const, data: members },
  ];

  return (
    <SafeAreaView edges={["top"]} style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="back">
          <Ionicons name="chevron-back" size={22} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{group.name}</Text>
        <View style={{ width: 36 }} />
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(item: any) => `${item.user_id}_${(item as any).role || "req"}`}
        contentContainerStyle={{ padding: 14, gap: 4 }}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionTitle}>{section.title}</Text>
        )}
        renderItem={({ item, section }) => {
          const initial = (item.name?.[0] || "?").toUpperCase();
          if (section.kind === "request") {
            const r = item as Request;
            return (
              <View style={styles.row}>
                <View style={styles.avatar}>
                  {r.picture
                    ? <Image source={{ uri: r.picture }} style={styles.avatarImg} />
                    : <Text style={styles.avatarInit}>{initial}</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowName} numberOfLines={1}>{r.name}</Text>
                  {!!r.username && <Text style={styles.rowSub}>@{r.username}</Text>}
                </View>
                <TouchableOpacity onPress={() => approve(r)} style={styles.approveBtn} testID={`approve-${r.user_id}`}>
                  <Ionicons name="checkmark" size={18} color="#fff" />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => reject(r)} style={styles.rejectBtn} testID={`reject-${r.user_id}`}>
                  <Ionicons name="close" size={18} color={theme.error} />
                </TouchableOpacity>
              </View>
            );
          }
          const m = item as Member;
          const badge = m.role === "owner" ? "Owner" : m.role === "admin" ? "Admin" : null;
          return (
            <TouchableOpacity
              style={styles.row}
              onPress={() => onMemberActions(m)}
              activeOpacity={canModerate && m.role !== "owner" ? 0.85 : 1}
              disabled={!canModerate || m.role === "owner"}
              testID={`member-${m.user_id}`}
            >
              <View style={styles.avatar}>
                {m.picture
                  ? <Image source={{ uri: m.picture }} style={styles.avatarImg} />
                  : <Text style={styles.avatarInit}>{initial}</Text>}
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={styles.rowName} numberOfLines={1}>{m.name}</Text>
                  {badge && (
                    <View style={[styles.badge, m.role === "owner" && { backgroundColor: theme.primary, borderColor: theme.primary }]}>
                      <Text style={[styles.badgeText, m.role === "owner" && { color: "#fff" }]}>{badge}</Text>
                    </View>
                  )}
                </View>
                {!!m.username && <Text style={styles.rowSub}>@{m.username}</Text>}
              </View>
              {canModerate && m.role !== "owner" && (
                <Ionicons name="ellipsis-horizontal" size={18} color={theme.textMuted} />
              )}
            </TouchableOpacity>
          );
        }}
        ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
        SectionSeparatorComponent={() => <View style={{ height: 14 }} />}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
  },
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  title: { flex: 1, color: theme.textPrimary, fontSize: 16, fontWeight: "800", textAlign: "center" },

  sectionTitle: {
    color: theme.textMuted, fontSize: 11, fontWeight: "800",
    textTransform: "uppercase", letterSpacing: 0.6,
    paddingBottom: 6, paddingTop: 4,
  },

  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface, borderRadius: 14,
    borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  avatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: theme.primary, overflow: "hidden",
    alignItems: "center", justifyContent: "center",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontWeight: "800", fontSize: 15 },
  rowName: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  rowSub: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  badge: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999,
    backgroundColor: "rgba(0,168,132,0.12)",
    borderWidth: 1, borderColor: "rgba(0,168,132,0.4)",
  },
  badgeText: { color: theme.primary, fontSize: 10, fontWeight: "800", letterSpacing: 0.3 },

  approveBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
  },
  rejectBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: "rgba(241,92,109,0.15)",
    borderWidth: 1, borderColor: "rgba(241,92,109,0.5)",
    alignItems: "center", justifyContent: "center",
  },
});
