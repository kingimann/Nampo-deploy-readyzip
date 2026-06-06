// Web (and default) no-op: the browser provides WebRTC, so nothing to set up.
// Metro picks livekitNative.native.ts on iOS/Android, so @livekit/react-native
// is never pulled into the web bundle.
export async function setupNativeAudio(): Promise<void> {}
export async function teardownNativeAudio(): Promise<void> {}
