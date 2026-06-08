import React, { useEffect, useRef, useCallback, useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, Image,
  ScrollView, Pressable, Modal, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import { useSidebar } from "@/src/context/SidebarContext";
import { useSidebarMenu } from "@/src/context/SidebarMenuContext";
import { useAuth } from "@/src/context/AuthContext";
import { api } from "@/src/api/client";
import { theme } from "@/src/theme";

// Frosted-glass surface — matches the floating bottom nav pill (real blur on
// web, a denser translucent fill on native).
const GLASS: any =
  Platform.OS === "web"
    ? {
        backgroundColor: "rgba(31,44,51,0.72)",
        borderWidth: 1,
        borderColor: theme.borderStrong,
        backdropFilter: "blur(22px)",
        WebkitBackdropFilter: "blur(22px)",
      }
    : {
        backgroundColor: theme.surfaceGlass,
        borderWidth: 1,
        borderColor: theme.borderStrong,
      };

export function SidebarMenuButton({ light }: { light?: boolean } = {}) {
  const { setOpen } = useSidebar();
  return (
    <TouchableOpacity
      onPress={() => setOpen(true)}
      style={[styles.menuBtn, light && styles.menuBtnLight]}
      testID="sidebar-open"
      activeOpacity={0.8}
    >
      <Ionicons name="menu" size={22} color={light ? "#fff" : theme.textPrimary} />
    </TouchableOpacity>
  );
}

export default function LeftSidebar() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { open, setOpen } = useSidebar();
  const { items } = useSidebarMenu();
  const { user, signOut } = useAuth();
  const translateX = useRef(new Animated.Value(-1)).current;
  const [unreadNotif, setUnreadNotif] = useState(0);

  const refreshBadge = useCallback(async () => {
    try {
      const r = await api.unreadNotificationsCount();
      setUnreadNotif(r.count);
    } catch {}
  }, []);

  // Refresh whenever sidebar opens
  useEffect(() => {
    if (open) refreshBadge();
  }, [open, refreshBadge]);

  useFocusEffect(useCallback(() => { refreshBadge(); }, [refreshBadge]));

  useEffect(() => {
    Animated.timing(translateX, {
      toValue: open ? 0 : -1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [open, translateX]);

  const go = (route: string) => {
    setOpen(false);
    setTimeout(() => router.push(route as any), 150);
  };

  const tx = translateX.interpolate({
    inputRange: [-1, 0],
    outputRange: [-340, 0],   // fully off-screen incl. the 10px left float gap
  });
  const backdropOpacity = translateX.interpolate({
    inputRange: [-1, 0],
    outputRange: [0, 1],
  });

  return (
    <Modal
      visible={open}
      transparent
      animationType="none"
      onRequestClose={() => setOpen(false)}
      statusBarTranslucent
    >
      <View style={styles.root} pointerEvents={open ? "auto" : "none"}>
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
        </Animated.View>

        <Animated.View
          style={[styles.drawer, { top: insets.top + 10, bottom: insets.bottom + 10, transform: [{ translateX: tx }] }]}
        >
          {/* Brand */}
          <View style={styles.brandRow}>
            <Text style={styles.brandTitle}>Nami Social</Text>
            <Text style={styles.brandBeta}>beta</Text>
          </View>

          {/* Header — profile */}
          <TouchableOpacity
            style={styles.profileBlock}
            onPress={() => go("/(tabs)/profile")}
            activeOpacity={0.85}
            testID="side-profile"
          >
            <View style={styles.profileAvatar}>
              {user?.picture ? (
                <Image source={{ uri: user.picture }} style={styles.profileAvatarImg} />
              ) : (
                <Text style={styles.profileAvatarInit}>
                  {(user?.name?.[0] || "?").toUpperCase()}
                </Text>
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.profileName} numberOfLines={1}>{user?.name || "Nami App"}</Text>
              <Text style={styles.profileEmail} numberOfLines={1}>{user?.email || "View profile"}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
          </TouchableOpacity>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 16, paddingTop: 8 }}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionLabel}>Your shortcuts</Text>
              <TouchableOpacity onPress={() => go("/customize-sidebar")} testID="side-customize" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={styles.editText}>Edit</Text>
              </TouchableOpacity>
            </View>
            {items.map((it) => {
              const badge = it.id === "notifications" ? unreadNotif : 0;
              return (
                <TouchableOpacity
                  key={it.id}
                  style={styles.row}
                  onPress={() => go(it.route)}
                  activeOpacity={0.7}
                  testID={`side-${it.id}`}
                >
                  <View style={[styles.rowIcon, { backgroundColor: it.color + "22" }]}>
                    <Ionicons name={it.icon} size={20} color={it.color} />
                  </View>
                  <Text style={styles.rowLabel}>{it.label}</Text>
                  {badge > 0 && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{badge > 9 ? "9+" : String(badge)}</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}

            <View style={styles.divider} />

            {Platform.OS === "web" && (
              <TouchableOpacity
                style={styles.row}
                onPress={() => {
                  try {
                    sessionStorage.setItem("nami_refreshed", "1");
                    (window as any).location.reload();
                  } catch {}
                }}
                activeOpacity={0.7}
                testID="side-refresh"
              >
                <View style={[styles.rowIcon, { backgroundColor: theme.primary + "22" }]}>
                  <Ionicons name="refresh" size={20} color={theme.primary} />
                </View>
                <Text style={styles.rowLabel}>Refresh / get latest update</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={styles.row}
              onPress={async () => { setOpen(false); await signOut(); }}
              activeOpacity={0.7}
              testID="side-logout"
            >
              <View style={[styles.rowIcon, { backgroundColor: "#EF444422" }]}>
                <Ionicons name="log-out-outline" size={20} color="#EF4444" />
              </View>
              <Text style={[styles.rowLabel, { color: "#EF4444" }]}>Sign out</Text>
            </TouchableOpacity>
          </ScrollView>

          <View style={[styles.footer, { paddingBottom: 14 }]}>
            <Text style={styles.footerText}>Nami App · v1.0</Text>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.55)" },
  // Floating, rounded, frosted-glass panel — same surface as the bottom pill.
  drawer: {
    position: "absolute", left: 10,
    width: 300, borderRadius: 28,
    paddingHorizontal: 14, paddingTop: 16,
    ...GLASS,
    ...(Platform.OS === "web" ? ({ boxShadow: "0 12px 40px rgba(0,0,0,0.5)" } as object) : {
      shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 8 },
    }),
  },
  menuBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: "center", justifyContent: "center",
    ...GLASS,
  },
  menuBtnLight: { backgroundColor: "rgba(0,0,0,0.55)", borderColor: "rgba(255,255,255,0.2)" },

  brandRow: { flexDirection: "row", alignItems: "flex-start", gap: 5, paddingHorizontal: 4, marginBottom: 12 },
  brandTitle: { color: theme.textPrimary, fontSize: 22, fontWeight: "900", letterSpacing: -0.5 },
  brandBeta: { color: theme.primary, fontSize: 10, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 3 },
  profileBlock: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface, borderRadius: 16,
    borderWidth: 1, borderColor: theme.border,
    padding: 12, marginBottom: 12,
  },
  profileAvatar: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center", overflow: "hidden",
  },
  profileAvatarImg: { width: "100%", height: "100%" },
  profileAvatarInit: { color: "#fff", fontSize: 18, fontWeight: "800" },
  profileName: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  profileEmail: { color: theme.textMuted, fontSize: 12, marginTop: 2 },

  sectionHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 8,
  },
  sectionLabel: {
    color: theme.textMuted, fontSize: 11, fontWeight: "800",
    textTransform: "uppercase", letterSpacing: 0.6,
    paddingVertical: 8,
  },
  editText: { color: theme.primary, fontSize: 13, fontWeight: "700" },
  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingVertical: 12, paddingHorizontal: 8,
    borderRadius: 12,
  },
  rowIcon: {
    width: 36, height: 36, borderRadius: 12,
    alignItems: "center", justifyContent: "center",
  },
  rowLabel: { flex: 1, color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  badge: {
    minWidth: 22, height: 22, paddingHorizontal: 7, borderRadius: 11,
    backgroundColor: "#EF4444",
    alignItems: "center", justifyContent: "center",
  },
  badgeText: { color: "#fff", fontSize: 11, fontWeight: "800" },

  divider: {
    height: StyleSheet.hairlineWidth, backgroundColor: theme.border,
    marginVertical: 10, marginHorizontal: 8,
  },
  footer: { paddingHorizontal: 8, paddingTop: 8 },
  footerText: { color: theme.textMuted, fontSize: 11 },
});
