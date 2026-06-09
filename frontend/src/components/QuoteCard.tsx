import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Image } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Post, mediaUri } from "@/src/api/client";
import { theme } from "@/src/theme";
import RichText from "./RichText";

export default function QuoteCard({ post }: { post: Post }) {
  const router = useRouter();
  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.85}
      onPress={() => router.push({ pathname: "/post/[id]", params: { id: post.id } })}
      testID={`quote-${post.id}`}
    >
      <View style={styles.head}>
        <View style={styles.avatar}>
          {post.author.picture ? (
            <Image source={{ uri: post.author.picture }} style={{ width: "100%", height: "100%" }} />
          ) : (
            <Text style={styles.avatarInit}>
              {(post.author.name?.[0] || "?").toUpperCase()}
            </Text>
          )}
        </View>
        <Text style={styles.name} numberOfLines={1}>{post.author.name}</Text>
      </View>
      {!!post.text && (
        <RichText
          text={post.text}
          style={styles.body}
          numberOfLines={6}
        />
      )}
      {post.media && post.media.length > 0 && (
        post.media[0].type === "video" ? (
          <View style={[styles.preview, styles.videoPreview]}>
            <Ionicons name="play" size={26} color="#fff" />
          </View>
        ) : (
          <Image
            source={{ uri: mediaUri(post.media[0]) }}
            style={styles.preview}
            resizeMode="cover"
          />
        )
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 10, borderRadius: 14,
    borderWidth: 1, borderColor: theme.border,
    padding: 12, gap: 6, backgroundColor: theme.surfaceAlt,
  },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  avatar: {
    width: 24, height: 24, borderRadius: 12, overflow: "hidden",
    backgroundColor: theme.primary, alignItems: "center", justifyContent: "center",
  },
  avatarInit: { color: "#fff", fontSize: 11, fontWeight: "700" },
  name: { color: theme.textPrimary, fontSize: 13, fontWeight: "800", flex: 1 },
  body: { fontSize: 14, color: theme.textPrimary },
  preview: { width: "100%", height: 140, borderRadius: 10, marginTop: 6 },
  videoPreview: { backgroundColor: theme.surface, alignItems: "center", justifyContent: "center" },
});
