import React, { useEffect } from "react";
import { StyleSheet } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";

/** Native reel player (expo-video). Web uses ReelVideo.web.tsx (raw <video>). */
export default function ReelVideo({
  uri, active, paused, muted,
}: {
  uri: string;
  active: boolean;
  paused: boolean;
  muted: boolean;
}) {
  const player = useVideoPlayer(uri || "about:blank", (p) => { p.loop = true; p.muted = muted; });

  useEffect(() => {
    if (!uri) return;
    if (active && !paused) { try { player.play(); } catch {} }
    else { try { player.pause(); } catch {} }
    return () => { try { player.pause(); } catch {} };
  }, [active, paused, player, uri]);

  useEffect(() => { try { player.muted = muted; } catch {} }, [muted, player]);

  return (
    <VideoView
      player={player}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      nativeControls={false}
    />
  );
}
