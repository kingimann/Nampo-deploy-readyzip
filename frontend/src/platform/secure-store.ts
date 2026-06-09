/** SecureStore seam — localStorage on web (same as expo-secure-store's web fallback). */
export async function getItemAsync(key: string): Promise<string | null> {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
export async function setItemAsync(key: string, value: string): Promise<void> {
  try { window.localStorage.setItem(key, value); } catch {}
}
export async function deleteItemAsync(key: string): Promise<void> {
  try { window.localStorage.removeItem(key); } catch {}
}
export async function isAvailableAsync(): Promise<boolean> {
  try { return typeof window !== "undefined" && !!window.localStorage; } catch { return false; }
}
