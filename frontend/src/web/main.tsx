/**
 * Web entry point (replaces `expo-router/entry`).
 *
 * ⚠️ Untested scaffold — see src/web/README.md.
 */
import "react-native-url-polyfill/auto";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./routes";

const el = document.getElementById("root");
if (!el) throw new Error("#root not found");

createRoot(el).render(<RouterProvider router={router} />);
