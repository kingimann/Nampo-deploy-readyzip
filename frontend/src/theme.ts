/**
 * App theme — WhatsApp-inspired dark palette.
 *
 * Surfaces:
 *   bg          deepest background (chat list / app body)
 *   surface     elevated card / sheet / row hover
 *   surfaceAlt  inputs, alt cards, hover states
 *
 * Accent (green) mirrors WhatsApp's signature.
 */
export const theme = {
  // ── Surfaces ────────────────────────────────────────────────────────────
  bg: "#0B141A",            // WhatsApp body background (very deep slate)
  surface: "#1F2C33",       // WhatsApp dark surface (chats list rows, tab bar)
  surfaceAlt: "#2A3942",    // hover / outgoing bubble / pressed pill
  surfaceGlass: "rgba(31, 44, 51, 0.92)",

  // ── Accent ──────────────────────────────────────────────────────────────
  primary: "#00A884",       // WhatsApp green
  primaryHover: "#06CF9C",
  primaryActive: "#008F6F",

  // ── Text ────────────────────────────────────────────────────────────────
  textPrimary: "#E9EDEF",   // off-white (WhatsApp primary text)
  textSecondary: "#AEBAC1", // secondary
  textMuted: "#8696A0",     // muted (timestamps, captions)

  // ── Borders / Dividers ─────────────────────────────────────────────────
  border: "rgba(134,150,160,0.18)",
  borderStrong: "rgba(134,150,160,0.32)",

  // ── Semantic ────────────────────────────────────────────────────────────
  success: "#00A884",
  warning: "#F6C455",
  error: "#F15C6D",
};

export const MAP_STYLES = [
  {
    key: "standard",
    label: "Standard",
    url: "mapbox://styles/mapbox/standard",
  },
  {
    key: "streets",
    label: "Streets",
    url: "mapbox://styles/mapbox/streets-v12",
  },
  {
    key: "satellite",
    label: "Satellite",
    url: "mapbox://styles/mapbox/satellite-streets-v12",
  },
  {
    key: "dark",
    label: "Dark",
    url: "mapbox://styles/mapbox/dark-v11",
  },
  {
    key: "outdoors",
    label: "Outdoors",
    url: "mapbox://styles/mapbox/outdoors-v12",
  },
] as const;

export type MapStyleKey = (typeof MAP_STYLES)[number]["key"];
