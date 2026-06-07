import React, { useEffect, useState } from "react";
import { Platform, View, Text, StyleSheet, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";

// Width the mobile layout is designed for. On screens wider than BREAKPOINT
// (desktop / tablet web) we pin the whole app to a centred phone-width column so
// the mobile UI never stretches, reflows, or breaks — it always looks and
// navigates like the phone app, complete with a faux status bar so it reads as a
// device. On phones (and all native) this is a no-op passthrough.
const FRAME_MAX = 480;
const BREAKPOINT = 600;

export default function MobileFrame({ children }: { children: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const constrain = Platform.OS === "web" && width > BREAKPOINT;

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!constrain) return;
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, [constrain]);

  if (!constrain) return <View style={styles.full}>{children}</View>;

  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <View style={styles.backdrop}>
      <View style={styles.frame}>
        <View style={styles.statusbar}>
          <Text style={styles.clock}>{time}</Text>
          <View style={styles.statusIcons}>
            <Ionicons name="cellular" size={13} color={theme.textPrimary} />
            <Ionicons name="wifi" size={14} color={theme.textPrimary} />
            <Ionicons name="battery-full" size={16} color={theme.textPrimary} />
          </View>
        </View>
        <View style={styles.full}>{children}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  // Dark backdrop with a little breathing room so the column reads as a device.
  backdrop: { flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center", paddingVertical: 22 },
  // A floating, rounded phone-app window with a soft shadow.
  frame: {
    flex: 1,
    width: FRAME_MAX,
    maxWidth: "100%",
    alignSelf: "center",
    backgroundColor: theme.bg,
    overflow: "hidden",
    position: "relative",
    borderRadius: 30,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    shadowColor: "#000",
    shadowOpacity: 0.5,
    shadowRadius: 36,
    shadowOffset: { width: 0, height: 10 },
  },
  statusbar: {
    height: 30,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    backgroundColor: theme.bg,
  },
  clock: { color: theme.textPrimary, fontSize: 12.5, fontWeight: "700", letterSpacing: 0.3 },
  statusIcons: { flexDirection: "row", alignItems: "center", gap: 5 },
});
