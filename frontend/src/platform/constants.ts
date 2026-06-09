/** Constants seam — minimal web shim (web stack). */
export enum ExecutionEnvironment {
  Bare = "bare",
  Standalone = "standalone",
  StoreClient = "storeClient",
}
const Constants = {
  // Never the Expo Go client on web — drives use-icon-fonts to skip CDN fonts.
  executionEnvironment: ExecutionEnvironment.Bare,
  expoConfig: null as any,
  expoGoConfig: null as any,
  manifest: null as any,
  manifest2: null as any,
  platform: { web: {} } as any,
  sessionId: "",
  isHeadless: false,
};
export default Constants;
