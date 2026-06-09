import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, Modal, ScrollView, TextInput, TouchableOpacity, ActivityIndicator, Linking, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { api, Factcheck } from "@/src/api/client";
import { useKeyboardHeight } from "@/src/hooks/useKeyboardHeight";
import { theme } from "@/src/theme";

const webInput = Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {};

// Optimistic local update of a note's counts when the viewer rates it.
function applyRate(n: Factcheck, next: boolean | null): Factcheck {
  let h = n.helpful_count, nh = n.not_helpful_count;
  if (n.my_rating === true) h--;
  if (n.my_rating === false) nh--;
  if (next === true) h++;
  if (next === false) nh++;
  return { ...n, my_rating: next, helpful_count: Math.max(0, h), not_helpful_count: Math.max(0, nh) };
}

/** Community notes ("Factcheck") on a post: view, rate, and add (source required). */
export default function FactcheckSheet({ visible, postId, onClose, onChanged }: {
  visible: boolean; postId: string; onClose: () => void; onChanged?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const kb = useKeyboardHeight();
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<Factcheck[]>([]);
  const [threshold, setThreshold] = useState(3);
  const [showForm, setShowForm] = useState(false);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.listFactchecks(postId);
      setNotes(r.factchecks || []);
      setThreshold(r.threshold || 3);
    } catch {} finally { setLoading(false); }
  }, [postId]);

  useEffect(() => {
    if (!visible) return;
    setLoading(true); setShowForm(false); setText(""); setUrl(""); setErr(null);
    load();
  }, [visible, load]);

  const rate = async (n: Factcheck, helpful: boolean) => {
    const next = n.my_rating === helpful ? null : helpful;
    setNotes((arr) => arr.map((x) => (x.id === n.id ? applyRate(x, next) : x)));
    try { await api.rateFactcheck(n.id, next); await load(); onChanged?.(); } catch { load(); }
  };

  const submit = async () => {
    setErr(null);
    if (!text.trim()) { setErr("Add the note text."); return; }
    if (!/^https?:\/\//i.test(url.trim())) { setErr("Add a valid source link (https://…)."); return; }
    setAdding(true);
    try {
      await api.addFactcheck(postId, text.trim(), url.trim());
      setText(""); setUrl(""); setShowForm(false); await load(); onChanged?.();
    } catch (e: any) {
      setErr(String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setAdding(false); }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 14, marginBottom: kb }]}>
          <View style={styles.handle} />
          <View style={styles.titleRow}>
            <Ionicons name="shield-checkmark" size={18} color={theme.primary} />
            <Text style={styles.title}>Factcheck</Text>
          </View>
          <Text style={styles.sub}>Community notes add context. A note shows publicly once {threshold} people rate it helpful.</Text>

          {loading ? (
            <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
          ) : (
            <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {notes.length === 0 && <Text style={styles.empty}>No notes yet. Add context if you can cite a source.</Text>}
              {notes.map((n) => (
                <View key={n.id} style={styles.note}>
                  <View style={styles.noteTop}>
                    <Text style={styles.noteAuthor} numberOfLines={1}>{n.author_name}</Text>
                    {n.status === "shown" ? (
                      <View style={styles.shownPill}><Text style={styles.shownPillText}>Showing</Text></View>
                    ) : (
                      <View style={styles.pendingPill}><Text style={styles.pendingPillText}>Pending</Text></View>
                    )}
                  </View>
                  <Text style={styles.noteText}>{n.text}</Text>
                  {!!n.source_url && (
                    <TouchableOpacity onPress={() => Linking.openURL(n.source_url).catch(() => {})}>
                      <Text style={styles.noteSource} numberOfLines={1}>🔗 {n.source_url}</Text>
                    </TouchableOpacity>
                  )}
                  <View style={styles.rateRow}>
                    <TouchableOpacity style={[styles.rateBtn, n.my_rating === true && styles.rateOn]} onPress={() => rate(n, true)}>
                      <Ionicons name="thumbs-up" size={14} color={n.my_rating === true ? "#fff" : theme.textSecondary} />
                      <Text style={[styles.rateText, n.my_rating === true && { color: "#fff" }]}>Helpful · {n.helpful_count}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.rateBtn, n.my_rating === false && styles.rateOnBad]} onPress={() => rate(n, false)}>
                      <Ionicons name="thumbs-down" size={14} color={n.my_rating === false ? "#fff" : theme.textSecondary} />
                      <Text style={[styles.rateText, n.my_rating === false && { color: "#fff" }]}>Not helpful · {n.not_helpful_count}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </ScrollView>
          )}

          {showForm ? (
            <View style={styles.form}>
              <TextInput style={[styles.input, styles.area, webInput]} value={text} onChangeText={setText} placeholder="Add context people should know…" placeholderTextColor={theme.textMuted} multiline />
              <TextInput style={[styles.input, webInput]} value={url} onChangeText={setUrl} placeholder="Source link (https://…)" placeholderTextColor={theme.textMuted} autoCapitalize="none" keyboardType="url" />
              {!!err && <Text style={styles.err}>{err}</Text>}
              <TouchableOpacity style={[styles.submit, adding && { opacity: 0.6 }]} onPress={submit} disabled={adding} testID="factcheck-submit">
                {adding ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Submit note</Text>}
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={styles.addBtn} onPress={() => setShowForm(true)} testID="factcheck-add">
              <Ionicons name="add" size={18} color={theme.primary} />
              <Text style={styles.addText}>Add a Factcheck note</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: theme.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, borderColor: theme.border, paddingTop: 10, paddingHorizontal: 16 },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 12 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, marginBottom: 4 },
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  sub: { color: theme.textMuted, fontSize: 12.5, lineHeight: 17, textAlign: "center", marginBottom: 12 },
  center: { paddingVertical: 30, alignItems: "center" },
  empty: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingVertical: 22 },
  note: { backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12, marginBottom: 10 },
  noteTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  noteAuthor: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "700", flex: 1 },
  shownPill: { backgroundColor: theme.primary, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  shownPillText: { color: "#fff", fontSize: 10.5, fontWeight: "800" },
  pendingPill: { backgroundColor: theme.surfaceAlt, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  pendingPillText: { color: theme.textMuted, fontSize: 10.5, fontWeight: "800" },
  noteText: { color: theme.textPrimary, fontSize: 14, lineHeight: 19 },
  noteSource: { color: theme.primary, fontSize: 12.5, marginTop: 6 },
  rateRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  rateBtn: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: theme.surfaceAlt, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  rateOn: { backgroundColor: theme.primary },
  rateOnBad: { backgroundColor: theme.error },
  rateText: { color: theme.textSecondary, fontSize: 12, fontWeight: "700" },
  form: { marginTop: 8 },
  input: { backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, paddingVertical: 12, color: theme.textPrimary, fontSize: 14.5, marginBottom: 10 },
  area: { minHeight: 70, textAlignVertical: "top" },
  err: { color: theme.error, fontSize: 12.5, marginBottom: 8 },
  submit: { backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 13, alignItems: "center" },
  submitText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  addBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 13, marginTop: 6, borderWidth: 1, borderColor: theme.border, borderRadius: 12 },
  addText: { color: theme.primary, fontSize: 14.5, fontWeight: "800" },
});
