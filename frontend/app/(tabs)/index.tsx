import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  FlatList,
  ActivityIndicator,
  Platform,
  Linking,
  KeyboardAvoidingView,
  Keyboard,
  Share,
  Image as RNImage,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";
import {
  MapboxWebView,
  MapboxWebViewHandle,
  MapboxEvent,
} from "@/src/components/MapboxWebView";
import {
  forwardGeocode,
  GeocodeFeature,
} from "@/src/api/mapbox";
import { api, Place, Recent, Review, FsqProfile, buildPlaceKey } from "@/src/api/client";
import { MAP_STYLES, MapStyleKey, theme } from "@/src/theme";

type SelectedPlace = {
  id?: string; // db id when saved
  name: string;
  address?: string;
  longitude: number;
  latitude: number;
  saved?: Place | null;
  isCategoryPoi?: boolean;
};

export default function MapScreen() {
  const router = useRouter();
  const mapRef = useRef<MapboxWebViewHandle>(null);
  const insets = useSafeAreaInsets();

  const [styleKey, setStyleKey] = useState<MapStyleKey>("standard");
  const [styleSheetOpen, setStyleSheetOpen] = useState(false);
  const [lightMode, setLightMode] = useState<"auto" | "dawn" | "day" | "dusk" | "night">("auto");
  const [mapReady, setMapReady] = useState(false);

  const effectivePreset = useCallback((): "dawn" | "day" | "dusk" | "night" => {
    if (lightMode !== "auto") return lightMode;
    const h = new Date().getHours();
    if (h >= 5 && h < 8) return "dawn";
    if (h >= 8 && h < 17) return "day";
    if (h >= 17 && h < 20) return "dusk";
    return "night";
  }, [lightMode]);

  // Apply the day/night light preset to the Standard basemap once ready / on change.
  useEffect(() => {
    if (!mapReady) return;
    mapRef.current?.setLightPreset(effectivePreset());
  }, [mapReady, lightMode, effectivePreset]);

  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  const [bearing, setBearing] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [locating, setLocating] = useState(false);
  const [trafficOn, setTrafficOn] = useState(false);
  const [buildingsOn, setBuildingsOn] = useState(false);
  const [followMode, setFollowMode] = useState(false);
  const followModeRef = useRef(false);
  useEffect(() => { followModeRef.current = followMode; }, [followMode]);

  const [places, setPlaces] = useState<Place[]>([]);
  const [recents, setRecents] = useState<Recent[]>([]);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeFeature[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);

  const [selected, setSelected] = useState<SelectedPlace | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [fsq, setFsq] = useState<FsqProfile | null>(null);
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewText, setReviewText] = useState("");
  const [submittingReview, setSubmittingReview] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);

  // Load reviews + foursquare profile whenever a place is selected
  useEffect(() => {
    if (!selected) { setReviews([]); setFsq(null); return; }
    const key = buildPlaceKey(selected.name, selected.longitude, selected.latitude);
    (async () => {
      try { setReviews(await api.listReviews(key)); } catch { setReviews([]); }
    })();
    (async () => {
      try {
        const p = await api.fsqMatch(selected.name, selected.longitude, selected.latitude);
        setFsq(p);
      } catch { setFsq(null); }
    })();
  }, [selected]);

  const submitReview = async () => {
    if (!selected) return;
    setSubmittingReview(true);
    try {
      const r = await api.upsertReview({
        place_key: buildPlaceKey(selected.name, selected.longitude, selected.latitude),
        place_name: selected.name,
        longitude: selected.longitude,
        latitude: selected.latitude,
        rating: reviewRating,
        text: reviewText.trim(),
      });
      setReviews((rs) => [r, ...rs.filter((x) => x.user_id !== r.user_id)]);
      setReviewModalOpen(false);
      setReviewText("");
      setReviewRating(5);
    } catch {} finally { setSubmittingReview(false); }
  };

  const avgRating = reviews.length
    ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1)
    : null;

  const loadData = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([api.listPlaces(), api.listRecents()]);
      setPlaces(p);
      setRecents(r);
    } catch {}
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Render markers on map: saved places
  useEffect(() => {
    const markers = places.map((p) => ({
      id: `place_${p.id}`,
      longitude: p.longitude,
      latitude: p.latitude,
      title: p.title,
      color: p.category === "favorite" ? "#EAB308" : "#3B82F6",
    }));
    mapRef.current?.setMarkers(markers);
  }, [places]);

  const requestLocation = useCallback(async () => {
    setLocating(true);
    try {
      let { status } = await Location.getForegroundPermissionsAsync();
      if (status !== "granted") {
        const req = await Location.requestForegroundPermissionsAsync();
        status = req.status;
        if (status !== "granted") {
          setPermissionDenied(!req.canAskAgain);
          return;
        }
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.BestForNavigation,
      });
      const coords: [number, number] = [pos.coords.longitude, pos.coords.latitude];
      setUserLocation(coords);
      mapRef.current?.setUserLocation(
        coords[0], coords[1],
        pos.coords.accuracy ?? undefined,
        (pos.coords.heading != null && pos.coords.heading >= 0) ? pos.coords.heading : undefined,
      );
      mapRef.current?.flyTo(coords[0], coords[1], 16);
      // Enable follow mode — camera will track the user until they pan.
      setFollowMode(true);
    } catch {} finally {
      setLocating(false);
    }
  }, []);

  // ── Live location watcher: keep the blue dot in sync as the user moves.
  //    Does NOT recenter the camera (user can pan freely); the locate button
  //    is still used for explicit re-centering.
  const watcherRef = useRef<Location.LocationSubscription | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== "granted") return;
        // Initial fix at the best available accuracy
        const initial = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.BestForNavigation,
        });
        if (cancelled) return;
        const c0: [number, number] = [initial.coords.longitude, initial.coords.latitude];
        setUserLocation((prev) => prev ?? c0);
        mapRef.current?.setUserLocation(
          c0[0], c0[1],
          initial.coords.accuracy ?? undefined,
          (initial.coords.heading != null && initial.coords.heading >= 0) ? initial.coords.heading : undefined,
        );
        // Center on the user's first fix so the map opens where they are,
        // instead of the neutral world view.
        mapRef.current?.flyTo(c0[0], c0[1], 14);
        // Continuous high-accuracy subscription (Google-Maps-grade)
        watcherRef.current?.remove();
        watcherRef.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 1000,
            distanceInterval: 2,
          },
          (loc) => {
            if (cancelled) return;
            // Drop low-quality fixes that would make the dot jump wildly
            const acc = loc.coords.accuracy;
            if (acc != null && acc > 100) return;
            const c: [number, number] = [loc.coords.longitude, loc.coords.latitude];
            setUserLocation(c);
            mapRef.current?.setUserLocation(
              c[0], c[1],
              acc ?? undefined,
              (loc.coords.heading != null && loc.coords.heading >= 0) ? loc.coords.heading : undefined,
            );
            // Follow mode: glide the camera with the user (Google-Maps "blue dot
            // follow"). panTo is a short linear ease — far smoother than flyTo
            // when fired on every GPS fix.
            if (followModeRef.current) {
              mapRef.current?.panTo(c[0], c[1]);
            }
          },
        );
      } catch {}
    })();
    return () => {
      cancelled = true;
      watcherRef.current?.remove();
      watcherRef.current = null;
    };
  }, []);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(async () => {
      if (!query.trim()) {
        setResults([]);
        return;
      }
      setSearching(true);
      try {
        const r = await forwardGeocode(query, userLocation || undefined);
        setResults(r);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, userLocation]);

  const onMapEvent = useCallback(
    (e: MapboxEvent) => {
      if (e.type === "ready") {
        mapRef.current?.setStyle(MAP_STYLES.find((s) => s.key === styleKey)!.url);
        setMapReady(true);
        requestLocation();
      } else if (e.type === "moveEnd") {
        setBearing(e.bearing);
        setPitch(e.pitch);
      } else if (e.type === "userPan") {
        // User panned/zoomed/rotated → leave follow mode (Google-Maps parity)
        setFollowMode(false);
      } else if (e.type === "click") {
        setShowResults(false);
        setSelected({
          name: "Dropped pin",
          longitude: e.lng,
          latitude: e.lat,
        });
      } else if (e.type === "longpress") {
        // Long-press anywhere → jump straight into directions to that point.
        setShowResults(false);
        setSelected(null);
        router.push({
          pathname: "/(tabs)/directions",
          params: {
            destLng: String(e.lng),
            destLat: String(e.lat),
            destName: "Dropped pin",
          },
        });
      } else if (e.type === "markerClick") {
        if (e.id.startsWith("place_")) {
          const pid = e.id.slice("place_".length);
          const p = places.find((pp) => pp.id === pid);
          if (p) {
            setSelected({
              id: p.id,
              name: p.title,
              address: p.address,
              longitude: p.longitude,
              latitude: p.latitude,
              saved: p,
            });
            mapRef.current?.flyTo(p.longitude, p.latitude, 15);
          }
        }
      }
    },
    [places, requestLocation, styleKey, router],
  );

  const onPickStyle = (key: MapStyleKey) => {
    setStyleKey(key);
    setStyleSheetOpen(false);
    mapRef.current?.setStyle(MAP_STYLES.find((x) => x.key === key)!.url);
  };

  const onPickResult = async (r: GeocodeFeature) => {
    setQuery(r.name);
    setShowResults(false);
    Keyboard.dismiss();
    mapRef.current?.flyTo(r.longitude, r.latitude, 14);
    setSelected({
      name: r.name,
      address: r.full_address,
      longitude: r.longitude,
      latitude: r.latitude,
    });
    try {
      const added = await api.addRecent({
        name: r.name,
        full_address: r.full_address,
        longitude: r.longitude,
        latitude: r.latitude,
      });
      setRecents((rs) => [added, ...rs.filter((x) => x.id !== added.id)].slice(0, 20));
    } catch {}
  };

  const onPickRecent = (r: Recent) => {
    setQuery(r.name);
    setShowResults(false);
    Keyboard.dismiss();
    mapRef.current?.flyTo(r.longitude, r.latitude, 14);
    setSelected({
      name: r.name,
      address: r.full_address,
      longitude: r.longitude,
      latitude: r.latitude,
    });
  };

  const toggleTraffic = () => {
    const next = !trafficOn;
    setTrafficOn(next);
    mapRef.current?.setTraffic(next);
  };
  const toggle3D = () => {
    const next = !buildingsOn;
    setBuildingsOn(next);
    mapRef.current?.set3DBuildings(next);
  };
  const resetNorth = () => {
    mapRef.current?.resetNorth();
  };

  const savePlace = async (category: "marker" | "favorite") => {
    if (!selected) return;
    try {
      const created = await api.createPlace({
        title: selected.name || "Dropped pin",
        notes: "",
        longitude: selected.longitude,
        latitude: selected.latitude,
        address: selected.address || "",
        category,
      });
      setPlaces((p) => [created, ...p]);
      setSelected({ ...selected, id: created.id, saved: created });
    } catch {}
  };

  const removePlace = async () => {
    if (!selected?.id) return;
    try {
      await api.deletePlace(selected.id);
      setPlaces((p) => p.filter((x) => x.id !== selected.id));
      setSelected({ ...selected, id: undefined, saved: null });
    } catch {}
  };

  const directionsTo = () => {
    if (!selected) return;
    router.push({
      pathname: "/(tabs)/directions",
      params: {
        destLng: String(selected.longitude),
        destLat: String(selected.latitude),
        destName: selected.name,
      },
    });
    setSelected(null);
  };

  // Jump straight to directions for a search result / recent (skips the card).
  const directionsToFeature = (lng: number, lat: number, name: string) => {
    setShowResults(false);
    Keyboard.dismiss();
    router.push({
      pathname: "/(tabs)/directions",
      params: { destLng: String(lng), destLat: String(lat), destName: name },
    });
  };

  const sharePlace = async () => {
    if (!selected) return;
    const url =
      Platform.OS === "web" && typeof window !== "undefined"
        ? `${window.location.origin}/?lng=${selected.longitude}&lat=${selected.latitude}&name=${encodeURIComponent(selected.name)}`
        : `https://maps.google.com/?q=${selected.latitude},${selected.longitude}`;
    const message = `${selected.name}${selected.address ? `\n${selected.address}` : ""}\n${url}`;
    try {
      if (Platform.OS === "web" && (navigator as any).share) {
        await (navigator as any).share({ title: selected.name, text: message, url });
      } else {
        await Share.share({ message });
      }
    } catch {}
  };

  const openInMaps = () => {
    if (!selected) return;
    const url = Platform.select({
      ios: `http://maps.apple.com/?ll=${selected.latitude},${selected.longitude}&q=${encodeURIComponent(selected.name)}`,
      default: `https://www.google.com/maps?q=${selected.latitude},${selected.longitude}`,
    });
    if (url) Linking.openURL(url);
  };

  const distanceFromUser = (lng: number, lat: number): string | null => {
    if (!userLocation) return null;
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat - userLocation[1]);
    const dLon = toRad(lng - userLocation[0]);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(userLocation[1])) *
        Math.cos(toRad(lat)) *
        Math.sin(dLon / 2) ** 2;
    const d = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (d > 1000) return `${(d / 1000).toFixed(1)} km`;
    return `${Math.round(d)} m`;
  };

  // Neutral world view until we get the user's location (no hardcoded city).
  const initialCenter: [number, number] = useMemo(() => [10, 25], []);
  const initialStyleUrl = useMemo(
    () => MAP_STYLES.find((s) => s.key === styleKey)!.url,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const compassVisible = Math.abs(bearing) > 1 || pitch > 1;

  return (
    <View style={styles.root} testID="map-screen">
      <MapboxWebView
        ref={mapRef}
        initialCenter={initialCenter}
        initialZoom={1.7}
        initialStyle={initialStyleUrl}
        onEvent={onMapEvent}
      />

      {/* Top: search + categories */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <View style={styles.searchRow}>
          <SidebarMenuButton light />
          <View style={[styles.searchPill, { flex: 1 }]}>
            <Ionicons name="search" size={18} color={theme.textSecondary} style={{ marginRight: 8 }} />
            <TextInput
              testID="search-input"
              style={styles.searchInput}
              placeholder="Search places, addresses…"
              placeholderTextColor={theme.textMuted}
              value={query}
              onChangeText={(t) => {
                setQuery(t);
                setShowResults(true);
              }}
              onFocus={() => setShowResults(true)}
              returnKeyType="search"
            />
            {searching && <ActivityIndicator color={theme.primary} size="small" />}
            {!searching && !!query && (
              <TouchableOpacity
                onPress={() => {
                  setQuery("");
                  setResults([]);
                }}
                testID="search-clear"
              >
                <Ionicons name="close-circle" size={18} color={theme.textMuted} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Results / Recents dropdown */}
        {showResults && (results.length > 0 || (!query && recents.length > 0)) && (
          <View style={styles.resultsCard} testID="search-results">
            {!query && recents.length > 0 && (
              <View style={styles.recentsHeader}>
                <Text style={styles.recentsTitle}>Recent</Text>
                <TouchableOpacity
                  onPress={async () => {
                    await api.clearRecents();
                    setRecents([]);
                  }}
                  testID="clear-recents"
                >
                  <Text style={styles.clearBtn}>Clear</Text>
                </TouchableOpacity>
              </View>
            )}
            <FlatList
              data={
                (!query
                  ? recents.map((r) => ({
                      id: r.id,
                      name: r.name,
                      full_address: r.full_address || "",
                      longitude: r.longitude,
                      latitude: r.latitude,
                      __recent: true as const,
                    }))
                  : results.map((r) => ({ ...r, __recent: false as const }))) as any[]
              }
              keyExtractor={(i) => i.id}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }: any) => (
                <View style={styles.resultRow}>
                  <TouchableOpacity
                    style={styles.resultMain}
                    onPress={() => (item.__recent ? onPickRecent(item) : onPickResult(item))}
                    testID={`result-${item.id}`}
                  >
                    <Ionicons
                      name={item.__recent ? "time" : "location"}
                      size={16}
                      color={item.__recent ? theme.textMuted : theme.primary}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.resultTitle} numberOfLines={1}>{item.name}</Text>
                      {!!item.full_address && (
                        <Text style={styles.resultSub} numberOfLines={1}>{item.full_address}</Text>
                      )}
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.resultDirBtn}
                    onPress={() => directionsToFeature(item.longitude, item.latitude, item.name)}
                    testID={`result-dir-${item.id}`}
                  >
                    <Ionicons name="navigate" size={16} color={theme.primary} />
                  </TouchableOpacity>
                </View>
              )}
            />
          </View>
        )}

      </View>

      {/* Apple-Maps-style grouped control stack (bottom-right) */}
      <View style={[styles.fabStack, { bottom: insets.bottom + 24 }]} pointerEvents="box-none">
        {compassVisible && (
          <TouchableOpacity
            style={[styles.fab, styles.fabSolo]}
            onPress={resetNorth}
            testID="compass-fab"
            activeOpacity={0.85}
          >
            <View style={{ transform: [{ rotate: `${-bearing}deg` }] }}>
              <Ionicons name="compass" size={22} color={theme.primary} />
            </View>
          </TouchableOpacity>
        )}
        <View style={styles.fabGroup}>
          <TouchableOpacity
            style={[styles.fabSegment, styles.fabSegmentTop]}
            onPress={() => setStyleSheetOpen(true)}
            testID="layers-button"
            activeOpacity={0.85}
          >
            <Ionicons name="layers" size={22} color={theme.textPrimary} />
          </TouchableOpacity>
          <View style={styles.fabDivider} />
          <TouchableOpacity
            style={[styles.fabSegment, styles.fabSegmentBottom]}
            onPress={requestLocation}
            testID="location-fab"
            activeOpacity={0.85}
          >
            {locating ? (
              <ActivityIndicator color={theme.primary} />
            ) : (
              <Ionicons
                name={followMode ? "locate" : "locate-outline"}
                size={22}
                color={followMode ? theme.primary : theme.textPrimary}
              />
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Style picker bottom sheet */}
      {styleSheetOpen && (
        <View style={styles.sheetBackdrop} testID="style-sheet">
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setStyleSheetOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Map style</Text>
            <View style={styles.styleGrid}>
              {MAP_STYLES.map((s) => {
                const active = s.key === styleKey;
                return (
                  <TouchableOpacity
                    key={s.key}
                    onPress={() => onPickStyle(s.key)}
                    style={[styles.styleTile, active && styles.styleTileActive]}
                    testID={`style-option-${s.key}`}
                  >
                    <View
                      style={[
                        styles.styleSwatch,
                        s.key === "standard" && { backgroundColor: "#2b6cb0" },
                        s.key === "streets" && { backgroundColor: "#3a4a5a" },
                        s.key === "satellite" && { backgroundColor: "#2d3a26" },
                        s.key === "dark" && { backgroundColor: "#111" },
                        s.key === "outdoors" && { backgroundColor: "#4b6643" },
                      ]}
                    >
                      <Ionicons
                        name={
                          s.key === "satellite" ? "planet"
                            : s.key === "dark" ? "moon"
                            : s.key === "outdoors" ? "leaf"
                            : "map"
                        }
                        size={20}
                        color="#fff"
                      />
                    </View>
                    <Text style={[styles.styleLabel, active && { color: theme.primary }]}>{s.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {styleKey === "standard" && (
              <>
                <Text style={[styles.sheetTitle, { marginTop: 20 }]}>Lighting</Text>
                <View style={styles.lightRow}>
                  {(["auto", "dawn", "day", "dusk", "night"] as const).map((m) => (
                    <TouchableOpacity key={m} style={[styles.lightChip, lightMode === m && styles.lightChipOn]} onPress={() => setLightMode(m)} testID={`light-${m}`}>
                      <Text style={[styles.lightChipText, lightMode === m && { color: "#fff" }]}>{m === "auto" ? "Auto" : m[0].toUpperCase() + m.slice(1)}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}

            <Text style={[styles.sheetTitle, { marginTop: 20 }]}>Overlays</Text>
            <View style={styles.overlayRow}>
              <TouchableOpacity
                style={[styles.overlayTile, buildingsOn && styles.styleTileActive]}
                onPress={toggle3D}
                testID="overlay-3d"
              >
                <View style={[styles.styleSwatch, { backgroundColor: "rgba(59,130,246,0.2)" }]}>
                  <Ionicons name="cube" size={20} color={buildingsOn ? theme.primary : theme.textPrimary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.styleLabel}>3D buildings</Text>
                  <Text style={styles.overlaySub}>{buildingsOn ? "On" : "Off"}</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.overlayTile, trafficOn && styles.styleTileActive]}
                onPress={toggleTraffic}
                testID="overlay-traffic"
              >
                <View style={[styles.styleSwatch, { backgroundColor: "rgba(234,179,8,0.2)" }]}>
                  <Ionicons name="speedometer" size={20} color={trafficOn ? "#EAB308" : theme.textPrimary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.styleLabel}>Traffic</Text>
                  <Text style={styles.overlaySub}>{trafficOn ? "On" : "Off"}</Text>
                </View>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* Place card sheet */}
      {selected && (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.sheetBackdrop}
          testID="place-card-sheet"
        >
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setSelected(null)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.pcHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.pcTitle} numberOfLines={2}>{selected.name}</Text>
                {!!selected.address && (
                  <Text style={styles.pcAddress} numberOfLines={2}>{selected.address}</Text>
                )}
                <View style={styles.pcMeta}>
                  {userLocation && (
                    <View style={styles.pcMetaItem}>
                      <Ionicons name="navigate" size={12} color={theme.textSecondary} />
                      <Text style={styles.pcMetaText}>
                        {distanceFromUser(selected.longitude, selected.latitude)}
                      </Text>
                    </View>
                  )}
                  {avgRating && (
                    <View style={styles.pcMetaItem}>
                      <Ionicons name="star" size={12} color="#EAB308" />
                      <Text style={styles.pcMetaText}>
                        {avgRating} · {reviews.length} {reviews.length === 1 ? "review" : "reviews"}
                      </Text>
                    </View>
                  )}
                  <View style={styles.pcMetaItem}>
                    <Ionicons name="pin" size={12} color={theme.textSecondary} />
                    <Text style={styles.pcMetaText}>
                      {selected.latitude.toFixed(4)}, {selected.longitude.toFixed(4)}
                    </Text>
                  </View>
                </View>
              </View>
              <TouchableOpacity
                onPress={() => setSelected(null)}
                style={styles.closeBtn}
                testID="close-place-card"
              >
                <Ionicons name="close" size={20} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.pcButtonsRow}>
              <TouchableOpacity
                style={styles.pcPrimary}
                onPress={directionsTo}
                testID="pc-directions"
                activeOpacity={0.85}
              >
                <Ionicons name="navigate" size={18} color="#fff" />
                <Text style={styles.pcPrimaryText}>Directions</Text>
              </TouchableOpacity>
              {selected.saved ? (
                <TouchableOpacity
                  style={styles.pcSecondary}
                  onPress={removePlace}
                  testID="pc-remove"
                  activeOpacity={0.85}
                >
                  <Ionicons name="bookmark" size={18} color="#EAB308" />
                  <Text style={styles.pcSecondaryText}>Saved</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={styles.pcSecondary}
                  onPress={() => savePlace("favorite")}
                  testID="pc-save"
                  activeOpacity={0.85}
                >
                  <Ionicons name="bookmark-outline" size={18} color={theme.textPrimary} />
                  <Text style={styles.pcSecondaryText}>Save</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.pcButtonsRow}>
              <TouchableOpacity
                style={styles.pcSecondary}
                onPress={sharePlace}
                testID="pc-share"
                activeOpacity={0.85}
              >
                <Ionicons name="share-outline" size={18} color={theme.textPrimary} />
                <Text style={styles.pcSecondaryText}>Share</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.pcSecondary}
                onPress={openInMaps}
                testID="pc-open-maps"
                activeOpacity={0.85}
              >
                <Ionicons name="open-outline" size={18} color={theme.textPrimary} />
                <Text style={styles.pcSecondaryText}>Open in Maps</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.reviewsSection}>
              {fsq && (
                <View style={styles.fsqCard} testID="fsq-card">
                  {!!fsq.photo && (
                    <RNImage source={{ uri: fsq.photo }} style={styles.fsqPhoto} resizeMode="cover" />
                  )}
                  <View style={styles.fsqMetaRow}>
                    {!!fsq.category && (
                      <View style={styles.fsqChip}><Text style={styles.fsqChipText}>{fsq.category}</Text></View>
                    )}
                    {typeof fsq.rating === "number" && (
                      <View style={styles.fsqChip}>
                        <Ionicons name="star" size={11} color="#EAB308" />
                        <Text style={styles.fsqChipText}>{fsq.rating.toFixed(1)}</Text>
                      </View>
                    )}
                    {typeof fsq.price === "number" && (
                      <View style={styles.fsqChip}>
                        <Text style={styles.fsqChipText}>{"$".repeat(Math.max(1, fsq.price))}</Text>
                      </View>
                    )}
                    {typeof fsq.open_now === "boolean" && (
                      <View style={[styles.fsqChip, { backgroundColor: fsq.open_now ? "rgba(34,197,94,0.18)" : "rgba(239,68,68,0.18)" }]}>
                        <Text style={[styles.fsqChipText, { color: fsq.open_now ? "#22C55E" : "#EF4444" }]}>
                          {fsq.open_now ? "Open now" : "Closed"}
                        </Text>
                      </View>
                    )}
                  </View>
                  {!!fsq.hours_display && (
                    <View style={styles.fsqRow}>
                      <Ionicons name="time-outline" size={14} color={theme.textSecondary} />
                      <Text style={styles.fsqText} numberOfLines={2}>{fsq.hours_display}</Text>
                    </View>
                  )}
                  {!!fsq.phone && (
                    <TouchableOpacity
                      style={styles.fsqRow}
                      onPress={() => Linking.openURL(`tel:${fsq.phone}`)}
                      testID="fsq-phone"
                    >
                      <Ionicons name="call-outline" size={14} color={theme.primary} />
                      <Text style={[styles.fsqText, { color: theme.primary }]}>{fsq.phone}</Text>
                    </TouchableOpacity>
                  )}
                  {!!fsq.website && (
                    <TouchableOpacity
                      style={styles.fsqRow}
                      onPress={() => Linking.openURL(fsq.website!)}
                      testID="fsq-website"
                    >
                      <Ionicons name="globe-outline" size={14} color={theme.primary} />
                      <Text style={[styles.fsqText, { color: theme.primary }]} numberOfLines={1}>{fsq.website}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
              <View style={styles.reviewsHeader}>
                <Text style={styles.reviewsTitle}>Reviews</Text>
                <TouchableOpacity onPress={() => setReviewModalOpen(true)} testID="write-review-btn">
                  <Text style={styles.writeReview}>Write a review</Text>
                </TouchableOpacity>
              </View>
              {reviews.length === 0 ? (
                <Text style={styles.reviewsEmpty}>Be the first to review this place.</Text>
              ) : (
                reviews.slice(0, 3).map((r) => (
                  <View key={r.id} style={styles.reviewRow} testID={`review-${r.id}`}>
                    <View style={styles.reviewAvatar}>
                      <Text style={styles.reviewAvatarText}>{(r.user_name?.[0] || "?").toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={styles.reviewTop}>
                        <Text style={styles.reviewName} numberOfLines={1}>{r.user_name}</Text>
                        <View style={{ flexDirection: "row" }}>
                          {[1,2,3,4,5].map((n) => (
                            <Ionicons key={n} name={n <= r.rating ? "star" : "star-outline"} size={11} color="#EAB308" />
                          ))}
                        </View>
                      </View>
                      {!!r.text && <Text style={styles.reviewText} numberOfLines={3}>{r.text}</Text>}
                    </View>
                  </View>
                ))
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* Write review modal */}
      {reviewModalOpen && selected && (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.sheetBackdrop}
        >
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setReviewModalOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Review {selected.name}</Text>
            <View style={styles.starsRow}>
              {[1,2,3,4,5].map((n) => (
                <TouchableOpacity key={n} onPress={() => setReviewRating(n)} testID={`star-${n}`}>
                  <Ionicons
                    name={n <= reviewRating ? "star" : "star-outline"}
                    size={36}
                    color="#EAB308"
                    style={{ marginHorizontal: 4 }}
                  />
                </TouchableOpacity>
              ))}
            </View>
            <TextInput
              style={[styles.reviewInput, { textAlignVertical: "top" }]}
              placeholder="Share your experience (optional)"
              placeholderTextColor={theme.textMuted}
              value={reviewText}
              onChangeText={setReviewText}
              multiline
              maxLength={500}
              testID="review-text-input"
            />
            <TouchableOpacity
              style={[styles.pcPrimary, { marginTop: 14 }, submittingReview && { opacity: 0.6 }]}
              onPress={submitReview}
              disabled={submittingReview}
              testID="submit-review-btn"
            >
              {submittingReview ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Ionicons name="checkmark" size={18} color="#fff" />
                  <Text style={styles.pcPrimaryText}>Post review</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      )}

      {permissionDenied && (
        <View style={[styles.permBanner, { top: insets.top + 80 }]} testID="perm-banner">
          <Text style={styles.permText}>
            Location permission is blocked. Open settings to enable.
          </Text>
          <TouchableOpacity onPress={() => Linking.openSettings()}>
            <Text style={styles.permLink}>Open Settings</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  topBar: { position: "absolute", top: 0, left: 0, right: 0 },
  searchRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 14, paddingTop: 8,
  },
  searchPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Platform.select({
      ios: "rgba(28,28,32,0.55)",
      android: "rgba(28,28,32,0.85)",
      default: "rgba(28,28,32,0.78)",
    }),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.15)",
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 11,
    gap: 6,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
    ...(Platform.OS === "web" ? ({
      backdropFilter: "blur(28px) saturate(170%)",
      WebkitBackdropFilter: "blur(28px) saturate(170%)",
    } as any) : {}),
  },
  searchInput: {
    flex: 1,
    color: theme.textPrimary,
    fontSize: 15.5,
    fontWeight: "500",
    paddingVertical: 0,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  resultsCard: {
    marginTop: 8,
    backgroundColor: "rgba(15,15,17,0.97)",
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 20,
    overflow: "hidden",
    maxHeight: 320,
  },
  recentsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  recentsTitle: { color: theme.textPrimary, fontSize: 13, fontWeight: "700" },
  clearBtn: { color: theme.primary, fontSize: 12, fontWeight: "700" },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  resultMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
  resultDirBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: theme.surfaceAlt,
    alignItems: "center", justifyContent: "center",
  },
  resultTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "600" },
  resultSub: { color: theme.textSecondary, fontSize: 12, marginTop: 2 },

  fabStack: { position: "absolute", right: 14, gap: 10, alignItems: "flex-end" },
  // Solo FAB (compass — appears only when bearing != 0)
  fab: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Platform.select({
      ios: "rgba(28,28,32,0.55)",
      android: "rgba(28,28,32,0.85)",
      default: "rgba(28,28,32,0.78)",
    }),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
    ...(Platform.OS === "web" ? ({
      backdropFilter: "blur(28px) saturate(160%)",
      WebkitBackdropFilter: "blur(28px) saturate(160%)",
    } as any) : {}),
  },
  fabSolo: {},
  // Grouped FAB stack — Apple-Maps connected pill
  fabGroup: {
    width: 48,
    backgroundColor: Platform.select({
      ios: "rgba(28,28,32,0.55)",
      android: "rgba(28,28,32,0.85)",
      default: "rgba(28,28,32,0.78)",
    }),
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.15)",
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
    ...(Platform.OS === "web" ? ({
      backdropFilter: "blur(28px) saturate(160%)",
      WebkitBackdropFilter: "blur(28px) saturate(160%)",
    } as any) : {}),
  },
  fabSegment: {
    width: 48, height: 48,
    alignItems: "center", justifyContent: "center",
  },
  fabSegmentTop: {},
  fabSegmentBottom: {},
  fabDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.15)",
    marginHorizontal: 10,
  },
  fabActive: { borderColor: theme.primary, backgroundColor: "rgba(0,168,132,0.15)" },

  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#0E0E10",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 12,
    paddingHorizontal: 20,
    borderTopWidth: 1,
    borderColor: theme.border,
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.borderStrong,
    marginBottom: 16,
  },
  sheetTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "700", marginBottom: 12 },
  styleGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 4 },
  styleTile: {
    width: "47%",
    backgroundColor: theme.surface,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: "flex-start",
    gap: 10,
  },
  styleTileActive: { borderColor: theme.primary },
  styleSwatch: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  styleLabel: { color: theme.textPrimary, fontSize: 14, fontWeight: "600" },
  lightRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  lightChip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface },
  lightChipOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  lightChipText: { color: theme.textSecondary, fontSize: 13, fontWeight: "700" },
  overlayRow: { flexDirection: "row", gap: 12, marginTop: 4 },
  overlayTile: {
    flex: 1, flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface, borderRadius: 16,
    paddingHorizontal: 12, paddingVertical: 12,
    borderWidth: 1, borderColor: theme.border,
  },
  overlaySub: { color: theme.textSecondary, fontSize: 11, marginTop: 2 },

  pcHeader: { flexDirection: "row", gap: 12, marginBottom: 14 },
  pcTitle: {
    color: theme.textPrimary,
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  pcAddress: { color: theme.textSecondary, fontSize: 13, marginTop: 4 },
  pcMeta: { flexDirection: "row", gap: 12, marginTop: 8, flexWrap: "wrap" },
  pcMetaItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  pcMetaText: { color: theme.textSecondary, fontSize: 12 },
  closeBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: theme.surface,
    alignItems: "center", justifyContent: "center",
  },
  pcButtonsRow: { flexDirection: "row", gap: 10, marginBottom: 10 },
  pcPrimary: {
    flex: 1,
    flexDirection: "row", gap: 8,
    backgroundColor: theme.primary,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center", justifyContent: "center",
  },
  pcPrimaryText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  pcSecondary: {
    flex: 1,
    flexDirection: "row", gap: 8,
    backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center", justifyContent: "center",
  },
  pcSecondaryText: { color: theme.textPrimary, fontSize: 14, fontWeight: "600" },

  reviewsSection: { marginTop: 18, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  fsqCard: {
    backgroundColor: theme.surface,
    borderRadius: 16, borderWidth: 1, borderColor: theme.border,
    padding: 12, marginBottom: 14, gap: 8,
  },
  fsqPhoto: { width: "100%", height: 140, borderRadius: 12, backgroundColor: theme.surfaceAlt },
  fsqMetaRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  fsqChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: theme.surfaceAlt, borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 4,
  },
  fsqChipText: { color: theme.textPrimary, fontSize: 11, fontWeight: "700" },
  fsqRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 },
  fsqText: { color: theme.textSecondary, fontSize: 13, flex: 1 },
  reviewsHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  reviewsTitle: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  writeReview: { color: theme.primary, fontSize: 13, fontWeight: "700" },
  reviewsEmpty: { color: theme.textMuted, fontSize: 13, paddingVertical: 6 },
  reviewRow: { flexDirection: "row", gap: 10, paddingVertical: 8, alignItems: "flex-start" },
  reviewAvatar: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
  },
  reviewAvatarText: { color: "#fff", fontWeight: "700", fontSize: 12 },
  reviewTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  reviewName: { color: theme.textPrimary, fontSize: 13, fontWeight: "700", flex: 1 },
  reviewText: { color: theme.textSecondary, fontSize: 12, marginTop: 2, lineHeight: 16 },
  starsRow: { flexDirection: "row", justifyContent: "center", marginVertical: 8 },
  reviewInput: {
    backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border,
    borderRadius: 14,
    paddingHorizontal: 14, paddingVertical: 12,
    color: theme.textPrimary, fontSize: 14, minHeight: 90,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },

  permBanner: {
    position: "absolute", left: 16, right: 16,
    backgroundColor: "rgba(239,68,68,0.95)",
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
  },
  permText: { color: "#fff", flex: 1, marginRight: 12, fontSize: 13 },
  permLink: { color: "#fff", fontWeight: "700", fontSize: 13 },
});
