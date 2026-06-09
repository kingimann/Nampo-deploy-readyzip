import React from "react";
import { Ionicons } from "@expo/vector-icons";

/** Twitter/Instagram-style blue verified checkmark. */
export default function VerifiedBadge({ size = 14, style }: { size?: number; style?: any }) {
  return (
    <Ionicons
      name="checkmark-circle"
      size={size}
      color="#1D9BF0"
      style={[{ marginLeft: 3 }, style]}
    />
  );
}
