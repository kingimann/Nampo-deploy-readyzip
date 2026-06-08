import React from "react";
import { View, Image, StyleSheet } from "react-native";
import { SvgXml } from "react-native-svg";

/**
 * Renders a captured form value that is an image data URI.
 *
 * Drawn signatures are SVG data URIs, which React Native's core <Image> cannot
 * decode on native (iOS/Android) — only on web. So for SVG we render with
 * react-native-svg's SvgXml (works on every platform); raster photos
 * (PNG/JPEG data URIs) keep using <Image>.
 */
export default function SignatureImage({ uri, style }: { uri: string; style?: any }) {
  if (uri.startsWith("data:image/svg+xml")) {
    const comma = uri.indexOf(",");
    const header = uri.slice(0, comma);
    let xml = uri.slice(comma + 1);
    try {
      xml = header.includes("base64")
        ? (typeof atob !== "undefined" ? atob(xml) : xml)
        : decodeURIComponent(xml);
    } catch {
      // leave xml as-is if decoding fails
    }
    return (
      <View style={[styles.box, style]}>
        <SvgXml xml={xml} width="100%" height="100%" />
      </View>
    );
  }
  return <Image source={{ uri }} style={style} resizeMode="contain" />;
}

const styles = StyleSheet.create({
  box: { overflow: "hidden", alignItems: "center", justifyContent: "center" },
});
