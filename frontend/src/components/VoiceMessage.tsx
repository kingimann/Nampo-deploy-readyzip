import React, { useEffect } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAudioPlayer, useAudioPlayerStatus } from "@/src/platform/audio";
import { theme } from "@/src/theme";

function fmt(ms?: number | null): string {
  if (!ms || ms < 0) return "0:00";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type Props = {
  uri: string;            // data URI or remote/file uri of the audio
  durationMs?: number | null;
  mine?: boolean;
  testID?: string;
};

/** A compact play/pause voice-note bubble with a progress bar. */
export default function VoiceMessage({ uri, durationMs, mine, testID }: Props) {
  const player = useAudioPlayer({ uri });
  const status = useAudioPlayerStatus(player);

  // When playback reaches the end, reset to the start so it can replay.
  useEffect(() => {
    if (status.didJustFinish) {
      player.seekTo(0);
      player.pause();
    }
  }, [status.didJustFinish, player]);

  const tint = mine ? "#fff" : theme.primary;
  const subTint = mine ? "rgba(255,255,255,0.75)" : theme.textMuted;
  const trackBg = mine ? "rgba(255,255,255,0.3)" : theme.border;

  const totalMs =
    (status.duration ? status.duration * 1000 : 0) || durationMs || 0;
  const playedMs = (status.currentTime || 0) * 1000;
  const pct = totalMs > 0 ? Math.min(1, playedMs / totalMs) : 0;

  const toggle = () => {
    if (status.playing) {
      player.pause();
    } else {
      player.play();
    }
  };

  const label = status.playing || playedMs > 0 ? fmt(playedMs) : fmt(totalMs);

  return (
    <View style={styles.row} testID={testID}>
      <TouchableOpacity onPress={toggle} style={styles.playBtn} testID={`${testID}-toggle`}>
        <Ionicons
          name={status.playing ? "pause" : "play"}
          size={18}
          color={tint}
        />
      </TouchableOpacity>
      <View style={styles.body}>
        <View style={[styles.track, { backgroundColor: trackBg }]}>
          <View style={[styles.fill, { backgroundColor: tint, width: `${pct * 100}%` }]} />
        </View>
        <Text style={[styles.time, { color: subTint }]}>{label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, width: 180 },
  playBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, gap: 4 },
  track: { height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4, borderRadius: 2 },
  time: { fontSize: 11, fontWeight: "600" },
});
