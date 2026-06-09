# `src/platform` — the seam for moving off Expo

This folder is a thin **abstraction layer** between the app and platform/native
APIs. App code imports native capabilities from here (e.g.
`import * as Clipboard from "@/src/platform/clipboard"`) instead of reaching for
`expo-*` packages directly.

## Why

We're migrating off Expo **gradually** (strangler-fig style). Each wrapper here
currently just re-exports the Expo implementation, so **behavior is unchanged and
nothing breaks today**. But once every call site imports through this seam,
swapping a dependency (e.g. `expo-clipboard` → a bare-React-Native clipboard
library) becomes a **one-file change** instead of editing every call site.

## Rules

- Keep the public API of each wrapper **small** — only expose what the app
  actually uses.
- Wrappers should be **pass-through** until we deliberately swap the
  implementation. Don't add behavior here unless it's genuinely cross-cutting.
- When migrating a new Expo dependency, add its wrapper here, point all call
  sites at it, then (later, on a machine with the native toolchain) swap the
  internals.

## Migration order (easiest → hardest)

1. ✅ **clipboard** (`expo-clipboard`)
2. ✅ Thin, low-usage libs: linear-gradient, status-bar, linking, constants,
   device, secure-store, speech, document-picker.
3. ✅ Media: image-picker, camera, audio, video.
4. Notifications, splash-screen, font.
5. **Icons** (`@expo/vector-icons`, ~115 files) → `react-native-vector-icons`.
6. **Routing** (`expo-router`, ~99 files) → React Navigation. The big one.
7. **Build system**: generate native `ios/`/`android/` projects, Metro/Babel
   config, drop `expo-router/entry`, re-wire the web target.

Steps 5–7 require a real build/native toolchain to verify and should each be
their own reviewed PR.
