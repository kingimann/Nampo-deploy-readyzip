/** Clipboard seam — browser implementation (web stack). */
export async function setStringAsync(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for non-secure contexts.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
  }
}
export async function getStringAsync(): Promise<string> {
  try { return await navigator.clipboard.readText(); } catch { return ""; }
}
