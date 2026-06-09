/**
 * RootShell — the web app shell, ported from `app/_layout.tsx`.
 *
 * Same provider tree, gates, global tab bar and sidebar as the expo-router root
 * layout, but the file-based `<Stack>` is replaced by react-router's `<Outlet/>`
 * (the matched route renders there). The two expo-router `_layout.tsx` files are
 * superseded by this + `routes.tsx`.
 *
 * ⚠️ Untested scaffold — see src/web/README.md.
 */
import { Suspense, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { View, ActivityIndicator } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { usePathname, useRouter } from "@/src/platform/navigation";
import { StatusBar } from "@/src/platform/status-bar";
import { AuthProvider, useAuth } from "@/src/context/AuthContext";
import { SidebarProvider } from "@/src/context/SidebarContext";
import { SidebarMenuProvider } from "@/src/context/SidebarMenuContext";
import { NavBarProvider } from "@/src/context/NavBarContext";
import { ConfirmProvider } from "@/src/context/ConfirmContext";
import { NavHistoryProvider } from "@/src/context/NavHistoryContext";
import WebNavGuard from "@/src/components/WebNavGuard";
import MobileOnlyGate from "@/src/components/MobileOnlyGate";
import MobileFrame from "@/src/components/MobileFrame";
import WebPullToRefresh from "@/src/components/WebPullToRefresh";
import LeftSidebar from "@/src/components/LeftSidebar";
import LiquidTabBar from "@/src/components/LiquidTabBar";
import UsernameGate from "@/src/components/UsernameGate";
import PolicyGate from "@/src/components/PolicyGate";
import PushManager from "@/src/components/PushManager";
import { theme } from "@/src/theme";

function AuthedSidebar() {
  const { user } = useAuth();
  if (!user) return null;
  return <LeftSidebar />;
}

const PUBLIC_PREFIXES = ["/login", "/auth", "/legal", "/oauth", "/eta/"];

function AuthRedirect() {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (loading || user) return;
    const isPublic = PUBLIC_PREFIXES.some((p) =>
      p.endsWith("/") ? pathname?.startsWith(p) : pathname === p || pathname?.startsWith(p + "/"),
    );
    if (!isPublic) router.replace("/login");
  }, [user, loading, pathname, router]);
  return null;
}

// Hide the bottom bar on immersive / modal-feel screens (same list as the
// expo-router layout).
const HIDDEN_BAR_PREFIXES = [
  "/login", "/auth", "/customize-nav", "/customize-sidebar", "/notifications",
  "/chat/", "/post/", "/reels", "/eta/", "/g/", "/guide/", "/group/", "/user/",
  "/hashtag/", "/story/", "/listing/", "/my-listings", "/seller/", "/advertise",
  "/wallet", "/activity", "/money", "/pay-qr", "/pay-scan", "/pay/", "/account",
  "/developer", "/monetize", "/connected-apps", "/admin-revenue", "/admin-bot",
  "/admin-users", "/admin-audit", "/admin-payments", "/admin-support",
  "/admin-roadside", "/admin-render", "/documents", "/support", "/support/",
  "/privacy", "/encryption-key", "/oauth/", "/legal/",
];

function shouldShowBar(pathname: string) {
  if (!pathname) return false;
  for (const p of HIDDEN_BAR_PREFIXES) {
    if (p.endsWith("/")) {
      if (pathname.startsWith(p)) return false;
    } else if (pathname === p) {
      return false;
    }
  }
  return true;
}

function GlobalTabBar() {
  const { user } = useAuth();
  const pathname = usePathname();
  if (!user) return null;
  if (!shouldShowBar(pathname || "")) return null;
  return <LiquidTabBar />;
}

const Fallback = () => (
  <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center" }}>
    <ActivityIndicator color={theme.primary} size="large" />
  </View>
);

export default function RootShell() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: "#0A0A0A" }}>
      <SafeAreaProvider>
        <AuthProvider>
          <SidebarProvider>
            <NavBarProvider>
              <SidebarMenuProvider>
                <ConfirmProvider>
                  <NavHistoryProvider>
                    <WebNavGuard />
                    <MobileOnlyGate>
                      <StatusBar style="light" />
                      <WebPullToRefresh />
                      <MobileFrame>
                        <View style={{ flex: 1 }}>
                          <Suspense fallback={<Fallback />}>
                            <Outlet />
                          </Suspense>
                        </View>
                        <GlobalTabBar />
                        <AuthedSidebar />
                        <UsernameGate />
                        <PolicyGate />
                      </MobileFrame>
                      <PushManager />
                      <AuthRedirect />
                    </MobileOnlyGate>
                  </NavHistoryProvider>
                </ConfirmProvider>
              </SidebarMenuProvider>
            </NavBarProvider>
          </SidebarProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
