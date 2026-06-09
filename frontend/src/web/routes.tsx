/**
 * Route table — react-router-dom equivalent of the expo-router `app/` tree.
 *
 * Each existing screen component (default export under `app/`) is lazy-loaded at
 * its URL. Dynamic segments `[x]` become `:x`. The `(tabs)` group is flattened
 * (no `(tabs)` in the URL), matching `buildHref`'s group-stripping.
 *
 * ⚠️ Untested scaffold. Verify against a running `vite dev`. Known things to
 * confirm:
 *   - The Map (tabs index) is mapped to "/"; the old `app/index.tsx` entry gate
 *     ("open the user's first customized shortcut") is NOT a route here to avoid
 *     a redirect loop — its auth bounce is covered by AuthRedirect in RootShell,
 *     but the "first shortcut" behavior may need re-adding.
 *   - Vite must resolve module paths containing `[ ]` and `( )` (it does, but
 *     check the build).
 */
import { lazy, type ReactNode } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import RootShell from "./RootShell";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const el = (loader: () => Promise<any>): ReactNode => {
  const C = lazy(loader);
  return <C />;
};

export const router = createBrowserRouter([
  {
    element: <RootShell />,
    children: [
      // ── Tabs (group flattened) ──────────────────────────────────────────
      { path: "/", element: el(() => import("@/app/(tabs)/index")) },
      { path: "/feed", element: el(() => import("@/app/(tabs)/feed")) },
      { path: "/messages", element: el(() => import("@/app/(tabs)/messages")) },
      { path: "/marketplace", element: el(() => import("@/app/(tabs)/marketplace")) },
      { path: "/groups", element: el(() => import("@/app/(tabs)/groups")) },
      { path: "/favorites", element: el(() => import("@/app/(tabs)/favorites")) },
      { path: "/directions", element: el(() => import("@/app/(tabs)/directions")) },
      { path: "/profile", element: el(() => import("@/app/(tabs)/profile")) },

      // ── Auth / legal / public ───────────────────────────────────────────
      { path: "/login", element: el(() => import("@/app/login")) },
      { path: "/auth", element: el(() => import("@/app/auth")) },
      { path: "/legal/:doc", element: el(() => import("@/app/legal/[doc]")) },
      { path: "/privacy", element: el(() => import("@/app/privacy")) },
      { path: "/oauth/authorize", element: el(() => import("@/app/oauth/authorize")) },
      { path: "/eta/:shareId", element: el(() => import("@/app/eta/[shareId]")) },

      // ── Social / content ────────────────────────────────────────────────
      { path: "/post/:id", element: el(() => import("@/app/post/[id]")) },
      { path: "/user/:name", element: el(() => import("@/app/user/[name]")) },
      { path: "/hashtag/:tag", element: el(() => import("@/app/hashtag/[tag]")) },
      { path: "/reels", element: el(() => import("@/app/reels")) },
      { path: "/search", element: el(() => import("@/app/search")) },
      { path: "/people", element: el(() => import("@/app/people")) },
      { path: "/connections", element: el(() => import("@/app/connections")) },
      { path: "/bookmarks", element: el(() => import("@/app/bookmarks")) },
      { path: "/notifications", element: el(() => import("@/app/notifications")) },
      { path: "/activity", element: el(() => import("@/app/activity")) },
      { path: "/story/:userId", element: el(() => import("@/app/story/[userId]")) },

      // ── Messaging / calls ───────────────────────────────────────────────
      { path: "/chat/:id", element: el(() => import("@/app/chat/[id]")) },
      { path: "/call/:id", element: el(() => import("@/app/call/[id]")) },

      // ── Communities / groups / guides ───────────────────────────────────
      { path: "/communities", element: el(() => import("@/app/communities")) },
      { path: "/c/:name", element: el(() => import("@/app/c/[name]")) },
      { path: "/g/:slug", element: el(() => import("@/app/g/[slug]")) },
      { path: "/group/:id", element: el(() => import("@/app/group/[id]")) },
      { path: "/group/:id/members", element: el(() => import("@/app/group/[id]/members")) },
      { path: "/guide/:id", element: el(() => import("@/app/guide/[id]")) },
      { path: "/games", element: el(() => import("@/app/games")) },
      { path: "/game/:id", element: el(() => import("@/app/game/[id]")) },

      // ── Marketplace ─────────────────────────────────────────────────────
      { path: "/listing/:id", element: el(() => import("@/app/listing/[id]")) },
      { path: "/seller/:id", element: el(() => import("@/app/seller/[id]")) },
      { path: "/my-listings", element: el(() => import("@/app/my-listings")) },
      { path: "/my-marketplace", element: el(() => import("@/app/my-marketplace")) },
      { path: "/advertise", element: el(() => import("@/app/advertise")) },
      { path: "/place/:id", element: el(() => import("@/app/place/[id]")) },
      { path: "/roadside", element: el(() => import("@/app/roadside")) },

      // ── Money / payments ────────────────────────────────────────────────
      { path: "/wallet", element: el(() => import("@/app/wallet")) },
      { path: "/money", element: el(() => import("@/app/money")) },
      { path: "/monetize", element: el(() => import("@/app/monetize")) },
      { path: "/add-bank", element: el(() => import("@/app/add-bank")) },
      { path: "/add-card", element: el(() => import("@/app/add-card")) },
      { path: "/pay/:id", element: el(() => import("@/app/pay/[id]")) },
      { path: "/pay-qr", element: el(() => import("@/app/pay-qr")) },
      { path: "/pay-scan", element: el(() => import("@/app/pay-scan")) },
      { path: "/verify-payouts", element: el(() => import("@/app/verify-payouts")) },

      // ── Forms ───────────────────────────────────────────────────────────
      { path: "/forms", element: el(() => import("@/app/forms")) },
      { path: "/forms/:id", element: el(() => import("@/app/forms/[id]")) },
      { path: "/f/:key", element: el(() => import("@/app/f/[key]")) },

      // ── Settings / account ──────────────────────────────────────────────
      { path: "/settings", element: el(() => import("@/app/settings")) },
      { path: "/account", element: el(() => import("@/app/account")) },
      { path: "/documents", element: el(() => import("@/app/documents")) },
      { path: "/encryption-key", element: el(() => import("@/app/encryption-key")) },
      { path: "/connected-apps", element: el(() => import("@/app/connected-apps")) },
      { path: "/developer", element: el(() => import("@/app/developer")) },
      { path: "/customize-nav", element: el(() => import("@/app/customize-nav")) },
      { path: "/customize-sidebar", element: el(() => import("@/app/customize-sidebar")) },
      { path: "/support", element: el(() => import("@/app/support")) },
      { path: "/support/:id", element: el(() => import("@/app/support/[id]")) },

      // ── Admin ───────────────────────────────────────────────────────────
      { path: "/admin-audit", element: el(() => import("@/app/admin-audit")) },
      { path: "/admin-badges", element: el(() => import("@/app/admin-badges")) },
      { path: "/admin-bot", element: el(() => import("@/app/admin-bot")) },
      { path: "/admin-integrations", element: el(() => import("@/app/admin-integrations")) },
      { path: "/admin-payments", element: el(() => import("@/app/admin-payments")) },
      { path: "/admin-render", element: el(() => import("@/app/admin-render")) },
      { path: "/admin-revenue", element: el(() => import("@/app/admin-revenue")) },
      { path: "/admin-roadside", element: el(() => import("@/app/admin-roadside")) },
      { path: "/admin-roadside-calls", element: el(() => import("@/app/admin-roadside-calls")) },
      { path: "/admin-settings", element: el(() => import("@/app/admin-settings")) },
      { path: "/admin-support", element: el(() => import("@/app/admin-support")) },
      { path: "/admin-users", element: el(() => import("@/app/admin-users")) },

      // ── Fallback ────────────────────────────────────────────────────────
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
