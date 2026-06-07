import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

export type RestrictionKind = "posting" | "messaging" | "marketplace";

const COPY: Record<RestrictionKind, { title: string; body: string; subject: string }> = {
  posting: {
    title: "Posting disabled",
    body: "An administrator has disabled posting to the newsfeed on your account.",
    subject: "Appeal: posting disabled",
  },
  messaging: {
    title: "Messaging disabled",
    body: "An administrator has disabled messaging on your account.",
    subject: "Appeal: messaging disabled",
  },
  marketplace: {
    title: "Marketplace selling disabled",
    body: "An administrator has disabled creating Marketplace listings on your account.",
    subject: "Appeal: Marketplace disabled",
  },
};

/** True when the current user has the given feature disabled by an admin. */
export function isRestricted(
  user: { posting_disabled?: boolean; messaging_disabled?: boolean; marketplace_disabled?: boolean } | null | undefined,
  kind: RestrictionKind,
): boolean {
  if (!user) return false;
  if (kind === "posting") return !!user.posting_disabled;
  if (kind === "messaging") return !!user.messaging_disabled;
  return !!user.marketplace_disabled;
}

/**
 * Warning shown when an admin has disabled one of the user's features. Renders
 * nothing when the feature isn't restricted. Includes a "Dispute" action that
 * opens a pre-filled support ticket so the user can appeal.
 */
export default function RestrictionBanner({
  kind,
  style,
}: {
  kind: RestrictionKind;
  style?: any;
}) {
  const { user } = useAuth();
  const router = useRouter();
  if (!isRestricted(user, kind)) return null;
  const c = COPY[kind];
  return (
    <View style={[styles.wrap, style]} testID={`restriction-${kind}`}>
      <Ionicons name="warning" size={20} color={theme.warning} style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>{c.title}</Text>
        <Text style={styles.body}>{c.body}</Text>
      </View>
      <TouchableOpacity
        style={styles.btn}
        onPress={() => router.push({ pathname: "/support", params: { compose: "1", category: "account", subject: c.subject } })}
        testID={`dispute-${kind}`}
      >
        <Text style={styles.btnText}>Dispute</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: theme.warning + "1f",
    borderWidth: 1,
    borderColor: theme.warning + "55",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginHorizontal: 14,
    marginVertical: 8,
  },
  title: { color: theme.textPrimary, fontSize: 14.5, fontWeight: "800" },
  body: { color: theme.textSecondary, fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  btn: {
    backgroundColor: theme.warning,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  btnText: { color: "#1a1300", fontSize: 13, fontWeight: "900" },
});
