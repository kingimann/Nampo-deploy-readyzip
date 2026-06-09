import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const daysInMonth = (y: number, m1: number) => new Date(y, m1, 0).getDate();

/** A dependency-free date picker (Month / Day / Year columns) → YYYY-MM-DD. */
export default function DatePickerField({
  value, onChange, placeholder, testID,
}: { value: string; onChange: (iso: string) => void; placeholder?: string; testID?: string }) {
  const now = new Date();
  const years = useMemo(() => {
    const out: number[] = [];
    for (let y = now.getFullYear() + 10; y >= now.getFullYear() - 100; y--) out.push(y);
    return out;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(parsed ? +parsed[1] : now.getFullYear());
  const [month, setMonth] = useState(parsed ? +parsed[2] : now.getMonth() + 1);
  const [day, setDay] = useState(parsed ? +parsed[3] : now.getDate());
  const days = useMemo(() => Array.from({ length: daysInMonth(year, month) }, (_, i) => i + 1), [year, month]);
  // Keep the selected day valid (and visibly highlighted) when month/year change
  // e.g. Jan 31 → Feb should snap to Feb 28/29, not leave 31 selected-but-hidden.
  useEffect(() => {
    const max = daysInMonth(year, month);
    if (day > max) setDay(max);
  }, [year, month]); // eslint-disable-line react-hooks/exhaustive-deps

  const confirm = () => {
    const d = Math.min(day, daysInMonth(year, month));
    onChange(`${year}-${pad(month)}-${pad(d)}`);
    setOpen(false);
  };

  return (
    <>
      <TouchableOpacity style={styles.field} onPress={() => setOpen(true)} testID={testID}>
        <Ionicons name="calendar-outline" size={18} color={theme.textMuted} />
        <Text style={[styles.fieldText, !value && { color: theme.textMuted }]}>{value || placeholder || "Select a date"}</Text>
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={styles.card}>
            <Text style={styles.title}>Select date</Text>
            <View style={styles.cols}>
              <Col data={MONTHS.map((m, i) => ({ label: m, val: i + 1 }))} sel={month} onSel={setMonth} />
              <Col data={days.map((d) => ({ label: String(d), val: d }))} sel={day} onSel={setDay} />
              <Col data={years.map((y) => ({ label: String(y), val: y }))} sel={year} onSel={setYear} />
            </View>
            <TouchableOpacity style={styles.done} onPress={confirm} testID="datepicker-done">
              <Text style={styles.doneText}>Done</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

function Col({ data, sel, onSel }: { data: { label: string; val: number }[]; sel: number; onSel: (v: number) => void }) {
  return (
    <ScrollView style={styles.col} showsVerticalScrollIndicator={false}>
      {data.map((d) => (
        <TouchableOpacity key={d.val} style={[styles.opt, sel === d.val && styles.optOn]} onPress={() => onSel(d.val)}>
          <Text style={[styles.optText, sel === d.val && { color: "#fff", fontWeight: "800" }]}>{d.label}</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  field: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13 },
  fieldText: { color: theme.textPrimary, fontSize: 14.5 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  card: { backgroundColor: theme.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, borderColor: theme.border, padding: 18, paddingBottom: 30 },
  title: { color: theme.textPrimary, fontSize: 16, fontWeight: "800", textAlign: "center", marginBottom: 12 },
  cols: { flexDirection: "row", gap: 10, height: 200 },
  col: { flex: 1, backgroundColor: theme.surfaceAlt, borderRadius: 12 },
  opt: { paddingVertical: 11, alignItems: "center" },
  optOn: { backgroundColor: theme.primary, borderRadius: 8 },
  optText: { color: theme.textPrimary, fontSize: 15 },
  done: { backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 16 },
  doneText: { color: "#fff", fontWeight: "800", fontSize: 15 },
});
