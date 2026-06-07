import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, FormField } from "@/src/api/client";
import { theme } from "@/src/theme";

type PublicForm = { id: string; title: string; description?: string | null; submit_label?: string; fields: FormField[] };

export default function PublicFormScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const insets = useSafeAreaInsets();
  const [form, setForm] = useState<PublicForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<Record<string, any>>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!key) return;
    try { setForm(await api.publicForm(String(key))); } catch { setForm(null); } finally { setLoading(false); }
  }, [key]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const fid = (f: FormField, i: number) => f.id || `f${i + 1}`;
  const setVal = (k: string, v: any) => setValues((s) => ({ ...s, [k]: v }));
  const toggleCheck = (k: string, opt: string) => setValues((s) => {
    const arr: string[] = Array.isArray(s[k]) ? s[k] : [];
    return { ...s, [k]: arr.includes(opt) ? arr.filter((x) => x !== opt) : [...arr, opt] };
  });

  const submit = async () => {
    if (!form || submitting) return;
    for (let i = 0; i < form.fields.length; i++) {
      const f = form.fields[i]; const k = fid(f, i); const v = values[k];
      const empty = f.type === "checkbox" ? !(Array.isArray(v) && v.length) : !String(v ?? "").trim();
      if (f.required && empty) { setErr(`${f.label || "A field"} is required.`); return; }
    }
    setErr(null); setSubmitting(true);
    try {
      const r = await api.submitPublicForm(String(key), values);
      if (r.ok) setDone(true); else setErr("Couldn't submit. Try again.");
    } catch (e: any) { setErr(String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setSubmitting(false); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="public-form-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="pf-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{form?.title || "Form"}</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : !form ? (
        <View style={styles.center}><Text style={styles.muted}>This form is unavailable.</Text></View>
      ) : done ? (
        <View style={styles.center}>
          <Ionicons name="checkmark-circle" size={52} color={theme.primary} />
          <Text style={styles.doneTitle}>Thank you!</Text>
          <Text style={styles.muted}>Your response was submitted.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>{form.title}</Text>
          {!!form.description && <Text style={styles.desc}>{form.description}</Text>}

          {form.fields.map((f, i) => {
            const k = fid(f, i);
            const req = f.required ? <Text style={styles.req}> *</Text> : null;
            return (
              <View key={k} style={{ marginTop: 16 }}>
                <Text style={styles.label}>{f.label}{req}</Text>
                {f.type === "textarea" ? (
                  <TextInput style={[styles.input, styles.area]} value={values[k] || ""} onChangeText={(t) => setVal(k, t)} placeholder={f.placeholder || ""} placeholderTextColor={theme.textMuted} multiline testID={`pf-${k}`} />
                ) : f.type === "select" ? (
                  <View style={styles.optWrap}>
                    {(f.options || []).map((o) => {
                      const on = values[k] === o;
                      return (
                        <TouchableOpacity key={o} style={[styles.chip, on && styles.chipOn]} onPress={() => setVal(k, o)} testID={`pf-${k}-${o}`}>
                          <Text style={[styles.chipText, on && { color: "#fff" }]}>{o}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ) : f.type === "radio" ? (
                  (f.options || []).map((o) => (
                    <TouchableOpacity key={o} style={styles.optRow} onPress={() => setVal(k, o)} testID={`pf-${k}-${o}`}>
                      <Ionicons name={values[k] === o ? "radio-button-on" : "radio-button-off"} size={20} color={values[k] === o ? theme.primary : theme.textMuted} />
                      <Text style={styles.optText}>{o}</Text>
                    </TouchableOpacity>
                  ))
                ) : f.type === "checkbox" ? (
                  (f.options || []).map((o) => {
                    const on = Array.isArray(values[k]) && values[k].includes(o);
                    return (
                      <TouchableOpacity key={o} style={styles.optRow} onPress={() => toggleCheck(k, o)} testID={`pf-${k}-${o}`}>
                        <Ionicons name={on ? "checkbox" : "square-outline"} size={20} color={on ? theme.primary : theme.textMuted} />
                        <Text style={styles.optText}>{o}</Text>
                      </TouchableOpacity>
                    );
                  })
                ) : (
                  <TextInput
                    style={styles.input}
                    value={values[k] || ""}
                    onChangeText={(t) => setVal(k, t)}
                    placeholder={f.placeholder || (f.type === "date" ? "YYYY-MM-DD" : "")}
                    placeholderTextColor={theme.textMuted}
                    keyboardType={f.type === "email" ? "email-address" : f.type === "phone" ? "phone-pad" : f.type === "number" ? "number-pad" : "default"}
                    autoCapitalize={f.type === "email" ? "none" : "sentences"}
                    testID={`pf-${k}`}
                  />
                )}
              </View>
            );
          })}

          {!!err && <Text style={styles.err}>{err}</Text>}
          <TouchableOpacity style={[styles.submit, submitting && { opacity: 0.6 }]} onPress={submit} disabled={submitting} testID="pf-submit">
            {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>{form.submit_label || "Submit"}</Text>}
          </TouchableOpacity>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 6, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, color: theme.textPrimary, fontSize: 16, fontWeight: "700", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 28 },
  muted: { color: theme.textMuted, fontSize: 14, textAlign: "center" },
  doneTitle: { color: theme.textPrimary, fontSize: 20, fontWeight: "800", marginTop: 4 },
  title: { color: theme.textPrimary, fontSize: 22, fontWeight: "900", letterSpacing: -0.4 },
  desc: { color: theme.textSecondary, fontSize: 14, lineHeight: 20, marginTop: 6 },
  label: { color: theme.textSecondary, fontSize: 13, fontWeight: "700", marginBottom: 7 },
  req: { color: theme.error },
  input: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: theme.textPrimary, fontSize: 14.5, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  area: { minHeight: 100, textAlignVertical: "top" },
  optWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  chipOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  chipText: { color: theme.textPrimary, fontSize: 13.5, fontWeight: "700" },
  optRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  optText: { color: theme.textPrimary, fontSize: 15, flex: 1 },
  err: { color: theme.error, fontSize: 13.5, marginTop: 14, fontWeight: "600" },
  submit: { backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 20 },
  submitText: { color: "#fff", fontWeight: "800", fontSize: 15 },
});
