/**
 * Audio seam — browser implementation (web stack).
 *
 * Playback via HTMLAudioElement, recording via MediaRecorder. Mirrors the parts
 * of the expo-audio API the app uses (useAudioPlayer/useAudioPlayerStatus and
 * useAudioRecorder/AudioModule/setAudioModeAsync/RecordingPresets) so call sites
 * are unchanged.
 */
import { useEffect, useRef, useState } from "react";

// ── Playback ────────────────────────────────────────────────────────────────
class WebAudioPlayer {
  el: HTMLAudioElement;
  constructor(uri: string) {
    this.el = new Audio(uri || undefined);
    this.el.preload = "metadata";
  }
  setUri(uri: string) {
    if (uri && this.el.src !== uri) this.el.src = uri;
  }
  play() { this.el.play().catch(() => {}); }
  pause() { try { this.el.pause(); } catch {} }
  seekTo(seconds: number) { try { this.el.currentTime = seconds; } catch {} }
  remove() { try { this.el.pause(); this.el.removeAttribute("src"); this.el.load(); } catch {} }
  get playing() { return !this.el.paused && !this.el.ended; }
  get currentTime() { return this.el.currentTime || 0; }
  get duration() { return Number.isFinite(this.el.duration) ? this.el.duration : 0; }
}

type Source = string | { uri: string } | null | undefined;
function uriOf(s: Source): string {
  return typeof s === "string" ? s : s?.uri || "";
}

export function useAudioPlayer(source?: Source): WebAudioPlayer {
  const uri = uriOf(source);
  const ref = useRef<WebAudioPlayer | null>(null);
  if (!ref.current) ref.current = new WebAudioPlayer(uri);
  useEffect(() => {
    ref.current?.setUri(uri);
  }, [uri]);
  useEffect(() => () => { ref.current?.remove(); ref.current = null; }, []);
  return ref.current as WebAudioPlayer;
}

export type AudioStatus = {
  playing: boolean;
  currentTime: number;
  duration: number;
  didJustFinish: boolean;
  isLoaded: boolean;
};

export function useAudioPlayerStatus(player: WebAudioPlayer | null): AudioStatus {
  const [, force] = useState(0);
  const finishedRef = useRef(false);
  useEffect(() => {
    const el = player?.el;
    if (!el) return;
    const bump = () => force((x) => x + 1);
    const onPlay = () => { finishedRef.current = false; bump(); };
    const onEnded = () => { finishedRef.current = true; bump(); };
    el.addEventListener("timeupdate", bump);
    el.addEventListener("durationchange", bump);
    el.addEventListener("loadedmetadata", bump);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", bump);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("timeupdate", bump);
      el.removeEventListener("durationchange", bump);
      el.removeEventListener("loadedmetadata", bump);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", bump);
      el.removeEventListener("ended", onEnded);
    };
  }, [player]);
  return {
    playing: player?.playing ?? false,
    currentTime: player?.currentTime ?? 0,
    duration: player?.duration ?? 0,
    didJustFinish: finishedRef.current,
    isLoaded: (player?.duration ?? 0) > 0,
  };
}

// ── Recording ───────────────────────────────────────────────────────────────
export const RecordingPresets = {
  HIGH_QUALITY: { extension: ".webm" },
  LOW_QUALITY: { extension: ".webm" },
};

function pickMimeType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  const MR: any = typeof MediaRecorder !== "undefined" ? MediaRecorder : null;
  if (!MR?.isTypeSupported) return undefined;
  return candidates.find((c) => MR.isTypeSupported(c));
}

class WebAudioRecorder {
  private stream: MediaStream | null = null;
  private mr: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  uri: string | null = null;

  async prepareToRecordAsync(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.uri = null;
    const mimeType = pickMimeType();
    this.mr = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.mr.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
  }
  record(): void { try { this.mr?.start(); } catch {} }
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      const mr = this.mr;
      if (!mr || mr.state === "inactive") { this.cleanup(); return resolve(); }
      mr.onstop = () => {
        const blob = new Blob(this.chunks, { type: mr.mimeType || "audio/webm" });
        this.uri = URL.createObjectURL(blob);
        this.cleanup();
        resolve();
      };
      try { mr.stop(); } catch { this.cleanup(); resolve(); }
    });
  }
  private cleanup() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

export function useAudioRecorder(_preset?: unknown): WebAudioRecorder {
  const ref = useRef<WebAudioRecorder | null>(null);
  if (!ref.current) ref.current = new WebAudioRecorder();
  return ref.current;
}

export const AudioModule = {
  async requestRecordingPermissionsAsync() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      return { granted: true, status: "granted", canAskAgain: true };
    } catch {
      return { granted: false, status: "denied", canAskAgain: false };
    }
  },
};

export async function setAudioModeAsync(_opts?: unknown): Promise<void> {
  /* no-op on web — the browser manages audio focus */
}
