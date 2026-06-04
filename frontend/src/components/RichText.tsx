/**
 * RichText - render text with #hashtag, @mention, and http(s) URL detection.
 * Tap hashtag => /hashtag/[tag]; tap mention => /user/[name]; tap url => Linking.
 */
import React from "react";
import { Text, StyleSheet, Linking, Platform } from "react-native";
import { useRouter } from "expo-router";
import { theme } from "@/src/theme";

const TOKEN_RE = /(#[A-Za-z0-9_]{1,50})|(@[A-Za-z0-9_]{1,30})|(https?:\/\/[^\s]+)/g;

export default function RichText({
  text, style, numberOfLines,
}: {
  text: string;
  style?: any;
  numberOfLines?: number;
}) {
  const router = useRouter();
  if (!text) return null;
  const parts: Array<{ kind: "text" | "tag" | "mention" | "url"; value: string; key: string }> = [];
  let lastEnd = 0; let idx = 0;
  text.replace(TOKEN_RE, (match, tag, mention, url, offset: number) => {
    if (offset > lastEnd) parts.push({ kind: "text", value: text.slice(lastEnd, offset), key: `t${idx++}` });
    if (tag) parts.push({ kind: "tag", value: match, key: `h${idx++}` });
    else if (mention) parts.push({ kind: "mention", value: match, key: `m${idx++}` });
    else if (url) parts.push({ kind: "url", value: match, key: `u${idx++}` });
    lastEnd = offset + match.length;
    return match;
  });
  if (lastEnd < text.length) parts.push({ kind: "text", value: text.slice(lastEnd), key: `t${idx++}` });

  return (
    <Text style={[styles.text, style]} numberOfLines={numberOfLines}>
      {parts.map((p) => {
        if (p.kind === "text") return <Text key={p.key}>{p.value}</Text>;
        if (p.kind === "url") {
          return (
            <Text
              key={p.key}
              style={styles.link}
              onPress={() => Linking.openURL(p.value).catch(() => {})}
            >
              {p.value}
            </Text>
          );
        }
        if (p.kind === "tag") {
          const tag = p.value.slice(1);
          return (
            <Text
              key={p.key}
              style={styles.link}
              onPress={() => router.push({ pathname: "/hashtag/[tag]", params: { tag } })}
            >
              {p.value}
            </Text>
          );
        }
        // mention
        const name = p.value.slice(1);
        return (
          <Text
            key={p.key}
            style={styles.link}
            onPress={() => router.push({ pathname: "/user/[name]", params: { name } })}
          >
            {p.value}
          </Text>
        );
      })}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: { color: theme.textPrimary, fontSize: 15, lineHeight: 20 },
  link: {
    color: theme.primary, fontWeight: "600",
    ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : {}),
  },
});
