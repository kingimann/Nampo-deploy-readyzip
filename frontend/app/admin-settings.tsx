import React from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

/** One home for every admin/staff tool, so the main Settings screen stays short. */
export default function AdminSettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const isStaff = isAdmin || user?.role === "mod";

  const Row = ({ icon, label, color, onPress, last }: {
    icon: any; label: string; color: string; onPress: () => void; last?: boolean;
  }) => (
    <TouchableOpacity
      style={[styles.row, last && { borderBottomWidth: 0 }]}
      onPress={onPress}
      testID={`admin-row-${label}`}
    >
      <View style={[styles.rowIcon, { backgroundColor: color }]}>
        <Ionicons name={icon} size={19} color="#fff" />
      </View>
      <Text style={styles.rowLabel}>{label}</Text>
      <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
    </TouchableOpacity>
  );

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="admin-settings-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn} testID="admin-settings-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Admin settings</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        {isAdmin && (
          <>
            <Text style={styles.groupTitle}>Moderation</Text>
            <View style={styles.group}>
              <Row icon="people-circle-outline" label="Manage users" color="#F97316" onPress={() => router.push("/admin-users")} />
              <Row icon="receipt-outline" label="Audit log" color="#64748B" onPress={() => router.push("/admin-audit")} last />
            </View>

            <Text style={styles.groupTitle}>Money & growth</Text>
            <View style={styles.group}>
              <Row icon="card-outline" label="Payments & data" color="#0EA5E9" onPress={() => router.push("/admin-payments")} />
              <Row icon="bar-chart-outline" label="Ad revenue" color="#EAB308" onPress={() => router.push("/admin-revenue")} />
              <Row icon="ribbon-outline" label="Custom badges" color="#A855F7" onPress={() => router.push("/admin-badges")} last />
            </View>

            <Text style={styles.groupTitle}>System</Text>
            <View style={styles.group}>
              <Row icon="flask-outline" label="Test bot" color="#EC4899" onPress={() => router.push("/admin-bot")} />
              <Row icon="pulse-outline" label="Integrations & SDKs" color="#06B6D4" onPress={() => router.push("/admin-integrations")} />
              <Row icon="cloud-outline" label="Render hosting" color="#8B5CF6" onPress={() => router.push("/admin-render")} last />
            </View>
          </>
        )}

        <Text style={styles.groupTitle}>Staff</Text>
        <View style={styles.group}>
          {isStaff && (
            <Row icon="construct-outline" label="Roadside verifications" color="#F59E0B" onPress={() => router.push("/admin-roadside")} />
          )}
          {isStaff && (
            <Row icon="help-buoy-outline" label="Support queue" color="#06B6D4" onPress={() => router.push("/admin-support")} last />
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  backBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  groupTitle: { color: theme.textMuted, fontSize: 12.5, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 22, marginBottom: 9, marginLeft: 6 },
  group: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  rowIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  rowLabel: { flex: 1, color: theme.textPrimary, fontSize: 15.5, fontWeight: "600" },
});
