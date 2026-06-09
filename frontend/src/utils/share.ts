import { Platform, Share } from "react-native";
import * as Clipboard from "expo-clipboard";

// The PUBLIC web origin to build shareable links from. On web we use the real
// origin (okayspace.ca); on native we fall back to the canonical domain. NOTE:
// this is the WEB app, not EXPO_PUBLIC_BACKEND_URL (that's the API server, which
// can't render a shareable page).
export const WEB_ORIGIN: string =
  Platform.OS === "web" && typeof window !== "undefined" && window.location?.origin
    ? window.location.origin
    : "https://okayspace.ca";

/** Build an absolute, shareable okayspace.ca link for an in-app path. */
export function canonicalUrl(path: string): string {
  return `${WEB_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Canonical path for a user profile — the vanity URL when a username exists. */
export function profilePath(user: { username?: string | null; name?: string | null; user_id?: string }): string {
  if (user.username) return `/${user.username}`;
  if (user.name) return `/user/${encodeURIComponent(user.name)}`;
  return `/user/${user.user_id || ""}`;
}

/**
 * Share a link via the OS share sheet (native + mobile web). Falls back to
 * copying the link to the clipboard when no share sheet is available (desktop
 * web). Returns what happened so callers can show a "Link copied" toast.
 */
export async function shareLink(
  path: string,
  opts?: { title?: string; message?: string },
): Promise<"shared" | "copied" | "failed"> {
  const url = canonicalUrl(path);
  try {
    if (Platform.OS === "web") {
      const nav: any = typeof navigator !== "undefined" ? navigator : null;
      if (nav?.share) {
        await nav.share({ title: opts?.title, text: opts?.message, url });
        return "shared";
      }
      await Clipboard.setStringAsync(url);
      return "copied";
    }
    await Share.share({
      url,
      message: opts?.message ? `${opts.message}\n\n${url}` : url,
      title: opts?.title,
    });
    return "shared";
  } catch {
    return "failed";
  }
}
