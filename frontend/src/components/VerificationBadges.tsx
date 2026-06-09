import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";

type Flags = { id_verified?: boolean; phone_verified?: boolean; email_verified?: boolean };

const ITEMS: { key: keyof Flags; label: string; icon: string }[] = [
  { key: "id_verified", label: "ID", icon: "card-outline" },
  { key: "phone_verified", label: "Phone", icon: "call-outline" },
  { key: "email_verified", label: "Email", icon: "mail-outline" },
];

/**
 * Trust badges for a marketplace seller/buyer: shows whether their ID, phone,
 * and email are verified (green) or not (muted).
 */
export default function VerificationBadges({ user, size = "md" }: { user: Flags; size?: "sm" | "md" }) {
  const sm = size === "sm";
  return (
    <View style={styles.row}>
      {ITEMS.map((it) => {
        const ok = !!user[it.key];
        return (
          <View key={it.key as string} style={[styles.chip, sm && styles.chipSm, ok ? styles.chipOn : styles.chipOff]} testID={`verif-${it.key}-${ok ? "on" : "off"}`}>
            <Ionicons name={(ok ? "checkmark-circle" : it.icon) as any} size={sm ? 12 : 14} color={ok ? "#22C55E" : theme.textMuted} />
            <Text style={[styles.label, sm && styles.labelSm, { color: ok ? "#22C55E" : theme.textMuted }]}>{it.label}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 999, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 4 },
  chipSm: { paddingHorizontal: 7, paddingVertical: 3, gap: 3 },
  chipOn: { borderColor: "rgba(34,197,94,0.45)", backgroundColor: "rgba(34,197,94,0.10)" },
  chipOff: { borderColor: theme.border, backgroundColor: theme.surface },
  label: { fontSize: 12, fontWeight: "700" },
  labelSm: { fontSize: 11 },
});
