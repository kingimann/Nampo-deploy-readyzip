import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator,
  Image, Modal, Platform, Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, Circle, PublicUser } from "@/src/api/client";
import { theme } from "@/src/theme";

/**
 * Audience circles — create layers (Work, Inner Circle, Hobbies…) and choose who
 * belongs to each. When composing a post you can target a circle so only its
 * members see it.
 */
export default function CirclesScreen() {
  const insets = useSafeAreaInsets();
  const [circles, setCircles] = useState<Circle[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [edit, setEdit] = useState<Circle | null>(null);

  const load = useCallback(async () => {
    try { setCircles(await api.listCircles()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try { const c = await api.createCircle(name); setCircles((a) => [c, ...a]); setNewName(""); }
    catch (e: any) { Alert.alert("Couldn't create", String(e?.message || e).replace(/^\d+:\s*/, "")); }
    finally { setCreating(false); }
  };

  const onDeleted = (id: string) => setCircles((a) => a.filter((c) => c.id !== id));
  const onUpdated = (c: Circle) => setCircles((a) => a.map((x) => (x.id === c.id ? c : x)));

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="circles-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn} testID="circles-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Circles</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
        <Text style={styles.note}>
          Group people into circles, then post to a circle so only its members can see it — no
          second account needed.
        </Text>

        <View style={styles.addRow}>
          <TextInput
            style={styles.input}
            value={newName}
            onChangeText={setNewName}
            onSubmitEditing={create}
            placeholder="New circle (e.g. Work, Inner Circle)…"
            placeholderTextColor={theme.textMuted}
            maxLength={60}
            returnKeyType="done"
            testID="circle-name-input"
          />
          <TouchableOpacity style={[styles.addBtn, (!newName.trim() || creating) && { opacity: 0.5 }]} onPress={create} disabled={!newName.trim() || creating} testID="circle-create">
            {creating ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="add" size={22} color="#fff" />}
          </TouchableOpacity>
        </View>

        {loading ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 30 }} />
        ) : circles.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="people-circle-outline" size={44} color={theme.textMuted} />
            <Text style={styles.emptyText}>No circles yet. Create one above, then add people to it.</Text>
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            {circles.map((c) => (
              <TouchableOpacity key={c.id} style={styles.circleRow} onPress={() => setEdit(c)} testID={`circle-${c.id}`}>
                <View style={styles.circleIcon}><Ionicons name="people" size={18} color={theme.primary} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.circleName} numberOfLines={1}>{c.name}</Text>
                  <Text style={styles.circleSub}>{c.member_count} {c.member_count === 1 ? "person" : "people"}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>

      <CircleEditor circle={edit} onClose={() => setEdit(null)} onDeleted={onDeleted} onUpdated={onUpdated} />
    </SafeAreaView>
  );
}

function CircleEditor({ circle, onClose, onDeleted, onUpdated }: {
  circle: Circle | null; onClose: () => void; onDeleted: (id: string) => void; onUpdated: (c: Circle) => void;
}) {
  const insets = useSafeAreaInsets();
  const [members, setMembers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PublicUser[]>([]);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!circle) return;
    setLoading(true); setQ(""); setResults([]); setCount(circle.member_count);
    api.circleMembers(circle.id).then((m) => setMembers(m)).catch(() => {}).finally(() => setLoading(false));
  }, [circle?.id]);

  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api.searchUsers(q);
        const have = new Set(members.map((m) => m.user_id));
        setResults(r.filter((u) => !have.has(u.user_id)).slice(0, 8));
      } catch {}
    }, 220);
    return () => clearTimeout(t);
  }, [q, members]);

  if (!circle) return null;

  const add = async (u: PublicUser) => {
    setMembers((m) => [u, ...m]); setCount((c) => c + 1); setResults((r) => r.filter((x) => x.user_id !== u.user_id)); setQ("");
    try { const c = await api.updateCircle(circle.id, { add_member_ids: [u.user_id] }); onUpdated(c); } catch {}
  };
  const remove = async (u: PublicUser) => {
    setMembers((m) => m.filter((x) => x.user_id !== u.user_id)); setCount((c) => Math.max(0, c - 1));
    try { const c = await api.updateCircle(circle.id, { remove_member_ids: [u.user_id] }); onUpdated(c); } catch {}
  };
  const del = () => {
    Alert.alert("Delete circle?", `"${circle.name}" will be removed. Posts shared only to it become visible to just you.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => { try { await api.deleteCircle(circle.id); onDeleted(circle.id); onClose(); } catch {} } },
    ]);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetWrap}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle} numberOfLines={1}>{circle.name}</Text>
            <TouchableOpacity onPress={del} testID="circle-delete"><Ionicons name="trash-outline" size={22} color={theme.error} /></TouchableOpacity>
          </View>

          <TextInput
            style={styles.input}
            value={q}
            onChangeText={setQ}
            placeholder="Add people…"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            testID="circle-add-search"
          />
          {results.length > 0 && (
            <View style={styles.results}>
              {results.map((u) => (
                <TouchableOpacity key={u.user_id} style={styles.memberRow} onPress={() => add(u)} testID={`circle-add-${u.user_id}`}>
                  <Avatar u={u} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.memberName} numberOfLines={1}>{u.name}</Text>
                    {!!u.username && <Text style={styles.memberHandle}>@{u.username}</Text>}
                  </View>
                  <Ionicons name="add-circle" size={22} color={theme.primary} />
                </TouchableOpacity>
              ))}
            </View>
          )}

          <Text style={styles.membersLabel}>{count} member{count === 1 ? "" : "s"}</Text>
          <ScrollView style={{ maxHeight: 320 }}>
            {loading ? <ActivityIndicator color={theme.primary} style={{ marginTop: 16 }} /> :
              members.length === 0 ? <Text style={styles.emptyText}>No one in this circle yet.</Text> :
              members.map((u) => (
                <View key={u.user_id} style={styles.memberRow}>
                  <Avatar u={u} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.memberName} numberOfLines={1}>{u.name}</Text>
                    {!!u.username && <Text style={styles.memberHandle}>@{u.username}</Text>}
                  </View>
                  <TouchableOpacity onPress={() => remove(u)} testID={`circle-remove-${u.user_id}`}>
                    <Ionicons name="close-circle" size={22} color={theme.textMuted} />
                  </TouchableOpacity>
                </View>
              ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Avatar({ u }: { u: PublicUser }) {
  return u.picture ? (
    <Image source={{ uri: u.picture }} style={styles.avatar} />
  ) : (
    <View style={[styles.avatar, styles.avatarFallback]}><Text style={styles.avatarInit}>{(u.name?.[0] || "?").toUpperCase()}</Text></View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  backBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  note: { color: theme.textSecondary, fontSize: 13, lineHeight: 19, marginBottom: 16 },
  addRow: { flexDirection: "row", gap: 10, marginBottom: 18 },
  input: {
    flex: 1, backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border,
    color: theme.textPrimary, fontSize: 15, paddingHorizontal: 14, paddingVertical: 12,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  addBtn: { width: 48, borderRadius: 12, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center", gap: 12, paddingVertical: 50 },
  emptyText: { color: theme.textMuted, fontSize: 13.5, textAlign: "center", paddingHorizontal: 30, lineHeight: 19, paddingVertical: 12 },
  circleRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, paddingVertical: 14 },
  circleIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: theme.surfaceAlt, alignItems: "center", justifyContent: "center" },
  circleName: { color: theme.textPrimary, fontSize: 15.5, fontWeight: "800" },
  circleSub: { color: theme.textMuted, fontSize: 12.5, marginTop: 1 },
  sheetWrap: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: { backgroundColor: theme.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 16, paddingTop: 8, borderTopWidth: 1, borderColor: theme.border },
  sheetHandle: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: theme.borderStrong, marginBottom: 14 },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  sheetTitle: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  results: { marginTop: 8, backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, overflow: "hidden" },
  membersLabel: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 18, marginBottom: 6 },
  memberRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9, paddingHorizontal: 6 },
  avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: theme.surfaceAlt },
  avatarFallback: { alignItems: "center", justifyContent: "center" },
  avatarInit: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  memberName: { color: theme.textPrimary, fontSize: 14.5, fontWeight: "700" },
  memberHandle: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
});
