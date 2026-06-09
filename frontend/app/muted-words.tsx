import React, { useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

/**
 * Feed content filters — manage muted keywords/topics. Any post whose text or
 * hashtags match a muted word is hidden from your Home and Explore feeds.
 */
export default function MutedWordsScreen() {
  const insets = useSafeAreaInsets();
  const { user, refresh } = useAuth() as any;
  const [words, setWords] = useState<string[]>(Array.isArray(user?.muted_keywords) ? user.muted_keywords : []);
  const [boost, setBoost] = useState<string[]>(Array.isArray(user?.boost_keywords) ? user.boost_keywords : []);
  const [input, setInput] = useState("");
  const [boostInput, setBoostInput] = useState("");
  const [saving, setSaving] = useState(false);

  const persist = async (patch: { muted_keywords?: string[]; boost_keywords?: string[] }) => {
    if (patch.muted_keywords) setWords(patch.muted_keywords);
    if (patch.boost_keywords) setBoost(patch.boost_keywords);
    setSaving(true);
    try { await api.updateMe(patch); if (typeof refresh === "function") await refresh(); }
    catch {} finally { setSaving(false); }
  };

  const add = () => {
    const t = input.trim().toLowerCase();
    if (!t) return;
    if (!words.includes(t)) persist({ muted_keywords: [t, ...words].slice(0, 200) });
    setInput("");
  };
  const remove = (w: string) => persist({ muted_keywords: words.filter((x) => x !== w) });

  const addBoost = () => {
    const t = boostInput.trim().toLowerCase();
    if (!t) return;
    if (!boost.includes(t)) persist({ boost_keywords: [t, ...boost].slice(0, 200) });
    setBoostInput("");
  };
  const removeBoost = (w: string) => persist({ boost_keywords: boost.filter((x) => x !== w) });

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="muted-words-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn} testID="muted-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Feed controls</Text>
        <View style={{ width: 40, alignItems: "center" }}>{saving && <ActivityIndicator size="small" color={theme.primary} />}</View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
        <Text style={styles.note}>
          Shape your Home and Explore feeds. Mute words to hide matching posts; prioritize words
          to surface those topics higher. Matching is case-insensitive and matches whole words
          (so "art" won't hide "start").
        </Text>

        <Text style={styles.heading}>Mute — hide these</Text>
        <View style={styles.addRow}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            onSubmitEditing={add}
            placeholder="Add a word or #hashtag…"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            maxLength={60}
            testID="muted-input"
          />
          <TouchableOpacity style={[styles.addBtn, !input.trim() && { opacity: 0.5 }]} onPress={add} disabled={!input.trim()} testID="muted-add">
            <Ionicons name="add" size={22} color="#fff" />
          </TouchableOpacity>
        </View>

        {words.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="filter-outline" size={40} color={theme.textMuted} />
            <Text style={styles.emptyText}>No muted words yet. Add a topic, team, show, or phrase you'd rather not see.</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {words.map((w) => (
              <View key={w} style={styles.chipRow}>
                <Ionicons name="ban-outline" size={16} color={theme.textMuted} />
                <Text style={styles.chipText} numberOfLines={1}>{w}</Text>
                <TouchableOpacity onPress={() => remove(w)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} testID={`muted-remove-${w}`}>
                  <Ionicons name="close-circle" size={20} color={theme.textMuted} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        <Text style={[styles.heading, { marginTop: 28 }]}>Prioritize — show more of these</Text>
        <View style={styles.addRow}>
          <TextInput
            style={styles.input}
            value={boostInput}
            onChangeText={setBoostInput}
            onSubmitEditing={addBoost}
            placeholder="Add a topic to see more of…"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            maxLength={60}
            testID="boost-input"
          />
          <TouchableOpacity style={[styles.addBtn, !boostInput.trim() && { opacity: 0.5 }]} onPress={addBoost} disabled={!boostInput.trim()} testID="boost-add">
            <Ionicons name="add" size={22} color="#fff" />
          </TouchableOpacity>
        </View>
        {boost.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="trending-up-outline" size={40} color={theme.textMuted} />
            <Text style={styles.emptyText}>Nothing prioritized yet. Add topics, teams, or hashtags you want to see more of.</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {boost.map((w) => (
              <View key={w} style={styles.chipRow}>
                <Ionicons name="trending-up" size={16} color={theme.primary} />
                <Text style={styles.chipText} numberOfLines={1}>{w}</Text>
                <TouchableOpacity onPress={() => removeBoost(w)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} testID={`boost-remove-${w}`}>
                  <Ionicons name="close-circle" size={20} color={theme.textMuted} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  backBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  note: { color: theme.textSecondary, fontSize: 13, lineHeight: 19, marginBottom: 16 },
  heading: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 },
  addRow: { flexDirection: "row", gap: 10, marginBottom: 18 },
  input: {
    flex: 1, backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border,
    color: theme.textPrimary, fontSize: 15, paddingHorizontal: 14, paddingVertical: 12,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  addBtn: { width: 48, borderRadius: 12, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  list: { gap: 8 },
  chipRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, paddingVertical: 12 },
  chipText: { flex: 1, color: theme.textPrimary, fontSize: 15, fontWeight: "600" },
  empty: { alignItems: "center", gap: 12, paddingVertical: 50 },
  emptyText: { color: theme.textMuted, fontSize: 13.5, textAlign: "center", paddingHorizontal: 30, lineHeight: 19 },
});
