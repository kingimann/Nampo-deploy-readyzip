import React, { useMemo } from "react";
import { View, Image } from "react-native";
// Import the pure-JS encoder core only (not the package entry, which pulls
// Node fs / browser canvas renderers that break the Metro bundle).
import QRCode from "qrcode/lib/core/qrcode";

/**
 * Fully on-device QR code — generated with the pure-JS `qrcode` library and
 * rendered as plain Views (no external service, no native SVG dependency).
 * Works on web and native. An optional center `logo` (URL or data URI) is
 * overlaid on a white disc; high error-correction keeps it scannable.
 */
export default function QrCode({
  value, size = 232, dark = "#075E54", light = "#ffffff", logo,
}: {
  value: string;
  size?: number;
  dark?: string;
  light?: string;
  logo?: string;
}) {
  const data = useMemo(() => {
    if (!value) return null;
    try {
      const qr = QRCode.create(value, { errorCorrectionLevel: "H" });
      return { n: qr.modules.size, bits: qr.modules.data as Uint8Array | number[] };
    } catch {
      return null;
    }
  }, [value]);

  if (!data) return <View style={{ width: size, height: size, backgroundColor: light }} />;
  const { n, bits } = data;
  const cell = Math.max(1, Math.floor(size / n));
  const dim = cell * n;

  // Run-length encode each row so we render a handful of Views, not n×n.
  const rows: { on: boolean; len: number }[][] = [];
  for (let r = 0; r < n; r++) {
    const segs: { on: boolean; len: number }[] = [];
    let c = 0;
    while (c < n) {
      const on = !!bits[r * n + c];
      let len = 1;
      while (c + len < n && !!bits[r * n + c + len] === on) len++;
      segs.push({ on, len });
      c += len;
    }
    rows.push(segs);
  }

  return (
    <View style={{ width: dim, height: dim, backgroundColor: light }}>
      {rows.map((segs, r) => (
        <View key={r} style={{ flexDirection: "row", height: cell }}>
          {segs.map((s, i) => (
            <View key={i} style={{ width: cell * s.len, height: cell, backgroundColor: s.on ? dark : light }} />
          ))}
        </View>
      ))}
      {logo ? (
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }} pointerEvents="none">
          <View style={{ width: dim * 0.26, height: dim * 0.26, borderRadius: dim * 0.13, backgroundColor: light, alignItems: "center", justifyContent: "center", padding: 3 }}>
            <Image source={{ uri: logo }} style={{ width: "100%", height: "100%", borderRadius: dim * 0.12 }} />
          </View>
        </View>
      ) : null}
    </View>
  );
}
