import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { transform } from "esbuild";
import path from "node:path";

/**
 * Many `react-native`/`expo-*` packages publish **untranspiled JSX + Flow** in
 * their `node_modules` build output, which Rollup/esbuild's default parser can't
 * read. This plugin runs esbuild's JSX loader over those `.js` files so the web
 * build can consume them. (They ship real web implementations via
 * `Platform.select({ web: … })`, so transpiling them is correct.)
 */
function rnNodeModulesJsx(): Plugin {
  const NEEDS = /node_modules[/\\](expo-[^/\\]+|@expo[/\\][^/\\]+|react-native-[^/\\]+|@react-native[/\\][^/\\]+)[/\\].*\.js$/;
  return {
    name: "rn-node-modules-jsx",
    enforce: "pre",
    async transform(code, id) {
      if (!NEEDS.test(id)) return null;
      if (!code.includes("<") && !code.includes("@flow")) return null;
      const res = await transform(code, {
        loader: "jsx",
        jsx: "automatic",
        sourcefile: id,
        sourcemap: true,
      });
      return { code: res.code, map: res.map };
    },
  };
}

/**
 * Vite config for the web build (replaces Expo's Metro web bundler).
 *
 * Keeps every React Native component working by aliasing `react-native` ->
 * `react-native-web`. Screens render unchanged; only the bundler + router change.
 *
 * ⚠️ Untested scaffold. Expect to tune `optimizeDeps`/`commonjsOptions` for any
 * RN-flavored dependency that ships untranspiled Flow/JSX (react-native-web
 * itself is fine; some RN libs aren't). See src/web/README.md.
 */
export default defineConfig(({ mode }) => {
  // The app reads its config from `process.env.EXPO_PUBLIC_*` (backend URL,
  // Mapbox/Stripe/Cloudinary). Bake those into the build so they're available at
  // runtime (Vite doesn't expose process.env to the client by default).
  const env = loadEnv(mode, process.cwd(), "EXPO_PUBLIC_");
  const envDefines = Object.fromEntries(
    Object.entries(env).map(([k, v]) => [`process.env.${k}`, JSON.stringify(v)]),
  );
  return {
  plugins: [
    rnNodeModulesJsx(),
    react({
      // Let Babel strip Flow types from RN deps that ship untranspiled source.
      babel: {
        plugins: ["@babel/plugin-transform-flow-strip-types"],
      },
    }),
  ],
  resolve: {
    alias: {
      // RN component model on the web.
      "react-native": "react-native-web",
      // react-native-webview has no web build and reaches for native modules at
      // import (blank screen). Components use an <iframe> on web anyway.
      "react-native-webview": path.resolve(__dirname, "src/web/shims/react-native-webview.tsx"),
      // Mirror tsconfig "@/*": ["./*"].
      "@": path.resolve(__dirname, "."),
    },
    // Prefer .web.* platform files, then plain.
    extensions: [
      ".web.tsx",
      ".web.ts",
      ".web.jsx",
      ".web.js",
      ".tsx",
      ".ts",
      ".jsx",
      ".js",
      ".json",
    ],
  },
  define: {
    // RN/Expo code expects these globals.
    __DEV__: JSON.stringify(mode !== "production"),
    global: "window",
    "process.env.NODE_ENV": JSON.stringify(mode),
    // Specific EXPO_PUBLIC_* values (must come before the {} fallback below so
    // esbuild's longest-match picks them for `process.env.EXPO_PUBLIC_*`).
    ...envDefines,
    // Anything else read off process.env resolves to undefined (no ReferenceError).
    "process.env": "{}",
  },
  optimizeDeps: {
    // Pre-bundle RN-web and friends; esbuild handles their CJS/ESM interop.
    include: ["react-native-web", "react", "react-dom", "react-router-dom"],
    esbuildOptions: {
      // RN packages use the "react-native" condition; resolve to web shims.
      resolveExtensions: [".web.js", ".js", ".ts", ".tsx"],
      loader: { ".js": "jsx" },
    },
  },
  server: { port: 8081 },
  build: { outDir: "dist", target: "es2020" },
  };
});
