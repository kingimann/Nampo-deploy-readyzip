/** Device seam — browser-derived device info (web stack). */
const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
export const isDevice = true;
export const brand: string | null = null;
export const manufacturer: string | null = null;
export const modelName: string | null = ua || null;
export const osName: string | null = "web";
export const osVersion: string | null = null;
export const deviceName: string | null = null;
