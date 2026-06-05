import { useEffect } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@/src/context/AuthContext";
import { useNavBar } from "@/src/context/NavBarContext";
import { theme } from "@/src/theme";

export default function Index() {
  const router = useRouter();
  const { loading, user } = useAuth();
  const { ready, shortcuts } = useNavBar();

  useEffect(() => {
    if (loading) return;
    if (!user) { router.replace("/login"); return; }
    // Open the user's FIRST bottom-nav destination (their customized home),
    // not always the Map. Wait for the persisted nav bar to load first.
    if (!ready) return;
    const first = shortcuts[0]?.route || "/(tabs)";
    router.replace(first as any);
  }, [loading, user, ready, shortcuts, router]);

  return (
    <View style={styles.container} testID="splash-loader">
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
