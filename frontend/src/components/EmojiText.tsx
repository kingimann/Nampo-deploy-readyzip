import React from "react";
import { View, Image } from "react-native";
import RichText from "./RichText";

const CODE_RE = /:([a-z0-9_]{2,32}):/g;

/**
 * Renders message text, swapping :shortcode: for custom-emoji images. Text
 * segments still go through RichText (@mentions / #tags / links). Falls back to
 * plain RichText when no custom emoji is present.
 */
export default function EmojiText({
  text, emojis, style, size = 22,
}: {
  text: string;
  emojis: Record<string, string>;
  style?: any;
  size?: number;
}) {
  if (!text) return null;
  const hasCustom = Object.keys(emojis).length > 0 && /:[a-z0-9_]{2,32}:/.test(text);
  if (!hasCustom) return <RichText text={text} style={style} />;

  const parts: Array<{ t: "text" | "emoji"; v: string }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  CODE_RE.lastIndex = 0;
  while ((m = CODE_RE.exec(text))) {
    const uri = emojis[m[1]];
    if (!uri) continue;
    if (m.index > last) parts.push({ t: "text", v: text.slice(last, m.index) });
    parts.push({ t: "emoji", v: uri });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ t: "text", v: text.slice(last) });
  if (!parts.some((p) => p.t === "emoji")) return <RichText text={text} style={style} />;

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
      {parts.map((p, i) =>
        p.t === "text" ? (
          <RichText key={i} text={p.v} style={style} />
        ) : (
          <Image key={i} source={{ uri: p.v }} style={{ width: size, height: size, marginHorizontal: 1 }} resizeMode="contain" />
        ),
      )}
    </View>
  );
}
