import React from "react";
import { Tabs, Redirect } from "expo-router";
import { View } from "react-native";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

export default function TabsLayout() {
  const { user, loading } = useAuth();

  if (loading) return null;
  if (!user) return <Redirect href="/login" />;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Tabs
        // The global LiquidTabBar lives in the root layout and uses
        // expo-router pathname-based active detection (not the Tabs state).
        // We disable the built-in bar here to avoid double bars.
        screenOptions={{
          headerShown: false,
          tabBarStyle: { display: "none" },
        }}
      >
        <Tabs.Screen name="index" options={{ title: "Map" }} />
        <Tabs.Screen name="feed" options={{ title: "Feed" }} />
        <Tabs.Screen name="messages" options={{ title: "Chat" }} />
        <Tabs.Screen name="groups" options={{ href: null }} />
        <Tabs.Screen name="marketplace" options={{ href: null }} />
        <Tabs.Screen name="profile" options={{ href: null }} />
        <Tabs.Screen name="directions" options={{ href: null }} />
        <Tabs.Screen name="favorites" options={{ href: null }} />
      </Tabs>
    </View>
  );
}
