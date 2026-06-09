import React from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { useNavBar, NAV_CATALOG, NavShortcut } from "@/src/context/NavBarContext";
import { theme } from "@/src/theme";

export default function CustomizeNavScreen() {
  const router = useRouter();
  const { ids, shortcuts, add, remove, move, reset, canAdd, canRemove } = useNavBar();

  const inBar = new Set(ids);
  const others: NavShortcut[] = NAV_CATALOG.filter((s) => !inBar.has(s.id));

  return (
    <SafeAreaView edges={["top"]} style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="customize-back">
          <Ionicons name="chevron-back" size={22} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Customize your shortcut bar</Text>
        <TouchableOpacity onPress={reset} testID="customize-reset">
          <Text style={styles.resetText}>Reset</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 80 }}>
        <Text style={styles.sectionTitle}>In your shortcut bar ({ids.length}/5)</Text>
        <Text style={styles.sectionSub}>Choose 3-5 shortcuts. Tap arrows to reorder, or remove with the red button.</Text>

        <View style={styles.list}>
          {shortcuts.map((s, i) => (
            <View key={s.id} style={styles.row} testID={`current-${s.id}`}>
              <View style={[styles.iconBox, styles.iconBoxActive]}>
                <Ionicons name={s.iconFilled} size={20} color={theme.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{s.label}</Text>
                <Text style={styles.rowSub} numberOfLines={1}>{s.route}</Text>
              </View>
              <TouchableOpacity
                onPress={() => move(s.id, -1)}
                style={[styles.arrowBtn, i === 0 && { opacity: 0.3 }]}
                disabled={i === 0}
                testID={`up-${s.id}`}
              >
                <Ionicons name="chevron-up" size={18} color={theme.textPrimary} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => move(s.id, 1)}
                style={[styles.arrowBtn, i === shortcuts.length - 1 && { opacity: 0.3 }]}
                disabled={i === shortcuts.length - 1}
                testID={`down-${s.id}`}
              >
                <Ionicons name="chevron-down" size={18} color={theme.textPrimary} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => remove(s.id)}
                style={[styles.removeBtn, !canRemove && { opacity: 0.3 }]}
                disabled={!canRemove}
                testID={`remove-${s.id}`}
              >
                <Ionicons name="remove" size={18} color={theme.error} />
              </TouchableOpacity>
            </View>
          ))}
        </View>

        {others.length > 0 && (
          <>
            <Text style={[styles.sectionTitle, { marginTop: 24 }]}>More shortcuts</Text>
            <Text style={styles.sectionSub}>
              {canAdd
                ? "Tap to add to your bar."
                : "Remove a shortcut above to add more."}
            </Text>
            <View style={styles.list}>
              {others.map((s) => (
                <TouchableOpacity
                  key={s.id}
                  style={[styles.row, !canAdd && { opacity: 0.5 }]}
                  onPress={() => add(s.id)}
                  disabled={!canAdd}
                  activeOpacity={0.85}
                  testID={`add-${s.id}`}
                >
                  <View style={styles.iconBox}>
                    <Ionicons name={s.iconOutline} size={20} color={theme.textPrimary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle}>{s.label}</Text>
                    <Text style={styles.rowSub} numberOfLines={1}>{s.route}</Text>
                  </View>
                  <View style={styles.addBtn}>
                    <Ionicons name="add" size={18} color={theme.primary} />
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
  },
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  title: { flex: 1, color: theme.textPrimary, fontSize: 15, fontWeight: "800", textAlign: "center", marginHorizontal: 12 },
  resetText: { color: theme.primary, fontSize: 13, fontWeight: "700" },

  sectionTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "800", marginBottom: 4 },
  sectionSub: { color: theme.textMuted, fontSize: 12, marginBottom: 12, lineHeight: 16 },

  list: { gap: 8 },
  row: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: theme.surface, borderRadius: 14,
    borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 12, paddingVertical: 10,
  },
  iconBox: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: theme.surfaceAlt,
    alignItems: "center", justifyContent: "center",
  },
  iconBoxActive: {
    backgroundColor: "rgba(0,168,132,0.12)",
    borderWidth: 1, borderColor: "rgba(0,168,132,0.35)",
  },
  rowTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  rowSub: { color: theme.textMuted, fontSize: 11, marginTop: 2 },
  arrowBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: theme.surfaceAlt,
    alignItems: "center", justifyContent: "center",
  },
  removeBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: "rgba(241,92,109,0.12)",
    borderWidth: 1, borderColor: "rgba(241,92,109,0.4)",
    alignItems: "center", justifyContent: "center",
  },
  addBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: "rgba(0,168,132,0.12)",
    borderWidth: 1, borderColor: "rgba(0,168,132,0.4)",
    alignItems: "center", justifyContent: "center",
  },
});
