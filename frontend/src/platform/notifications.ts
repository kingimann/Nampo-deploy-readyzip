/**
 * Notifications — internal seam over push/local notifications.
 * Pass-through to `expo-notifications` today; the eventual bare-RN swap (e.g.
 * @notifee/react-native + a push library) happens here. Part of the gradual
 * move off Expo (see ./README.md).
 */
export * from "expo-notifications";
