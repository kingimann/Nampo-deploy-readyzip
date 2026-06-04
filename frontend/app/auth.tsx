import React, { useEffect } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

export default function AuthRedirect() {
  const router = useRouter();
  const { user, processSessionId, loading } = useAuth();
  const params = useLocalSearchParams<{ session_id?: string }>();

  useEffect(() => {
    (async () => {
      const sid = params.session_id;
      if (sid) {
        const ok = await processSessionId(sid);
        if (ok) {
          router.replace("/(tabs)");
          return;
        }
      }
      if (!loading) {
        router.replace(user ? "/(tabs)" : "/login");
      }
    })();
  }, [params.session_id, processSessionId, router, user, loading]);

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
