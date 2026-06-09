/**
 * SecureStore — internal seam over encrypted key/value storage.
 * Pass-through to `expo-secure-store` today; the eventual bare-RN swap (e.g.
 * react-native-keychain) happens here. Part of the gradual move off Expo.
 */
export * from "expo-secure-store";
