/**
 * Video seam — browser implementation (web stack).
 *
 * Wraps an HTMLVideoElement to mirror the bits of expo-video the app uses:
 * useVideoPlayer(source, setup) with loop/muted/playbackRate/playing +
 * play/pause/replace, the <VideoView player=… /> component, and a `useEvent`
 * compatible shim (ReelVideo reads "playingChange").
 */
import React, { useEffect, useRef, useState } from "react";
import { View, type ViewProps } from "react-native";

type Source = string | { uri: string } | null | undefined;
const uriOf = (s: Source): string => (typeof s === "string" ? s : s?.uri || "");

class WebVideoPlayer {
  el: HTMLVideoElement;
  private _loop = false;
  private _muted = false;
  private _rate = 1;
  constructor(uri: string) {
    this.el = document.createElement("video");
    this.el.playsInline = true;
    (this.el as any).webkitPlaysInline = true;
    if (uri) this.el.src = uri;
  }
  set loop(v: boolean) { this._loop = v; this.el.loop = v; }
  get loop() { return this._loop; }
  set muted(v: boolean) { this._muted = v; this.el.muted = v; }
  get muted() { return this._muted; }
  set playbackRate(v: number) { this._rate = v; try { this.el.playbackRate = v; } catch {} }
  get playbackRate() { return this._rate; }
  get playing() { return !this.el.paused && !this.el.ended; }
  play() { this.el.play().catch(() => {}); }
  pause() { try { this.el.pause(); } catch {} }
  replace(source: Source) {
    const uri = uriOf(source);
    this.el.src = uri;
    this.el.load();
  }
  remove() { try { this.el.pause(); this.el.removeAttribute("src"); this.el.load(); } catch {} }
}

export function useVideoPlayer(source?: Source, setup?: (p: WebVideoPlayer) => void): WebVideoPlayer {
  const uri = uriOf(source);
  const ref = useRef<WebVideoPlayer | null>(null);
  if (!ref.current) {
    ref.current = new WebVideoPlayer(uri);
    setup?.(ref.current);
  }
  useEffect(() => () => { ref.current?.remove(); ref.current = null; }, []);
  return ref.current as WebVideoPlayer;
}

/** Minimal expo-style `useEvent` — supports the "playingChange" event the app uses. */
export function useEvent(
  player: WebVideoPlayer | null,
  _eventName: string,
  initial?: { isPlaying?: boolean },
): { isPlaying: boolean } {
  const [, force] = useState(0);
  useEffect(() => {
    const el = player?.el;
    if (!el) return;
    const bump = () => force((x) => x + 1);
    el.addEventListener("play", bump);
    el.addEventListener("pause", bump);
    el.addEventListener("ended", bump);
    return () => {
      el.removeEventListener("play", bump);
      el.removeEventListener("pause", bump);
      el.removeEventListener("ended", bump);
    };
  }, [player]);
  return { isPlaying: player?.playing ?? initial?.isPlaying ?? false };
}

type VideoViewProps = ViewProps & {
  player: WebVideoPlayer | null;
  contentFit?: "contain" | "cover" | "fill";
  nativeControls?: boolean;
};

export function VideoView({ player, style, contentFit = "contain", nativeControls = false, ...rest }: VideoViewProps) {
  const containerRef = useRef<any>(null);
  useEffect(() => {
    const c = containerRef.current as HTMLElement | null;
    const v = player?.el;
    if (!c || !v) return;
    v.style.width = "100%";
    v.style.height = "100%";
    v.style.objectFit = contentFit === "fill" ? "fill" : contentFit;
    v.controls = !!nativeControls;
    c.appendChild(v);
    return () => { if (v.parentNode === c) c.removeChild(v); };
  }, [player, contentFit, nativeControls]);
  return <View ref={containerRef} style={style} {...rest} />;
}
export default VideoView;
