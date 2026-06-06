// Native (iOS/Android): register the react-native-webrtc globals so the
// livekit-client SDK works, and manage the audio session (routing, speaker).
// Requires a dev/production build — react-native-webrtc isn't in Expo Go.
import { registerGlobals, AudioSession } from "@livekit/react-native";

let registered = false;

export async function setupNativeAudio(): Promise<void> {
  if (!registered) {
    registerGlobals();
    registered = true;
  }
  await AudioSession.startAudioSession();
}

export async function teardownNativeAudio(): Promise<void> {
  try { await AudioSession.stopAudioSession(); } catch {}
}
