import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, FlatList, Platform } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, GameScore } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import GameWebView, { GameWebViewHandle, GameEvent } from "@/src/components/GameWebView";
import { theme } from "@/src/theme";

function apiOrigin(): string {
  const env = process.env.EXPO_PUBLIC_BACKEND_URL as string;
  if (env) return env.replace(/\/$/, "");
  if (Platform.OS === "web" && typeof window !== "undefined") return window.location.origin;
  return "";
}

export default function GamePlayerScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const gameRef = useRef<GameWebViewHandle>(null);
  const [lbOpen, setLbOpen] = useState(false);
  const [board, setBoard] = useState<GameScore[]>([]);
  const [best, setBest] = useState<number | null>(null);

  const uri = `${apiOrigin()}/api/pub/game/${id}`;

  const loadBoard = useCallback(async () => {
    if (!id) return;
    try { setBoard((await api.gameLeaderboard(String(id))).leaderboard); } catch {}
  }, [id]);
  useEffect(() => { loadBoard(); }, [loadBoard]);

  const onEvent = useCallback((e: GameEvent) => {
    if (e.type === "ready") {
      if (id) api.recordGamePlay(String(id)).catch(() => {});
      gameRef.current?.sendPlayer({ name: user?.name || "Player" });
    } else if (e.type === "getPlayer") {
      gameRef.current?.sendPlayer({ name: user?.name || "Player" });
    } else if (e.type === "score") {
      if (id && typeof e.score === "number") {
        api.submitGameScore(String(id), e.score).then((r) => { setBest(r.best); loadBoard(); }).catch(() => {});
      }
    } else if (e.type === "exit") {
      safeBack("/games");
    }
  }, [id, user?.name, loadBoard]);

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.root} testID="game-player">
      <Stack.Screen options={{ headerShown: false }} />
      <GameWebView ref={gameRef} uri={uri} onEvent={onEvent} />

      {/* Floating controls */}
      <View style={[styles.bar, { top: insets.top + 8 }]} pointerEvents="box-none">
        <TouchableOpacity style={styles.ctrl} onPress={() => safeBack("/games")} testID="game-back">
          <Ionicons name="close" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={styles.titlePill}>
          <Text style={styles.titleText} numberOfLines={1}>{title || "Game"}</Text>
          {best != null && <Text style={styles.bestText}>Best {best}</Text>}
        </View>
        <TouchableOpacity style={styles.ctrl} onPress={() => { loadBoard(); setLbOpen(true); }} testID="game-leaderboard">
          <Ionicons name="trophy" size={20} color="#FACC15" />
        </TouchableOpacity>
      </View>

      <Modal visible={lbOpen} transparent animationType="slide" onRequestClose={() => setLbOpen(false)}>
        <View style={styles.lbBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setLbOpen(false)} />
          <View style={[styles.lbSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.handle} />
            <Text style={styles.lbTitle}>🏆 Leaderboard</Text>
            <FlatList
              data={board}
              keyExtractor={(_, i) => String(i)}
              ListEmptyComponent={<Text style={styles.lbEmpty}>No scores yet — be the first!</Text>}
              renderItem={({ item, index }) => (
                <View style={[styles.lbRow, item.mine && styles.lbRowMine]}>
                  <Text style={styles.lbRank}>{index + 1}</Text>
                  <Text style={styles.lbName} numberOfLines={1}>{item.name}{item.mine ? " (you)" : ""}</Text>
                  <Text style={styles.lbScore}>{item.score}</Text>
                </View>
              )}
            />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  bar: { position: "absolute", left: 12, right: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  ctrl: { width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center" },
  titlePill: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "rgba(0,0,0,0.45)", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  titleText: { color: "#fff", fontSize: 14, fontWeight: "800", flexShrink: 1 },
  bestText: { color: "#FACC15", fontSize: 12, fontWeight: "700" },
  lbBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  lbSheet: { backgroundColor: theme.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, borderColor: theme.border, paddingTop: 10, paddingHorizontal: 16, maxHeight: "70%" },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 12 },
  lbTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800", textAlign: "center", marginBottom: 12 },
  lbEmpty: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingVertical: 24 },
  lbRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  lbRowMine: { backgroundColor: theme.surfaceAlt, borderRadius: 10, paddingHorizontal: 8 },
  lbRank: { color: theme.textMuted, fontSize: 14, fontWeight: "800", width: 26 },
  lbName: { flex: 1, color: theme.textPrimary, fontSize: 14.5, fontWeight: "600" },
  lbScore: { color: theme.primary, fontSize: 14.5, fontWeight: "800" },
});
