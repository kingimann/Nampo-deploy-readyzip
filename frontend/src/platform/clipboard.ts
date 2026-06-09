/**
 * Clipboard — internal seam over the system clipboard.
 *
 * Part of the gradual move off Expo: app code imports from here instead of
 * `expo-clipboard` directly, so the day we swap the implementation (e.g. to
 * `@react-native-clipboard/clipboard`) it's a one-file change. Today this is a
 * thin pass-through to `expo-clipboard`, so behavior is unchanged.
 *
 * The named exports mirror the bits of the `expo-clipboard` API the app uses,
 * so call sites only need to change their import path.
 */
import * as ExpoClipboard from "expo-clipboard";

/** Copy text to the system clipboard. */
export async function setStringAsync(text: string): Promise<void> {
  await ExpoClipboard.setStringAsync(text);
}

/** Read the current text contents of the system clipboard. */
export async function getStringAsync(): Promise<string> {
  return ExpoClipboard.getStringAsync();
}
