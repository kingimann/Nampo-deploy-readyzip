import { Platform } from "react-native";
import { theme } from "@/src/theme";

/**
 * Frosted-glass surface — the shared look used by the floating bottom nav pill,
 * the left sidebar, the feed cards, and the marketplace/settings/wallet cards.
 * Real backdrop blur on web; a denser translucent fill on native (no blur API).
 *
 * Spread it into a style: `card: { borderRadius: 16, padding: 14, ...GLASS }`.
 * It provides backgroundColor + a 1px border, so don't also set those.
 */
export const GLASS: any =
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
