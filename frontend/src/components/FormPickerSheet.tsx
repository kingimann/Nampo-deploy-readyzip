import React, { useEffect, useState } from "react";
import {
  View, Text, StyleSheet, Modal, FlatList, TouchableOpacity, ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api, FormDef } from "@/src/api/client";
import { theme } from "@/src/theme";

type Props = { visible: boolean; onClose: () => void; onPick: (f: FormDef) => void };

/** Pick one of your saved forms to share into a chat. */
export default function FormPickerSheet({ visible, onClose, onPick }: Props) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [forms, setForms] = useState<FormDef[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    (async () => {
      try {
        const res = await api.listForms();
        setForms(res.forms || []);
      } catch {
      } finally {
        setLoading(false);
      }
    })();
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 8 }]} testID="form-sheet">
          <View style={styles.handle} />
          <Text style={styles.title}>Share a form</Text>
          {loading ? (
            <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
          ) : (
            <FlatList
              data={forms}
              keyExtractor={(f) => f.id}
              contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 8 }}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <View style={styles.emptyWrap}>
                  <Text style={styles.empty}>You haven't created any forms yet.</Text>
                  <TouchableOpacity
                    style={styles.createBtn}
                    onPress={() => { onClose(); router.push("/forms"); }}
                    testID="form-create-cta"
                  >
                    <Ionicons name="add" size={16} color="#fff" />
                    <Text style={styles.createText}>Create a form</Text>
                  </TouchableOpacity>
                </View>
              }
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.row} onPress={() => { onPick(item); onClose(); }} testID={`form-${item.id}`}>
                  <View style={styles.icon}>
                    <Ionicons name="document-text" size={20} color="#fff" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name} numberOfLines={1}>{item.title || "Untitled form"}</Text>
                    <Text style={styles.sub} numberOfLines={1}>
                      {(item.fields?.length || 0)} field{(item.fields?.length || 0) === 1 ? "" : "s"} · {item.submissions || 0} response{(item.submissions || 0) === 1 ? "" : "s"}
                    </Text>
                  </View>
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
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyWrap: { alignItems: "center", paddingVertical: 30, gap: 14 },
  empty: { color: theme.textMuted, fontSize: 13, textAlign: "center" },
  createBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.primary, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 },
  createText: { color: "#fff", fontSize: 14, fontWeight: "800" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  icon: { width: 44, height: 44, borderRadius: 12, backgroundColor: "#0EA5A0", alignItems: "center", justifyContent: "center" },
  name: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  sub: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
});
