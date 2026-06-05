import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  MapboxWebView, MapboxWebViewHandle,
} from "@/src/components/MapboxWebView";
import { fetchPublicEta, EtaShare } from "@/src/api/client";
import { MAP_STYLES, theme } from "@/src/theme";

const _BACKEND_URL = (process.env.EXPO_PUBLIC_BACKEND_URL as string) || "";
// Build the WebSocket base: on web use window.location.origin, on native use the configured URL.
function getWsBase(): string {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return window.location.origin.replace(/^http/, "ws");
  }
  return _BACKEND_URL.replace(/^http/, "ws");
}

export default function EtaPublicViewer() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { shareId } = useLocalSearchParams<{ shareId: string }>();
  const mapRef = useRef<MapboxWebViewHandle>(null);
  const [share, setShare] = useState<EtaShare | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Initial fetch
  useEffect(() => {
    if (!shareId) return;
    (async () => {
      const s = await fetchPublicEta(shareId);
      setShare(s);
      setLoading(false);
    })();
  }, [shareId]);

  // WebSocket for live updates
  useEffect(() => {
    if (!shareId) return;
    const wsUrl = getWsBase() + `/api/ws/eta/${shareId}`;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      try {
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.onopen = () => setConnected(true);
        ws.onclose = () => {
          setConnected(false);
          reconnectTimer = setTimeout(connect, 3000);
        };
        ws.onerror = () => { ws?.close(); };
        ws.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            if (data?.type === "eta" && data.share) {
              setShare(data.share as EtaShare);
            }
          } catch {}
        };
      } catch {}
    };
    connect();
    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [shareId]);

  // Update markers + route line whenever share changes
  useEffect(() => {
    if (!share || !mapRef.current) return;
    mapRef.current.setMarkers([
      {
        id: "person", longitude: share.current_longitude, latitude: share.current_latitude,
        title: share.name || "Friend", color: "#3B82F6", label: "A",
      },
      {
        id: "dest", longitude: share.destination_longitude, latitude: share.destination_latitude,
        title: share.destination_name || "Destination", color: "#EF4444", label: "B",
      },
    ]);
    mapRef.current.setRoute({
      type: "LineString",
      coordinates: [
        [share.current_longitude, share.current_latitude],
        [share.destination_longitude, share.destination_latitude],
      ],
    });
    mapRef.current.fitBounds(
      [
        [share.current_longitude, share.current_latitude],
        [share.destination_longitude, share.destination_latitude],
      ],
      120,
    );
  }, [share]);

  if (loading) {
    return <View style={[styles.root, styles.center]}><ActivityIndicator color={theme.primary} /></View>;
  }
  if (!share) {
    return (
      <SafeAreaView edges={["top"]} style={[styles.root, styles.center]}>
        <Ionicons name="time-outline" size={48} color={theme.textMuted} />
        <Text style={styles.title}>ETA link not found</Text>
        <Text style={styles.sub}>This share may have ended or expired.</Text>
      </SafeAreaView>
    );
  }

  const expired = !share.active || new Date(share.expires_at) < new Date();

  return (
    <View style={styles.root} testID="eta-public">
      <MapboxWebView
        ref={mapRef}
        initialCenter={[share.current_longitude, share.current_latitude]}
        initialZoom={12}
        initialStyle={MAP_STYLES.find((s) => s.key === "dark")!.url}
      />
      <SafeAreaView edges={["top"]} style={styles.topWrap} pointerEvents="box-none">
        <View style={styles.card}>
          <View style={styles.titleRow}>
            <View style={[styles.statusDot, { backgroundColor: expired ? theme.textMuted : theme.success }]} />
            <Text style={styles.cardTitle} numberOfLines={1}>
              {share.name || "Friend"} {expired ? "ended sharing" : "is on the way"}
            </Text>
            {connected && !expired && <Ionicons name="radio" size={14} color={theme.success} />}
          </View>
          {!!share.destination_name && (
            <Text style={styles.cardSub} numberOfLines={1}>To: {share.destination_name}</Text>
          )}
          {share.eta_minutes != null && !expired && (
            <Text style={styles.eta}>{share.eta_minutes} min away</Text>
          )}
        </View>
      </SafeAreaView>
      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <Text style={styles.poweredBy}>Powered by Nami App</Text>
        <TouchableOpacity onPress={() => router.replace("/login")} style={styles.cta}>
          <Text style={styles.ctaText}>Get Nami App →</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center", gap: 8 },
  title: { color: theme.textPrimary, fontSize: 18, fontWeight: "700", marginTop: 12 },
  sub: { color: theme.textSecondary, fontSize: 13, textAlign: "center", paddingHorizontal: 32 },
  topWrap: { paddingHorizontal: 16, paddingTop: 8 },
  card: {
    backgroundColor: "rgba(15,15,17,0.97)",
    borderRadius: 20, borderWidth: 1, borderColor: theme.border,
    padding: 16, gap: 6,
    shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 12, elevation: 6,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  cardTitle: { flex: 1, color: theme.textPrimary, fontSize: 16, fontWeight: "700" },
  cardSub: { color: theme.textSecondary, fontSize: 13 },
  eta: { color: theme.primary, fontSize: 26, fontWeight: "800", letterSpacing: -0.5, marginTop: 6 },
  footer: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    paddingHorizontal: 20, paddingTop: 14,
    backgroundColor: "rgba(10,10,12,0.95)",
    borderTopWidth: 1, borderTopColor: theme.border,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
  },
  poweredBy: { color: theme.textSecondary, fontSize: 12 },
  cta: {
    backgroundColor: theme.primary, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12,
  },
  ctaText: { color: "#fff", fontWeight: "700", fontSize: 13 },
});
