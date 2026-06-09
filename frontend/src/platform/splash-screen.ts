/** SplashScreen seam — no-op on web (the HTML shell handles first paint). */
export async function preventAutoHideAsync(): Promise<boolean> { return true; }
export async function hideAsync(): Promise<boolean> { return true; }
export function setOptions(_opts: any): void {}
