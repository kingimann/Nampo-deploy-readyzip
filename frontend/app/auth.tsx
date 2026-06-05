import React, { useEffect } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useAuth } from "@/src/context/AuthContext";
import { useNavBar } from "@/src/context/NavBarContext";
import { theme } from "@/src/theme";

export default function AuthRedirect() {
  const router = useRouter();
  const { user, processSessionId, loading } = useAuth();
  const { shortcuts, ready: navReady } = useNavBar();
  const params = useLocalSearchParams<{ session_id?: string }>();

  useEffect(() => {
    (async () => {
      if (!navReady) return;
      const home = (shortcuts[0]?.route || "/(tabs)") as any;
      const sid = params.session_id;
      if (sid) {
        const ok = await processSessionId(sid);
        if (ok) {
          router.replace(home);
          return;
        }
      }
      if (!loading) {
        router.replace(user ? home : "/login");
      }
    })();
  }, [params.session_id, processSessionId, router, user, loading, navReady, shortcuts]);

  return (
    <View style={styles.container} testID="auth-loader">
      <ActivityIndicator color={theme.primary} size="large" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.bg,
    alignItems: "center",
    justifyContent: "center",
  },
});
