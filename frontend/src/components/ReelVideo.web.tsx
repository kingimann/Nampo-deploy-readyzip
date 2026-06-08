import React, { useEffect, useRef, useState } from "react";
import { View, StyleSheet } from "react-native";
import ReelPoster from "@/src/components/ReelPoster";

/**
 * Web reel player — a raw HTML5 <video> so we fully control the look:
 * full-bleed (object-fit: cover), looping, muted-autoplay, and **no native
 * controls** (expo-video's web VideoView renders a controlled, letterboxed
 * player which doesn't fit a TikTok-style reels UI).
 *
 * A cover image (custom thumbnail or the branded "Nami Social" default) is laid
 * over the video until it actually starts playing.
 */
export default function ReelVideo({
  uri, active, paused, muted, rate = 1, poster, brand = true,
}: {
  uri: string;
  active: boolean;
  paused: boolean;
  muted: boolean;
  rate?: number;
  poster?: string | null;
  brand?: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [started, setStarted] = useState(false);
  useEffect(() => { setStarted(false); }, [uri]);

  useEffect(() => {
    const v = ref.current;
    if (!v || !uri) return;
    if (active && !paused) { try { v.play()?.catch(() => {}); } catch {} }
    else { try { v.pause(); } catch {} }
    // Pause on unmount/recycle so a scrolled-away element can't keep playing audio.
    return () => { try { v.pause(); } catch {} };
  }, [active, paused, uri]);

  useEffect(() => { const v = ref.current; if (v) v.muted = muted; }, [muted]);
  useEffect(() => { const v = ref.current; if (v) { try { v.playbackRate = rate; } catch {} } }, [rate]);

  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "#000" }}>
      <video
        ref={ref}
        src={uri}
        loop
        muted={muted}
        playsInline
        onPlaying={() => setStarted(true)}
        // @ts-ignore — DOM attribute on web
        controls={false}
        style={{
          width: "100%", height: "100%",
          objectFit: "cover",
          background: "#000",
          display: "block",
        }}
      />
      {!started && (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <ReelPoster uri={poster} brand={brand} />
        </View>
      )}
    </div>
  );
}
