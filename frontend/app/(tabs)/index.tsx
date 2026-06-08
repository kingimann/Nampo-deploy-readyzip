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
  Modal,
  Image as RNImage,
  Animated,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { useRouter, useFocusEffect } from "expo-router";
import { useNavBar } from "@/src/context/NavBarContext";
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
import { api, Place, Recent, Review, FsqProfile, Hazard, HazardType, buildPlaceKey } from "@/src/api/client";
import { MAP_STYLES, MapStyleKey, theme } from "@/src/theme";

// Driver-report hazard types → marker emoji + label.
const HAZARD_META: Record<HazardType, { emoji: string; label: string }> = {
  police: { emoji: "👮", label: "Police" },
  accident: { emoji: "💥", label: "Accident" },
  hazard: { emoji: "⚠️", label: "Hazard on road" },
  traffic: { emoji: "🚗", label: "Heavy traffic" },
  road_closed: { emoji: "🚧", label: "Road closed" },
  construction: { emoji: "🏗️", label: "Construction" },
  pothole: { emoji: "🕳️", label: "Pothole" },
  weather: { emoji: "🌧️", label: "Bad weather" },
  stalled: { emoji: "🛑", label: "Stalled vehicle" },
};
const HAZARD_ORDER: HazardType[] = ["police", "accident", "hazard", "traffic", "road_closed", "construction", "pothole", "weather", "stalled"];

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

  const [styleKey, setStyleKey] = useState<MapStyleKey>("streets");
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
  // Include styleKey so the preset is re-pushed after a style switch (a freshly
  // loaded Standard style otherwise reverts to its default night lighting).
  useEffect(() => {
    if (!mapReady) return;
    mapRef.current?.setLightPreset(effectivePreset());
  }, [mapReady, lightMode, effectivePreset, styleKey]);

  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  // Always-fresh location (updated every fix) for search bias, without forcing a
  // re-render on every GPS tick. The `userLocation` state is updated only on
  // meaningful moves so the distance labels refresh but the screen stays smooth.
  const userLocationRef = useRef<[number, number] | null>(null);
  const mapCenterRef = useRef<[number, number] | null>(null); // fallback origin for nearby search
  const setUserLoc = useCallback((c: [number, number]) => {
    userLocationRef.current = c;
    setUserLocation((prev) =>
      prev && Math.abs(prev[0] - c[0]) < 0.0002 && Math.abs(prev[1] - c[1]) < 0.0002 ? prev : c,
    );
  }, []);
  const [bearing, setBearing] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [locating, setLocating] = useState(false);
  const [trafficOn, setTrafficOn] = useState(false);
  const [buildingsOn, setBuildingsOn] = useState(false);
  const [followMode, setFollowMode] = useState(false);
  const followModeRef = useRef(false);

  // Auto-hide the chrome while the user is actively moving the map: the bottom
  // nav bar (global) slides away and the search bar fades out, so the map is
  // unobstructed. Both come back shortly after the gesture ends (or immediately
  // if the user taps the search field).
  const { setTabBarHidden } = useNavBar();
  const [mapActive, setMapActive] = useState(false);
  const searchFocusedRef = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchHide = useRef(new Animated.Value(0)).current; // 0 = shown, 1 = hidden
  const showChrome = useCallback(() => {
    if (idleTimer.current) { clearTimeout(idleTimer.current); idleTimer.current = null; }
    setMapActive(false);
    setTabBarHidden(false);
  }, [setTabBarHidden]);
  const hideChromeForPan = useCallback(() => {
    if (searchFocusedRef.current) return; // don't yank the search bar while typing
    if (idleTimer.current) { clearTimeout(idleTimer.current); idleTimer.current = null; }
    setMapActive(true);
    setTabBarHidden(true);
  }, [setTabBarHidden]);
  const scheduleShowChrome = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => { setMapActive(false); setTabBarHidden(false); }, 1600);
  }, [setTabBarHidden]);
  useEffect(() => {
    Animated.timing(searchHide, {
      toValue: mapActive ? 1 : 0, duration: 200, useNativeDriver: true,
    }).start();
  }, [mapActive, searchHide]);
  // Never leave the bottom bar stuck hidden when this screen loses focus or
  // unmounts (tab screens can stay mounted, and tabBarHidden is global).
  useFocusEffect(useCallback(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setMapActive(false);
    setTabBarHidden(false);
  }, [setTabBarHidden]));
  useEffect(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setTabBarHidden(false);
  }, [setTabBarHidden]);
  useEffect(() => { followModeRef.current = followMode; }, [followMode]);

  const [places, setPlaces] = useState<Place[]>([]);
  const [recents, setRecents] = useState<Recent[]>([]);

  const [query, setQuery] = useState("");
  const [radiusKm, setRadiusKm] = useState(8); // nearby-search radius
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
  const [placeCollapsed, setPlaceCollapsed] = useState(false);

  // Load reviews + foursquare profile whenever a place is selected
  useEffect(() => {
    if (!selected) { setReviews([]); setFsq(null); return; }
    setPlaceCollapsed(false); // each new place opens expanded
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
      // Replace this user's previous review. Match on a present id first, then
      // user_id — guarding against an empty user_id wiping every other review.
      setReviews((rs) => [r, ...rs.filter((x) => (x.id && r.id ? x.id !== r.id : !!r.user_id && x.user_id !== r.user_id))]);
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
    if (!mapReady) return;
    const markers = places.map((p) => ({
      id: `place_${p.id}`,
      longitude: p.longitude,
      latitude: p.latitude,
      title: p.title,
      color: p.category === "favorite" ? "#EAB308" : "#3B82F6",
    }));
    // GPU circle layer (not DOM markers) so pan/zoom stays smooth regardless
    // of how many saved places there are.
    mapRef.current?.setPlaceMarkers(markers);
  }, [places, mapReady]);

  const watcherRef = useRef<Location.LocationSubscription | null>(null);
  const watchingRef = useRef(false);

  // Start the continuous GPS subscription (idempotent). Kept separate so it can
  // begin the moment permission is granted — including on web / first run, where
  // the user grants permission AFTER this screen has already mounted.
  const startWatcher = useCallback(async () => {
    if (watchingRef.current) return;
    watchingRef.current = true;
    try {
      watcherRef.current?.remove();
      watcherRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 3000, distanceInterval: 8 },
        (loc) => {
          // Drop low-quality fixes that would make the dot jump wildly.
          const acc = loc.coords.accuracy;
          if (acc != null && acc > 100) return;
          const c: [number, number] = [loc.coords.longitude, loc.coords.latitude];
          setUserLoc(c);
          mapRef.current?.setUserLocation(
            c[0], c[1], acc ?? undefined,
            (loc.coords.heading != null && loc.coords.heading >= 0) ? loc.coords.heading : undefined,
          );
          // Follow mode: glide the camera with the user until they pan.
          if (followModeRef.current) mapRef.current?.panTo(c[0], c[1]);
        },
      );
    } catch { watchingRef.current = false; }
  }, [setUserLoc]);

  const requestLocation = useCallback(async () => {
    setLocating(true);
    try {
      let { status } = await Location.getForegroundPermissionsAsync();
      if (status !== "granted") {
        const req = await Location.requestForegroundPermissionsAsync();
        status = req.status;
        if (status !== "granted") {
          // On web the browser remembers a block and won't re-prompt, so always
          // show the hint; on native only show it once it can't be asked again.
          setPermissionDenied(Platform.OS === "web" ? true : !req.canAskAgain);
          return;
        }
      }
      setPermissionDenied(false);
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const coords: [number, number] = [pos.coords.longitude, pos.coords.latitude];
      setUserLoc(coords);
      mapRef.current?.setUserLocation(
        coords[0], coords[1],
        pos.coords.accuracy ?? undefined,
        (pos.coords.heading != null && pos.coords.heading >= 0) ? pos.coords.heading : undefined,
      );
      mapRef.current?.flyTo(coords[0], coords[1], 16);
      // Enable follow mode — camera will track the user until they pan.
      setFollowMode(true);
      // Begin live tracking now that permission is granted (this is what makes
      // the dot + camera keep moving on web / first run).
      startWatcher();
    } catch {} finally {
      setLocating(false);
    }
  }, [startWatcher]);

  // ── Live location watcher.
  // On mount, if permission is ALREADY granted (e.g. a returning native user),
  // center on the first fix and start tracking right away. On web / first run
  // permission is granted later via the locate button, and requestLocation
  // starts the watcher then — so live follow works there too.
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== "granted") return;
        const initial = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        const c0: [number, number] = [initial.coords.longitude, initial.coords.latitude];
        setUserLoc(c0);   // for search bias; centering is done by requestLocation() on map 'ready'
        // NOTE: don't push setUserLocation/flyTo here — this can resolve before the
        // map's 'ready' event, in which case the bridge silently drops the command.
        // The onMapEvent('ready') handler calls requestLocation(), which centers
        // the user and starts follow mode once the map is actually loaded.
        startWatcher();
      } catch {}
    })();
    return () => {
      watcherRef.current?.remove();
      watcherRef.current = null;
      watchingRef.current = false;
    };
  }, [startWatcher, setUserLoc]);

  // Debounced search
  useEffect(() => {
    let cancelled = false;   // ignore a stale in-flight response if the query changed
    const t = setTimeout(async () => {
      if (!query.trim()) {
        setResults([]);
        return;
      }
      setSearching(true);
      try {
        // Prefer the GPS fix; fall back to the map's current center so nearby
        // search works on web (or before a location fix lands).
        const loc = userLocationRef.current || mapCenterRef.current;
        // Run the address geocoder and a Foursquare place search in parallel —
        // the latter lists every nearby match for a brand/business like
        // "McDonald's", nearest first.
        const [geo, fsq] = await Promise.all([
          forwardGeocode(query, loc || undefined),
          loc
            ? api.fsqSearch(query, loc[0], loc[1], radiusKm * 1000).then((r) => r.results).catch(() => [])
            : Promise.resolve([] as Awaited<ReturnType<typeof api.fsqSearch>>["results"]),
        ]);
        const fsqFeatures: GeocodeFeature[] = fsq.map((r) => ({
          id: `fsq_${r.fsq_id || `${r.longitude},${r.latitude}`}`,
          name: r.name,
          full_address: r.address || "",
          longitude: r.longitude,
          latitude: r.latitude,
          category: r.category || undefined,
          distance: r.distance ?? undefined,
        }));
        // Nearby businesses first (with distance), then geocoder hits; dedupe by name+addr.
        const seen = new Set<string>();
        const merged = [...fsqFeatures, ...geo].filter((f) => {
          const key = `${f.name}|${f.full_address}`.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (!cancelled) setResults(merged.slice(0, 12));
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, radiusKm]);

  // ── Driver hazard reports (Waze-style) ──
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const hazardsRef = useRef<Hazard[]>([]);
  const [hazardSel, setHazardSel] = useState<Hazard | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const lastHazardLoad = useRef(0);

  const loadHazards = useCallback(async () => {
    const c = userLocationRef.current || mapCenterRef.current;
    if (!c) return;
    lastHazardLoad.current = Date.now();
    try {
      const r = await api.listHazards(c[0], c[1]);
      hazardsRef.current = r.hazards;
      setHazards(r.hazards);
      mapRef.current?.setHazardMarkers(r.hazards.map((h) => ({
        id: h.id, longitude: h.longitude, latitude: h.latitude,
        label: HAZARD_META[h.type]?.emoji || "⚠️", title: HAZARD_META[h.type]?.label || "Hazard",
      })));
    } catch {}
  }, []);

  const reportingRef = useRef(false);
  const submitReport = async (type: HazardType) => {
    if (reportingRef.current) return;   // ignore a double-tap during the modal's close animation
    reportingRef.current = true;
    const c = userLocationRef.current || mapCenterRef.current;
    setReportOpen(false);
    if (!c) { reportingRef.current = false; return; }
    try { await api.reportHazard(type, c[0], c[1]); await loadHazards(); } catch {}
    finally { reportingRef.current = false; }
  };

  const confirmSelHazard = async () => {
    const h = hazardSel; setHazardSel(null);
    if (!h) return;
    try { await api.confirmHazard(h.id); } catch {}
    loadHazards();
  };
  const dismissSelHazard = async () => {
    const h = hazardSel; setHazardSel(null);
    if (!h) return;
    try { await api.dismissHazard(h.id); } catch {}
    loadHazards();
  };

  // Refresh hazards when the area changes, but throttle it (same 8s budget as the
  // moveEnd path) so a moving user doesn't churn the markers on every fix.
  useEffect(() => {
    if (mapReady && Date.now() - lastHazardLoad.current > 8000) loadHazards();
  }, [mapReady, userLocation, loadHazards]);

  const onMapEvent = useCallback(
    (e: MapboxEvent) => {
      if (e.type === "ready") {
        // The map already loaded with `initialStyle` (== current styleKey), so
        // don't re-setStyle here — that forces a full, heavy reload on startup.
        setMapReady(true);
        requestLocation();
        loadHazards();
      } else if (e.type === "moveEnd") {
        // Interaction settled → bring the chrome back after a short idle.
        scheduleShowChrome();
        // Remember the map center so "near me / nearby" still works when there's
        // no GPS fix (e.g. on web without location permission) — we search around
        // wherever the map is currently looking.
        mapCenterRef.current = e.center;
        // Refresh hazards for the new area (throttled so routine panning is cheap).
        if (Date.now() - lastHazardLoad.current > 8000) loadHazards();
        // Only update state when the compass-relevant values actually changed,
        // so routine pan/zoom-end events don't re-render the whole screen.
        setBearing((b) => (Math.abs(b - e.bearing) > 0.5 ? e.bearing : b));
        setPitch((p) => (Math.abs(p - e.pitch) > 0.5 ? e.pitch : p));
      } else if (e.type === "userPan") {
        // User panned/zoomed/rotated → leave follow mode (Google-Maps parity)
        setFollowMode(false);
        // …and get the chrome out of the way while they explore.
        hideChromeForPan();
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
      } else if (e.type === "hazardClick") {
        const h = hazardsRef.current.find((x) => x.id === e.id);
        if (h) setHazardSel(h);
      }
    },
    [places, requestLocation, styleKey, router, scheduleShowChrome, hideChromeForPan],
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

  // Block re-entrancy on save/unsave so a double-tap (or a tap during a slow
  // request on a flaky connection) can't create duplicate saved places.
  const savingPlaceRef = useRef(false);
  const savePlace = async (category: "marker" | "favorite") => {
    if (!selected || savingPlaceRef.current) return;
    savingPlaceRef.current = true;
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
    } catch {} finally { savingPlaceRef.current = false; }
  };

  const removePlace = async () => {
    if (!selected?.id || savingPlaceRef.current) return;
    savingPlaceRef.current = true;
    try {
      await api.deletePlace(selected.id);
      setPlaces((p) => p.filter((x) => x.id !== selected.id));
      setSelected({ ...selected, id: undefined, saved: null });
    } catch {} finally { savingPlaceRef.current = false; }
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

  // Open the full custom business profile for the selected place.
  const viewProfile = () => {
    if (!selected) return;
    router.push({
      pathname: "/place/[id]",
      params: {
        id: fsq?.fsq_id || "_",
        name: selected.name,
        lng: String(selected.longitude),
        lat: String(selected.latitude),
        address: selected.address || fsq?.address || "",
        category: fsq?.category || "",
      },
    });
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
      <Animated.View
        style={[styles.topBar, { paddingTop: insets.top + 8 },
          { opacity: searchHide.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
            transform: [{ translateY: searchHide.interpolate({ inputRange: [0, 1], outputRange: [0, -16] }) }] }]}
        pointerEvents={mapActive ? "none" : "box-none"}
      >
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
              onFocus={() => { searchFocusedRef.current = true; showChrome(); setShowResults(true); }}
              onBlur={() => { searchFocusedRef.current = false; }}
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
                      {(!!item.full_address || !!item.category) && (
                        <Text style={styles.resultSub} numberOfLines={1}>
                          {[item.category, item.full_address].filter(Boolean).join(" · ")}
                        </Text>
                      )}
                    </View>
                    {typeof item.distance === "number" && (
                      <Text style={styles.resultDist}>
                        {item.distance < 1000 ? `${Math.round(item.distance)} m` : `${(item.distance / 1000).toFixed(1)} km`}
                      </Text>
                    )}
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

      </Animated.View>

      {/* Apple-Maps-style grouped control stack (bottom-right) */}
      <View style={[styles.fabStack, { bottom: insets.bottom + 24 }]} pointerEvents="box-none">
        <TouchableOpacity
          style={[styles.fab, styles.fabSolo]}
          onPress={() => setReportOpen(true)}
          testID="hazard-report-fab"
          activeOpacity={0.85}
        >
          <Ionicons name="warning" size={21} color="#F59E0B" />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.fab, styles.fabSolo]}
          onPress={() => router.push("/roadside")}
          testID="roadside-fab"
          activeOpacity={0.85}
        >
          <Ionicons name="construct" size={21} color="#F59E0B" />
        </TouchableOpacity>
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
          <View style={[styles.sheet, { paddingBottom: insets.bottom + (placeCollapsed ? 12 : 20) }]}>
            <TouchableOpacity
              onPress={() => setPlaceCollapsed((c) => !c)}
              style={styles.sheetGrab}
              activeOpacity={0.7}
              testID="place-fold"
            >
              <View style={styles.sheetHandle} />
              <Ionicons name={placeCollapsed ? "chevron-up" : "chevron-down"} size={16} color={theme.textMuted} />
            </TouchableOpacity>
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

            {!placeCollapsed && (
            <>
            <TouchableOpacity
              style={styles.pcProfileBtn}
              onPress={viewProfile}
              testID="pc-view-profile"
              activeOpacity={0.85}
            >
              <Ionicons name="business-outline" size={18} color={theme.primary} />
              <Text style={styles.pcProfileText}>View business profile</Text>
              <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
            </TouchableOpacity>
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
                      onPress={() => Linking.openURL(`tel:${(fsq.phone || "").replace(/[^\d+]/g, "")}`).catch(() => {})}
                      testID="fsq-phone"
                    >
                      <Ionicons name="call-outline" size={14} color={theme.primary} />
                      <Text style={[styles.fsqText, { color: theme.primary }]}>{fsq.phone}</Text>
                    </TouchableOpacity>
                  )}
                  {!!fsq.website && (
                    <TouchableOpacity
                      style={styles.fsqRow}
                      onPress={() => Linking.openURL(/^https?:\/\//i.test(fsq.website!) ? fsq.website! : `https://${fsq.website}`).catch(() => {})}
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
            </>
            )}
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
          <View style={{ flex: 1 }}>
            <Text style={styles.permText}>
              {Platform.OS === "web"
                ? "Location is blocked. Tap the lock/ⓘ icon in your browser's address bar → allow Location, then reload."
                : "Location permission is blocked. Open settings to enable it."}
            </Text>
            {Platform.OS !== "web" && (
              <TouchableOpacity onPress={() => Linking.openSettings()}>
                <Text style={styles.permLink}>Open Settings</Text>
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity onPress={() => setPermissionDenied(false)} hitSlop={8} testID="perm-dismiss">
            <Ionicons name="close" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
      )}

      {/* Report a hazard — type picker */}
      <Modal visible={reportOpen} transparent animationType="slide" onRequestClose={() => setReportOpen(false)}>
        <View style={styles.hzBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setReportOpen(false)} />
          <View style={[styles.hzSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.hzHandle} />
            <Text style={styles.hzTitle}>Report on the map</Text>
            <Text style={styles.hzSub}>Other drivers nearby will see it. It shows for everyone once a few people report the same thing.</Text>
            <View style={styles.hzGrid}>
              {HAZARD_ORDER.map((t) => (
                <TouchableOpacity key={t} style={styles.hzTile} onPress={() => submitReport(t)} testID={`hazard-${t}`}>
                  <Text style={styles.hzEmoji}>{HAZARD_META[t].emoji}</Text>
                  <Text style={styles.hzLabel}>{HAZARD_META[t].label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      </Modal>

      {/* Tap a hazard marker — confirm / clear */}
      <Modal visible={!!hazardSel} transparent animationType="fade" onRequestClose={() => setHazardSel(null)}>
        <TouchableOpacity style={styles.hzCenterBackdrop} activeOpacity={1} onPress={() => setHazardSel(null)}>
          <View style={styles.hzCard}>
            {hazardSel && (
              <>
                <Text style={styles.hzCardEmoji}>{HAZARD_META[hazardSel.type]?.emoji}</Text>
                <Text style={styles.hzCardTitle}>{HAZARD_META[hazardSel.type]?.label}</Text>
                <Text style={styles.hzCardSub}>
                  {hazardSel.status === "active"
                    ? `${hazardSel.confirmations} driver${hazardSel.confirmations === 1 ? "" : "s"} reported this`
                    : "Pending — needs more reports to show for everyone"}
                </Text>
                <View style={styles.hzCardRow}>
                  <TouchableOpacity style={[styles.hzCardBtn, styles.hzConfirm]} onPress={confirmSelHazard} testID="hazard-confirm">
                    <Ionicons name="thumbs-up" size={16} color="#fff" />
                    <Text style={styles.hzCardBtnText}>Still there</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.hzCardBtn, styles.hzDismiss]} onPress={dismissSelHazard} testID="hazard-dismiss">
                    <Ionicons name="close" size={16} color="#fff" />
                    <Text style={styles.hzCardBtnText}>Not there</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </TouchableOpacity>
      </Modal>
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
    maxHeight: 440,
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
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  resultMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 14 },
  resultDirBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: theme.surfaceAlt,
    alignItems: "center", justifyContent: "center",
  },
  resultTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "700" },
  resultSub: { color: theme.textSecondary, fontSize: 13, marginTop: 3 },
  resultDist: { color: theme.textMuted, fontSize: 12.5, fontWeight: "700", marginLeft: 8 },

  fabStack: { position: "absolute", right: 14, gap: 10, alignItems: "flex-end" },
  hzBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  hzSheet: { backgroundColor: theme.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, borderColor: theme.border, paddingTop: 10, paddingHorizontal: 16 },
  hzHandle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 12 },
  hzTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800", textAlign: "center" },
  hzSub: { color: theme.textMuted, fontSize: 12.5, lineHeight: 17, textAlign: "center", marginTop: 4, marginBottom: 14 },
  hzGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 10 },
  hzTile: { width: "31%", backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, paddingVertical: 14, alignItems: "center", gap: 6, marginBottom: 4 },
  hzEmoji: { fontSize: 26 },
  hzLabel: { color: theme.textPrimary, fontSize: 11.5, fontWeight: "700", textAlign: "center" },
  hzCenterBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", padding: 28 },
  hzCard: { width: "100%", maxWidth: 320, backgroundColor: theme.surface, borderRadius: 20, borderWidth: 1, borderColor: theme.border, padding: 20, alignItems: "center" },
  hzCardEmoji: { fontSize: 40 },
  hzCardTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "800", marginTop: 8 },
  hzCardSub: { color: theme.textMuted, fontSize: 13, textAlign: "center", marginTop: 6, lineHeight: 18 },
  hzCardRow: { flexDirection: "row", gap: 10, marginTop: 18, alignSelf: "stretch" },
  hzCardBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12, borderRadius: 12 },
  hzConfirm: { backgroundColor: theme.primary },
  hzDismiss: { backgroundColor: theme.textMuted },
  hzCardBtnText: { color: "#fff", fontSize: 14, fontWeight: "800" },
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
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingTop: 8,
    paddingHorizontal: 18,
    borderTopWidth: 1,
    borderColor: theme.border,
  },
  sheetGrab: { alignSelf: "center", alignItems: "center", gap: 2, paddingTop: 2, paddingBottom: 8, paddingHorizontal: 30 },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.borderStrong,
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

  pcHeader: { flexDirection: "row", gap: 12, marginBottom: 10 },
  pcTitle: {
    color: theme.textPrimary,
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  pcAddress: { color: theme.textSecondary, fontSize: 12.5, marginTop: 3 },
  pcMeta: { flexDirection: "row", gap: 10, marginTop: 6, flexWrap: "wrap" },
  pcMetaItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  pcMetaText: { color: theme.textSecondary, fontSize: 12 },
  closeBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: theme.surface,
    alignItems: "center", justifyContent: "center",
  },
  pcButtonsRow: { flexDirection: "row", gap: 10, marginBottom: 8 },
  pcPrimary: {
    flex: 1,
    flexDirection: "row", gap: 7,
    backgroundColor: theme.primary,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: "center", justifyContent: "center",
  },
  pcPrimaryText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  pcSecondary: {
    flex: 1,
    flexDirection: "row", gap: 7,
    backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: "center", justifyContent: "center",
  },
  pcSecondaryText: { color: theme.textPrimary, fontSize: 14, fontWeight: "600" },
  pcProfileBtn: {
    flexDirection: "row", alignItems: "center", gap: 9,
    backgroundColor: theme.primary + "14", borderWidth: 1, borderColor: theme.primary + "55",
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 8,
  },
  pcProfileText: { flex: 1, color: theme.primary, fontSize: 14.5, fontWeight: "800" },

  reviewsSection: { marginTop: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
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
