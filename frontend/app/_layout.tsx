import { Stack, usePathname, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { Platform, View, useWindowDimensions } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { AuthProvider, useAuth } from "@/src/context/AuthContext";
import { SidebarProvider } from "@/src/context/SidebarContext";
import { SidebarMenuProvider } from "@/src/context/SidebarMenuContext";
import { NavBarProvider } from "@/src/context/NavBarContext";
import { ConfirmProvider } from "@/src/context/ConfirmContext";
import { NavHistoryProvider } from "@/src/context/NavHistoryContext";
import EdgeSwipe from "@/src/components/EdgeSwipe";
import WebNavGuard from "@/src/components/WebNavGuard";
import MobileOnlyGate from "@/src/components/MobileOnlyGate";
import MobileFrame from "@/src/components/MobileFrame";
import DesktopShell from "@/src/components/DesktopShell";
import WebPullToRefresh from "@/src/components/WebPullToRefresh";
import AppErrorBoundary from "@/src/components/AppErrorBoundary";
import { installWebAlertShim } from "@/src/lib/webAlertShim";
import { startWebUpdateWatcher } from "@/src/lib/webUpdate";
import LeftSidebar from "@/src/components/LeftSidebar";
import LiquidTabBar from "@/src/components/LiquidTabBar";
import UsernameGate from "@/src/components/UsernameGate";
import PolicyGate from "@/src/components/PolicyGate";
import PushManager from "@/src/components/PushManager";

// Silence two harmless, noisy web-only console messages so genuine errors
// aren't buried: "useNativeDriver is not supported" (React Native Web logs it
// for every Animated call and transparently falls back to JS animation) and
// "Cannot record touch end without a touch start" (its touch responder).
// Matched by exact text, so nothing else is hidden.
if (Platform.OS === "web" && typeof console !== "undefined") {
  const NOISE = ["useNativeDriver", "Cannot record touch end"];
  const wrap = (orig: (...a: any[]) => void) => (...args: any[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (NOISE.some((n) => first.includes(n))) return;
    orig(...args);
  };
  console.warn = wrap(console.warn.bind(console));
  console.error = wrap(console.error.bind(console));
}

// Make Alert.alert confirmations actually work on web (RN-Web ignores buttons).
installWebAlertShim();

SplashScreen.preventAutoHideAsync();

function AuthedSidebar() {
  const { user } = useAuth();
  if (!user) return null;
  return <LeftSidebar />;
}

// Routes a logged-out user is allowed to stay on (everything else bounces to
// /login). Without this, signing out while on a stacked screen (e.g.
// Notifications) leaves you stranded there.
const PUBLIC_PREFIXES = ["/login", "/auth", "/legal", "/oauth", "/eta/"];

function AuthRedirect() {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (loading || user) return;
    const isPublic = PUBLIC_PREFIXES.some((p) =>
      p.endsWith("/") ? pathname?.startsWith(p) : (pathname === p || pathname?.startsWith(p + "/")),
    );
    if (!isPublic) router.replace("/login");
  }, [user, loading, pathname, router]);
  return null;
}

// Hide the bar on these immersive / modal-feel screens.
const HIDDEN_BAR_PREFIXES = [
  "/login", "/auth",
  "/customize-nav", "/customize-sidebar",
  "/notifications", // reached from the feed bell; full-screen with its own back
  "/chat/", // 1-1 / group chat thread is immersive
  "/post/", // post detail
  "/reels", // full-screen video
  "/eta/", "/g/", "/guide/", "/group/", "/user/", "/hashtag/",
  "/story/",
  "/listing/", // marketplace listing detail
  "/my-listings", // seller's own listings manager
  "/seller/",  // marketplace seller profile
  "/advertise",
  "/wallet",
  "/activity", // "All activity" — pushed sub-screen of wallet with its own back
  "/money",
  "/pay-qr",
  "/pay-scan",
  "/pay/",
  "/account",
  "/developer",
  "/monetize",
  "/connected-apps",
  "/admin-revenue",
  "/admin-bot",
  "/admin-users",
  "/admin-audit",
  "/admin-payments",
  "/admin-support",
  "/admin-roadside",
  "/admin-render",
  "/documents", // documents & verification hub
  "/support", // support list
  "/support/", // ticket thread (reply bar)
  "/privacy",
  "/encryption-key",
  "/oauth/",
  "/legal/",
  // Communities (list and /c/<name> detail) keep the bottom nav bar — it's a
  // top-level section opened from the sidebar, like Home/Feed/Chat.
  "/+html",
];

function shouldShowBar(pathname: string) {
  if (!pathname) return false;
  // Hide on the various sub-paths that already have their own back UI
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
  const { width } = useWindowDimensions();
  if (!user) return null;
  // On desktop web the left nav rail (DesktopShell) replaces the floating pill.
  if (Platform.OS === "web" && width >= 900) return null;
  if (!shouldShowBar(pathname || "")) return null;
  return <LiquidTabBar />;
}

export default function RootLayout() {
  const [loaded, error] = useIconFonts();

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  // Web-update kill switch: hard-refresh to the latest deploy when the server's
  // build token changes (no-op on native).
  useEffect(() => startWebUpdateWatcher(), []);

  if (!loaded && !error) return null;

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
                        <DesktopShell>
                          <View style={{ flex: 1 }}>
                            {/* Web: instant transitions (the fade adds lag and jank
                                to every navigation). Native keeps the fade. */}
                            <AppErrorBoundary>
                              <Stack screenOptions={{ headerShown: false, animation: Platform.OS === "web" ? "none" : "fade", animationDuration: 220, contentStyle: { backgroundColor: "#0A0A0A" } }} />
                            </AppErrorBoundary>
                            {Platform.OS !== "web" && <EdgeSwipe />}
                          </View>
                        </DesktopShell>
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
