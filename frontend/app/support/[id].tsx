import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator,
  Platform, KeyboardAvoidingView,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, SupportTicket } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import { statusMeta, fmtAgo } from "@/app/support";

export default function TicketScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const staff = user?.role === "admin" || user?.role === "mod";
  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try { setTicket(await api.getTicket(String(id))); } catch {} finally { setLoading(false); }
  }, [id]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try { setTicket(await api.replyTicket(String(id), body)); setText(""); }
    catch {} finally { setSending(false); }
  };
  const setStatus = async (s: string) => {
    try { setTicket(await api.setTicketStatus(String(id), s)); } catch {}
  };

  const m = ticket ? statusMeta(ticket.status) : null;
  const closed = ticket?.status === "closed" || ticket?.status === "resolved";

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="ticket-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack("/support")} style={styles.iconBtn} testID="ticket-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{ticket?.subject || "Ticket"}</Text>
          {!!m && <Text style={[styles.headStatus, { color: m.color }]}>{m.label}{staff && ticket?.user ? ` · ${ticket.user.name}` : ""}</Text>}
        </View>
      </View>

      {loading || !ticket ? (
        <View style={styles.center}>{loading ? <ActivityIndicator color={theme.primary} /> : <Text style={styles.emptyText}>Ticket not found.</Text>}</View>
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 16 }} keyboardShouldPersistTaps="handled">
            {(ticket.messages || []).map((msg) => {
              const mine = msg.sender_id === user?.user_id;
              return (
                <View key={msg.id} style={[styles.bubbleRow, mine ? styles.rowMine : styles.rowOther]}>
                  <View style={[styles.bubble, mine ? styles.bubbleMine : (msg.is_staff ? styles.bubbleStaff : styles.bubbleOther)]}>
                    {msg.is_staff && !mine && <Text style={styles.staffTag}>Support</Text>}
                    <Text style={[styles.bubbleText, mine && { color: "#fff" }]}>{msg.text}</Text>
                    <Text style={[styles.bubbleTime, mine && { color: "rgba(255,255,255,0.7)" }]}>{fmtAgo(msg.created_at)}</Text>
                  </View>
                </View>
              );
            })}
            {/* Status controls */}
            <View style={styles.statusRow}>
              {staff ? (
                <>
                  <TouchableOpacity style={styles.statusBtn} onPress={() => setStatus("resolved")} testID="ticket-resolve">
                    <Ionicons name="checkmark-circle-outline" size={15} color={theme.success} />
                    <Text style={[styles.statusBtnText, { color: theme.success }]}>Mark resolved</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.statusBtn} onPress={() => setStatus("closed")} testID="ticket-close">
                    <Ionicons name="lock-closed-outline" size={15} color={theme.textMuted} />
                    <Text style={[styles.statusBtnText, { color: theme.textMuted }]}>Close</Text>
                  </TouchableOpacity>
                </>
              ) : !closed ? (
                <TouchableOpacity style={styles.statusBtn} onPress={() => setStatus("closed")} testID="ticket-user-close">
                  <Ionicons name="checkmark-done-outline" size={15} color={theme.textMuted} />
                  <Text style={[styles.statusBtnText, { color: theme.textMuted }]}>Close this ticket</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={styles.statusBtn} onPress={() => setStatus("open")} testID="ticket-reopen">
                  <Ionicons name="refresh-outline" size={15} color={theme.primary} />
                  <Text style={[styles.statusBtnText, { color: theme.primary }]}>Reopen</Text>
                </TouchableOpacity>
              )}
            </View>
          </ScrollView>

          <View style={[styles.inputRow, { paddingBottom: insets.bottom + 8 }]}>
            <TextInput
              style={styles.input}
              placeholder={closed ? "Reopen to reply…" : "Write a reply…"}
              placeholderTextColor={theme.textMuted}
              value={text}
              onChangeText={setText}
              editable={!closed || staff}
              multiline
              testID="ticket-reply"
            />
            <TouchableOpacity onPress={send} disabled={!text.trim() || sending} style={[styles.sendBtn, (!text.trim() || sending) && { opacity: 0.4 }]} testID="ticket-send">
              {sending ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="arrow-up" size={18} color="#fff" />}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  headStatus: { fontSize: 12, fontWeight: "700", marginTop: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyText: { color: theme.textMuted, fontSize: 14 },
  bubbleRow: { flexDirection: "row" },
  rowMine: { justifyContent: "flex-end" },
  rowOther: { justifyContent: "flex-start" },
  bubble: { maxWidth: "82%", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleMine: { backgroundColor: theme.primary, borderBottomRightRadius: 4 },
  bubbleStaff: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.primary, borderBottomLeftRadius: 4 },
  bubbleOther: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderBottomLeftRadius: 4 },
  staffTag: { color: theme.primary, fontSize: 11, fontWeight: "800", marginBottom: 3 },
  bubbleText: { color: theme.textPrimary, fontSize: 14.5, lineHeight: 20 },
  bubbleTime: { color: theme.textMuted, fontSize: 10.5, marginTop: 4, alignSelf: "flex-end" },
  statusRow: { flexDirection: "row", gap: 10, justifyContent: "center", marginTop: 6 },
  statusBtn: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: theme.surface, borderRadius: 999, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 12, paddingVertical: 7 },
  statusBtnText: { fontSize: 12.5, fontWeight: "700" },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 10, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  input: { flex: 1, color: theme.textPrimary, fontSize: 14.5, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9, maxHeight: 110, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  sendBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
});
