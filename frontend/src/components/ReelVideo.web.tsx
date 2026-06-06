import React, { useEffect, useRef } from "react";

/**
 * Web reel player — a raw HTML5 <video> so we fully control the look:
 * full-bleed (object-fit: cover), looping, muted-autoplay, and **no native
 * controls** (expo-video's web VideoView renders a controlled, letterboxed
 * player which doesn't fit a TikTok-style reels UI).
 */
export default function ReelVideo({
  uri, active, paused, muted, rate = 1,
}: {
  uri: string;
  active: boolean;
  paused: boolean;
  muted: boolean;
  rate?: number;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v || !uri) return;
    if (active && !paused) { try { v.play()?.catch(() => {}); } catch {} }
    else { try { v.pause(); } catch {} }
  }, [active, paused, uri]);

  useEffect(() => { const v = ref.current; if (v) v.muted = muted; }, [muted]);
  useEffect(() => { const v = ref.current; if (v) { try { v.playbackRate = rate; } catch {} } }, [rate, active, paused]);

  return (
    <video
      ref={ref}
      src={uri}
      loop
      muted={muted}
      autoPlay={active}
      playsInline
      // @ts-ignore — DOM attribute on web
      controls={false}
      style={{
        position: "absolute",
        top: 0, left: 0, right: 0, bottom: 0,
        width: "100%", height: "100%",
        objectFit: "cover",
        background: "#000",
      }}
    />
  );
}
