import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api } from "@/src/api/client";
import { setupNativeAudio, teardownNativeAudio } from "@/src/utils/livekitNative";
import VideoTile from "@/src/components/call/VideoTile";
import { theme } from "@/src/theme";

type Status = "connecting" | "ringing" | "connected" | "ended" | "error";

/**
 * 1:1 voice/video call screen (LiveKit). Web uses livekit-client directly and
 * mounts the media elements into DOM containers. Native needs a dev build with
 * the LiveKit RN SDK, so it shows a friendly fallback.
 */
export default function CallScreen() {
  const router = useRouter();
  const { id, name, video } = useLocalSearchParams<{ id: string; name?: string; video?: string }>();
  const isVideoCall = video === "1";

  const [status, setStatus] = useState<Status>("connecting");
  const [muted, setMuted] = useState(false);
  const [camOn, setCamOn] = useState(isVideoCall);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  // Native renders video from TrackReferences (web uses DOM refs instead).
  const [remoteRef, setRemoteRef] = useState<any>(null);
  const [localRef, setLocalRef] = useState<any>(null);
  const [seconds, setSeconds] = useState(0);
  const [errText, setErrText] = useState<string | null>(null);

  const roomRef = useRef<any>(null);
  const mediaEls = useRef<any[]>([]);
  const timerRef = useRef<any>(null);
  const remoteVideoRef = useRef<any>(null);
  const localVideoRef = useRef<any>(null);

  const isWeb = Platform.OS === "web";

  const cleanup = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    try { roomRef.current?.disconnect?.(); } catch {}
    roomRef.current = null;
    if (isWeb) {
      mediaEls.current.forEach((el) => { try { el.remove(); } catch {} });
      mediaEls.current = [];
    } else {
      teardownNativeAudio();
    }
  }, [isWeb]);

  const hangUp = useCallback(() => {
    cleanup();
    setStatus("ended");
    safeBack();
  }, [cleanup, router]);

  // Mount a LiveKit media track into a DOM container (web only).
  const mountTrack = useCallback((track: any, container: any, cover = true) => {
    if (Platform.OS !== "web" || !container) return null;
    const el = track.attach();
    el.autoplay = true;
    el.playsInline = true;
    if (track.kind === "video") {
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.objectFit = cover ? "cover" : "contain";
      // Clear any previous element in this container first.
      while (container.firstChild) container.removeChild(container.firstChild);
    }
    container.appendChild(el);
    mediaEls.current.push(el);
    return el;
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
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
        // Native: register WebRTC globals + start the audio session first.
        if (!isWeb) await setupNativeAudio();

        const LK: any = await import("livekit-client");
        const { Room, RoomEvent, Track } = LK;
        const room = new Room({ adaptiveStream: true, dynacast: true });
        roomRef.current = room;

        const onSubscribed = (track: any, publication: any, participant: any) => {
          if (track.kind === Track.Kind.Audio) {
            // Web mounts an <audio> element; native plays through the audio session.
            if (isWeb) mountTrack(track, remoteVideoRef.current ? remoteVideoRef.current : document.body);
          } else if (track.kind === Track.Kind.Video) {
            if (cancelled) return;
            setHasRemoteVideo(true);
            if (isWeb) mountTrack(track, remoteVideoRef.current);
            else setRemoteRef({ participant, publication, source: publication?.source });
          }
        };
        const onLocalPublished = (pub: any) => {
          if (pub?.track?.kind !== Track.Kind.Video) return;
          if (isWeb) mountTrack(pub.track, localVideoRef.current);
          else setLocalRef({ participant: room.localParticipant, publication: pub, source: pub?.source });
        };
        const markConnected = () => {
          if (cancelled) return;
          if ((room.remoteParticipants?.size ?? 0) > 0) {
            setStatus("connected");
            if (!timerRef.current) timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
          }
        };

        room.on(RoomEvent.TrackSubscribed, onSubscribed);
        room.on(RoomEvent.LocalTrackPublished, onLocalPublished);
        room.on(RoomEvent.ParticipantConnected, markConnected);
        room.on(RoomEvent.TrackUnsubscribed, (t: any) => {
          if (t.kind === Track.Kind.Video && !cancelled) { setHasRemoteVideo(false); setRemoteRef(null); }
        });
        room.on(RoomEvent.ParticipantDisconnected, () => {
          if (!cancelled && (room.remoteParticipants?.size ?? 0) === 0) hangUp();
        });
        room.on(RoomEvent.Disconnected, () => { if (!cancelled) hangUp(); });

        await room.connect(info.url, info.token);
        await room.localParticipant.setMicrophoneEnabled(true);
        if (isVideoCall) await room.localParticipant.setCameraEnabled(true);
        if (cancelled) { cleanup(); return; }
        setStatus((room.remoteParticipants?.size ?? 0) > 0 ? "connected" : "ringing");
        markConnected();
      } catch (e: any) {
        if (cancelled) return;
        setStatus("error");
        setErrText("Couldn't connect the call. Check your mic/camera permission and try again.");
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

  const toggleCam = async () => {
    const next = !camOn;
    setCamOn(next);
    try { await roomRef.current?.localParticipant?.setCameraEnabled?.(next); } catch {}
    if (!next) {
      if (Platform.OS === "web" && localVideoRef.current) {
        while (localVideoRef.current.firstChild) localVideoRef.current.removeChild(localVideoRef.current.firstChild);
      } else {
        setLocalRef(null);
      }
    }
  };

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const statusLabel =
    status === "connecting" ? "Connecting…"
    : status === "ringing" ? "Ringing…"
    : status === "connected" ? mmss
    : status === "ended" ? "Call ended"
    : "Couldn't connect";

  // Video tiles render on both platforms now (web via DOM, native via <VideoTrack>).
  const showVideoStage = isVideoCall && status !== "error";

  return (
    <SafeAreaView style={styles.root} testID="call-screen">
      <Stack.Screen options={{ headerShown: false }} />

      {/* Remote video fills the screen. */}
      {showVideoStage && (
        isWeb
          ? <View ref={remoteVideoRef} style={styles.remoteStage} pointerEvents="none" />
          : <VideoTile trackRef={remoteRef} style={styles.remoteStage} />
      )}

      {/* Avatar / status — shown for audio calls, or video before the peer's camera arrives. */}
      {(!showVideoStage || !hasRemoteVideo) && (
        <View style={styles.center} pointerEvents="none">
          <View style={styles.avatar}>
            <Text style={styles.avatarInit}>{(name?.[0] || "?").toUpperCase()}</Text>
          </View>
          <Text style={styles.name} numberOfLines={1}>{name || (isVideoCall ? "Video call" : "Voice call")}</Text>
          <View style={styles.statusRow}>
            {(status === "connecting" || status === "ringing") && <ActivityIndicator color={theme.textSecondary} size="small" />}
            <Text style={styles.status}>{statusLabel}</Text>
          </View>
          {!!errText && <Text style={styles.err}>{errText}</Text>}
        </View>
      )}

      {/* Local camera PiP */}
      {showVideoStage && camOn && (
        <View style={styles.pip}>
          {isWeb
            ? <View ref={localVideoRef} style={styles.pipInner} pointerEvents="none" />
            : <VideoTile trackRef={localRef} style={styles.pipInner} mirror />}
        </View>
      )}

      {/* Connected timer pill over video */}
      {showVideoStage && hasRemoteVideo && (
        <View style={styles.timerPill}><Text style={styles.timerText}>{statusLabel}</Text></View>
      )}

      <View style={styles.controls}>
        <View style={styles.ctrlBtn}>
          {(status === "connected" || status === "ringing") && (
            <TouchableOpacity onPress={toggleMute} testID="call-mute" activeOpacity={0.85} style={styles.ctrlInner}>
              <View style={[styles.circle, muted && styles.circleActive]}>
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

        <View style={styles.ctrlBtn}>
          {isVideoCall && (status === "connected" || status === "ringing") && (
            <TouchableOpacity onPress={toggleCam} testID="call-camera" activeOpacity={0.85} style={styles.ctrlInner}>
              <View style={[styles.circle, !camOn && styles.circleActive]}>
                <Ionicons name={camOn ? "videocam" : "videocam-off"} size={26} color="#fff" />
              </View>
              <Text style={styles.ctrlLabel}>{camOn ? "Camera" : "Camera off"}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B141A", justifyContent: "space-between" },
  remoteStage: { ...StyleSheet.absoluteFillObject, backgroundColor: "#000", overflow: "hidden" },
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
  pip: {
    position: "absolute", top: 50, right: 16, width: 96, height: 140, borderRadius: 14,
    overflow: "hidden", backgroundColor: "#000", borderWidth: 1, borderColor: "rgba(255,255,255,0.25)",
  },
  pipInner: { flex: 1 },
  timerPill: {
    position: "absolute", top: 52, alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5,
  },
  timerText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  controls: { flexDirection: "row", justifyContent: "space-around", alignItems: "flex-end", paddingBottom: 40, paddingHorizontal: 24 },
  ctrlBtn: { width: 88, alignItems: "center", minHeight: 64, justifyContent: "flex-end" },
  ctrlInner: { alignItems: "center", gap: 8 },
  circle: {
    width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center",
    backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border,
  },
  circleActive: { backgroundColor: theme.warning, borderColor: theme.warning },
  hangCircle: { backgroundColor: theme.error, borderColor: theme.error },
  ctrlLabel: { color: theme.textSecondary, fontSize: 12, fontWeight: "600", marginTop: 8 },
});
