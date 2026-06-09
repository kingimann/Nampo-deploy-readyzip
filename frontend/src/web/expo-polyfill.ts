/**
 * Initialise Expo's `globalThis.expo` runtime on web.
 *
 * Expo modules (expo-audio/-video/-camera/-notifications) extend
 * `globalThis.expo.NativeModule` at module-evaluation time. Under Expo/Metro the
 * `expo-modules-core` web polyfill installs that global automatically; under Vite
 * the `.web` index of that polyfill isn't picked up, so the global is missing and
 * the app crashes at load with "Cannot read properties of undefined (reading
 * 'NativeModule')".
 *
 * This module installs the polyfill as a side effect. It MUST be imported before
 * anything that pulls an expo module — i.e. the very first import in main.tsx —
 * because ES module imports evaluate in source order, depth-first.
 */
import { installExpoGlobalPolyfill } from "expo-modules-core/src/polyfill/dangerous-internal";

installExpoGlobalPolyfill();
