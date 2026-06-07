# Mobile and Web

Nami is mobile-first and runs on iOS, Android, and the web. The web build is engineered to **feel like a native app**.

## Phone-width frame (web)
On screens wider than ~600px, `src/components/MobileFrame.tsx` pins the whole app to a centered **480px phone-width column** — a floating, rounded "device" with a soft shadow, a subtle **faux status bar** (live clock + signal/wifi/battery), and clipped overflow — so the mobile layout never stretches or breaks. On phones and all native it's a transparent passthrough.

## Installable PWA
`frontend/public/manifest.json` (standalone, portrait, theme color, icon) + apple-mobile-web-app / theme-color / apple-touch-icon meta in `app/+html.tsx`. Users can **Add to Home Screen** and launch fullscreen. A branded **launch splash** (`#nami-splash`) shows on load / cold start and is removed when the app mounts.

## App-feel
`app/+html.tsx` disables text selection (inputs/selectable text still work), tap-highlight, long-press callouts, image drag, and focus rings; hides scrollbars (screens scroll internally); enables momentum scroll; and avoids white flashes. Orientation is locked to **portrait** (`app.json`).

## Navigation
- **Bottom tab bar** (`LiquidTabBar`): customizable shortcuts around a permanent center **Search**, with big touch targets, a tinted **active pill**, and press/active **animations**. Long-press a tab → customize.
- **Left sidebar** drawer + **edge-swipe back** gesture (native): a Reanimated handle follows your finger; release past the trigger to go back (falls back to a threshold swipe if Reanimated isn't available).
- The bottom bar auto-hides on immersive/stacked screens.

## Animations
Tasteful motion via React Native's core `Animated` API (native driver). Reusable primitives in `src/components/`:
- **`FadeIn`** — mount fade + rise (with `animateKey` so list items animate only once).
- **`PressableScale`** — whole-element press scale (cards/buttons).
- **`BouncyPressable`** — content bounce that preserves layout (FABs/positioned elements).
- **`Skeleton`** / **`PostSkeleton`** — shimmer loading placeholders.

Applied to: the tab bar, FABs, the feed/marketplace list entrances, the PostCard like (heart pop), the feed loading state, and an app-wide screen-entrance fade.

### Reanimated
Reanimated 4 worklets are enabled via `frontend/babel.config.js` (`react-native-worklets/plugin` — the Reanimated-4 plugin, *not* the v3 `react-native-reanimated/plugin`). After pulling, run **`npx expo start --clear`**. The interactive swipe-back is the main Reanimated usage; everything else uses the core `Animated` API.

## Admin "mobile-only" gate
Admins can toggle a mode that blocks desktop web behind a "scan to open on your phone" QR screen (`MobileOnlyGate`).
