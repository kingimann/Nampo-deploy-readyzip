# EAS (Expo Application Services) setup

This app is wired for **EAS Build** and **EAS Submit** on iOS and Android. The
repo contains everything that can live in version control; the only remaining
work is the parts that are tied to *your* accounts (Expo, Apple, Google) and
must be run with the CLI on a machine you're logged in on.

> **What's already done in the repo**
> - `eas.json` — `development`, `preview`, `preview:device` and `production`
>   build profiles + a `production` submit profile for both platforms.
> - `app.json` — `bundleIdentifier` / `package` (`com.okayspace.mobile`),
>   iOS `infoPlist` usage strings, Android permissions, all config plugins,
>   and `runtimeVersion` (policy `appVersion`) for OTA compatibility.
> - The backend URL (`EXPO_PUBLIC_BACKEND_URL=https://okayspace-v0vx.onrender.com`)
>   is baked into every build profile via `eas.json` → `build.base.env`.
> - `package.json` scripts for every common build / submit / update command.
> - `credentials/.gitignore` so store secrets are never committed.

---

## 1. Prerequisites

| You need | Why | Cost |
|---|---|---|
| An **Expo account** | Owns the EAS project, runs builds | Free tier works |
| **Apple Developer Program** membership | iOS builds + App Store submit | $99/yr |
| **Google Play Developer** account | Android submit | $25 once |
| `eas-cli` installed | Drives everything | — |

Install the CLI (global, not a project dependency):

```bash
npm install -g eas-cli
eas --version        # expect >= 13
```

All commands below are run from the `frontend/` directory.

---

## 2. One-time project link

```bash
npm run eas:login        # eas login   (your Expo credentials)
npm run eas:init         # eas init     (creates the EAS project + writes
                         #               extra.eas.projectId into app.json)
```

`eas init` is what assigns this app a **projectId** and links it to your Expo
account. Commit the `app.json` change it makes.

> If you build under an **organization** rather than a personal account, also
> add `"owner": "<your-expo-org>"` under `expo` in `app.json`.

---

## 3. Build profiles (`eas.json`)

| Profile | Distribution | Use it for |
|---|---|---|
| `development` | internal, **dev client** | Day-to-day dev with a custom dev client; iOS builds for the **simulator**, Android as **APK** |
| `preview` | internal | QA / TestFlight-style sharing; iOS **simulator** build, Android **APK** |
| `preview-device` | internal | Same as preview but a **real iOS device** build (needs registered UDIDs) |
| `production` | store | App Store / Play Store; Android **app-bundle**, build number auto-incremented |

Build:

```bash
npm run build:dev            # both platforms, development profile
npm run build:preview:ios    # one platform
npm run build:prod           # both platforms, production (store) builds
```

The first iOS build walks you through credentials interactively — let EAS
**generate and manage** the distribution certificate, provisioning profile and
push key (recommended). The first Android build offers to generate a keystore —
again, let EAS manage it. Everything is stored on EAS, nothing lands in git.

---

## 4. Submitting to the stores

### iOS — App Store Connect

1. Create the app record once in App Store Connect (matching bundle id
   `com.okayspace.mobile`) and note its **Apple ID number** (the `ascAppId`).
2. Create an **App Store Connect API key** (App Store Connect → Users and Access
   → Integrations → App Store Connect API). EAS uses this instead of your
   password; store it with `eas credentials` or let `eas submit` prompt you.
3. Fill the two placeholders in `eas.json` → `submit.production.ios`:
   - `ascAppId` → the app's Apple ID number
   - `appleTeamId` → your 10-character Apple Team ID
4. Submit:

   ```bash
   npm run submit:ios
   ```

### Android — Google Play

1. In Play Console create the app (package `com.okayspace.mobile`) and a
   **service account** with the *Release manager* role (Play Console → Setup →
   API access). Download its JSON key.
2. Save the key at `frontend/credentials/play-store-service-account.json`
   (already git-ignored — the path is referenced from `eas.json`).
3. The first upload to a track must be done manually in the Play Console; after
   that:

   ```bash
   npm run submit:android       # uploads to the "internal" track
   ```

   Change `track` in `eas.json` (`internal` → `alpha` / `beta` / `production`)
   as you graduate the release.

You can also build **and** submit in one shot:

```bash
eas build --profile production --platform ios --auto-submit
```

---

## 5. Over-the-air updates (EAS Update) — optional

`runtimeVersion` is already set, and each build profile declares a `channel`
(`development` / `preview` / `production`). To push JS/asset-only updates without
a new store build:

```bash
npx expo install expo-updates     # adds the OTA runtime (updates package-lock.json)
eas update:configure              # writes updates.url into app.json
```

Then publish:

```bash
npm run update:preview            # eas update --branch preview
npm run update:prod               # eas update --branch production
```

Map an update **branch** to a build **channel** once with
`eas channel:edit production --branch production` (the names already line up
here). Only the JS bundle and assets ship OTA — native/config changes still need
a new build.

> Adding `expo-updates` changes `package-lock.json`; commit the regenerated
> lockfile so the Render web build (`npm ci`) stays in sync.

---

## 6. Environment variables

Public, build-time values (anything the client reads) go under each profile's
`env` in `eas.json`. They're already inherited from `build.base.env`:

```json
"env": { "EXPO_PUBLIC_BACKEND_URL": "https://okayspace-v0vx.onrender.com" }
```

For **secret** values (never expose to the client) use EAS secrets instead:

```bash
eas secret:create --name MY_SECRET --value ... --scope project
```

Optional Cloudinary direct-upload (used for media) can be added the same way the
backend URL is, e.g. `EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME` /
`EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET`.

---

## 7. Quick reference

```bash
npm run eas:login            # log in to Expo
npm run eas:init             # link project (one time)
npm run build:dev            # dev-client build (both platforms)
npm run build:preview        # internal QA build
npm run build:prod           # store build
npm run submit:ios           # upload iOS build to App Store Connect
npm run submit:android       # upload Android build to Play (internal track)
npm run update:prod          # OTA push to production (after EAS Update setup)
npm run eas:doctor           # expo-doctor sanity check
```
