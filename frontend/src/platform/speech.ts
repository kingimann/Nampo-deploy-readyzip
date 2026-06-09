/** Speech seam — Web Speech API (web stack). */
type SpeakOptions = { rate?: number; pitch?: number; language?: string; volume?: number };
export function speak(text: string, options: SpeakOptions = {}): void {
  try {
    const u = new SpeechSynthesisUtterance(text);
    if (options.rate != null) u.rate = options.rate;
    if (options.pitch != null) u.pitch = options.pitch;
    if (options.volume != null) u.volume = options.volume;
    if (options.language) u.lang = options.language;
    window.speechSynthesis.speak(u);
  } catch {}
}
export function stop(): void {
  try { window.speechSynthesis.cancel(); } catch {}
}
export async function isSpeakingAsync(): Promise<boolean> {
  try { return window.speechSynthesis.speaking; } catch { return false; }
}
