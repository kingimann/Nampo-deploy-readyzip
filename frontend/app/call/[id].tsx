import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { api } from "@/src/api/client";
import { theme } from "@/src/theme";

type Status = "connecting" | "ringing" | "connected" | "ended" | "error";

/**
 * 1:1 voice call screen (LiveKit). Web uses livekit-client directly. Native
 * needs a dev build with the LiveKit RN SDK, so it shows a friendly fallback.
 */
export default function CallScreen() {
  const router = useRouter();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const [status, setStatus] = useState<Status>("connecting");
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [errText, setErrText] = useState<string | null>(null);
  const roomRef = useRef<any>(null);
  const audioEls = useRef<HTMLAudioElement[]>([]);
  const timerRef = useRef<any>(null);

  const cleanup = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    try { roomRef.current?.disconnect?.(); } catch {}
    roomRef.current = null;
    if (Platform.OS === "web") {
      audioEls.current.forEach((el) => { try { el.remove(); } catch {} });
      audioEls.current = [];
    }
  }, []);

  const hangUp = useCallback(() => {
    cleanup();
    setStatus("ended");
    router.back();
  }, [cleanup, router]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (Platform.OS !== "web") {
        // Native WebRTC needs the LiveKit RN SDK + a dev build.
        setStatus("error");
        setErrText("Voice calls run in the web app for now. A native build with calling is coming soon.");
        return;
      }
      let info;
      try {
        info = await api.callToken(String(id));
      } catch (e: any) {
        if (cancelled) return;
        setStatus("error");
        setErrText(
          String(e?.message || e).includes("503")
            ? "Calling isn't set up on this server yet."
            : "Couldn't start the call.",
        );
        return;
      }
      try {
        const LK: any = await import("livekit-client");
        const { Room, RoomEvent, Track } = LK;
        const room = new Room({ adaptiveStream: false, dynacast: false });
        roomRef.current = room;

        const attach = (track: any) => {
          if (track.kind === Track.Kind.Audio) {
            const el = track.attach();
            el.autoplay = true;
            (el as any).playsInline = true;
            document.body.appendChild(el);
            audioEls.current.push(el);
          }
        };
        const updatePresence = () => {
          if (cancelled) return;
          const others = room.remoteParticipants?.size ?? 0;
          if (others > 0 && status !== "connected") {
            setStatus("connected");
            if (!timerRef.current) timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
          }
        };

        room.on(RoomEvent.TrackSubscribed, attach);
        room.on(RoomEvent.ParticipantConnected, updatePresence);
        room.on(RoomEvent.ParticipantDisconnected, () => {
          if (cancelled) return;
          if ((room.remoteParticipants?.size ?? 0) === 0) hangUp();
        });
        room.on(RoomEvent.Disconnected, () => { if (!cancelled) hangUp(); });

        await room.connect(info.url, info.token);
        await room.localParticipant.setMicrophoneEnabled(true);
        if (cancelled) { cleanup(); return; }
        setStatus(room.remoteParticipants?.size > 0 ? "connected" : "ringing");
        updatePresence();
      } catch (e: any) {
        if (cancelled) return;
        setStatus("error");
        setErrText("Couldn't connect the call. Check your mic permission and try again.");
      }
    })();

    return () => { cancelled = true; cleanup(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const toggleMute = async () => {
    const next = !muted;
    setMuted(next);
    try { await roomRef.current?.localParticipant?.setMicrophoneEnabled?.(!next); } catch {}
  };

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const statusLabel =
    status === "connecting" ? "Connecting…"
    : status === "ringing" ? "Ringing…"
    : status === "connected" ? mmss
    : status === "ended" ? "Call ended"
    : "Couldn't connect";

  return (
    <SafeAreaView style={styles.root} testID="call-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.center}>
        <View style={styles.avatar}>
          <Text style={styles.avatarInit}>{(name?.[0] || "?").toUpperCase()}</Text>
        </View>
        <Text style={styles.name} numberOfLines={1}>{name || "Voice call"}</Text>
        <View style={styles.statusRow}>
          {(status === "connecting" || status === "ringing") && <ActivityIndicator color={theme.textSecondary} size="small" />}
          <Text style={styles.status}>{statusLabel}</Text>
        </View>
        {!!errText && <Text style={styles.err}>{errText}</Text>}
      </View>

      <View style={styles.controls}>
        <View style={styles.ctrlBtn}>
          {(status === "connected" || status === "ringing") && (
            <TouchableOpacity onPress={toggleMute} testID="call-mute" activeOpacity={0.85} style={{ alignItems: "center", gap: 8 }}>
              <View style={[styles.circle, muted && { backgroundColor: theme.warning, borderColor: theme.warning }]}>
                <Ionicons name={muted ? "mic-off" : "mic"} size={26} color="#fff" />
              </View>
              <Text style={styles.ctrlLabel}>{muted ? "Unmute" : "Mute"}</Text>
            </TouchableOpacity>
          )}
        </View>

        <TouchableOpacity style={styles.ctrlBtn} onPress={hangUp} testID="call-hangup" activeOpacity={0.85}>
          <View style={[styles.circle, styles.hangCircle]}>
            <Ionicons name="call" size={28} color="#fff" style={{ transform: [{ rotate: "135deg" }] }} />
          </View>
          <Text style={styles.ctrlLabel}>{status === "error" ? "Close" : "End"}</Text>
        </TouchableOpacity>

        <View style={styles.ctrlBtn} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B141A", justifyContent: "space-between" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, paddingHorizontal: 24 },
  avatar: {
    width: 120, height: 120, borderRadius: 60, backgroundColor: theme.surfaceAlt,
    alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: theme.primary,
  },
  avatarInit: { color: theme.textPrimary, fontSize: 48, fontWeight: "800" },
  name: { color: theme.textPrimary, fontSize: 24, fontWeight: "800", letterSpacing: -0.4 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  status: { color: theme.textSecondary, fontSize: 16, fontWeight: "600" },
  err: { color: theme.textMuted, fontSize: 13, textAlign: "center", lineHeight: 19, marginTop: 8 },
  controls: { flexDirection: "row", justifyContent: "space-around", alignItems: "flex-end", paddingBottom: 40, paddingHorizontal: 24 },
  ctrlBtn: { width: 80, alignItems: "center", gap: 8, minHeight: 64, justifyContent: "flex-end" },
  circle: {
    width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center",
    backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border,
  },
  hangCircle: { backgroundColor: theme.error, borderColor: theme.error },
  ctrlLabel: { color: theme.textSecondary, fontSize: 12, fontWeight: "600" },
});
