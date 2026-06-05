# Building Nami App for iOS (App Store / TestFlight)

This app is built with Expo SDK 54. You can build it for iOS **without a Mac**
using EAS Build (Expo's cloud build service).

## One-time setup

1. **Accounts**
   - Free Expo account: https://expo.dev/signup
   - Apple Developer Program ($99/yr) — required for a real device, TestFlight,
     or the App Store: https://developer.apple.com/programs/
     (You can skip this and use the iOS *Simulator* profile for free.)

2. **Install the CLI and log in**
   ```bash
   npm i -g eas-cli
   eas login
   ```

3. **Link the project** (creates the EAS project + writes `extra.eas.projectId`)
   ```bash
   cd frontend
   eas init
   ```

4. **Set the Mapbox token as an EAS env var** (the backend URL is already wired
   in `eas.json`). The maps need this or they'll render blank:
   ```bash
   eas env:create --name EXPO_PUBLIC_MAPBOX_TOKEN --value "pk.YOUR_MAPBOX_TOKEN" --visibility plaintext --environment production --environment preview
   ```

## Build

- **Cloud build for the App Store / TestFlight** (needs the Apple account; EAS
  will offer to create the signing certs & provisioning profile for you):
  ```bash
  npm run ios:build          # = eas build --platform ios --profile production
  ```

- **Install-on-device / simulator test build** (no App Store):
  ```bash
  npm run ios:build:preview  # = eas build --platform ios --profile preview
  ```

A build takes ~15–20 min and finishes with a download link / QR code.

## Submit to TestFlight & the App Store

```bash
npm run ios:submit           # = eas submit --platform ios --profile production
```

Then in **App Store Connect** (https://appstoreconnect.apple.com): add the build
to TestFlight for testers, or fill in the store listing + screenshots and submit
for App Store review.

## Notes

- Bundle ID is `com.namiapp.mobile` (set in `app.json` → `ios.bundleIdentifier`).
  Change it before your first build if you want a different identifier — it's
  permanent once an app is created in App Store Connect.
- The native build talks to the production backend at
  `https://nampo-backend.onrender.com` (baked in via `eas.json`).
- Native builds use true GPS, so the map "follow me" / location accuracy is far
  better than the web build.
- Bump the user-facing version in `app.json` (`expo.version`) for each App Store
  release; the iOS build number auto-increments (`autoIncrement` in `eas.json`).
