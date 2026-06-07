import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image, ActivityIndicator, RefreshControl,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import { api, Listing } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { useConfirm } from "@/src/context/ConfirmContext";
import { theme } from "@/src/theme";

export default function MyListingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [items, setItems] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user?.user_id) { setLoading(false); return; }
    try { setItems(await api.userListings(user.user_id)); }
    catch {} finally { setLoading(false); setRefreshing(false); }
  }, [user?.user_id]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const toggleSold = async (l: Listing) => {
    const status = l.status === "sold" ? "active" : "sold";
    setItems((arr) => arr.map((x) => (x.id === l.id ? { ...x, status } : x)));
    setBusyId(l.id);
    try { await api.updateListing(l.id, { status }); } catch { load(); } finally { setBusyId(null); }
  };

  const remove = async (l: Listing) => {
    if (!(await confirm({ title: "Delete listing?", message: `“${l.title}” will be permanently removed.`, confirmLabel: "Delete", destructive: true }))) return;
    setItems((arr) => arr.filter((x) => x.id !== l.id));
    try { await api.deleteListing(l.id); } catch { load(); }
  };

  const photoOf = (l: Listing) => (l.photos?.length ? l.photos[0] : l.photo_base64) || null;

  const renderItem = ({ item }: { item: Listing }) => {
    const sold = item.status === "sold";
    return (
      <View style={styles.card}>
        <TouchableOpacity
          style={styles.cardMain}
          onPress={() => router.push({ pathname: "/listing/[id]", params: { id: item.id } })}
          testID={`my-listing-${item.id}`}
        >
          <View style={styles.thumb}>
            {photoOf(item) ? (
              <Image source={{ uri: photoOf(item)! }} style={StyleSheet.absoluteFill} />
            ) : (
              <Ionicons name="pricetag-outline" size={22} color={theme.textMuted} />
            )}
            {sold && <View style={styles.soldOverlay}><Text style={styles.soldOverlayText}>SOLD</Text></View>}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
            <Text style={styles.price}>{item.price > 0 ? `$${item.price.toFixed(0)}` : "Free"}</Text>
            {item.status === "flagged" ? (
              <View style={styles.flagRow}>
                <Ionicons name="alert-circle" size={13} color={theme.error} />
                <Text style={styles.flagText} numberOfLines={2}>Unpublished: {(item.flag_reasons || ["flagged by our automated check"]).join(" ")} Edit to fix.</Text>
              </View>
            ) : (
              <Text style={styles.meta} numberOfLines={1}>
                {(item.views_count || 0)} views · {(item.saved_count || 0)} saved
              </Text>
            )}
          </View>
        </TouchableOpacity>
        <View style={styles.actions}>
          <TouchableOpacity style={styles.actionBtn} onPress={() => router.push({ pathname: "/(tabs)/marketplace", params: { edit: item.id } })} testID={`my-listing-edit-${item.id}`}>
            <Ionicons name="create-outline" size={18} color={theme.primary} />
            <Text style={styles.actionText}>Edit</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={() => toggleSold(item)} disabled={busyId === item.id} testID={`my-listing-sold-${item.id}`}>
            <Ionicons name={sold ? "refresh" : "checkmark-done"} size={18} color={theme.textSecondary} />
            <Text style={styles.actionText}>{sold ? "Relist" : "Sold"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={() => remove(item)} testID={`my-listing-del-${item.id}`}>
            <Ionicons name="trash-outline" size={18} color={theme.error} />
            <Text style={[styles.actionText, { color: theme.error }]}>Delete</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="my-listings-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack("/(tabs)/marketplace")} style={styles.iconBtn} testID="my-listings-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My listings</Text>
        <TouchableOpacity onPress={() => router.push("/(tabs)/marketplace")} style={styles.iconBtn} testID="my-listings-new">
          <Ionicons name="add" size={26} color={theme.primary} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 24, gap: 12 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIcon}><Ionicons name="pricetags-outline" size={30} color={theme.textMuted} /></View>
              <Text style={styles.emptyTitle}>No listings yet</Text>
              <Text style={styles.emptySub}>Items you post on Marketplace show up here.</Text>
              <TouchableOpacity style={styles.emptyBtn} onPress={() => router.push("/(tabs)/marketplace")} testID="my-listings-create">
                <Text style={styles.emptyBtnText}>Create a listing</Text>
              </TouchableOpacity>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  card: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, overflow: "hidden" },
  cardMain: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12 },
  thumb: { width: 64, height: 64, borderRadius: 12, overflow: "hidden", backgroundColor: theme.surfaceAlt, alignItems: "center", justifyContent: "center" },
  soldOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center" },
  soldOverlayText: { color: "#fff", fontSize: 12, fontWeight: "800", letterSpacing: 1 },
  title: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  price: { color: theme.primary, fontSize: 14, fontWeight: "800", marginTop: 2 },
  meta: { color: theme.textMuted, fontSize: 12, marginTop: 3 },
  flagRow: { flexDirection: "row", alignItems: "flex-start", gap: 5, marginTop: 4 },
  flagText: { flex: 1, color: theme.error, fontSize: 11.5, lineHeight: 15 },
  actions: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  actionBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 11 },
  actionText: { color: theme.textSecondary, fontSize: 13.5, fontWeight: "700" },
  empty: { alignItems: "center", paddingTop: 80, paddingHorizontal: 30, gap: 8 },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, alignItems: "center", justifyContent: "center", marginBottom: 6 },
  emptyTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  emptySub: { color: theme.textMuted, fontSize: 13.5, textAlign: "center", lineHeight: 19 },
  emptyBtn: { marginTop: 12, backgroundColor: theme.primary, borderRadius: 12, paddingHorizontal: 22, paddingVertical: 11 },
  emptyBtnText: { color: "#fff", fontSize: 14, fontWeight: "800" },
});
