import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image, ActivityIndicator,
  Modal, TextInput, ScrollView, Platform, Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import * as Clipboard from "@/src/platform/clipboard";
import { safeBack } from "@/src/utils/nav";
import { api, Game } from "@/src/api/client";
import { useKeyboardHeight } from "@/src/hooks/useKeyboardHeight";
import { theme } from "@/src/theme";

const webInput = Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {};

const SDK_SNIPPET = `<!-- Build a whole 3D game with the OkaySpace API (Three.js is bundled) -->
<script src="https://nampo-backend.onrender.com/api/pub/games/sdk.js"></script>
<script>
  NamiGames.create3D({
    background: 0x101018,
    onReady(g) {                       // g = your game API
      const player = g.box({ color: 0x00e0a4, y: 0.5 });
      g.ground();
      let score = 0;
      g.onTap(async (tap) => {         // tap to jump + score
        player.position.y = 2; score++;
        g.submitScore(score);          // → app leaderboard
      });
      g.onUpdate((dt) => {             // game loop (dt = seconds)
        player.rotation.y += dt;
        if (player.position.y > 0.5) player.position.y -= dt * 4;
      });
      const me = await g.getPlayer();  // { name }
    },
  });
  // Low-level platform calls also available: NamiGames.submitScore(n),
  // getPlayer(), exit(), and the raw THREE via g.THREE.
</script>`;

export default function GamesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const kb = useKeyboardHeight();
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [compose, setCompose] = useState(false);
  const [docs, setDocs] = useState(false);

  // Upload form
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [mode, setMode] = useState<"url" | "html">("url");
  const [url, setUrl] = useState("");
  const [html, setHtml] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try { setGames((await api.listGames()).games); } catch {} finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const submit = async () => {
    if (!title.trim()) { Alert.alert("Title required", "Give your game a name."); return; }
    if (mode === "url" && !/^https?:\/\//i.test(url.trim())) { Alert.alert("Game URL required", "Enter the https URL where your game is hosted."); return; }
    if (mode === "html" && !html.trim()) { Alert.alert("Game code required", "Paste your game's HTML."); return; }
    setSaving(true);
    try {
      await api.createGame({
        title: title.trim(), description: desc.trim(),
        url: mode === "url" ? url.trim() : undefined,
        html: mode === "html" ? html : undefined,
      });
      setCompose(false); setTitle(""); setDesc(""); setUrl(""); setHtml("");
      await load();
    } catch (e: any) {
      Alert.alert("Couldn't add game", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setSaving(false); }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="games-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="games-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Games</Text>
        <TouchableOpacity onPress={() => setDocs(true)} style={styles.iconBtn} testID="games-docs">
          <Ionicons name="code-slash-outline" size={20} color={theme.textPrimary} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={games}
          keyExtractor={(g) => g.id}
          numColumns={2}
          columnWrapperStyle={{ gap: 12 }}
          contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 90, gap: 12 }}
          ListEmptyComponent={<Text style={styles.empty}>No games yet. Upload one — a Three.js game works great.</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.card}
              onPress={() => router.push({ pathname: "/game/[id]", params: { id: item.id, title: item.title } })}
              testID={`game-${item.id}`}
            >
              <View style={styles.thumb}>
                {item.thumbnail ? (
                  <Image source={{ uri: item.thumbnail }} style={styles.thumbImg} />
                ) : (
                  <Ionicons name="game-controller" size={34} color={theme.primary} />
                )}
              </View>
              <Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text>
              <Text style={styles.cardMeta} numberOfLines={1}>{item.plays} play{item.plays === 1 ? "" : "s"} · {item.owner_name || "Someone"}</Text>
            </TouchableOpacity>
          )}
        />
      )}

      <TouchableOpacity style={[styles.fab, { bottom: insets.bottom + 24 }]} onPress={() => setCompose(true)} testID="games-upload">
        <Ionicons name="add" size={26} color="#fff" />
      </TouchableOpacity>

      {/* Upload */}
      <Modal visible={compose} transparent animationType="slide" onRequestClose={() => setCompose(false)}>
        <View style={styles.sheetBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setCompose(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16, marginBottom: kb, maxHeight: "88%" }]}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Upload a game</Text>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <TextInput style={[styles.input, webInput]} value={title} onChangeText={setTitle} placeholder="Game title" placeholderTextColor={theme.textMuted} />
              <TextInput style={[styles.input, webInput]} value={desc} onChangeText={setDesc} placeholder="Short description" placeholderTextColor={theme.textMuted} />
              <View style={styles.seg}>
                {(["url", "html"] as const).map((m) => (
                  <TouchableOpacity key={m} style={[styles.segItem, mode === m && styles.segOn]} onPress={() => setMode(m)} testID={`game-mode-${m}`}>
                    <Text style={[styles.segText, mode === m && { color: "#fff" }]}>{m === "url" ? "Hosted URL" : "Paste HTML"}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {mode === "url" ? (
                <TextInput style={[styles.input, webInput]} value={url} onChangeText={setUrl} placeholder="https://your-game.example.com" placeholderTextColor={theme.textMuted} autoCapitalize="none" keyboardType="url" />
              ) : (
                <TextInput style={[styles.input, styles.code, webInput]} value={html} onChangeText={setHtml} placeholder="<!doctype html> … your Three.js game …" placeholderTextColor={theme.textMuted} multiline autoCapitalize="none" autoCorrect={false} />
              )}
              <Text style={styles.hint}>Add the OkaySpace Games SDK to your game so scores and the leaderboard work. Tap the {"</>"} icon up top for the snippet.</Text>
              <TouchableOpacity style={[styles.submit, saving && { opacity: 0.6 }]} onPress={submit} disabled={saving} testID="game-submit">
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Publish game</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* SDK docs */}
      <Modal visible={docs} transparent animationType="slide" onRequestClose={() => setDocs(false)}>
        <View style={styles.sheetBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setDocs(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16, maxHeight: "80%" }]}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>OkaySpace Games SDK</Text>
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text style={styles.docText}>Include the SDK script in your game, then call it. Scores are submitted through the app (the player is already signed in), so your game never handles auth.</Text>
              <View style={styles.codeBox}><Text style={styles.codeBoxText}>{SDK_SNIPPET}</Text></View>
              <TouchableOpacity style={styles.copyBtn} onPress={async () => { await Clipboard.setStringAsync(SDK_SNIPPET); Alert.alert("Copied", "SDK snippet copied."); }} testID="game-copy-sdk">
                <Ionicons name="copy-outline" size={16} color="#fff" />
                <Text style={styles.copyText}>Copy snippet</Text>
              </TouchableOpacity>
              <Text style={styles.docText}>Inline-HTML games get the SDK injected automatically. Hosted-URL games must include the script tag above. Three.js (or any web game) works.</Text>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { color: theme.textMuted, fontSize: 13.5, textAlign: "center", paddingVertical: 40, paddingHorizontal: 24 },
  card: { flex: 1, backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 10 },
  thumb: { height: 100, borderRadius: 12, backgroundColor: theme.surfaceAlt, alignItems: "center", justifyContent: "center", overflow: "hidden", marginBottom: 8 },
  thumbImg: { width: "100%", height: "100%" },
  cardTitle: { color: theme.textPrimary, fontSize: 14.5, fontWeight: "800" },
  cardMeta: { color: theme.textMuted, fontSize: 11.5, marginTop: 2 },
  fab: { position: "absolute", right: 18, width: 56, height: 56, borderRadius: 28, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 5 },
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: theme.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, borderColor: theme.border, paddingTop: 10, paddingHorizontal: 16 },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 12 },
  sheetTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800", textAlign: "center", marginBottom: 12 },
  input: { backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 14, paddingVertical: 12, color: theme.textPrimary, fontSize: 14.5, marginBottom: 10 },
  code: { minHeight: 120, textAlignVertical: "top", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12.5 },
  seg: { flexDirection: "row", backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, padding: 3, marginBottom: 10 },
  segItem: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: "center" },
  segOn: { backgroundColor: theme.primary },
  segText: { color: theme.textSecondary, fontSize: 13.5, fontWeight: "700" },
  hint: { color: theme.textMuted, fontSize: 12, lineHeight: 17, marginBottom: 12 },
  submit: { backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginBottom: 8 },
  submitText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  docText: { color: theme.textSecondary, fontSize: 13.5, lineHeight: 19, marginBottom: 12 },
  codeBox: { backgroundColor: "#0B0B0D", borderRadius: 12, borderWidth: 1, borderColor: theme.border, padding: 12, marginBottom: 10 },
  codeBoxText: { color: "#9FE9C9", fontSize: 11.5, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", lineHeight: 17 },
  copyBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 11, marginBottom: 14 },
  copyText: { color: "#fff", fontSize: 14, fontWeight: "800" },
});
