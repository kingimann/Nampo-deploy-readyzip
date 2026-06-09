/** LinearGradient seam — CSS gradient over a react-native-web View. */
import React from "react";
import { View, type ViewProps } from "react-native";

type Point = { x: number; y: number };
type Props = ViewProps & {
  colors: string[];
  start?: Point;
  end?: Point;
  locations?: number[] | null;
  children?: React.ReactNode;
};

// Convert an expo-style start->end vector (x right, y down; 0..1) to a CSS angle
// (0deg points "to top").
function cssAngle(start: Point = { x: 0.5, y: 0 }, end: Point = { x: 0.5, y: 1 }): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

export function LinearGradient({ colors, start, end, locations, style, children, ...rest }: Props) {
  const stops = colors
    .map((c, i) => (locations && locations[i] != null ? `${c} ${Math.round(locations[i] * 100)}%` : c))
    .join(", ");
  const backgroundImage = `linear-gradient(${cssAngle(start ?? undefined, end ?? undefined)}deg, ${stops})`;
  return (
    <View {...rest} style={[style, { backgroundImage } as any]}>
      {children}
    </View>
  );
}
export default LinearGradient;
