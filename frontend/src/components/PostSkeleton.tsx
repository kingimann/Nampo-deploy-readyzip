import React from "react";
import { View, StyleSheet } from "react-native";
import Skeleton from "@/src/components/Skeleton";

/** A post-shaped shimmer placeholder for the feed loading state. */
export default function PostSkeleton() {
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Skeleton style={styles.avatar} />
        <View style={{ flex: 1, gap: 6 }}>
          <Skeleton style={{ width: "45%", height: 13, borderRadius: 6 }} />
          <Skeleton style={{ width: "30%", height: 11, borderRadius: 6 }} />
        </View>
      </View>
      <Skeleton style={{ width: "92%", height: 12, borderRadius: 6, marginTop: 12 }} />
      <Skeleton style={{ width: "78%", height: 12, borderRadius: 6, marginTop: 8 }} />
      <Skeleton style={{ width: "100%", height: 170, borderRadius: 14, marginTop: 12 }} />
      <View style={styles.actions}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} style={{ width: 38, height: 16, borderRadius: 8 }} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: 14, paddingVertical: 14 },
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  actions: { flexDirection: "row", justifyContent: "space-between", marginTop: 14, paddingRight: 30 },
});
