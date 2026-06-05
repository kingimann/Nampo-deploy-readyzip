import React from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Image, Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useRouter } from "expo-router";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

const DEFAULT_AVATAR =
  "https://images.unsplash.com/photo-1544005313-94ddf0286df2?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NTYxOTJ8MHwxfHNlYXJjaHwxfHxwb3J0cmFpdCUyMHBlcnNvbnxlbnwwfHx8fDE3ODA1NTgzMjh8MA&ixlib=rb-4.1.0&q=85";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuth();

  const onSignOut = () => {
    Alert.alert("Sign out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          await signOut();
          router.replace("/login");
        },
      },
    ]);
  };

  const Row = ({
    icon, label, color = theme.primary, onPress, danger, last,
  }: {
    icon: IconName; label: string; color?: string;
    onPress: () => void; danger?: boolean; last?: boolean;
  }) => (
    <TouchableOpacity
      style={[styles.row, last && { borderBottomWidth: 0 }]}
      onPress={onPress}
      activeOpacity={0.7}
      testID={`settings-row-${label}`}
    >
      <View style={[styles.rowIcon, { backgroundColor: (danger ? theme.error : color) + "22" }]}>
        <Ionicons name={icon} size={18} color={danger ? theme.error : color} />
      </View>
      <Text style={[styles.rowLabel, danger && { color: theme.error }]}>{label}</Text>
      {!danger && <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />}
    </TouchableOpacity>
  );

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="settings-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="settings-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Settings</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
      >
        <TouchableOpacity
          style={styles.account}
          onPress={() => router.push("/(tabs)/profile")}
          activeOpacity={0.85}
          testID="settings-account"
        >
          <Image source={{ uri: user?.picture || DEFAULT_AVATAR }} style={styles.accAvatar} />
          <View style={{ flex: 1 }}>
            <Text style={styles.accName} numberOfLines={1}>{user?.name || "Explorer"}</Text>
            {!!user?.username && <Text style={styles.accHandle} numberOfLines={1}>@{user.username}</Text>}
            {!!user?.email && <Text style={styles.accEmail} numberOfLines={1}>{user.email}</Text>}
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
        </TouchableOpacity>

        <Text style={styles.groupTitle}>General</Text>
        <View style={styles.group}>
          <Row icon="grid-outline" label="Customize navigation bar" color="#0EA5E9" onPress={() => router.push("/customize-nav")} />
          <Row icon="notifications-outline" label="Notifications" color="#EF4444" onPress={() => router.push("/notifications")} />
          <Row icon="bookmark-outline" label="Bookmarks" color={theme.primary} onPress={() => router.push("/bookmarks")} />
          <Row icon="people-outline" label="Connections" color="#7C3AED" onPress={() => router.push({ pathname: "/connections", params: { userId: user?.user_id || "", name: user?.name || "You", tab: "followers" } })} />
          <Row icon="location-outline" label="Saved places" color="#22C55E" onPress={() => router.push("/(tabs)/favorites")} last />
        </View>

        <Text style={styles.groupTitle}>About</Text>
        <View style={styles.group}>
          <View style={styles.aboutRow}><Ionicons name="map" size={18} color={theme.primary} /><Text style={styles.aboutText}>Powered by Mapbox</Text></View>
          <View style={styles.aboutRow}><Ionicons name="navigate" size={18} color={theme.primary} /><Text style={styles.aboutText}>Turn-by-turn navigation</Text></View>
          <View style={styles.aboutRow}><Ionicons name="bookmarks" size={18} color={theme.primary} /><Text style={styles.aboutText}>Shareable public guides</Text></View>
          <View style={styles.aboutRow}><Ionicons name="chatbubbles" size={18} color={theme.primary} /><Text style={styles.aboutText}>Chat with friends &amp; share places</Text></View>
        </View>

        <View style={styles.group}>
          <Row icon="log-out-outline" label="Sign out" danger onPress={onSignOut} last />
        </View>

        <Text style={styles.version}>Nampo · v1.0.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  backBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },

  account: {
    flexDirection: "row", alignItems: "center", gap: 14,
    backgroundColor: theme.surface, borderRadius: 18,
    borderWidth: 1, borderColor: theme.border,
    padding: 14,
  },
  accAvatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: theme.surfaceAlt },
  accName: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  accHandle: { color: theme.primary, fontSize: 13, fontWeight: "700", marginTop: 2 },
  accEmail: { color: theme.textMuted, fontSize: 12, marginTop: 2 },

  groupTitle: {
    color: theme.textMuted, fontSize: 12, fontWeight: "700",
    textTransform: "uppercase", letterSpacing: 0.5,
    marginTop: 22, marginBottom: 8, marginLeft: 6,
  },
  group: {
    backgroundColor: theme.surface, borderRadius: 16,
    borderWidth: 1, borderColor: theme.border,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row", alignItems: "center", gap: 14,
    paddingHorizontal: 14, paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  rowIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  rowLabel: { flex: 1, color: theme.textPrimary, fontSize: 15, fontWeight: "600" },

  aboutRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 14, paddingVertical: 11,
  },
  aboutText: { color: theme.textSecondary, fontSize: 14 },

  version: { color: theme.textMuted, fontSize: 12, textAlign: "center", marginTop: 24 },
});
