import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image, ActivityIndicator, RefreshControl, Modal,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, Community, CommunityMember, CommunityKarmaEntry } from "@/src/api/client";
import { useConfirm } from "@/src/context/ConfirmContext";
import { theme } from "@/src/theme";
import { AvatarFrame } from "@/src/components/ProfileDecor";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", mod: "Mod", member: "Member" };

export default function CommunityMembersScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const confirm = useConfirm();
  const { name } = useLocalSearchParams<{ name: string }>();
  const [community, setCommunity] = useState<Community | null>(null);
  const [members, setMembers] = useState<CommunityMember[]>([]);
  const [top, setTop] = useState<CommunityKarmaEntry[]>([]);
  const [tab, setTab] = useState<"members" | "top">("members");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sheet, setSheet] = useState<CommunityMember | null>(null);

  const isOwner = !!community && community.role === "owner";
  const canModerate = !!community?.can_moderate;

  const load = useCallback(async () => {
    if (!name) return;
    try {
      const [c, m, t] = await Promise.all([api.getCommunity(name), api.communityMembers(name), api.communityTop(name)]);
      setCommunity(c); setMembers(m.members); setTop(t.leaders);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [name]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const update = (uid: string, patch: Partial<CommunityMember>) =>
    setMembers((arr) => arr.map((m) => (m.user_id === uid ? { ...m, ...patch } : m)));

  const promote = async (m: CommunityMember) => {
    setSheet(null);
    update(m.user_id, { role: "mod" });
    try { await api.addCommunityMod(name!, m.user_id); } catch { load(); }
  };
  const demote = async (m: CommunityMember) => {
    setSheet(null);
    update(m.user_id, { role: "member" });
    try { await api.removeCommunityMod(name!, m.user_id); } catch { load(); }
  };
  const kick = async (m: CommunityMember) => {
    setSheet(null);
    if (!(await confirm({ title: `Remove ${m.name}?`, message: "They'll be removed from this community.", confirmLabel: "Remove", destructive: true }))) return;
    setMembers((arr) => arr.filter((x) => x.user_id !== m.user_id));
    try { await api.removeCommunityMember(name!, m.user_id); } catch { load(); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="community-members-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn} hitSlop={10} testID="members-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{community ? `/${community.name}` : "Members"}</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.toggleRow}>
        {(["members", "top"] as const).map((t) => (
          <TouchableOpacity key={t} style={[styles.toggleBtn, tab === t && styles.toggleBtnOn]} onPress={() => setTab(t)} testID={`members-tab-${t}`}>
            <Text style={[styles.toggleText, tab === t && { color: theme.primary }]}>{t === "members" ? "Members" : "Top karma"}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : tab === "top" ? (
        <FlatList
          data={top}
          keyExtractor={(e) => e.user_id}
          contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 24, gap: 8 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} colors={[theme.primary]} />}
          ListEmptyComponent={<Text style={styles.empty}>No karma yet — upvotes on members' posts here will rank them.</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.85}
              onPress={() => { if (item.username) router.push({ pathname: "/user/[name]", params: { name: item.username } }); }}
            >
              <Text style={styles.rank}>{item.rank}</Text>
              <AvatarFrame frame={item.avatar_frame} size={42} ring={2}>
                <Image source={{ uri: item.picture || undefined }} style={styles.avatar} />
              </AvatarFrame>
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                {!!item.username && <Text style={styles.handle} numberOfLines={1}>@{item.username}</Text>}
              </View>
              <View style={styles.karmaWrap}>
                <Ionicons name="flame" size={14} color={theme.primary} />
                <Text style={styles.karmaVal}>{item.karma}</Text>
              </View>
            </TouchableOpacity>
          )}
        />
      ) : (
        <FlatList
          data={members}
          keyExtractor={(m) => m.user_id}
          contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 24, gap: 8 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} colors={[theme.primary]} />}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.85}
              onPress={() => { if (item.username) router.push({ pathname: "/user/[name]", params: { name: item.username } }); }}
            >
              <AvatarFrame frame={item.avatar_frame} size={42} ring={2}>
                <Image source={{ uri: item.picture || undefined }} style={styles.avatar} />
              </AvatarFrame>
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                {!!item.username && <Text style={styles.handle} numberOfLines={1}>@{item.username}</Text>}
              </View>
              <View style={[styles.roleTag, item.role === "owner" && styles.roleOwner, item.role === "mod" && styles.roleMod]}>
                <Text style={[styles.roleText, item.role !== "member" && { color: "#fff" }]}>{ROLE_LABEL[item.role] || "Member"}</Text>
              </View>
              {canModerate && item.role !== "owner" && (
                <TouchableOpacity onPress={() => setSheet(item)} hitSlop={8} testID={`member-actions-${item.user_id}`}>
                  <Ionicons name="ellipsis-horizontal" size={18} color={theme.textMuted} />
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          )}
        />
      )}

      <Modal visible={!!sheet} transparent animationType="fade" onRequestClose={() => setSheet(null)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setSheet(null)}>
          <View style={[styles.actionSheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.sheetTitle} numberOfLines={1}>{sheet?.name}</Text>
            {isOwner && sheet?.role === "member" && (
              <TouchableOpacity style={styles.actionBtn} onPress={() => sheet && promote(sheet)}>
                <Ionicons name="shield-checkmark-outline" size={18} color={theme.primary} />
                <Text style={styles.actionText}>Make moderator</Text>
              </TouchableOpacity>
            )}
            {isOwner && sheet?.role === "mod" && (
              <TouchableOpacity style={styles.actionBtn} onPress={() => sheet && demote(sheet)}>
                <Ionicons name="shield-outline" size={18} color={theme.primary} />
                <Text style={styles.actionText}>Remove moderator role</Text>
              </TouchableOpacity>
            )}
            {(isOwner || sheet?.role === "member") && (
              <TouchableOpacity style={styles.actionBtn} onPress={() => sheet && kick(sheet)}>
                <Ionicons name="person-remove-outline" size={18} color={theme.error} />
                <Text style={[styles.actionText, { color: theme.error }]}>Remove from community</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.actionBtn} onPress={() => setSheet(null)}>
              <Text style={styles.actionText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 10 },
  backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 17, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  toggleRow: { flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingBottom: 10 },
  toggleBtn: { flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: 12, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  toggleBtnOn: { backgroundColor: theme.surfaceAlt, borderColor: theme.primary },
  toggleText: { color: theme.textSecondary, fontSize: 13.5, fontWeight: "800" },
  empty: { color: theme.textMuted, fontSize: 13, textAlign: "center", marginTop: 40, paddingHorizontal: 30 },
  rank: { width: 22, textAlign: "center", color: theme.textMuted, fontSize: 15, fontWeight: "800" },
  karmaWrap: { flexDirection: "row", alignItems: "center", gap: 4 },
  karmaVal: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12 },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: theme.surfaceAlt },
  name: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  handle: { color: theme.textMuted, fontSize: 12.5, marginTop: 1 },
  roleTag: { borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4, backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border },
  roleOwner: { backgroundColor: theme.primary, borderColor: theme.primary },
  roleMod: { backgroundColor: theme.primaryHover || theme.primary, borderColor: theme.primary },
  roleText: { color: theme.textSecondary, fontSize: 11, fontWeight: "800" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  actionSheet: { backgroundColor: "#0E0E10", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 16, borderTopWidth: 1, borderColor: theme.border },
  sheetTitle: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10, marginLeft: 4 },
  actionBtn: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, marginTop: 6 },
  actionText: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
});
