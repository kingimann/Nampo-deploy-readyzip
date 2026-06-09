/** Linking seam — browser URL handling (web stack). */
export async function getInitialURL(): Promise<string | null> {
  return typeof window !== "undefined" ? window.location.href : null;
}
export function addEventListener(
  _type: "url",
  handler: (event: { url: string }) => void,
): { remove: () => void } {
  const fn = () => handler({ url: window.location.href });
  window.addEventListener("popstate", fn);
  window.addEventListener("hashchange", fn);
  return {
    remove: () => {
      window.removeEventListener("popstate", fn);
      window.removeEventListener("hashchange", fn);
    },
  };
}
export async function openURL(url: string): Promise<void> {
  window.open(url, "_blank", "noopener,noreferrer");
}
export async function canOpenURL(_url: string): Promise<boolean> {
  return true;
}
export function createURL(pathOrUrl: string): string {
  try { return new URL(pathOrUrl, window.location.origin).href; } catch { return pathOrUrl; }
}
