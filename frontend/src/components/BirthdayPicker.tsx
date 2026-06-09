import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";
import { MONTHS, fmtBirthday } from "@/src/lib/socials";

const pad = (n: number) => String(n).padStart(2, "0");
const daysInMonth = (year: number, month1: number) => new Date(year, month1, 0).getDate();

/**
 * Birthday picker: the user chooses Month / Day / Year from columns — no manual
 * text entry. Emits a YYYY-MM-DD string (or "" when never set).
 */
export default function BirthdayPicker({
  value, onChange, testID,
}: { value: string; onChange: (iso: string) => void; testID?: string }) {
  const now = new Date();
  const maxYear = now.getFullYear() - 13;     // minimum age 13
  const minYear = now.getFullYear() - 100;
  const years = useMemo(() => {
    const out: number[] = [];
    for (let y = maxYear; y >= minYear; y--) out.push(y);
    return out;
  }, [maxYear, minYear]);

  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(parsed ? Number(parsed[1]) : maxYear - 5);
  const [month, setMonth] = useState(parsed ? Number(parsed[2]) : 1);
  const [day, setDay] = useState(parsed ? Number(parsed[3]) : 1);

  const dim = daysInMonth(year, month);
  const days = useMemo(() => Array.from({ length: dim }, (_, i) => i + 1), [dim]);
  const safeDay = Math.min(day, dim);

  const confirm = () => {
    onChange(`${year}-${pad(month)}-${pad(safeDay)}`);
    setOpen(false);
  };

  return (
    <>
      <TouchableOpacity style={styles.field} onPress={() => setOpen(true)} testID={testID}>
        <Ionicons name="gift-outline" size={16} color={theme.textMuted} />
        <Text style={[styles.fieldText, !value && { color: theme.textMuted }]}>
          {value ? fmtBirthday(value) : "Choose your birthday"}
        </Text>
        {!!value && (
          <TouchableOpacity onPress={() => onChange("")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} testID="birthday-clear">
            <Ionicons name="close-circle" size={18} color={theme.textMuted} />
          </TouchableOpacity>
        )}
        <Ionicons name="chevron-down" size={18} color={theme.textMuted} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={styles.card} onStartShouldSetResponder={() => true}>
            <Text style={styles.title}>Your birthday</Text>
            <View style={styles.cols}>
              <Col label="Month">
                {MONTHS.map((m, i) => (
                  <Opt key={m} active={month === i + 1} onPress={() => setMonth(i + 1)} text={m} testID={`bd-month-${i + 1}`} />
                ))}
              </Col>
              <Col label="Day">
                {days.map((d) => (
                  <Opt key={d} active={safeDay === d} onPress={() => setDay(d)} text={String(d)} testID={`bd-day-${d}`} />
                ))}
              </Col>
              <Col label="Year">
                {years.map((y) => (
                  <Opt key={y} active={year === y} onPress={() => setYear(y)} text={String(y)} testID={`bd-year-${y}`} />
                ))}
              </Col>
            </View>
            <TouchableOpacity style={styles.doneBtn} onPress={confirm} testID="birthday-done">
              <Text style={styles.doneText}>Done</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

function Col({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.col}>
      <Text style={styles.colLabel}>{label}</Text>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 4 }}>
        {children}
      </ScrollView>
    </View>
  );
}

function Opt({ active, onPress, text, testID }: { active: boolean; onPress: () => void; text: string; testID?: string }) {
  return (
    <TouchableOpacity style={[styles.opt, active && styles.optActive]} onPress={onPress} testID={testID}>
      <Text style={[styles.optText, active && styles.optTextActive]} numberOfLines={1}>{text}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  field: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, height: 50 },
  fieldText: { flex: 1, color: theme.textPrimary, fontSize: 15 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", paddingHorizontal: 22 },
  card: { width: "100%", maxWidth: 420, backgroundColor: theme.surface, borderRadius: 18, borderWidth: 1, borderColor: theme.border, padding: 16 },
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "800", marginBottom: 12, textAlign: "center" },
  cols: { flexDirection: "row", gap: 10, height: 240 },
  col: { flex: 1, backgroundColor: theme.bg, borderRadius: 12, borderWidth: 1, borderColor: theme.border, overflow: "hidden" },
  colLabel: { color: theme.textMuted, fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4, textAlign: "center", paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  opt: { paddingVertical: 11, paddingHorizontal: 6, alignItems: "center", borderRadius: 8, marginHorizontal: 4 },
  optActive: { backgroundColor: theme.primary },
  optText: { color: theme.textSecondary, fontSize: 14, fontWeight: "600" },
  optTextActive: { color: "#fff", fontWeight: "800" },
  doneBtn: { marginTop: 14, backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 13, alignItems: "center" },
  doneText: { color: "#fff", fontSize: 15, fontWeight: "800" },
});
