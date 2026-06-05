import React, { useState } from "react";
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, Image, ScrollView,
  TextInput, ActivityIndicator, Platform, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { api, CustomEmoji } from "@/src/api/client";
import { theme } from "@/src/theme";

type Props = {
  visible: boolean;
  emojis: CustomEmoji[];
  myUserId?: string;
  onClose: () => void;
  onPick: (shortcode: string) => void;        // insert :shortcode: into the composer
  onChanged: () => void;                       // re-fetch after add/delete
};

export default function CustomEmojiSheet({ visible, emojis, myUserId, onClose, onPick, onChanged }: Props) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [pendingImg, setPendingImg] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const pickImage = async () => {
    if (Platform.OS !== "web") {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"] as any, quality: 0.6, base64: true,
      allowsEditing: true, aspect: [1, 1],
    });
    if (res.canceled || !res.assets?.[0]?.base64) return;
    setPendingImg(`data:image/png;base64,${res.assets[0].base64}`);
  };

  const upload = async () => {
    const c = code.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!c || !pendingImg) return;
    setBusy(true);
    try {
      await api.createCustomEmoji(c, pendingImg);
      setPendingImg(null); setCode("");
      onChanged();
    } catch (e: any) {
      Alert.alert("Couldn't add emoji", e?.message || "Try a different shortcode.");
    } finally { setBusy(false); }
  };

  const remove = async (em: CustomEmoji) => {
    try { await api.deleteCustomEmoji(em.id); onChanged(); } catch {}
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.handle} />
          <Text style={styles.title}>Custom emojis</Text>

          {/* Upload row */}
          <View style={styles.uploadRow}>
            <TouchableOpacity style={styles.imgPick} onPress={pickImage} testID="emoji-pick-image">
              {pendingImg ? (
                <Image source={{ uri: pendingImg }} style={{ width: 40, height: 40 }} resizeMode="contain" />
              ) : (
                <Ionicons name="image" size={22} color={theme.primary} />
              )}
            </TouchableOpacity>
            <View style={styles.codeWrap}>
              <Text style={styles.colon}>:</Text>
              <TextInput
                style={styles.codeInput}
                placeholder="shortcode"
                placeholderTextColor={theme.textMuted}
                value={code}
                onChangeText={(t) => setCode(t.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                autoCapitalize="none"
                maxLength={32}
                testID="emoji-code"
              />
              <Text style={styles.colon}>:</Text>
            </View>
            <TouchableOpacity
              style={[styles.addBtn, (!pendingImg || !code.trim() || busy) && { opacity: 0.5 }]}
              onPress={upload}
              disabled={!pendingImg || !code.trim() || busy}
              testID="emoji-upload"
            >
              {busy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.addBtnText}>Add</Text>}
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.grid}>
            {emojis.length === 0 ? (
              <Text style={styles.empty}>No custom emojis yet. Upload one above, then use it as :shortcode: in chat.</Text>
            ) : emojis.map((em) => (
              <TouchableOpacity
                key={em.id}
                style={styles.emojiCell}
                onPress={() => { onPick(em.shortcode); onClose(); }}
                onLongPress={() => em.owner_id === myUserId && remove(em)}
                testID={`emoji-${em.shortcode}`}
              >
                <Image source={{ uri: em.image_base64 }} style={{ width: 34, height: 34 }} resizeMode="contain" />
                <Text style={styles.emojiCode} numberOfLines={1}>:{em.shortcode}:</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          {emojis.some((e) => e.owner_id === myUserId) && (
            <Text style={styles.hint}>Long-press your own emoji to delete it.</Text>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#0E0E10", borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingTop: 12, paddingHorizontal: 18, maxHeight: "75%",
    borderTopWidth: 1, borderColor: theme.border,
  },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 14 },
  title: { color: theme.textPrimary, fontSize: 18, fontWeight: "800", marginBottom: 12 },
  uploadRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 14 },
  imgPick: {
    width: 50, height: 50, borderRadius: 12, alignItems: "center", justifyContent: "center",
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderStyle: "dashed",
  },
  codeWrap: {
    flex: 1, flexDirection: "row", alignItems: "center",
    backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 10, height: 46,
  },
  colon: { color: theme.textMuted, fontSize: 16, fontWeight: "800" },
  codeInput: { flex: 1, color: theme.textPrimary, fontSize: 15, paddingHorizontal: 4, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  addBtn: { backgroundColor: theme.primary, borderRadius: 12, paddingHorizontal: 16, height: 46, alignItems: "center", justifyContent: "center" },
  addBtnText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingBottom: 8 },
  emojiCell: { width: 64, alignItems: "center", gap: 3, paddingVertical: 6 },
  emojiCode: { color: theme.textMuted, fontSize: 9.5 },
  empty: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingVertical: 24, paddingHorizontal: 20 },
  hint: { color: theme.textMuted, fontSize: 11, textAlign: "center", marginTop: 6 },
});
