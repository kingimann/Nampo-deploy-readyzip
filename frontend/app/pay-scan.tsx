import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Stack, useRouter } from "expo-router";
import { theme } from "@/src/theme";

const webInput = Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {};

// Pull a /pay/<id>?amount=&note= target out of scanned/pasted text.
function parsePay(data: string): { id: string; amount?: string; note?: string } | null {
  if (!data) return null;
  const m = data.match(/\/pay\/([^/?#\s]+)(\?[^#\s]*)?/i);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  let amount: string | undefined, note: string | undefined;
  if (m[2]) {
    try {
      const sp = new URLSearchParams(m[2].slice(1));
      amount = sp.get("amount") || undefined;
      note = sp.get("note") || undefined;
    } catch {}
  }
  return { id, amount, note };
}

export default function PayScanScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [perm, requestPerm] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [manual, setManual] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const go = (data: string) => {
    const p = parsePay(data);
    if (!p) { setErr("That's not a Nami pay code."); return; }
    router.replace({ pathname: "/pay/[id]", params: { id: p.id, amount: p.amount || "", note: p.note || "" } });
  };

  const onScan = ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);
    go(data);
    setTimeout(() => setScanned(false), 2000);
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="pay-scan-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="scan-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Scan to pay</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.cameraWrap}>
        {!perm ? (
          <View style={styles.center}><Text style={styles.muted}>Preparing camera…</Text></View>
        ) : !perm.granted ? (
          <View style={styles.center}>
            <Ionicons name="camera-outline" size={36} color={theme.textMuted} />
            <Text style={styles.muted}>Camera access is needed to scan a pay code.</Text>
            <TouchableOpacity style={styles.permBtn} onPress={requestPerm} testID="scan-perm">
              <Text style={styles.permText}>Allow camera</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={onScan}
            />
            <View style={styles.frame} pointerEvents="none" />
            <Text style={styles.scanHint}>Point at a Nami pay code</Text>
          </View>
        )}
      </View>

      <View style={[styles.manualWrap, { paddingBottom: insets.bottom + 16 }]}>
        <Text style={styles.manualLabel}>…or paste a pay link</Text>
        <View style={styles.manualRow}>
          <TextInput style={styles.manualInput} value={manual} onChangeText={(t) => { setManual(t); setErr(null); }} placeholder="https://…/pay/…" placeholderTextColor={theme.textMuted} autoCapitalize="none" testID="scan-manual" />
          <TouchableOpacity style={styles.goBtn} onPress={() => go(manual.trim())} testID="scan-go">
            <Ionicons name="arrow-forward" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
        {err && <Text style={styles.err}>{err}</Text>}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  cameraWrap: { flex: 1, backgroundColor: "#000", overflow: "hidden" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 30 },
  muted: { color: theme.textMuted, fontSize: 14, textAlign: "center" },
  permBtn: { backgroundColor: theme.primary, borderRadius: 12, paddingHorizontal: 18, height: 44, alignItems: "center", justifyContent: "center" },
  permText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  frame: { position: "absolute", top: "50%", left: "50%", width: 220, height: 220, marginLeft: -110, marginTop: -110, borderWidth: 3, borderColor: "rgba(255,255,255,0.9)", borderRadius: 20 },
  scanHint: { position: "absolute", bottom: 20, alignSelf: "center", color: "#fff", fontSize: 13, fontWeight: "700", backgroundColor: "rgba(0,0,0,0.5)", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  manualWrap: { paddingHorizontal: 16, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  manualLabel: { color: theme.textMuted, fontSize: 12, fontWeight: "700", marginBottom: 8 },
  manualRow: { flexDirection: "row", gap: 8 },
  manualInput: { flex: 1, backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 12, height: 46, color: theme.textPrimary, fontSize: 14, ...webInput },
  goBtn: { width: 46, height: 46, borderRadius: 12, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  err: { color: theme.error, fontSize: 12.5, marginTop: 8 },
});
