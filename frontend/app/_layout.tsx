import { Stack, usePathname } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { AuthProvider, useAuth } from "@/src/context/AuthContext";
import { SidebarProvider } from "@/src/context/SidebarContext";
import { SidebarMenuProvider } from "@/src/context/SidebarMenuContext";
import { NavBarProvider } from "@/src/context/NavBarContext";
import LeftSidebar from "@/src/components/LeftSidebar";
import LiquidTabBar from "@/src/components/LiquidTabBar";
import UsernameGate from "@/src/components/UsernameGate";

SplashScreen.preventAutoHideAsync();

function AuthedSidebar() {
  const { user } = useAuth();
  if (!user) return null;
  return <LeftSidebar />;
}

// Hide the bar on these immersive / modal-feel screens.
const HIDDEN_BAR_PREFIXES = [
  "/login", "/auth",
  "/customize-nav", "/customize-sidebar",
  "/chat/", // 1-1 / group chat thread is immersive
  "/post/", // post detail
  "/reels", // full-screen video
  "/eta/", "/g/", "/guide/", "/group/", "/user/", "/hashtag/",
  "/story/",
  "/listing/", // marketplace listing detail
  "/seller/",  // marketplace seller profile
  "/advertise",
  "/wallet",
  "/communities",
  "/c/",
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
  if (!user) return null;
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

  if (!loaded && !error) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: "#0A0A0A" }}>
      <SafeAreaProvider>
        <AuthProvider>
          <SidebarProvider>
            <NavBarProvider>
              <SidebarMenuProvider>
                <StatusBar style="light" />
                <View style={{ flex: 1 }}>
                  <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#0A0A0A" } }} />
                </View>
                <GlobalTabBar />
                <AuthedSidebar />
                <UsernameGate />
              </SidebarMenuProvider>
            </NavBarProvider>
          </SidebarProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
