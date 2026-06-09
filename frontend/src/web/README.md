# `src/web` — Vite + react-native-web + react-router stack

Scaffold for running the app **off Expo** on the web. It keeps every React
Native component (via `react-native-web`); only the **bundler** (Metro/Expo →
Vite) and **router** (expo-router → react-router-dom) change.

> ✅ **The web build is verified green** (`yarn install` + `yarn build:web`
> succeed; all ~600 modules bundle, `dist/` emitted). What's **not** yet
> confirmed is **runtime rendering** — a green build doesn't prove every screen
> paints in a browser, so do a `yarn dev` smoke-test and paste any console
> errors. Phases W3 (browser impls for the native-feature seams) and W4
> (cleanup) still remain.

## Files

| File | Role |
|---|---|
| `../../index.html` | HTML host, loads `main.tsx` |
| `../../vite.config.ts` | Vite + `react-native`→`react-native-web` alias, `@/*` alias, Flow strip |
| `main.tsx` | Entry: `createRoot().render(<RouterProvider/>)` (replaces `expo-router/entry`) |
| `RootShell.tsx` | App shell ported from `app/_layout.tsx` (providers, gates, tab bar, sidebar); `<Stack>` → `<Outlet/>` |
| `routes.tsx` | The route table — every `app/**` screen mapped to a URL |
| `../platform/navigation.tsx` | The navigation seam, now backed by react-router (was expo-router) |

## Run it

```bash
yarn install          # pulls vite, @vitejs/plugin-react, react-router-dom, ...
yarn dev              # vite dev server (http://localhost:8081)
yarn build:web        # production build -> dist/
yarn preview          # serve the build
```

## Known things to verify / likely first fixes

1. **RN deps with untranspiled Flow/JSX.** `vite.config.ts` strips Flow via
   Babel and pre-bundles RNW. Some RN libraries (gesture-handler, reanimated,
   svg, webview, safe-area-context) may need entries in `optimizeDeps.include`
   or an alias to their `.web` build. Add as the errors point them out.
2. **Module paths with `[ ]` / `( )`** in `routes.tsx` dynamic-import strings —
   Vite handles them, but confirm in the build.
3. **The `/` route** maps to the Map (tabs index). The old `app/index.tsx` entry
   gate ("open the user's first customized shortcut") is intentionally not a
   route to avoid a redirect loop; its auth bounce is handled by `AuthRedirect`
   in `RootShell`. Re-add the shortcut logic if you want it.
4. **`reanimated`** needs its Babel plugin; on web it often works without, but if
   animations throw, add `react-native-reanimated/plugin` via the Babel config.
5. **`router` singleton** (`platform/navigation.tsx`) uses the History API +
   `popstate`. The 2 call sites that use it outside components should be checked.
6. Once green: delete the dead expo-router files (`app/_layout.tsx`,
   `app/(tabs)/_layout.tsx`, `app/+html.tsx`), drop `"main": "expo-router/entry"`
   and the `expo*` deps, and give each `src/platform/*` seam a browser-API impl
   (Phase W3 in `../platform/MIGRATION_PLAN.md`).

The expo-router `app/**` screen files are still used as plain components — they
keep their default exports and get navigation/params through the seam, so they
don't change.
