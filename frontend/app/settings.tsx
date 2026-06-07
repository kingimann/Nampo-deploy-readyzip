import React from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Image, Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useRouter, useFocusEffect } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

const DEFAULT_AVATAR =
  "https://images.unsplash.com/photo-1544005313-94ddf0286df2?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NTYxOTJ8MHwxfHNlYXJjaHwxfHxwb3J0cmFpdCUyMHBlcnNvbnxlbnwwfHx8fDE3ODA1NTgzMjh8MA&ixlib=rb-4.1.0&q=85";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuth();
  const [supportUnread, setSupportUnread] = React.useState(0);
  useFocusEffect(React.useCallback(() => {
    api.supportUnreadCount().then((r) => setSupportUnread(r.count || 0)).catch(() => {});
  }, []));

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
    icon, label, color = theme.primary, onPress, danger, last, badge,
  }: {
    icon: IconName; label: string; color?: string;
    onPress: () => void; danger?: boolean; last?: boolean; badge?: number;
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
      {!!badge && badge > 0 && (
        <View style={styles.badge}><Text style={styles.badgeText}>{badge > 9 ? "9+" : badge}</Text></View>
      )}
      {!danger && <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />}
    </TouchableOpacity>
  );

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="settings-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn} testID="settings-back">
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

        <Text style={styles.groupTitle}>Account</Text>
        <View style={styles.group}>
          <Row icon="shield-checkmark-outline" label="Account & security" color="#22C55E" onPress={() => router.push("/account")} />
          <Row icon="link-outline" label="Connected apps" color="#A855F7" onPress={() => router.push("/connected-apps")} />
          <Row icon="code-slash-outline" label="Developer API" color="#0EA5E9" onPress={() => router.push("/developer")} />
          <Row icon="megaphone-outline" label="Advertise" color="#F97316" onPress={() => router.push("/advertise")} />
          <Row icon="cash-outline" label="Monetize your site" color="#16A34A" onPress={() => router.push("/monetize")} last={user?.role !== "admin"} />
          {user?.role === "admin" && (
            <Row icon="people-circle-outline" label="Manage users (admin)" color="#F97316" onPress={() => router.push("/admin-users")} />
          )}
          {user?.role === "admin" && (
            <Row icon="card-outline" label="Payments & data (admin)" color="#0EA5E9" onPress={() => router.push("/admin-payments")} />
          )}
          {user?.role === "admin" && (
            <Row icon="bar-chart-outline" label="Ad revenue (admin)" color="#EAB308" onPress={() => router.push("/admin-revenue")} />
          )}
          {user?.role === "admin" && (
            <Row icon="ribbon-outline" label="Custom badges (admin)" color="#A855F7" onPress={() => router.push("/admin-badges")} />
          )}
          {user?.role === "admin" && (
            <Row icon="flask-outline" label="Test bot (admin)" color="#EC4899" onPress={() => router.push("/admin-bot")} />
          )}
          {user?.role === "admin" && (
            <Row icon="pulse-outline" label="Integrations & SDKs (admin)" color="#06B6D4" onPress={() => router.push("/admin-integrations")} last />
          )}
        </View>

        <Text style={styles.groupTitle}>General</Text>
        <View style={styles.group}>
          <Row icon="grid-outline" label="Customize navigation bar" color="#0EA5E9" onPress={() => router.push("/customize-nav")} />
          <Row icon="lock-closed-outline" label="Privacy" color="#14B8A6" onPress={() => router.push("/privacy")} />
          <Row icon="notifications-outline" label="Notifications" color="#EF4444" onPress={() => router.push("/notifications")} />
          <Row icon="bookmark-outline" label="Bookmarks" color={theme.primary} onPress={() => router.push("/bookmarks")} />
          <Row icon="people-outline" label="Connections" color="#7C3AED" onPress={() => router.push({ pathname: "/connections", params: { userId: user?.user_id || "", name: user?.name || "You", tab: "followers" } })} />
          <Row icon="location-outline" label="Saved places" color="#22C55E" onPress={() => router.push("/(tabs)/favorites")} />
          <Row icon="help-buoy-outline" label="Support & disputes" color="#06B6D4" badge={supportUnread} onPress={() => router.push("/support")} last />
        </View>

        <View style={[styles.group, { marginTop: 24 }]}>
          <Row icon="log-out-outline" label="Sign out" danger onPress={onSignOut} last />
        </View>

        <Text style={styles.version}>Nami App · v1.0.0</Text>
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
    flexDirection: "row", alignItems: "center", gap: 16,
    backgroundColor: theme.surface, borderRadius: 20,
    borderWidth: 1, borderColor: theme.border,
    padding: 22,
  },
  accAvatar: { width: 68, height: 68, borderRadius: 34, backgroundColor: theme.surfaceAlt },
  accName: { color: theme.textPrimary, fontSize: 20, fontWeight: "800" },
  accHandle: { color: theme.primary, fontSize: 14, fontWeight: "700", marginTop: 3 },
  accEmail: { color: theme.textMuted, fontSize: 13, marginTop: 3 },

  groupTitle: {
    color: theme.textMuted, fontSize: 13, fontWeight: "700",
    textTransform: "uppercase", letterSpacing: 0.5,
    marginTop: 30, marginBottom: 12, marginLeft: 6,
  },
  group: {
    backgroundColor: theme.surface, borderRadius: 18,
    borderWidth: 1, borderColor: theme.border,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row", alignItems: "center", gap: 16,
    paddingHorizontal: 18, paddingVertical: 20,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  rowIcon: { width: 42, height: 42, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  rowLabel: { flex: 1, color: theme.textPrimary, fontSize: 16.5, fontWeight: "600" },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: theme.error, alignItems: "center", justifyContent: "center", marginRight: 8 },
  badgeText: { color: "#fff", fontSize: 11.5, fontWeight: "800" },

  aboutRow: {
    flexDirection: "row", alignItems: "center", gap: 14,
    paddingHorizontal: 18, paddingVertical: 16,
  },
  aboutText: { color: theme.textSecondary, fontSize: 15 },

  version: { color: theme.textMuted, fontSize: 12, textAlign: "center", marginTop: 30 },
});
