import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator,
  Modal, Platform, KeyboardAvoidingView,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, SupportTicket } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

const CATEGORIES: { k: string; label: string; icon: any }[] = [
  { k: "dispute", label: "Dispute a payment / transaction", icon: "card-outline" },
  { k: "payment", label: "Billing & payouts", icon: "cash-outline" },
  { k: "account", label: "Account & login", icon: "person-outline" },
  { k: "content", label: "Report content / user", icon: "flag-outline" },
  { k: "safety", label: "Safety concern", icon: "shield-outline" },
  { k: "bug", label: "Something's broken", icon: "bug-outline" },
  { k: "other", label: "Something else", icon: "help-circle-outline" },
];

export function statusMeta(s: string): { label: string; color: string } {
  switch (s) {
    case "awaiting_staff": return { label: "Open", color: theme.warning };
    case "awaiting_user": return { label: "Reply needed", color: theme.primary };
    case "open": return { label: "Open", color: theme.warning };
    case "resolved": return { label: "Resolved", color: theme.success };
    case "closed": return { label: "Closed", color: theme.textMuted };
    default: return { label: s, color: theme.textMuted };
  }
}

export function fmtAgo(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso); const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return d.toLocaleDateString();
}

export default function SupportScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [composeOpen, setComposeOpen] = useState(false);
  const [category, setCategory] = useState("dispute");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setTickets(await api.myTickets()); } catch {} finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const submit = async () => {
    setErr(null);
    if (!subject.trim() || !message.trim()) { setErr("Add a subject and describe the issue."); return; }
    setSending(true);
    try {
      const t = await api.createTicket({ category, subject: subject.trim(), message: message.trim() });
      setComposeOpen(false); setSubject(""); setMessage(""); setCategory("dispute");
      router.push({ pathname: "/support/[id]", params: { id: t.id } });
    } catch (e: any) {
      setErr(String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setSending(false); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="support-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="support-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Support</Text>
        {user?.role === "admin" || user?.role === "mod" ? (
          <TouchableOpacity onPress={() => router.push("/admin-support")} testID="support-admin">
            <Text style={styles.adminLink}>Inbox</Text>
          </TouchableOpacity>
        ) : <View style={{ width: 40 }} />}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 90 }}>
          <Text style={styles.intro}>
            Need help or want to dispute a charge or transaction? Open a ticket and our team will reply here.
          </Text>
          {tickets.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="chatbox-ellipses-outline" size={40} color={theme.textMuted} />
              <Text style={styles.emptyText}>No tickets yet.</Text>
            </View>
          ) : (
            tickets.map((t) => {
              const m = statusMeta(t.status);
              const cat = CATEGORIES.find((c) => c.k === t.category);
              return (
                <TouchableOpacity
                  key={t.id}
                  style={styles.ticket}
                  onPress={() => router.push({ pathname: "/support/[id]", params: { id: t.id } })}
                  testID={`ticket-${t.id}`}
                >
                  <View style={[styles.catIcon, { backgroundColor: theme.primary + "1f" }]}>
                    <Ionicons name={(cat?.icon || "help-circle-outline") as any} size={18} color={theme.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.ticketSubject} numberOfLines={1}>{t.subject}</Text>
                    <Text style={styles.ticketMeta} numberOfLines={1}>{cat?.label || t.category} · {fmtAgo(t.last_message_at)}</Text>
                  </View>
                  {t.unread_for_user && <View style={styles.unreadDot} />}
                  <View style={[styles.statusPill, { backgroundColor: m.color + "22", borderColor: m.color }]}>
                    <Text style={[styles.statusText, { color: m.color }]}>{m.label}</Text>
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </ScrollView>
      )}

      <TouchableOpacity style={[styles.fab, { bottom: insets.bottom + 20 }]} onPress={() => setComposeOpen(true)} testID="support-new">
        <Ionicons name="add" size={22} color="#fff" />
        <Text style={styles.fabText}>New ticket</Text>
      </TouchableOpacity>

      <Modal visible={composeOpen} transparent animationType="slide" onRequestClose={() => setComposeOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalWrap}>
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setComposeOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>New ticket</Text>
              <TouchableOpacity onPress={() => setComposeOpen(false)}><Ionicons name="close" size={22} color={theme.textPrimary} /></TouchableOpacity>
            </View>
            <Text style={styles.label}>What's this about?</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
              {CATEGORIES.map((c) => {
                const on = category === c.k;
                return (
                  <TouchableOpacity key={c.k} onPress={() => setCategory(c.k)} style={[styles.catChip, on && styles.catChipOn]} testID={`cat-${c.k}`}>
                    <Ionicons name={c.icon} size={14} color={on ? "#fff" : theme.primary} />
                    <Text style={[styles.catChipText, on && { color: "#fff" }]}>{c.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TextInput style={styles.input} placeholder="Subject" placeholderTextColor={theme.textMuted} value={subject} onChangeText={setSubject} maxLength={140} testID="ticket-subject" />
            <TextInput style={[styles.input, styles.textarea]} placeholder="Describe the issue (include amounts, dates, IDs for disputes)…" placeholderTextColor={theme.textMuted} value={message} onChangeText={setMessage} multiline testID="ticket-message" />
            {!!err && <Text style={styles.err}>{err}</Text>}
            <TouchableOpacity style={[styles.submit, sending && { opacity: 0.5 }]} onPress={submit} disabled={sending} testID="ticket-submit">
              {sending ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Submit ticket</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  adminLink: { color: theme.primary, fontSize: 14, fontWeight: "800", paddingHorizontal: 8 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  intro: { color: theme.textSecondary, fontSize: 13.5, lineHeight: 20, marginBottom: 14 },
  empty: { alignItems: "center", paddingVertical: 50, gap: 10 },
  emptyText: { color: theme.textMuted, fontSize: 14 },
  ticket: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12, marginBottom: 10 },
  catIcon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  ticketSubject: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  ticketMeta: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  unreadDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: theme.primary },
  statusPill: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 4 },
  statusText: { fontSize: 11, fontWeight: "800" },
  fab: { position: "absolute", right: 18, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.primary, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 12, shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 10, elevation: 8 },
  fabText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  modalWrap: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: theme.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, borderColor: theme.border, padding: 18, gap: 10 },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sheetTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  label: { color: theme.textSecondary, fontSize: 13, fontWeight: "700", marginTop: 4 },
  catChip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.surface, borderRadius: 999, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 12, paddingVertical: 8 },
  catChipOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  catChipText: { color: theme.textPrimary, fontSize: 12.5, fontWeight: "700" },
  input: { color: theme.textPrimary, fontSize: 14.5, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  textarea: { minHeight: 110, textAlignVertical: "top" },
  err: { color: theme.error, fontSize: 13 },
  submit: { backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 4 },
  submitText: { color: "#fff", fontWeight: "800", fontSize: 15 },
});
