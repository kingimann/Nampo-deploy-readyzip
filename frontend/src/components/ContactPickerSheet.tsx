import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, Modal, TextInput, FlatList, TouchableOpacity,
  Image, ActivityIndicator, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { api, PublicUser } from "@/src/api/client";
import { theme } from "@/src/theme";

type Props = { visible: boolean; onClose: () => void; onPick: (u: PublicUser) => void };

/** Pick an app user to share as a contact card. */
export default function ContactPickerSheet({ visible, onClose, onPick }: Props) {
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(false);
  const debounce = useRef<any>(null);

  useEffect(() => {
    if (!visible || !q.trim()) { setUsers([]); return; }
    setLoading(true);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      try { setUsers(await api.searchUsers(q.trim())); } catch {} finally { setLoading(false); }
    }, 300);
    return () => debounce.current && clearTimeout(debounce.current);
  }, [q, visible]);

  useEffect(() => { if (visible) setQ(""); }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 8 }]} testID="contact-sheet">
          <View style={styles.handle} />
          <Text style={styles.title}>Share a contact</Text>
          <View style={styles.searchRow}>
            <Ionicons name="search" size={16} color={theme.textMuted} />
            <TextInput
              style={styles.input}
              placeholder="Search people"
              placeholderTextColor={theme.textMuted}
              value={q}
              onChangeText={setQ}
              autoFocus
              testID="contact-search"
            />
          </View>
          {loading ? (
            <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
          ) : (
            <FlatList
              data={users}
              keyExtractor={(u) => u.user_id}
              contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 8 }}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={<Text style={styles.empty}>{q.trim() ? "No people found." : "Search to share someone."}</Text>}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.row} onPress={() => { onPick(item); onClose(); }} testID={`contact-${item.user_id}`}>
                  <View style={styles.avatar}>
                    {item.picture ? (
                      <Image source={{ uri: item.picture }} style={{ width: "100%", height: "100%" }} />
                    ) : (
                      <Text style={styles.avatarInit}>{(item.name?.[0] || "?").toUpperCase()}</Text>
                    )}
                  </View>
                  <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                  <Ionicons name="arrow-forward" size={16} color={theme.textMuted} />
                </TouchableOpacity>
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { height: "62%", backgroundColor: theme.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, borderColor: theme.border, paddingTop: 10 },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 10 },
  title: { color: theme.textPrimary, fontSize: 16, fontWeight: "800", textAlign: "center", marginBottom: 10 },
  searchRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 14, paddingHorizontal: 14, height: 42,
    backgroundColor: theme.surface, borderRadius: 21, borderWidth: 1, borderColor: theme.border, marginBottom: 8,
  },
  input: { flex: 1, color: theme.textPrimary, fontSize: 15, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingVertical: 30 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  avatar: { width: 44, height: 44, borderRadius: 22, overflow: "hidden", backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  avatarInit: { color: "#fff", fontSize: 18, fontWeight: "700" },
  name: { flex: 1, color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
});
