import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, Modal, TextInput, FlatList, TouchableOpacity,
  Image, ActivityIndicator, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { searchGifs, GIFS_ENABLED, Gif } from "@/src/api/gifs";
import { theme } from "@/src/theme";

type Props = { visible: boolean; onClose: () => void; onPick: (url: string) => void };

export default function GifPickerSheet({ visible, onClose, onPick }: Props) {
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState("");
  const [gifs, setGifs] = useState<Gif[]>([]);
  const [loading, setLoading] = useState(false);
  const debounce = useRef<any>(null);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setGifs(await searchGifs(q));
      setLoading(false);
    }, 350);
    return () => debounce.current && clearTimeout(debounce.current);
  }, [q, visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 8 }]} testID="gif-sheet">
          <View style={styles.handle} />
          <View style={styles.searchRow}>
            <Ionicons name="search" size={16} color={theme.textMuted} />
            <TextInput
              style={styles.input}
              placeholder="Search GIFs"
              placeholderTextColor={theme.textMuted}
              value={q}
              onChangeText={setQ}
              autoFocus
              testID="gif-search"
            />
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={20} color={theme.textMuted} /></TouchableOpacity>
          </View>

          {!GIFS_ENABLED ? (
            <View style={styles.center}>
              <Ionicons name="film-outline" size={28} color={theme.textMuted} />
              <Text style={styles.note}>GIF search needs a Tenor key.</Text>
              <Text style={styles.noteSub}>Set EXPO_PUBLIC_TENOR_KEY to enable GIFs.</Text>
            </View>
          ) : loading ? (
            <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
          ) : (
            <FlatList
              data={gifs}
              keyExtractor={(g) => g.id}
              numColumns={3}
              columnWrapperStyle={{ gap: 6 }}
              contentContainerStyle={{ padding: 10, gap: 6 }}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={<Text style={styles.empty}>No GIFs found.</Text>}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.cell} onPress={() => { onPick(item.url); onClose(); }} testID={`gif-${item.id}`}>
                  <Image source={{ uri: item.preview }} style={StyleSheet.absoluteFill} resizeMode="cover" />
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
  sheet: { height: "70%", backgroundColor: theme.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, borderColor: theme.border, paddingTop: 10 },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 10 },
  searchRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 14, paddingHorizontal: 14, height: 42,
    backgroundColor: theme.surface, borderRadius: 21, borderWidth: 1, borderColor: theme.border,
  },
  input: { flex: 1, color: theme.textPrimary, fontSize: 15, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 30 },
  note: { color: theme.textSecondary, fontSize: 14, fontWeight: "700" },
  noteSub: { color: theme.textMuted, fontSize: 12, textAlign: "center" },
  empty: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingVertical: 30 },
  cell: { flex: 1, aspectRatio: 1, borderRadius: 8, overflow: "hidden", backgroundColor: theme.surfaceAlt },
});
