import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Modal, Platform, Switch,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, FormDef, FormField, FormFieldType, FormSubmission } from "@/src/api/client";
import { useConfirm } from "@/src/context/ConfirmContext";
import { theme } from "@/src/theme";

const FALLBACK_BACKEND = "https://nampo-backend.onrender.com";
function apiOrigin(): string {
  const env = (process.env.EXPO_PUBLIC_BACKEND_URL as string) || "";
  return (env || FALLBACK_BACKEND).replace(/\/$/, "");
}

const TYPES: { k: FormFieldType; label: string; icon: any }[] = [
  { k: "text", label: "Short text", icon: "text-outline" },
  { k: "textarea", label: "Paragraph", icon: "reorder-four-outline" },
  { k: "email", label: "Email", icon: "mail-outline" },
  { k: "phone", label: "Phone", icon: "call-outline" },
  { k: "number", label: "Number", icon: "calculator-outline" },
  { k: "date", label: "Date", icon: "calendar-outline" },
  { k: "select", label: "Dropdown", icon: "chevron-down-circle-outline" },
  { k: "radio", label: "Single choice", icon: "radio-button-on-outline" },
  { k: "checkbox", label: "Checkboxes", icon: "checkbox-outline" },
];
const typeLabel = (t: string) => TYPES.find((x) => x.k === t)?.label || t;
const hasOptions = (t: string) => t === "select" || t === "radio" || t === "checkbox";
const fmtDate = (iso: string) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };

export default function FormBuilderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const confirm = useConfirm();

  const [form, setForm] = useState<FormDef | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"build" | "share" | "responses">("build");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitLabel, setSubmitLabel] = useState("Submit");
  const [fields, setFields] = useState<FormField[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [typePicker, setTypePicker] = useState<number | null>(null);
  const [copied, setCopied] = useState("");

  const [subs, setSubs] = useState<FormSubmission[]>([]);
  const [subFields, setSubFields] = useState<FormField[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const f = await api.getForm(String(id));
      setForm(f); setTitle(f.title); setDescription(f.description || "");
      setSubmitLabel(f.submit_label || "Submit"); setFields(f.fields || []);
    } catch {} finally { setLoading(false); }
  }, [id]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const loadSubs = useCallback(async () => {
    if (!id) return;
    setSubsLoading(true);
    try { const r = await api.listFormSubmissions(String(id)); setSubs(r.submissions); setSubFields(r.fields || []); }
    catch {} finally { setSubsLoading(false); }
  }, [id]);

  const onTab = (t: "build" | "share" | "responses") => { setTab(t); if (t === "responses") loadSubs(); };

  const mark = () => setDirty(true);
  const patchField = (i: number, p: Partial<FormField>) => { setFields((a) => a.map((f, idx) => (idx === i ? { ...f, ...p } : f))); mark(); };
  const addField = () => { setFields((a) => [...a, { type: "text", label: "", required: false }]); mark(); };
  const removeField = (i: number) => { setFields((a) => a.filter((_, idx) => idx !== i)); mark(); };
  const moveField = (i: number, dir: -1 | 1) => {
    setFields((a) => { const b = [...a]; const j = i + dir; if (j < 0 || j >= b.length) return a; [b[i], b[j]] = [b[j], b[i]]; return b; }); mark();
  };
  const setOpt = (i: number, oi: number, v: string) => patchField(i, { options: (fields[i].options || []).map((o, k) => (k === oi ? v : o)) });
  const addOpt = (i: number) => patchField(i, { options: [...(fields[i].options || []), `Option ${(fields[i].options || []).length + 1}`] });
  const removeOpt = (i: number, oi: number) => patchField(i, { options: (fields[i].options || []).filter((_, k) => k !== oi) });

  const save = async () => {
    if (!form || saving) return;
    if (!title.trim()) return;
    setSaving(true);
    try {
      const f = await api.updateForm(form.id, {
        title: title.trim(), description: description.trim() || undefined,
        submit_label: submitLabel.trim() || "Submit", fields,
      });
      setForm(f); setFields(f.fields || []); setDirty(false);
    } catch {} finally { setSaving(false); }
  };

  const remove = async () => {
    if (!form) return;
    if (!(await confirm({ title: "Delete form?", message: `"${form.title}" and all its responses will be permanently removed.`, confirmLabel: "Delete", destructive: true }))) return;
    try { await api.deleteForm(form.id); safeBack("/forms"); } catch {}
  };

  const snippet = form ? `<script async src="${apiOrigin()}/api/pub/form-embed.js?form=${form.form_key}"></script>` : "";
  const directLink = form ? `${apiOrigin()}/api/pub/form-unit?form=${form.form_key}` : "";
  const copy = async (what: string, text: string) => { await Clipboard.setStringAsync(text); setCopied(what); setTimeout(() => setCopied(""), 1500); };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="form-builder-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack("/forms")} style={styles.iconBtn} testID="form-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{form?.title || "Form"}</Text>
        <TouchableOpacity onPress={remove} style={styles.iconBtn} testID="form-delete">
          <Ionicons name="trash-outline" size={20} color={theme.error} />
        </TouchableOpacity>
      </View>

      <View style={styles.tabs}>
        {(["build", "share", "responses"] as const).map((t) => (
          <TouchableOpacity key={t} style={[styles.tab, tab === t && styles.tabOn]} onPress={() => onTab(t)} testID={`form-tab-${t}`}>
            <Text style={[styles.tabText, tab === t && styles.tabTextOn]}>{t === "build" ? "Build" : t === "share" ? "Share" : "Responses"}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading || !form ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
          {tab === "build" && (
            <>
              <Text style={styles.label}>Title</Text>
              <TextInput style={styles.input} value={title} onChangeText={(t) => { setTitle(t); mark(); }} placeholder="Form title" placeholderTextColor={theme.textMuted} testID="form-title" />
              <Text style={styles.label}>Description (optional)</Text>
              <TextInput style={[styles.input, styles.area]} value={description} onChangeText={(t) => { setDescription(t); mark(); }} placeholder="Shown above the form" placeholderTextColor={theme.textMuted} multiline />

              <Text style={[styles.label, { marginTop: 18 }]}>Fields</Text>
              {fields.map((f, i) => (
                <View key={i} style={styles.fieldCard}>
                  <View style={styles.fieldTop}>
                    <TextInput style={styles.fieldLabelInput} value={f.label} onChangeText={(t) => patchField(i, { label: t })} placeholder={`Field ${i + 1} label`} placeholderTextColor={theme.textMuted} testID={`field-label-${i}`} />
                    <TouchableOpacity onPress={() => moveField(i, -1)} style={styles.fieldIconBtn}><Ionicons name="chevron-up" size={16} color={theme.textMuted} /></TouchableOpacity>
                    <TouchableOpacity onPress={() => moveField(i, 1)} style={styles.fieldIconBtn}><Ionicons name="chevron-down" size={16} color={theme.textMuted} /></TouchableOpacity>
                    <TouchableOpacity onPress={() => removeField(i)} style={styles.fieldIconBtn}><Ionicons name="trash-outline" size={16} color={theme.error} /></TouchableOpacity>
                  </View>
                  <TouchableOpacity style={styles.typeBtn} onPress={() => setTypePicker(i)} testID={`field-type-${i}`}>
                    <Ionicons name={(TYPES.find((x) => x.k === f.type)?.icon) || "text-outline"} size={15} color={theme.primary} />
                    <Text style={styles.typeBtnText}>{typeLabel(f.type)}</Text>
                    <Ionicons name="chevron-down" size={15} color={theme.textMuted} />
                  </TouchableOpacity>
                  {hasOptions(f.type) ? (
                    <View style={{ marginTop: 8 }}>
                      {(f.options || []).map((o, oi) => (
                        <View key={oi} style={styles.optRow}>
                          <TextInput style={styles.optInput} value={o} onChangeText={(t) => setOpt(i, oi, t)} placeholder={`Option ${oi + 1}`} placeholderTextColor={theme.textMuted} />
                          <TouchableOpacity onPress={() => removeOpt(i, oi)} style={styles.fieldIconBtn}><Ionicons name="close" size={15} color={theme.textMuted} /></TouchableOpacity>
                        </View>
                      ))}
                      <TouchableOpacity onPress={() => addOpt(i)} style={styles.addOpt}><Ionicons name="add" size={15} color={theme.primary} /><Text style={styles.addOptText}>Add option</Text></TouchableOpacity>
                    </View>
                  ) : (
                    <TextInput style={[styles.input, { marginTop: 8 }]} value={f.placeholder || ""} onChangeText={(t) => patchField(i, { placeholder: t })} placeholder="Placeholder (optional)" placeholderTextColor={theme.textMuted} />
                  )}
                  <View style={styles.reqRow}>
                    <Text style={styles.reqText}>Required</Text>
                    <Switch value={!!f.required} onValueChange={(v) => patchField(i, { required: v })} trackColor={{ true: theme.primary }} testID={`field-req-${i}`} />
                  </View>
                </View>
              ))}
              <TouchableOpacity style={styles.addField} onPress={addField} testID="form-add-field">
                <Ionicons name="add-circle-outline" size={18} color={theme.primary} /><Text style={styles.addFieldText}>Add field</Text>
              </TouchableOpacity>

              <Text style={[styles.label, { marginTop: 18 }]}>Submit button text</Text>
              <TextInput style={styles.input} value={submitLabel} onChangeText={(t) => { setSubmitLabel(t); mark(); }} placeholder="Submit" placeholderTextColor={theme.textMuted} />

              <TouchableOpacity style={[styles.saveBtn, (!dirty || saving || !title.trim()) && { opacity: 0.5 }]} onPress={save} disabled={!dirty || saving || !title.trim()} testID="form-save">
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>{dirty ? "Save changes" : "Saved"}</Text>}
              </TouchableOpacity>
            </>
          )}

          {tab === "share" && (
            <>
              <Text style={styles.intro}>Use this form inside the app, or embed it on any website.</Text>
              <TouchableOpacity style={styles.shareBtn} onPress={() => router.push({ pathname: "/f/[key]", params: { key: form.form_key } })} testID="form-open-inapp">
                <Ionicons name="open-outline" size={18} color="#fff" />
                <Text style={styles.shareBtnText}>Open form in app</Text>
              </TouchableOpacity>

              <Text style={[styles.label, { marginTop: 18 }]}>Embed on a website</Text>
              <Text style={styles.hint}>Paste this snippet where you want the form to appear.</Text>
              <View style={styles.codeBox}><Text style={styles.code} selectable>{snippet}</Text></View>
              <TouchableOpacity style={styles.copyBtn} onPress={() => copy("snippet", snippet)} testID="form-copy-snippet">
                <Ionicons name={copied === "snippet" ? "checkmark" : "copy-outline"} size={16} color={theme.primary} />
                <Text style={styles.copyText}>{copied === "snippet" ? "Copied" : "Copy embed snippet"}</Text>
              </TouchableOpacity>

              <Text style={[styles.label, { marginTop: 18 }]}>Direct link</Text>
              <Text style={styles.hint}>A hosted page with just this form.</Text>
              <View style={styles.codeBox}><Text style={styles.code} selectable numberOfLines={2}>{directLink}</Text></View>
              <TouchableOpacity style={styles.copyBtn} onPress={() => copy("link", directLink)} testID="form-copy-link">
                <Ionicons name={copied === "link" ? "checkmark" : "link-outline"} size={16} color={theme.primary} />
                <Text style={styles.copyText}>{copied === "link" ? "Copied" : "Copy link"}</Text>
              </TouchableOpacity>
            </>
          )}

          {tab === "responses" && (
            subsLoading ? (
              <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
            ) : subs.length === 0 ? (
              <View style={styles.empty}>
                <Ionicons name="albums-outline" size={36} color={theme.textMuted} />
                <Text style={styles.emptySub}>No responses yet.</Text>
              </View>
            ) : (
              <>
                <Text style={styles.intro}>{subs.length} response{subs.length === 1 ? "" : "s"}</Text>
                {subs.map((s) => (
                  <View key={s.id} style={styles.subCard}>
                    <Text style={styles.subDate}>{fmtDate(s.submitted_at)}</Text>
                    {(subFields.length ? subFields : Object.keys(s.values).map((k) => ({ id: k, label: k, type: "text" as FormFieldType }))).map((f) => (
                      <View key={f.id} style={styles.subRow}>
                        <Text style={styles.subKey}>{f.label}</Text>
                        <Text style={styles.subVal}>{s.values[f.id || ""] || "—"}</Text>
                      </View>
                    ))}
                  </View>
                ))}
              </>
            )
          )}
        </ScrollView>
      )}

      <Modal visible={typePicker !== null} transparent animationType="fade" onRequestClose={() => setTypePicker(null)}>
        <TouchableOpacity style={styles.pickerBackdrop} activeOpacity={1} onPress={() => setTypePicker(null)}>
          <View style={styles.pickerCard}>
            <Text style={styles.pickerTitle}>Field type</Text>
            {TYPES.map((t) => (
              <TouchableOpacity key={t.k} style={styles.pickerRow} onPress={() => { if (typePicker !== null) patchField(typePicker, { type: t.k, options: hasOptions(t.k) ? (fields[typePicker].options || ["Option 1"]) : null }); setTypePicker(null); }} testID={`type-${t.k}`}>
                <Ionicons name={t.icon} size={18} color={theme.primary} />
                <Text style={styles.pickerRowText}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const webInput = Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {};
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 6, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, color: theme.textPrimary, fontSize: 16, fontWeight: "700", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 40 },
  tabs: { flexDirection: "row", paddingHorizontal: 14, gap: 8, paddingVertical: 10 },
  tab: { flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: 999, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  tabOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  tabText: { color: theme.textSecondary, fontSize: 13.5, fontWeight: "800" },
  tabTextOn: { color: "#fff" },
  intro: { color: theme.textSecondary, fontSize: 13.5, lineHeight: 20, marginBottom: 12 },
  label: { color: theme.textSecondary, fontSize: 13, fontWeight: "800", marginBottom: 7 },
  hint: { color: theme.textMuted, fontSize: 12, marginBottom: 8, marginTop: -2 },
  input: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, color: theme.textPrimary, fontSize: 14.5, ...webInput },
  area: { minHeight: 70, textAlignVertical: "top" },
  fieldCard: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, padding: 12, marginBottom: 10 },
  fieldTop: { flexDirection: "row", alignItems: "center", gap: 6 },
  fieldLabelInput: { flex: 1, color: theme.textPrimary, fontSize: 15, fontWeight: "700", paddingVertical: 4, ...webInput },
  fieldIconBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderRadius: 8, backgroundColor: theme.surfaceAlt },
  typeBtn: { flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "flex-start", marginTop: 8, backgroundColor: theme.surfaceAlt, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  typeBtnText: { color: theme.textPrimary, fontSize: 13, fontWeight: "700" },
  optRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  optInput: { flex: 1, backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, color: theme.textPrimary, fontSize: 14, ...webInput },
  addOpt: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 4 },
  addOptText: { color: theme.primary, fontSize: 13, fontWeight: "700" },
  reqRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10 },
  reqText: { color: theme.textSecondary, fontSize: 13.5, fontWeight: "700" },
  addField: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: theme.surfaceAlt, borderRadius: 12, paddingVertical: 12, marginTop: 2 },
  addFieldText: { color: theme.primary, fontSize: 14, fontWeight: "800" },
  saveBtn: { backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 20 },
  saveText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  shareBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 13 },
  shareBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  codeBox: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, padding: 12 },
  code: { color: theme.textPrimary, fontSize: 12.5, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  copyBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: theme.surfaceAlt, borderRadius: 12, paddingVertical: 11, marginTop: 8 },
  copyText: { color: theme.primary, fontSize: 14, fontWeight: "800" },
  empty: { alignItems: "center", paddingTop: 50, gap: 10 },
  emptySub: { color: theme.textMuted, fontSize: 14, textAlign: "center" },
  subCard: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, padding: 12, marginBottom: 10 },
  subDate: { color: theme.textMuted, fontSize: 11.5, fontWeight: "700", marginBottom: 8 },
  subRow: { marginBottom: 6 },
  subKey: { color: theme.textMuted, fontSize: 11.5, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.3 },
  subVal: { color: theme.textPrimary, fontSize: 14.5, lineHeight: 20, marginTop: 1 },
  pickerBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", padding: 28 },
  pickerCard: { width: "100%", maxWidth: 360, backgroundColor: theme.surface, borderRadius: 18, borderWidth: 1, borderColor: theme.border, paddingVertical: 8 },
  pickerTitle: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 },
  pickerRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 13 },
  pickerRowText: { color: theme.textPrimary, fontSize: 15, fontWeight: "600" },
});
