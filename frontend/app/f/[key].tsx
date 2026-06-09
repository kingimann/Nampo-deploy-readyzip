import React, { useCallback, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Platform, Image, Linking,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "@/src/platform/image-picker";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import SignaturePad from "@/src/components/SignaturePad";
import DatePickerField from "@/src/components/DatePickerField";
import { forwardGeocode } from "@/src/api/mapbox";

const FALLBACK_BACKEND = "https://nampo-backend.onrender.com";
const apiOrigin = () => ((process.env.EXPO_PUBLIC_BACKEND_URL as string) || FALLBACK_BACKEND).replace(/\/$/, "");
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
  const [sigModes, setSigModes] = useState<Record<string, "draw" | "type">>({});
  const [addr, setAddr] = useState<{ k: string | null; items: { full_address: string; name: string }[] }>({ k: null, items: [] });
  const addrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchAddr = (k: string, q: string) => {
    setVal(k, q);
    if (addrTimer.current) clearTimeout(addrTimer.current);
    if (q.trim().length < 3) { setAddr({ k, items: [] }); return; }
    addrTimer.current = setTimeout(async () => {
      try { const r = await forwardGeocode(q); setAddr({ k, items: r.slice(0, 6) }); } catch { setAddr({ k, items: [] }); }
    }, 300);
  };

  const load = useCallback(async () => {
    if (!key) return;
    try { setForm(await api.publicForm(String(key))); } catch { setForm(null); } finally { setLoading(false); }
  }, [key]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const fid = (f: FormField, i: number) => f.id || `f${i + 1}`;
  const setVal = (k: string, v: any) => setValues((s) => ({ ...s, [k]: v }));

  const pickPhoto = async (k: string, fromCamera: boolean) => {
    try {
      if (fromCamera) {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) { setErr("Camera permission denied."); return; }
      }
      const res = fromCamera
        ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6 })
        : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.6 });
      const a = !res.canceled ? res.assets?.[0] : null;
      if (a?.base64) setVal(k, `data:image/jpeg;base64,${a.base64}`);
    } catch { setErr("Couldn't add the photo."); }
  };

  // Completion progress (0..1) across all fields.
  const filledCount = (form?.fields || []).reduce((n, f, i) => {
    const v = values[fid(f, i)];
    const has = f.type === "checkbox" ? (Array.isArray(v) && v.length > 0) : !!String(v ?? "").trim();
    return n + (has ? 1 : 0);
  }, 0);
  const progress = form && form.fields.length ? filledCount / form.fields.length : 0;
  const payField = (form?.fields || []).find((f) => f.type === "payment");
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
          {form.fields.length > 1 && (
            <View style={styles.progTrack}><View style={[styles.progBar, { width: `${Math.round(progress * 100)}%` }]} /></View>
          )}

          {form.fields.map((f, i) => {
            const k = fid(f, i);
            const req = f.required ? <Text style={styles.req}> *</Text> : null;
            if (f.type === "heading") return <Text key={k} style={styles.sectionHead}>{f.label}</Text>;
            return (
              <View key={k} style={{ marginTop: 16 }}>
                <Text style={styles.label}>{f.label}{req}</Text>
                {f.type === "rating" ? (
                  <View style={styles.ratingRow}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <TouchableOpacity key={n} onPress={() => setVal(k, String(n))} testID={`pf-${k}-${n}`}>
                        <Ionicons name={Number(values[k]) >= n ? "star" : "star-outline"} size={32} color={Number(values[k]) >= n ? theme.primary : theme.textMuted} />
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : f.type === "payment" ? (
                  <View>
                    <Text style={styles.payInfo}>
                      {f.amount_open ? "You'll choose the amount at checkout." : `Amount: ${f.currency || "USD"} ${Number(f.amount || 0).toFixed(2)}`}
                    </Text>
                    <Text style={styles.payNote}>Payment is processed securely in your browser.</Text>
                  </View>
                ) : f.type === "date" ? (
                  <DatePickerField value={values[k] || ""} onChange={(v) => setVal(k, v)} testID={`pf-${k}`} />
                ) : f.type === "password" ? (
                  <TextInput style={styles.input} value={values[k] || ""} onChangeText={(t) => setVal(k, t)} placeholder={f.placeholder || ""} placeholderTextColor={theme.textMuted} secureTextEntry autoCapitalize="none" autoCorrect={false} testID={`pf-${k}`} />
                ) : f.type === "address" ? (
                  <View>
                    <TextInput style={styles.input} value={values[k] || ""} onChangeText={(t) => searchAddr(k, t)} placeholder={f.placeholder || "Start typing an address"} placeholderTextColor={theme.textMuted} autoCapitalize="none" autoCorrect={false} testID={`pf-${k}`} />
                    {addr.k === k && addr.items.length > 0 && (
                      <View style={styles.addrBox}>
                        {addr.items.map((it, idx) => (
                          <TouchableOpacity key={idx} style={styles.addrItem} onPress={() => { setVal(k, it.full_address || it.name); setAddr({ k: null, items: [] }); }} testID={`pf-${k}-sug-${idx}`}>
                            <Ionicons name="location-outline" size={15} color={theme.textMuted} />
                            <Text style={styles.addrText} numberOfLines={2}>{it.full_address || it.name}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                  </View>
                ) : f.type === "textarea" ? (
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
                ) : f.type === "consent" ? (
                  <View>
                    <ScrollView style={styles.consentBox} nestedScrollEnabled>
                      <Text style={styles.consentText}>{f.text || "I agree to the terms above."}</Text>
                    </ScrollView>
                    <TouchableOpacity style={styles.optRow} onPress={() => setVal(k, values[k] === "I agree" ? "" : "I agree")} testID={`pf-${k}`}>
                      <Ionicons name={values[k] === "I agree" ? "checkbox" : "square-outline"} size={20} color={values[k] === "I agree" ? theme.primary : theme.textMuted} />
                      <Text style={styles.optText}>I agree</Text>
                    </TouchableOpacity>
                  </View>
                ) : f.type === "photo" ? (
                  <View>
                    {!!values[k] && <Image source={{ uri: values[k] }} style={styles.photoPrev} resizeMode="cover" />}
                    <View style={styles.photoBtns}>
                      <TouchableOpacity style={styles.photoBtn} onPress={() => pickPhoto(k, true)} testID={`pf-${k}-camera`}>
                        <Ionicons name="camera-outline" size={18} color={theme.primary} /><Text style={styles.photoBtnText}>Take photo</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.photoBtn} onPress={() => pickPhoto(k, false)} testID={`pf-${k}-upload`}>
                        <Ionicons name="image-outline" size={18} color={theme.primary} /><Text style={styles.photoBtnText}>Upload</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : f.type === "signature" ? (
                  <View>
                    <View style={styles.sigTabs}>
                      {(["draw", "type"] as const).map((m) => {
                        const on = (sigModes[k] || "type") === m;
                        return (
                          <TouchableOpacity key={m} style={[styles.sigTab, on && styles.sigTabOn]} onPress={() => { setSigModes((s) => ({ ...s, [k]: m })); setVal(k, ""); }} testID={`pf-${k}-${m}`}>
                            <Ionicons name={m === "draw" ? "brush-outline" : "text-outline"} size={14} color={on ? "#fff" : theme.textMuted} />
                            <Text style={[styles.sigTabText, on && { color: "#fff" }]}>{m === "draw" ? "Draw" : "Type"}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    {(sigModes[k] || "type") === "draw" ? (
                      <SignaturePad onChange={(v) => setVal(k, v)} />
                    ) : (
                      <>
                        <TextInput
                          style={[styles.input, styles.sigInput]}
                          value={values[k] || ""}
                          onChangeText={(t) => setVal(k, t)}
                          placeholder="Type your full name to sign"
                          placeholderTextColor={theme.textMuted}
                          autoCapitalize="words"
                          testID={`pf-${k}`}
                        />
                        <Text style={styles.sigHint}>Typing your name here counts as your signature.</Text>
                      </>
                    )}
                  </View>
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
          {payField ? (
            <TouchableOpacity style={styles.submit} onPress={() => Linking.openURL(`${apiOrigin()}/api/pub/form-unit?form=${encodeURIComponent(String(key))}`)} testID="pf-pay">
              <Text style={styles.submitText}>Continue to payment →</Text>
            </TouchableOpacity>
          ) : (
          <TouchableOpacity style={[styles.submit, submitting && { opacity: 0.6 }]} onPress={submit} disabled={submitting} testID="pf-submit">
            {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>{form.submit_label || "Submit"}</Text>}
          </TouchableOpacity>
          )}
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
  addrBox: { marginTop: 6, borderWidth: 1, borderColor: theme.border, borderRadius: 12, backgroundColor: theme.surface, overflow: "hidden" },
  addrItem: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  addrText: { flex: 1, color: theme.textPrimary, fontSize: 14, lineHeight: 19 },
  sigTabs: { flexDirection: "row", gap: 8, marginBottom: 8 },
  sigTab: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface },
  sigTabOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  sigTabText: { color: theme.textMuted, fontSize: 13, fontWeight: "700" },
  sigInput: { fontStyle: "italic", fontSize: 18 },
  sigHint: { color: theme.textMuted, fontSize: 12, marginTop: 5 },
  sectionHead: { color: theme.textPrimary, fontSize: 17, fontWeight: "800", marginTop: 24, marginBottom: 2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border, paddingTop: 16 },
  ratingRow: { flexDirection: "row", gap: 6, marginTop: 4 },
  payInfo: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  payNote: { color: theme.textMuted, fontSize: 12.5, marginTop: 4 },
  progTrack: { height: 5, borderRadius: 3, backgroundColor: theme.surfaceAlt, overflow: "hidden", marginTop: 14 },
  progBar: { height: 5, borderRadius: 3, backgroundColor: theme.primary },
  consentBox: { maxHeight: 170, borderWidth: 1, borderColor: theme.border, borderRadius: 12, backgroundColor: theme.surface, padding: 12, marginBottom: 8 },
  consentText: { color: theme.textSecondary, fontSize: 13, lineHeight: 19 },
  photoPrev: { width: "100%", height: 180, borderRadius: 12, backgroundColor: theme.surfaceAlt, marginBottom: 8 },
  photoBtns: { flexDirection: "row", gap: 10 },
  photoBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingVertical: 12 },
  photoBtnText: { color: theme.primary, fontSize: 14, fontWeight: "700" },
  err: { color: theme.error, fontSize: 13.5, marginTop: 14, fontWeight: "600" },
  submit: { backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 20 },
  submitText: { color: "#fff", fontWeight: "800", fontSize: 15 },
});
