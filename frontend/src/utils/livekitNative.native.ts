// Native (iOS/Android): register the react-native-webrtc globals so the
// livekit-client SDK works, and manage the audio session (routing, speaker).
//
// @livekit/react-native pulls in react-native-webrtc — a native module that is
// NOT bundled in Expo Go. So we require it LAZILY (never at module-load time)
// and expose nativeCallsSupported(): that lets the call screen show a friendly
// fallback in Expo Go instead of crashing the whole app while expo-router is
// building its route tree at startup.

let registered = false;

// True only in a dev/production build where the WebRTC native module is linked.
// In Expo Go the require throws (missing native module) and we catch it.
export function nativeCallsSupported(): boolean {
  try {
    require("@livekit/react-native");
    return true;
  } catch {
    return false;
  }
}

export async function setupNativeAudio(): Promise<void> {
  const { registerGlobals, AudioSession } = require("@livekit/react-native");
  if (!registered) {
    registerGlobals();
    registered = true;
  }
  await AudioSession.startAudioSession();
}

export async function teardownNativeAudio(): Promise<void> {
  try {
    require("@livekit/react-native").AudioSession.stopAudioSession();
  } catch {}
}
