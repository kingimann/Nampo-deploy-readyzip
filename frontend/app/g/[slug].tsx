import React, { useEffect, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, Place, PublicGuide } from "@/src/api/client";
import { theme } from "@/src/theme";
import { useAuth } from "@/src/context/AuthContext";

export default function PublicGuideScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const [guide, setGuide] = useState<PublicGuide | null>(null);
  const [loading, setLoading] = useState(true);
  const [cloning, setCloning] = useState(false);
  const [cloned, setCloned] = useState(false);

  useEffect(() => {
    if (!slug) return;
    (async () => {
      try {
        const g = await api.getPublicGuide(slug);
        setGuide(g);
      } catch {} finally { setLoading(false); }
    })();
  }, [slug]);

  const clone = async () => {
    if (!user) { router.push("/login"); return; }
    if (!slug) return;
    setCloning(true);
    try {
      await api.clonePublicGuide(slug);
      setCloned(true);
    } catch {} finally { setCloning(false); }
  };

  if (loading) {
    return <View style={[styles.root, styles.center]}><ActivityIndicator color={theme.primary} /></View>;
  }
  if (!guide) {
    return (
      <SafeAreaView edges={["top"]} style={styles.root}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn}>
            <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
          </TouchableOpacity>
        </View>
        <View style={styles.center}><Text style={styles.emptyTitle}>Guide not found or private</Text></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="public-guide">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
      </View>

      <View style={styles.hero}>
        <View style={[styles.heroIcon, { backgroundColor: `${guide.color}25`, borderColor: guide.color }]}>
          <Ionicons name="bookmarks" size={36} color={guide.color} />
        </View>
        <Text style={styles.heroTitle}>{guide.name}</Text>
        <Text style={styles.heroOwner}>by {guide.owner.name}</Text>
        <Text style={styles.heroSub}>{guide.places.length} places · public guide</Text>

        <TouchableOpacity
          style={[styles.cloneBtn, cloned && { backgroundColor: theme.success }]}
          onPress={clone}
          disabled={cloning || cloned}
          testID="clone-guide-btn"
        >
          {cloning ? <ActivityIndicator color="#fff" /> : (
            <>
              <Ionicons name={cloned ? "checkmark" : "duplicate"} size={18} color="#fff" />
              <Text style={styles.cloneText}>
                {cloned ? "Saved to your library" : "Save to my library"}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      <FlatList
        data={guide.places}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        renderItem={({ item }: { item: Place }) => (
          <View style={styles.placeCard}>
            <View style={[styles.placeIcon, { backgroundColor: "rgba(59,130,246,0.15)" }]}>
              <Ionicons name="pin" size={18} color={theme.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.placeTitle} numberOfLines={1}>{item.title}</Text>
              {!!item.address && <Text style={styles.placeAddr} numberOfLines={1}>{item.address}</Text>}
              <Text style={styles.placeCoord}>
                {item.latitude.toFixed(4)}, {item.longitude.toFixed(4)}
              </Text>
            </View>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 8 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },

  hero: { alignItems: "center", paddingTop: 20, paddingBottom: 24, gap: 8 },
  heroIcon: {
    width: 88, height: 88, borderRadius: 22, borderWidth: 2,
    alignItems: "center", justifyContent: "center", marginBottom: 8,
  },
  heroTitle: { color: theme.textPrimary, fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  heroOwner: { color: theme.primary, fontSize: 14, fontWeight: "600" },
  heroSub: { color: theme.textSecondary, fontSize: 13 },
  cloneBtn: {
    flexDirection: "row", gap: 8, alignItems: "center",
    backgroundColor: theme.primary,
    paddingHorizontal: 20, paddingVertical: 12, borderRadius: 14,
    marginTop: 12,
  },
  cloneText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  emptyTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "700" },

  placeCard: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface, borderRadius: 14,
    borderWidth: 1, borderColor: theme.border,
    padding: 12,
  },
  placeIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  placeTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  placeAddr: { color: theme.textSecondary, fontSize: 12, marginTop: 2 },
  placeCoord: { color: theme.textMuted, fontSize: 11, marginTop: 2 },
});
