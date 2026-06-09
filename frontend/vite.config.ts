import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

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
export default defineConfig({
  plugins: [
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
    __DEV__: JSON.stringify(process.env.NODE_ENV !== "production"),
    global: "window",
    "process.env": {},
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
});
