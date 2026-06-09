import React, { useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, TextInput,
  ActivityIndicator, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import { assetToUri } from "@/src/utils/thumbnail";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";
import { ACCENT_COLORS, resolveAccent, isValidHex, accentGradient } from "@/src/lib/profileCustomize";

export default function ShopCustomizeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, refresh } = useAuth();
  const [name, setName] = useState(user?.shop_name || "");
  const [tagline, setTagline] = useState(user?.shop_tagline || "");
  const [policies, setPolicies] = useState(user?.shop_policies || "");
  const [logo, setLogo] = useState<string | null>(user?.shop_logo || null);
  const [banner, setBanner] = useState<string | null>(user?.shop_banner || null);
  const [accent, setAccent] = useState(user?.shop_accent || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const previewAccent = resolveAccent(accent || user?.accent_color);

  const pick = async (aspect: [number, number], set: (uri: string) => void) => {
    if (Platform.OS !== "web") {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"] as any, allowsEditing: true, aspect, quality: 0.7, base64: true });
    if (res.canceled || !res.assets?.[0]) return;
    const uri = await assetToUri(res.assets[0], "image");
    if (uri) set(uri);
  };

  const save = async () => {
    setSaving(true); setErr("");
    try {
      await api.updateMe({
        shop_name: name.trim(),
        shop_tagline: tagline.trim(),
        shop_policies: policies.trim(),
        shop_logo: logo || "",
        shop_banner: banner || "",
        shop_accent: accent && isValidHex(accent) ? accent : "",
      });
      await refresh();
      safeBack();
    } catch (e: any) {
      setErr(e?.message || "Couldn't save your storefront.");
    } finally { setSaving(false); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="shop-customize-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn} hitSlop={10} testID="shop-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Your storefront</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 100 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={styles.note}>Marketplace-only branding. When set, this is what buyers see on your seller profile — separate from your social profile.</Text>

        {/* Live preview */}
        <View style={styles.preview}>
          {banner ? (
            <Image source={{ uri: banner }} style={styles.previewBanner} resizeMode="cover" />
          ) : (
            <LinearGradientLike colors={accentGradient(accent || user?.accent_color)} />
          )}
          <View style={styles.previewBody}>
            <View style={[styles.previewLogo, { borderColor: previewAccent }]}>
              {logo ? <Image source={{ uri: logo }} style={{ width: "100%", height: "100%" }} /> : <Ionicons name="storefront" size={26} color={previewAccent} />}
            </View>
            <Text style={styles.previewName} numberOfLines={1}>{name.trim() || user?.name || "Your shop"}</Text>
            {!!(tagline.trim() || user?.headline) && <Text style={styles.previewTagline} numberOfLines={2}>{tagline.trim() || user?.headline}</Text>}
          </View>
        </View>

        <Text style={styles.label}>Shop name</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder={user?.name || "Your shop name"} placeholderTextColor={theme.textMuted} maxLength={60} testID="shop-name" />

        <Text style={styles.label}>Tagline</Text>
        <TextInput style={styles.input} value={tagline} onChangeText={setTagline} placeholder="What you sell, in a line" placeholderTextColor={theme.textMuted} maxLength={100} testID="shop-tagline" />

        <Text style={styles.label}>Logo</Text>
        <View style={styles.mediaRow}>
          <TouchableOpacity style={styles.logoBtn} onPress={() => pick([1, 1], setLogo)} testID="shop-logo-pick">
            {logo ? <Image source={{ uri: logo }} style={styles.logoImg} /> : <Ionicons name="image-outline" size={22} color={theme.textMuted} />}
          </TouchableOpacity>
          {!!logo && <TouchableOpacity onPress={() => setLogo(null)} style={styles.removeBtn}><Text style={styles.removeText}>Remove</Text></TouchableOpacity>}
        </View>

        <Text style={styles.label}>Banner</Text>
        <TouchableOpacity style={styles.bannerBtn} onPress={() => pick([3, 1], setBanner)} testID="shop-banner-pick">
          {banner ? <Image source={{ uri: banner }} style={styles.bannerImg} resizeMode="cover" /> : (
            <View style={styles.bannerEmpty}><Ionicons name="image-outline" size={22} color={theme.textMuted} /><Text style={styles.bannerEmptyText}>Add a banner</Text></View>
          )}
        </TouchableOpacity>
        {!!banner && <TouchableOpacity onPress={() => setBanner(null)}><Text style={styles.removeText}>Remove banner</Text></TouchableOpacity>}

        <Text style={styles.label}>Accent color</Text>
        <View style={styles.swatchRow}>
          {ACCENT_COLORS.map((c) => {
            const on = (accent || "").toLowerCase() === c.toLowerCase();
            return (
              <TouchableOpacity key={c} style={[styles.swatchWrap, on && { borderColor: theme.primary, backgroundColor: theme.surfaceAlt }]} onPress={() => setAccent(c)} testID={`shop-accent-${c}`}>
                <View style={[styles.swatch, { backgroundColor: c }]}>{on ? <Ionicons name="checkmark" size={16} color="#fff" /> : null}</View>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity style={[styles.swatchWrap, !accent && { borderColor: theme.primary, backgroundColor: theme.surfaceAlt }]} onPress={() => setAccent("")} testID="shop-accent-clear">
            <View style={[styles.swatch, { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border }]}><Ionicons name="refresh" size={14} color={theme.textMuted} /></View>
          </TouchableOpacity>
        </View>

        <Text style={styles.label}>Shop policies</Text>
        <TextInput style={[styles.input, { height: 90, textAlignVertical: "top" }]} value={policies} onChangeText={setPolicies} placeholder="Shipping, returns, meetup spots…" placeholderTextColor={theme.textMuted} multiline maxLength={500} testID="shop-policies" />

        {!!err && <Text style={styles.err}>{err}</Text>}
        <TouchableOpacity style={[styles.saveBtn, saving && { opacity: 0.6 }]} onPress={save} disabled={saving} testID="shop-save">
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save storefront</Text>}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function LinearGradientLike({ colors }: { colors: [string, string, string] }) {
  return <LinearGradient colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.previewBanner} />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 10 },
  backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  note: { color: theme.textMuted, fontSize: 12.5, lineHeight: 18, marginBottom: 14 },
  preview: { borderRadius: 16, overflow: "hidden", borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface, marginBottom: 16 },
  previewBanner: { width: "100%", height: 90, backgroundColor: theme.surfaceAlt },
  previewBody: { alignItems: "center", paddingBottom: 14, marginTop: -28, gap: 2 },
  previewLogo: { width: 56, height: 56, borderRadius: 28, borderWidth: 3, overflow: "hidden", backgroundColor: theme.surface, alignItems: "center", justifyContent: "center" },
  previewName: { color: theme.textPrimary, fontSize: 17, fontWeight: "800", marginTop: 6 },
  previewTagline: { color: theme.textSecondary, fontSize: 13, textAlign: "center", paddingHorizontal: 20 },
  label: { color: theme.textSecondary, fontSize: 12, fontWeight: "700", marginTop: 14, marginBottom: 6 },
  input: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: theme.textPrimary, fontSize: 14, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  mediaRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  logoBtn: { width: 64, height: 64, borderRadius: 32, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  logoImg: { width: "100%", height: "100%" },
  bannerBtn: { borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface },
  bannerImg: { width: "100%", height: 96 },
  bannerEmpty: { height: 96, alignItems: "center", justifyContent: "center", gap: 6 },
  bannerEmptyText: { color: theme.textMuted, fontSize: 13, fontWeight: "600" },
  removeBtn: { paddingHorizontal: 12, paddingVertical: 8 },
  removeText: { color: theme.error, fontSize: 13, fontWeight: "700", marginTop: 6 },
  swatchRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  swatchWrap: { padding: 3, borderRadius: 22, borderWidth: 2, borderColor: "transparent" },
  swatch: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  err: { color: theme.error, fontSize: 13, fontWeight: "600", marginTop: 14 },
  saveBtn: { marginTop: 20, paddingVertical: 14, borderRadius: 14, backgroundColor: theme.primary, alignItems: "center" },
  saveText: { color: "#fff", fontWeight: "800", fontSize: 15 },
});
