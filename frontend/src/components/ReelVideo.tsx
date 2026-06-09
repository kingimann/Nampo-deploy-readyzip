import React, { useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "@/src/platform/video";
import ReelPoster from "@/src/components/ReelPoster";

/** Native reel player (expo-video). Web uses ReelVideo.web.tsx (raw <video>). */
export default function ReelVideo({
  uri, active, paused, muted, rate = 1, poster, brand = true,
}: {
  uri: string;
  active: boolean;
  paused: boolean;
  muted: boolean;
  rate?: number;
  /** Cover image shown until the video starts playing. */
  poster?: string | null;
  /** When no poster is set, show the branded "OkaySpace" cover (vs plain black). */
  brand?: boolean;
}) {
  const player = useVideoPlayer(uri || "about:blank", (p) => { p.loop = true; p.muted = muted; });

  // Show the cover until the first frame actually renders. Once started, keep it
  // hidden even while paused so pausing freezes on the frame, not the cover.
  const { isPlaying } = useEvent(player, "playingChange", { isPlaying: player.playing });
  const [started, setStarted] = useState(false);
  useEffect(() => { if (isPlaying) setStarted(true); }, [isPlaying]);
  useEffect(() => { setStarted(false); }, [uri]);

  useEffect(() => {
    if (!uri) return;
    // Set muted synchronously before play so a freshly-mounted player can't emit
    // a frame of audio before the separate mute effect runs.
    try { player.muted = muted; } catch {}
    if (active && !paused) { try { player.play(); } catch {} }
    else { try { player.pause(); } catch {} }
    return () => { try { player.pause(); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, paused, player, uri]);

  useEffect(() => { try { player.muted = muted; } catch {} }, [muted, player]);
  useEffect(() => { try { player.playbackRate = rate; } catch {} }, [rate, player]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        nativeControls={false}
      />
      {!started && (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <ReelPoster uri={poster} brand={brand} />
        </View>
      )}
    </View>
  );
}
