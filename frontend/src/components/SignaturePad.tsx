import React, { useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, PanResponder, LayoutChangeEvent, Platform } from "react-native";
import Svg, { Path } from "react-native-svg";
import { theme } from "@/src/theme";

/**
 * A draw-to-sign pad for the in-app form renderer.
 *
 * Pure React Native — no WebView. Strokes are captured with PanResponder (which
 * works on iOS, Android, AND react-native-web) and rendered with
 * react-native-svg, so one implementation runs on every platform. `onChange`
 * emits the signature as an SVG `data:` URL (empty string when cleared), which
 * renders directly in an <Image>/<img> and embeds in the PDF export.
 */
export default function SignaturePad({ onChange, height = 170 }: { onChange: (dataUrl: string) => void; height?: number }) {
  const [paths, setPaths] = useState<string[]>([]); // finished strokes
  const [current, setCurrent] = useState<string>(""); // in-progress stroke
  // Refs mirror state so the PanResponder closures (created once) always read
  // the latest values without being re-created on every render.
  const pathsRef = useRef<string[]>([]);
  const curRef = useRef<string>("");
  const widthRef = useRef(300);

  const emit = (all: string[]) => {
    const strokes = all.filter(Boolean);
    if (strokes.length === 0) { onChange(""); return; }
    const w = Math.round(widthRef.current) || 300;
    const inner = strokes
      .map((d) => `<path d="${d}" stroke="#111111" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`)
      .join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}"><rect width="100%" height="100%" fill="#ffffff"/>${inner}</svg>`;
    onChange(`data:image/svg+xml,${encodeURIComponent(svg)}`);
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          const { locationX, locationY } = e.nativeEvent;
          curRef.current = `M${locationX.toFixed(1)} ${locationY.toFixed(1)}`;
          setCurrent(curRef.current);
        },
        onPanResponderMove: (e) => {
          const { locationX, locationY } = e.nativeEvent;
          if (!curRef.current) curRef.current = `M${locationX.toFixed(1)} ${locationY.toFixed(1)}`;
          else curRef.current += ` L${locationX.toFixed(1)} ${locationY.toFixed(1)}`;
          setCurrent(curRef.current);
        },
        onPanResponderRelease: () => {
          if (!curRef.current) return;
          pathsRef.current = [...pathsRef.current, curRef.current];
          curRef.current = "";
          setPaths(pathsRef.current);
          setCurrent("");
          emit(pathsRef.current);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const clear = () => {
    pathsRef.current = [];
    curRef.current = "";
    setPaths([]);
    setCurrent("");
    onChange("");
  };

  const onLayout = (ev: LayoutChangeEvent) => {
    widthRef.current = ev.nativeEvent.layout.width;
  };

  return (
    <View>
      <View
        style={[styles.box, { height }, webNoScroll]}
        onLayout={onLayout}
        {...responder.panHandlers}
        testID="sig-pad"
      >
        {/* The SVG is purely visual — pointerEvents="none" so every touch/mouse
            event reaches the responder View above (and locationX/Y stay relative
            to the pad, not to a drawn path). */}
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Svg width="100%" height="100%">
            {paths.map((d, i) => (
              <Path key={i} d={d} stroke={theme.textPrimary} strokeWidth={2.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            ))}
            {current ? (
              <Path d={current} stroke={theme.textPrimary} strokeWidth={2.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            ) : null}
          </Svg>
        </View>
      </View>
      <TouchableOpacity style={styles.clear} onPress={clear} testID="sig-clear">
        <Text style={styles.clearText}>Clear</Text>
      </TouchableOpacity>
    </View>
  );
}

// On web, stop the browser from scrolling/zooming the page while the finger is
// drawing on the pad (otherwise a touch-drag scrolls instead of signing).
const webNoScroll = Platform.OS === "web" ? ({ touchAction: "none" } as any) : null;

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderColor: theme.border, borderRadius: 12, overflow: "hidden", backgroundColor: theme.surface },
  clear: { alignSelf: "flex-end", marginTop: 6, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: theme.border, borderRadius: 8 },
  clearText: { color: theme.textMuted, fontSize: 12.5, fontWeight: "700" },
});
