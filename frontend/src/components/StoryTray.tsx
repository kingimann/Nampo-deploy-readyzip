import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, Alert, ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import * as ImagePicker from "@/src/platform/image-picker";
import { cloudinaryEnabled, uploadToCloudinary } from "@/src/api/cloudinary";
import { api, StoryTrayItem } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

export default function StoryTray({ onHide }: { onHide?: () => void }) {
  const { user } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<StoryTrayItem[]>([]);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.storiesTray();
      setItems(r);
    } catch {}
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const createStory = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { Alert.alert("Photos access needed"); return; }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"] as any,
        allowsEditing: false,
        quality: 0.7,
        base64: true,
        videoMaxDuration: 15,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      const isVideo = (asset.type || "").startsWith("video") || /\.(mp4|mov|webm)$/i.test(asset.uri);
      setCreating(true);
      let dataUri: string;
      if (cloudinaryEnabled()) {
        // Push to the CDN and store only the URL (the story media field accepts
        // any URI string the viewer can render).
        dataUri = (await uploadToCloudinary(asset.uri, isVideo ? "video" : "image")).url;
      } else {
        let b64 = asset.base64;
        if (!b64) {
          const r = await fetch(asset.uri);
          const blob = await r.blob();
          b64 = await new Promise<string>((res2, rej) => {
            const fr = new FileReader();
            fr.onerror = () => rej(new Error("read failed"));
            fr.onload = () => res2(String(fr.result).split(",")[1] || "");
            fr.readAsDataURL(blob);
          });
        }
        dataUri = `data:${isVideo ? "video/mp4" : "image/jpeg"};base64,${b64}`;
      }
      await api.createStory({
        media: {
          type: isVideo ? "video" : "image",
          base64: dataUri,
          duration_ms: asset.duration ? asset.duration : undefined,
        },
        caption: "",
      });
      await load();
    } catch (e: any) {
      Alert.alert("Couldn't post story", e?.message || "Try again.");
    } finally {
      setCreating(false);
    }
  };

  const mine = items.find((i) => i.user_id === user?.user_id);
  const others = items.filter((i) => i.user_id !== user?.user_id);

  return (
    <View style={styles.wrap}>
      {!!onHide && (
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>Stories</Text>
          <TouchableOpacity onPress={onHide} hitSlop={10} testID="stories-hide" style={styles.hideBtn}>
            <Ionicons name="eye-off-outline" size={15} color={theme.textMuted} />
            <Text style={styles.hideText}>Hide</Text>
          </TouchableOpacity>
        </View>
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {/* Your story (create / view) */}
        <TouchableOpacity
          style={styles.item}
          onPress={() => mine ? router.push(`/story/${user?.user_id}` as any) : createStory()}
          activeOpacity={0.85}
          testID="story-mine"
        >
          <View style={[styles.avatarRing, mine?.has_unviewed && styles.avatarRingActive]}>
            <View style={styles.avatarInner}>
              {user?.picture
                ? <Image source={{ uri: user.picture }} style={styles.avatarImg} />
                : <Text style={styles.avatarInit}>{(user?.name?.[0] || "?").toUpperCase()}</Text>}
            </View>
            {!mine && (
              <View style={styles.plusBadge}>
                {creating ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Ionicons name="add" size={14} color="#fff" />
                )}
              </View>
            )}
          </View>
          <Text style={styles.label} numberOfLines={1}>
            {mine ? "Your story" : "Add story"}
          </Text>
        </TouchableOpacity>

        {/* Others */}
        {others.map((it) => (
          <TouchableOpacity
            key={it.user_id}
            style={styles.item}
            onPress={() => router.push(`/story/${it.user_id}` as any)}
            activeOpacity={0.85}
            testID={`story-${it.user_id}`}
          >
            <View style={[styles.avatarRing, it.has_unviewed && styles.avatarRingActive]}>
              <View style={styles.avatarInner}>
                {it.user_picture
                  ? <Image source={{ uri: it.user_picture }} style={styles.avatarImg} />
                  : <Text style={styles.avatarInit}>{(it.user_name?.[0] || "?").toUpperCase()}</Text>}
              </View>
            </View>
            <Text style={styles.label} numberOfLines={1}>{it.user_name}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const RING = 64;
const styles = StyleSheet.create({
  wrap: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border, marginBottom: 6 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingBottom: 6 },
  headerTitle: { color: theme.textSecondary, fontSize: 13, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  hideBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  hideText: { color: theme.textMuted, fontSize: 12.5, fontWeight: "700" },
  row: { gap: 14, paddingHorizontal: 12 },
  item: { alignItems: "center", width: 70 },
  avatarRing: {
    width: RING, height: RING, borderRadius: RING / 2,
    padding: 2, backgroundColor: theme.surfaceAlt,
    alignItems: "center", justifyContent: "center", position: "relative",
  },
  avatarRingActive: {
    backgroundColor: "transparent",
    borderWidth: 2.5, borderColor: theme.primary,
  },
  avatarInner: {
    width: "100%", height: "100%", borderRadius: RING / 2,
    overflow: "hidden", backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontWeight: "800", fontSize: 18 },
  plusBadge: {
    position: "absolute", bottom: -2, right: -2,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: theme.primary, borderWidth: 2, borderColor: theme.bg,
    alignItems: "center", justifyContent: "center",
  },
  label: { color: theme.textPrimary, fontSize: 11, marginTop: 6, maxWidth: RING + 6 },
});
