import React from "react";
import { View } from "react-native";

// Desktop now gets the full-width website. We no longer pin the web app to a
// centred phone-width column (the old "forced app on PC" frame) — content fills
// the browser on every screen size. Kept as a thin passthrough so it can be
// re-enabled later if a dedicated phone-frame mode is ever wanted.
export default function MobileFrame({ children }: { children: React.ReactNode }) {
  return <View style={{ flex: 1 }}>{children}</View>;
}
