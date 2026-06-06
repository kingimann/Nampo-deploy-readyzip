import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList,
  ActivityIndicator, Platform, KeyboardAvoidingView, ScrollView, Share, PanResponder,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Location from "expo-location";
import * as Speech from "expo-speech";
import {
  MapboxWebView, MapboxWebViewHandle, MapboxEvent,
} from "@/src/components/MapboxWebView";
import {
  forwardGeocode, fetchRoutes, categorySearch, GeocodeFeature, Profile, Step, RouteResult,
} from "@/src/api/mapbox";
import { api, EtaShare, TransitNearby } from "@/src/api/client";
import { MAP_STYLES, theme } from "@/src/theme";
import { SidebarMenuButton } from "@/src/components/LeftSidebar";

type Waypoint = {
  id: string;
  query: string;
  feature: GeocodeFeature | null;
  isUserLocation?: boolean;
};

const PROFILES: { key: Profile; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: "driving-traffic", label: "Drive", icon: "car" },
  { key: "walking", label: "Walk", icon: "walk" },
  { key: "cycling", label: "Cycle", icon: "bicycle" },
];

const newId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const stepIconFor = (modifier?: string, type?: string): keyof typeof Ionicons.glyphMap => {
  if (type === "arrive") return "flag";
  if (type === "depart") return "navigate";
  if (!modifier) return "arrow-up";
  // Mapbox modifiers: uturn | sharp left | left | slight left | straight |
  // slight right | right | sharp right
  if (modifier.includes("uturn")) return "arrow-undo";
  // Order matters: check "sharp" / "slight" before plain "left"/"right".
  if (modifier.includes("sharp left")) return "arrow-back-circle";
  if (modifier.includes("sharp right")) return "arrow-forward-circle";
  if (modifier.includes("slight left")) return "trending-up"; // up-and-to-the-left visual hint
  if (modifier.includes("slight right")) return "trending-up";
  if (modifier.includes("left")) return "arrow-back";
  if (modifier.includes("right")) return "arrow-forward";
  if (modifier.includes("straight")) return "arrow-up";
  return "arrow-up";
};

const formatDistance = (m: number) => {
  if (m < 15) return "< 10 m";
  if (m < 50) return `${Math.round(m / 10) * 10} m`;
  if (m < 1000) return `${Math.round(m / 50) * 50} m`;
  return `${(m / 1000).toFixed(1)} km`;
};
const formatDuration = (s: number) => {
  const min = Math.round(s / 60);
  if (min < 1) return `<1 min`;
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
};
const arrivalTime = (s: number) => {
  const d = new Date(Date.now() + s * 1000);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

// Haversine distance in meters
function distMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Min distance from point to a polyline (route geometry coords)
function distanceToRoute(p: [number, number], coords: [number, number][]): number {
  if (coords.length === 0) return Infinity;
  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    // Approximate by checking distance to each endpoint
    best = Math.min(best, distMeters(p, a), distMeters(p, b));
  }
  return best;
}

function bearingTo(a: [number, number], b: [number, number]): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const toDeg = (x: number) => (x * 180) / Math.PI;
  const lat1 = toRad(a[1]); const lat2 = toRad(b[1]);
  const dLng = toRad(b[0] - a[0]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Strip "in N meters/km" boilerplate that Mapbox bakes into instruction for cleaner display.
// We render distance separately.
function cleanInstruction(s: string): string {
  return (s || "").replace(/^In \d+[\d,\.]*\s*(meters|m|kilometers|km|feet|ft|miles|mi)\s*,?\s*/i, "");
}

const transitIcon = (kind: string): keyof typeof Ionicons.glyphMap => {
  switch (kind) {
    case "bus": case "trolleybus": return "bus";
    case "ferry": return "boat";
    case "subway": case "rail": case "tram": case "monorail": case "funicular": return "train";
    default: return "navigate";
  }
};
const transitWhen = (d: { minutes: number | null; time_label?: string }): string => {
  if (d.minutes != null) {
    if (d.minutes <= 0) return "Now";
    if (d.minutes === 1) return "1 min";
    return `${d.minutes} min`;
  }
  return d.time_label || "—";
};
// Real-time punctuality from the GTFS-RT delay (seconds). null when the row is
// schedule-only (no live feed for that trip).
const transitStatus = (
  d: { realtime: boolean; delay?: number | null },
): { text: string; color: string } | null => {
  if (!d.realtime) return null;
  const delay = d.delay;
  if (delay == null) return { text: "Live", color: theme.success };
  if (Math.abs(delay) < 60) return { text: "On time", color: theme.success };
  const mins = Math.round(Math.abs(delay) / 60);
  return delay > 0
    ? { text: `${mins} min late`, color: theme.warning }
    : { text: `${mins} min early`, color: theme.textSecondary };
};
const agoLabel = (fetchedAt: number | null, now: number): string => {
  if (!fetchedAt) return "";
  const s = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (s < 5) return "Updated just now";
  if (s < 60) return `Updated ${s}s ago`;
  return `Updated ${Math.round(s / 60)} min ago`;
};

export default function DirectionsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const mapRef = useRef<MapboxWebViewHandle>(null);
  const params = useLocalSearchParams<{ destLng?: string; destLat?: string; destName?: string }>();

  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  const userLocationRef = useRef<[number, number] | null>(null); // fresh loc for search bias (no per-fix effect re-runs)
  const [heading, setHeading] = useState<number>(0);
  const [locAccuracy, setLocAccuracy] = useState<number | null>(null);
  const [waypoints, setWaypoints] = useState<Waypoint[]>([
    { id: newId(), query: "Your location", feature: null, isUserLocation: true },
    { id: newId(), query: "", feature: null },
  ]);
  const [activeWaypointId, setActiveWaypointId] = useState<string | null>(null);
  const [results, setResults] = useState<GeocodeFeature[]>([]);
  const [searching, setSearching] = useState(false);
  const [profile, setProfile] = useState<Profile>("driving-traffic");
  const [routeInfo, setRouteInfo] = useState<{ distance: number; duration: number } | null>(null);
  const [routes, setRoutes] = useState<RouteResult[]>([]);
  const [selectedRouteIdx, setSelectedRouteIdx] = useState(0);
  const [routeCoords, setRouteCoords] = useState<[number, number][]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [showSteps, setShowSteps] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  // Drag-or-tap handle for the foldable bottom panel.
  // A small move counts as a tap (toggle); a clear vertical drag sets the state directly.
  const panelHandle = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4,
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 24) setPanelOpen(false);
        else if (g.dy < -24) setPanelOpen(true);
        else setPanelOpen((o) => !o);
      },
    })
  ).current;
  const [loadingRoute, setLoadingRoute] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [navMode, setNavMode] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [distToManeuver, setDistToManeuver] = useState<number | null>(null);
  const [remainingDist, setRemainingDist] = useState<number | null>(null);
  const [remainingDur, setRemainingDur] = useState<number | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const [rerouting, setRerouting] = useState(false);
  const lastSpokenKey = useRef<string>("");
  const lastRerouteAt = useRef<number>(0);
  const [etaShare, setEtaShare] = useState<EtaShare | null>(null);
  const [sharingEta, setSharingEta] = useState(false);

  // ── Map-nav upgrades ──
  const [excludes, setExcludes] = useState<Set<"toll" | "motorway" | "ferry">>(new Set());
  const [maxSpeed, setMaxSpeed] = useState<{ speed: number; unit: string } | null>(null);
  const [routeLegs, setRouteLegs] = useState<any[]>([]);
  const [sarOpen, setSarOpen] = useState(false);
  const [sarCategory, setSarCategory] = useState<string | null>(null);
  const [sarResults, setSarResults] = useState<GeocodeFeature[]>([]);
  const [sarLoading, setSarLoading] = useState(false);

  // ── Nearby public transit (TransitLand) ──
  const [transitOpen, setTransitOpen] = useState(false);
  const [transitData, setTransitData] = useState<TransitNearby | null>(null);
  const [transitLoading, setTransitLoading] = useState(false);
  const [transitFetchedAt, setTransitFetchedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(Date.now()); // drives the "updated Xs ago" label

  // Step end-coordinates (where each maneuver "completes") — derived from route coords.
  // We approximate by using the cumulative distance per step against the route.
  const stepEndCoords = useMemo(() => {
    if (!steps.length || !routeCoords.length) return [] as [number, number][];
    const ends: [number, number][] = [];
    // Cumulative distances along coords
    const cum: number[] = [0];
    for (let i = 1; i < routeCoords.length; i++) {
      cum.push(cum[i - 1] + distMeters(routeCoords[i - 1], routeCoords[i]));
    }
    let acc = 0;
    let ci = 0;
    for (const s of steps) {
      acc += s.distance;
      while (ci < cum.length - 1 && cum[ci] < acc) ci++;
      ends.push(routeCoords[Math.min(ci, routeCoords.length - 1)]);
    }
    return ends;
  }, [steps, routeCoords]);

  // ───────── Location: foreground permission + live watcher ─────────
  const watcherRef = useRef<Location.LocationSubscription | null>(null);
  const startWatch = useCallback(async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return;
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      userLocationRef.current = [pos.coords.longitude, pos.coords.latitude];
      setUserLocation([pos.coords.longitude, pos.coords.latitude]);
      if (pos.coords.accuracy != null) setLocAccuracy(pos.coords.accuracy);
      if (pos.coords.heading != null && pos.coords.heading >= 0) setHeading(pos.coords.heading);
      watcherRef.current?.remove();
      watcherRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1000,
          distanceInterval: 3,
        },
        (loc) => {
          userLocationRef.current = [loc.coords.longitude, loc.coords.latitude];
          setUserLocation([loc.coords.longitude, loc.coords.latitude]);
          if (loc.coords.accuracy != null) setLocAccuracy(loc.coords.accuracy);
          if (loc.coords.heading != null && loc.coords.heading >= 0) setHeading(loc.coords.heading);
        },
      );
    } catch {}
  }, []);

  useEffect(() => {
    startWatch();
    return () => { watcherRef.current?.remove(); };
  }, [startWatch]);

  // Apply incoming destination from /map
  useEffect(() => {
    if (params.destLng && params.destLat) {
      const feature: GeocodeFeature = {
        id: `incoming_${params.destLng}_${params.destLat}`,
        name: params.destName || "Destination",
        full_address: "",
        longitude: Number(params.destLng),
        latitude: Number(params.destLat),
      };
      setWaypoints((wps) => {
        const next = [...wps];
        next[next.length - 1] = { id: next[next.length - 1].id, query: feature.name, feature };
        return next;
      });
    }
  }, [params.destLng, params.destLat, params.destName]);

  // Load one route (the primary, or a chosen alternate) into state + the map.
  // Alternates are drawn faint behind the active route.
  const applyRoute = useCallback((rs: RouteResult[], idx: number) => {
    const r = rs[idx];
    if (!r) return;
    setRouteInfo({ distance: r.distance, duration: r.duration });
    setRouteCoords(r.geometry.coordinates);
    setRouteLegs(r.legs);
    setSteps(r.legs.flatMap((l) => l.steps));
    setStepIdx(0);
    mapRef.current?.setRoute(r.geometry);
    mapRef.current?.setAltRoutes(rs.filter((_, i) => i !== idx).map((x) => x.geometry));
  }, []);

  // Tapping an alternate-route card just re-selects it (no refetch).
  const selectRoute = useCallback((idx: number) => {
    setSelectedRouteIdx(idx);
    applyRoute(routes, idx);
  }, [routes, applyRoute]);

  const recomputeRoute = useCallback(async (originOverride?: [number, number]) => {
    const coords: [number, number][] = waypoints
      .map((w, i) => {
        if (w.isUserLocation) return originOverride || userLocation;
        if (w.feature) return [w.feature.longitude, w.feature.latitude] as [number, number];
        return null;
      })
      .filter(Boolean) as [number, number][];
    if (coords.length < 2 || coords.length !== waypoints.length) {
      setRouteInfo(null); setSteps([]); setRouteCoords([]); setRoutes([]);
      mapRef.current?.setRoute(null);
      mapRef.current?.setAltRoutes([]);
      return;
    }
    setLoadingRoute(true);
    try {
      const rs = await fetchRoutes(coords, profile, {
        exclude: Array.from(excludes),
        annotations: profile.startsWith("driving"),
        alternatives: !navMode, // alternates only matter while planning
      });
      setRoutes(rs);
      setSelectedRouteIdx(0);
      if (rs.length) {
        applyRoute(rs, 0);
        mapRef.current?.setMarkers(
          coords.map((c, i) => ({
            id: `wp_${i}`,
            longitude: c[0],
            latitude: c[1],
            color: i === 0 ? "#22C55E" : i === coords.length - 1 ? "#EF4444" : "#EAB308",
            label: i === 0 ? "A" : i === coords.length - 1 ? "B" : String(i + 1),
          })),
        );
        if (!navMode) mapRef.current?.fitBounds(coords, 100);
      } else {
        setRouteInfo(null); setSteps([]); setRouteCoords([]);
        mapRef.current?.setRoute(null);
        mapRef.current?.setAltRoutes([]);
      }
    } finally {
      setLoadingRoute(false);
    }
  }, [waypoints, userLocation, profile, navMode, excludes, applyRoute]);

  // Auto-compute route when waypoints / profile / excludes change (NOT every GPS tick).
  // Gated on mapReady so the very first route reliably draws after the map loads.
  useEffect(() => { if (mapReady) recomputeRoute(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [waypoints, profile, excludes, mapReady]);

  // Search
  useEffect(() => {
    if (!activeWaypointId) return;
    const wp = waypoints.find((w) => w.id === activeWaypointId);
    const q = wp?.query || "";
    if (!q.trim() || wp?.isUserLocation) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await forwardGeocode(q, userLocationRef.current || undefined);
        setResults(r);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [activeWaypointId, waypoints]);

  const onMapReady = useCallback(() => {
    // Map already loaded with the initial (Streets) style — no redundant reload.
    setMapReady(true);
  }, []);

  // Long-press the map → set that point as the destination.
  const setDestinationTo = useCallback((lng: number, lat: number, name: string) => {
    setWaypoints((ws) => {
      const next = [...ws];
      const last = next[next.length - 1];
      next[next.length - 1] = {
        id: last.id,
        query: name,
        isUserLocation: false,
        feature: { id: `pin_${Date.now()}`, name, full_address: "", longitude: lng, latitude: lat },
      };
      return next;
    });
    setActiveWaypointId(null);
    setResults([]);
  }, []);

  const onEvent = (e: MapboxEvent) => {
    if (e.type === "ready") onMapReady();
    else if (e.type === "longpress" && !navMode) {
      setDestinationTo(e.lng, e.lat, "Dropped pin");
    }
  };

  const updateWaypoint = (id: string, patch: Partial<Waypoint>) => {
    setWaypoints((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  };
  const addStop = () => {
    setWaypoints((ws) => {
      const next = [...ws];
      next.splice(ws.length - 1, 0, { id: newId(), query: "", feature: null });
      return next;
    });
  };
  const removeStop = (id: string) => {
    setWaypoints((ws) => {
      if (ws.length <= 2) return ws;
      return ws.filter((w) => w.id !== id);
    });
  };
  // Swap origin and destination (carries the "your location" flag with its slot).
  const swapEnds = () => {
    setWaypoints((ws) => {
      if (ws.length < 2) return ws;
      const next = [...ws];
      const a = next[0], b = next[next.length - 1];
      next[0] = { ...b, id: a.id };
      next[next.length - 1] = { ...a, id: b.id };
      return next;
    });
    setActiveWaypointId(null);
    setResults([]);
  };
  // Reset the planner back to "your location → empty".
  const clearRoute = () => {
    setWaypoints([
      { id: newId(), query: "Your location", feature: null, isUserLocation: true },
      { id: newId(), query: "", feature: null },
    ]);
    setActiveWaypointId(null);
    setResults([]);
  };
  const pickResult = (f: GeocodeFeature) => {
    if (!activeWaypointId) return;
    updateWaypoint(activeWaypointId, { query: f.name, feature: f, isUserLocation: false });
    setActiveWaypointId(null);
    setResults([]);
  };

  const startNavigation = () => {
    if (!routeInfo || !userLocation) return;
    setNavMode(true);
    setShowSteps(false);
    setStepIdx(0);
    lastSpokenKey.current = "";
    // Drop the alternates — we commit to the selected route while navigating.
    mapRef.current?.setAltRoutes([]);
    // Camera: drop straight into the tilted, course-up navigation view (single
    // smooth move) so the road ahead and the next turn are clearly visible.
    const brg = (typeof heading === "number" && heading >= 0)
      ? heading
      : (routeCoords.length > 1 ? bearingTo(userLocation, routeCoords[1]) : 0);
    mapRef.current?.followCamera(userLocation[0], userLocation[1], 17.5, brg, 55);
  };

  const recenterMap = () => {
    if (!userLocation) return;
    if (navMode) {
      const brg = (typeof heading === "number" && heading >= 0)
        ? heading
        : (routeCoords.length > 1 ? bearingTo(userLocation, routeCoords[1]) : 0);
      mapRef.current?.followCamera(userLocation[0], userLocation[1], 17.5, brg, 55);
    } else {
      mapRef.current?.flyTo(userLocation[0], userLocation[1], 15);
    }
  };

  // Zoom out to frame the whole trip.
  const overviewRoute = () => {
    if (routeCoords.length > 1) mapRef.current?.fitBounds(routeCoords, 80);
  };
  // Reset the map to north-up (and flatten any tilt).
  const northUp = () => { mapRef.current?.resetNorth(); };

  const toggleExclude = (k: "toll" | "motorway" | "ferry") => {
    setExcludes((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  const openSAR = async (cat: string) => {
    if (!userLocation) return;
    setSarCategory(cat); setSarOpen(true); setSarLoading(true);
    try {
      const res = await categorySearch(cat, userLocation, 10);
      setSarResults(res);
    } catch { setSarResults([]); } finally { setSarLoading(false); }
  };

  const loadTransit = useCallback(async () => {
    const loc = userLocationRef.current || userLocation;
    if (!loc) return;
    setTransitLoading(true);
    try {
      const d = await api.transitNearby(loc[1], loc[0]);
      setTransitData(d);
      setTransitFetchedAt(Date.now());
    } catch {
      setTransitData(null);
    } finally {
      setTransitLoading(false);
    }
  }, [userLocation]);

  const openTransit = useCallback(() => {
    setTransitOpen(true);
    loadTransit();
  }, [loadTransit]);

  // Tick the "updated Xs ago" label while the sheet is open.
  useEffect(() => {
    if (!transitOpen) return;
    const t = setInterval(() => setNowTick(Date.now()), 10000);
    return () => clearInterval(t);
  }, [transitOpen]);

  const addSarStop = (f: GeocodeFeature) => {
    setWaypoints((ws) => {
      const next = [...ws];
      next.splice(ws.length - 1, 0, { id: newId(), query: f.name, feature: f });
      return next;
    });
    setSarOpen(false);
  };
  const exitNav = () => {
    setNavMode(false);
    Speech.stop();
    mapRef.current?.setPitch(0);
    mapRef.current?.setBearing(0);
    if (routeCoords.length) {
      const coords: [number, number][] = waypoints
        .map((w) => w.isUserLocation && userLocation ? userLocation : (w.feature ? [w.feature.longitude, w.feature.latitude] as [number, number] : null))
        .filter(Boolean) as [number, number][];
      mapRef.current?.fitBounds(coords, 100);
    }
  };

  // ───────── Follow camera + user dot — runs on EVERY GPS fix while navigating,
  // independent of step parsing, so the map always pans/tilts to track you. ─────
  useEffect(() => {
    if (!navMode || !userLocation) return;
    const useDeviceHeading = typeof heading === "number" && !isNaN(heading) && heading >= 0;
    const target = stepEndCoords[stepIdx] || (routeCoords.length > 1 ? routeCoords[1] : null);
    const brg = useDeviceHeading ? heading : (target ? bearingTo(userLocation, target) : 0);
    mapRef.current?.setUserLocation(userLocation[0], userLocation[1], locAccuracy ?? undefined, useDeviceHeading ? heading : undefined);
    // Tight, tilted, course-up camera so the streets and the next turn are visible.
    mapRef.current?.followCamera(userLocation[0], userLocation[1], 17.5, brg, 55);
  }, [navMode, userLocation, heading, locAccuracy, routeCoords, stepEndCoords, stepIdx]);

  // ───────── Nav loop: advance step + reroute + voice ─────────
  useEffect(() => {
    if (!navMode || !userLocation || steps.length === 0 || stepEndCoords.length === 0) return;
    const currentEnd = stepEndCoords[stepIdx];
    const d = currentEnd ? distMeters(userLocation, currentEnd) : null;
    setDistToManeuver(d);

    // Auto-advance when within ~25m of maneuver endpoint
    if (d != null && d < 25 && stepIdx < steps.length - 1) {
      setStepIdx((i) => Math.min(steps.length - 1, i + 1));
    }

    // Remaining distance/duration
    let remainD = 0;
    let remainT = 0;
    for (let i = stepIdx; i < steps.length; i++) {
      remainD += steps[i].distance;
      remainT += steps[i].duration;
    }
    // Subtract progress toward current step
    if (d != null && steps[stepIdx]) {
      const stepLen = steps[stepIdx].distance;
      const progress = Math.max(0, Math.min(stepLen, stepLen - d));
      remainD = remainD - progress;
      remainT = remainT - (steps[stepIdx].duration * (progress / Math.max(1, stepLen)));
    }
    setRemainingDist(remainD);
    setRemainingDur(remainT);

    // ── Speed limit lookup: find nearest route coord, then map to leg/segment ──
    if (routeLegs.length && routeCoords.length) {
      let bestI = 0, bestD = Infinity;
      for (let i = 0; i < routeCoords.length; i++) {
        const d2 = distMeters(userLocation, routeCoords[i]);
        if (d2 < bestD) { bestD = d2; bestI = i; }
      }
      // Find which leg/segment index `bestI` corresponds to
      let cursor = bestI;
      let foundSpeed: { speed: number; unit: string } | null = null;
      for (const leg of routeLegs) {
        const segs = (leg.maxspeeds || []) as (number | null)[];
        const units = (leg.maxspeed_units || []) as (string | undefined)[];
        if (cursor < segs.length) {
          const s = segs[cursor];
          const u = units[cursor];
          if (typeof s === "number" && u && s > 0) foundSpeed = { speed: s, unit: u };
          break;
        }
        cursor -= segs.length;
      }
      setMaxSpeed(foundSpeed);
    }

    // Off-route detection (throttle to 1 reroute per 8s).
    // Scale the threshold with GPS accuracy so a poor fix (common on web/desktop)
    // doesn't trigger a reroute storm that fights the follow camera.
    const offBy = distanceToRoute(userLocation, routeCoords);
    const offThreshold = Math.max(60, (locAccuracy ?? 0) * 1.5);
    if (offBy > offThreshold && Date.now() - lastRerouteAt.current > 8000 && !rerouting) {
      lastRerouteAt.current = Date.now();
      setRerouting(true);
      try { Speech.speak("Rerouting", { rate: 0.95 }); } catch {}
      recomputeRoute(userLocation).finally(() => setRerouting(false));
    }

    // Voice: speak at distance thresholds per step
    const s = steps[stepIdx];
    if (voiceOn && s) {
      const txt = cleanInstruction(s.instruction);
      let key = "";
      if (d == null) key = "";
      else if (d > 800) key = `${stepIdx}:far`;
      else if (d > 300) key = `${stepIdx}:near`;
      else if (d > 80) key = `${stepIdx}:close`;
      else key = `${stepIdx}:now`;
      if (key && key !== lastSpokenKey.current) {
        lastSpokenKey.current = key;
        let phrase = txt;
        if (d != null && d > 60) phrase = `In ${formatDistance(d)}, ${txt}`;
        try { Speech.stop(); Speech.speak(phrase, { rate: 0.95, pitch: 1.0 }); } catch {}
      }
    }
  }, [userLocation, navMode, steps, stepIdx, stepEndCoords, routeCoords, voiceOn, rerouting, heading, recomputeRoute, routeLegs, locAccuracy]);

  useEffect(() => () => { Speech.stop(); }, []);

  const shareEta = async () => {
    const last = waypoints[waypoints.length - 1];
    const dest = last?.feature;
    const origin = waypoints[0]?.isUserLocation ? userLocation : (waypoints[0]?.feature && [waypoints[0].feature.longitude, waypoints[0].feature.latitude] as [number, number]);
    if (!dest || !origin || !routeInfo) return;
    setSharingEta(true);
    try {
      const created = await api.createEta({
        destination_name: dest.name,
        destination_longitude: dest.longitude,
        destination_latitude: dest.latitude,
        initial_longitude: origin[0],
        initial_latitude: origin[1],
        eta_minutes: Math.round(routeInfo.duration / 60),
        ttl_minutes: 180,
      });
      setEtaShare(created);
      const origin2 = process.env.EXPO_PUBLIC_BACKEND_URL || "";
      const url = `${origin2}/eta/${created.share_id}`;
      const msg = `I'll be there in ~${Math.round(routeInfo.duration / 60)} min. Track me live:\n${url}`;
      try { await Share.share({ message: msg }); } catch {}
    } catch {} finally { setSharingEta(false); }
  };

  // Live position updates → push to ETA share
  useEffect(() => {
    if (!etaShare || !etaShare.active || !userLocation) return;
    const t = setInterval(() => {
      api.updateEta(etaShare.share_id, {
        current_longitude: userLocation[0],
        current_latitude: userLocation[1],
        eta_minutes: routeInfo ? Math.round((remainingDur || routeInfo.duration) / 60) : undefined,
      }).catch(() => {});
    }, 15000);
    return () => clearInterval(t);
  }, [etaShare, userLocation, routeInfo, remainingDur]);

  const stopEtaShare = async () => {
    if (!etaShare) return;
    try { await api.stopEta(etaShare.share_id); } catch {}
    setEtaShare(null);
  };

  const currentStep = steps[stepIdx];
  const nextStep = steps[stepIdx + 1];
  // How far through the current step we are (0..1), for the nav progress bar.
  const stepProgress = currentStep && currentStep.distance > 0 && distToManeuver != null
    ? Math.max(0, Math.min(1, 1 - distToManeuver / currentStep.distance))
    : 0;

  return (
    <View style={styles.root} testID="directions-screen">
      <MapboxWebView
        ref={mapRef}
        initialCenter={[-74.006, 40.7128]}
        initialZoom={11}
        initialStyle={MAP_STYLES.find((s) => s.key === "streets")!.url}
        onEvent={onEvent}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={StyleSheet.absoluteFillObject}
        pointerEvents="box-none"
      >
        {/* ───────── Header (always visible) ───────── */}
        <SafeAreaView edges={["top"]} pointerEvents="box-none">
          <View style={styles.headerRow}>
            {navMode ? (
              <TouchableOpacity onPress={exitNav} style={styles.iconBtn} testID="exit-nav-header" activeOpacity={0.85}>
                <Ionicons name="close" size={22} color="#fff" />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="back-btn" activeOpacity={0.85}>
                <Ionicons name="chevron-back" size={22} color="#fff" />
              </TouchableOpacity>
            )}
            <Text style={styles.headerTitle} numberOfLines={1}>
              {navMode ? "Navigating" : "Directions"}
            </Text>
            <SidebarMenuButton light />
          </View>
        </SafeAreaView>

        {/* ───────── Search / waypoints (non-nav mode) ───────── */}
        {!navMode && (
          <View style={styles.topWrap} pointerEvents="box-none">
            <View style={styles.card}>
              <View style={styles.cardTop}>
                <View style={{ flex: 1 }}>
                  {waypoints.map((w, i) => {
                const isFirst = i === 0;
                const isLast = i === waypoints.length - 1;
                const dotColor = isFirst ? theme.success : isLast ? theme.error : "#EAB308";
                return (
                  <View key={w.id}>
                    <View style={styles.row}>
                      <View style={[styles.dot, { backgroundColor: dotColor }]} />
                      <TextInput
                        style={styles.input}
                        placeholder={isFirst ? "From" : isLast ? "To" : "Stop"}
                        placeholderTextColor={theme.textMuted}
                        value={w.query}
                        onFocus={() => setActiveWaypointId(w.id)}
                        onChangeText={(t) => {
                          updateWaypoint(w.id, { query: t, isUserLocation: false, feature: t ? w.feature : null });
                          setActiveWaypointId(w.id);
                        }}
                        editable={!w.isUserLocation}
                        testID={`wp-${i}-input`}
                      />
                      {w.isUserLocation ? (
                        <Ionicons name="locate" size={16} color={theme.primary} />
                      ) : !isFirst && !isLast ? (
                        <TouchableOpacity onPress={() => removeStop(w.id)} testID={`wp-${i}-remove`}>
                          <Ionicons name="close-circle" size={18} color={theme.textMuted} />
                        </TouchableOpacity>
                      ) : null}
                    </View>
                    {i < waypoints.length - 1 && <View style={styles.divider} />}
                  </View>
                );
                  })}
                </View>
                <TouchableOpacity style={styles.swapBtn} onPress={swapEnds} testID="swap-waypoints" activeOpacity={0.85}>
                  <Ionicons name="swap-vertical" size={18} color={theme.primary} />
                </TouchableOpacity>
              </View>
              <View style={styles.cardActions}>
                <TouchableOpacity style={styles.addStopBtn} onPress={addStop} testID="add-stop">
                  <Ionicons name="add" size={16} color={theme.primary} />
                  <Text style={styles.addStopText}>Add stop</Text>
                </TouchableOpacity>
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  {profile.startsWith("driving") && (
                    <TouchableOpacity style={styles.addStopBtn} onPress={() => setShowAdvanced((v) => !v)} testID="toggle-options">
                      <Ionicons name="options-outline" size={16} color={showAdvanced ? theme.primary : theme.textMuted} />
                      <Text style={[styles.addStopText, { color: showAdvanced ? theme.primary : theme.textMuted }]}>Options</Text>
                    </TouchableOpacity>
                  )}
                  {!!routeInfo && (
                    <TouchableOpacity style={styles.addStopBtn} onPress={clearRoute} testID="clear-route">
                      <Ionicons name="close" size={16} color={theme.textMuted} />
                      <Text style={[styles.addStopText, { color: theme.textMuted }]}>Clear</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </View>

            {profile.startsWith("driving") && showAdvanced && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.avoidRow}
              >
                {([
                  { k: "toll" as const, label: "Avoid tolls", icon: "cash-outline" as const },
                  { k: "motorway" as const, label: "Avoid highways", icon: "remove-outline" as const },
                  { k: "ferry" as const, label: "Avoid ferries", icon: "boat-outline" as const },
                ]).map((opt) => {
                  const on = excludes.has(opt.k);
                  return (
                    <TouchableOpacity
                      key={opt.k}
                      onPress={() => toggleExclude(opt.k)}
                      style={[styles.avoidChip, on && styles.avoidChipOn]}
                      testID={`avoid-${opt.k}`}
                      activeOpacity={0.85}
                    >
                      <Ionicons name={opt.icon} size={14} color={on ? theme.primary : theme.textSecondary} />
                      <Text style={[styles.avoidText, { color: on ? theme.primary : theme.textSecondary }]}>{opt.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            {!!activeWaypointId && results.length > 0 && (
              <View style={styles.resultsCard} testID="dir-results">
                <FlatList
                  data={results}
                  keyExtractor={(i) => i.id}
                  keyboardShouldPersistTaps="handled"
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      style={styles.resultRow}
                      onPress={() => pickResult(item)}
                      testID={`dir-result-${item.id}`}
                    >
                      <Ionicons name="location" size={16} color={theme.primary} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.resultTitle} numberOfLines={1}>{item.name}</Text>
                        {!!item.full_address && (
                          <Text style={styles.resultSub} numberOfLines={1}>{item.full_address}</Text>
                        )}
                      </View>
                    </TouchableOpacity>
                  )}
                />
              </View>
            )}
            {searching && (
              <View style={styles.searchingPill}>
                <ActivityIndicator color={theme.primary} size="small" />
              </View>
            )}
          </View>
        )}

        {/* ───────── Navigation top banner ───────── */}
        {navMode && currentStep && (
          <View style={styles.navTopCard}>
            <View style={styles.navBanner}>
              <View style={styles.navIconBox}>
                <Ionicons
                  name={stepIconFor(currentStep.modifier, currentStep.type)}
                  size={19}
                  color="#fff"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.navDistBig}>
                  {distToManeuver != null ? formatDistance(distToManeuver) : formatDistance(currentStep.distance)}
                </Text>
                <Text style={styles.navInstr} numberOfLines={2}>
                  {cleanInstruction(currentStep.instruction)}
                </Text>
              </View>
            </View>
            <View style={styles.navProgressTrack}>
              <View style={[styles.navProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
            </View>
            {nextStep && (
              <View style={styles.thenRow}>
                <Ionicons
                  name={stepIconFor(nextStep.modifier, nextStep.type)}
                  size={16}
                  color={theme.textSecondary}
                />
                <Text style={styles.thenText} numberOfLines={1}>
                  Then {cleanInstruction(nextStep.instruction)}
                </Text>
              </View>
            )}
            {rerouting && (
              <View style={styles.rerouteRow}>
                <ActivityIndicator color={theme.primary} size="small" />
                <Text style={styles.rerouteText}>Rerouting…</Text>
              </View>
            )}
          </View>
        )}

        {/* ── Nav-mode floating chrome: speed limit, recenter pill, SAR chips ── */}
        {navMode && (
          <>
            {/* Speed limit badge (top-right) */}
            {maxSpeed && (
              <View style={styles.speedBadgeWrap} pointerEvents="none">
                <View style={styles.speedBadge}>
                  <Text style={styles.speedNum}>{Math.round(maxSpeed.speed)}</Text>
                  <Text style={styles.speedUnit}>{(maxSpeed.unit || "km/h").toUpperCase()}</Text>
                </View>
              </View>
            )}

            {/* Map controls (right side, above bottom card): north-up, overview, recenter */}
            <View style={styles.navControls} pointerEvents="box-none">
              <TouchableOpacity
                style={styles.mapCtrlBtn}
                onPress={northUp}
                testID="northup-btn"
                activeOpacity={0.85}
              >
                <Ionicons name="compass-outline" size={20} color={theme.textPrimary} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.mapCtrlBtn}
                onPress={overviewRoute}
                testID="overview-btn"
                activeOpacity={0.85}
              >
                <Ionicons name="expand-outline" size={20} color={theme.textPrimary} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.mapCtrlBtn}
                onPress={recenterMap}
                testID="recenter-btn"
                activeOpacity={0.85}
              >
                <Ionicons name="locate" size={20} color={theme.primary} />
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* ───────── Bottom panel ───────── */}
        {/* Pre-nav: route summary + start button. Nav-mode: footer with ETA/dist + end button. */}
        <View
          style={[
            styles.bottomCard,
            { paddingBottom: navMode ? 16 : 18 },
          ]}
        >
          <View style={styles.grabberWrap} testID="panel-toggle" {...panelHandle.panHandlers}>
            <View style={styles.grabber} />
            <View style={styles.grabberHint}>
              <Ionicons name={panelOpen ? "chevron-down" : "chevron-up"} size={15} color={theme.textSecondary} />
              <Text style={styles.grabberHintText}>{panelOpen ? "Hide" : "Show details"}</Text>
            </View>
          </View>

          {!navMode && panelOpen && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.profileRow}
            >
              {PROFILES.map((p) => {
                const a = p.key === profile;
                return (
                  <TouchableOpacity
                    key={p.key}
                    onPress={() => setProfile(p.key)}
                    style={[styles.profileChip, a && styles.profileChipActive]}
                    testID={`profile-${p.key}`}
                  >
                    <Ionicons name={p.icon} size={16} color={a ? theme.primary : theme.textSecondary} />
                    <Text style={[styles.profileLabel, { color: a ? theme.primary : theme.textSecondary }]}>
                      {p.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              {/* Transit isn't a routing profile — it opens nearby departures. */}
              <TouchableOpacity
                onPress={openTransit}
                style={styles.profileChip}
                testID="profile-transit"
                activeOpacity={0.85}
              >
                <Ionicons name="bus" size={16} color={theme.textSecondary} />
                <Text style={[styles.profileLabel, { color: theme.textSecondary }]}>Transit</Text>
              </TouchableOpacity>
            </ScrollView>
          )}

          {/* Alternate-route picker (only when Mapbox returned more than one). */}
          {!navMode && panelOpen && routes.length > 1 && (
            <View style={styles.routeOptions}>
              {routes.map((r, i) => {
                const a = i === selectedRouteIdx;
                const fastest = i === routes.reduce((m, x, j, arr) => (x.duration < arr[m].duration ? j : m), 0);
                return (
                  <TouchableOpacity
                    key={i}
                    style={[styles.routeOption, a && styles.routeOptionActive]}
                    onPress={() => selectRoute(i)}
                    activeOpacity={0.85}
                    testID={`route-option-${i}`}
                  >
                    <Text style={[styles.routeOptDur, a && { color: theme.primary }]}>{formatDuration(r.duration)}</Text>
                    <Text style={styles.routeOptDist}>{formatDistance(r.distance)}</Text>
                    <Text style={[styles.routeOptTag, fastest ? { color: theme.primary } : null]}>
                      {fastest ? "Fastest" : i === 0 ? "Recommended" : "Alternative"}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {loadingRoute && !routeInfo ? (
            <View style={styles.routeBox}><ActivityIndicator color={theme.primary} /></View>
          ) : routeInfo ? (
            navMode ? (
              <View style={styles.navFooter}>
                {panelOpen ? (
                  <View style={styles.navStats}>
                    <View style={styles.navStat}>
                      <Text style={styles.navStatHero}>{arrivalTime(remainingDur ?? routeInfo.duration)}</Text>
                      <Text style={styles.navStatLabel}>arrival</Text>
                    </View>
                    <View style={styles.navStatDivider} />
                    <View style={styles.navStat}>
                      <Text style={styles.navStatValue}>{formatDuration(remainingDur ?? routeInfo.duration)}</Text>
                      <Text style={styles.navStatLabel}>time left</Text>
                    </View>
                    <View style={styles.navStatDivider} />
                    <View style={styles.navStat}>
                      <Text style={styles.navStatValue}>{formatDistance(remainingDist ?? routeInfo.distance)}</Text>
                      <Text style={styles.navStatLabel}>distance</Text>
                    </View>
                  </View>
                ) : (
                  <Text style={styles.navCollapsedLine}>
                    {formatDuration(remainingDur ?? routeInfo.duration)} · {formatDistance(remainingDist ?? routeInfo.distance)} · arrive {arrivalTime(remainingDur ?? routeInfo.duration)}
                  </Text>
                )}
                <View style={styles.navBtnRow}>
                  <TouchableOpacity
                    onPress={() => {
                      const next = !voiceOn;
                      setVoiceOn(next);
                      if (!next) Speech.stop();
                    }}
                    style={[styles.iconCircle, voiceOn && { backgroundColor: "rgba(0,168,132,0.18)", borderColor: theme.primary }]}
                    testID="voice-toggle"
                    activeOpacity={0.85}
                  >
                    <Ionicons name={voiceOn ? "volume-high" : "volume-mute"} size={19} color={voiceOn ? theme.primary : theme.textMuted} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setShowSteps((s) => !s)}
                    style={[styles.iconCircle, showSteps && { backgroundColor: theme.surfaceAlt, borderColor: theme.primary }]}
                    testID="toggle-steps"
                    activeOpacity={0.85}
                  >
                    <Ionicons name="list" size={19} color={showSteps ? theme.primary : theme.textSecondary} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={exitNav} style={styles.endBtn} testID="end-route-btn" activeOpacity={0.85}>
                    <Ionicons name="close" size={16} color="#fff" />
                    <Text style={styles.endBtnText}>End route</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <>
                <View style={styles.goRow}>
                  <TouchableOpacity
                    style={{ flex: 1 }}
                    onPress={() => setShowSteps((s) => !s)}
                    testID="route-summary"
                    activeOpacity={0.7}
                  >
                    <Text style={styles.goDur}>{formatDuration(routeInfo.duration)}</Text>
                    <Text style={styles.goSub}>
                      {arrivalTime(routeInfo.duration)} ETA · {formatDistance(routeInfo.distance)}
                      {routes.length > 1 &&
                      selectedRouteIdx === routes.reduce((m, x, j, arr) => (x.duration < arr[m].duration ? j : m), 0)
                        ? " · Fastest"
                        : ""}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.goBtn}
                    onPress={startNavigation}
                    testID="start-nav"
                    activeOpacity={0.85}
                  >
                    <Text style={styles.goText}>GO</Text>
                  </TouchableOpacity>
                </View>
                {panelOpen && (
                  <View style={styles.goLinks}>
                    <TouchableOpacity onPress={() => setShowSteps((s) => !s)} testID="toggle-steps-link" hitSlop={8}>
                      <Text style={styles.linkText}>{showSteps ? "Hide steps" : `${steps.length} steps`}</Text>
                    </TouchableOpacity>
                    <Text style={styles.linkDot}>·</Text>
                    {!etaShare ? (
                      <TouchableOpacity onPress={shareEta} disabled={sharingEta} testID="share-eta-btn" hitSlop={8}>
                        <Text style={styles.linkText}>{sharingEta ? "Sharing…" : "Share live ETA"}</Text>
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity onPress={stopEtaShare} testID="stop-eta-btn" hitSlop={8}>
                        <Text style={[styles.linkText, { color: theme.error }]}>Stop sharing ETA</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </>
            )
          ) : (
            !navMode && (
              <View style={styles.routeBox}>
                <Text style={styles.placeholderText}>
                  Pick origin & destination to see route
                </Text>
              </View>
            )
          )}

          {panelOpen && showSteps && steps.length > 0 && (
            <View style={styles.stepsList} testID="steps-list">
              <ScrollView style={{ maxHeight: 220 }}>
                {steps.map((s, i) => (
                  <TouchableOpacity
                    key={i}
                    style={[styles.stepRow, navMode && i === stepIdx && styles.stepRowActive]}
                    onPress={() => setStepIdx(i)}
                    testID={`step-${i}`}
                  >
                    <View style={styles.stepIcon}>
                      <Ionicons name={stepIconFor(s.modifier, s.type)} size={16} color={theme.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.stepInstr} numberOfLines={2}>{cleanInstruction(s.instruction)}</Text>
                      <Text style={styles.stepDist}>{formatDistance(s.distance)}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>

      {/* Search-along-route results sheet */}
      {sarOpen && (
        <View style={styles.sarSheetWrap} pointerEvents="box-none">
          <View style={[styles.sarSheet, { paddingBottom: insets.bottom + 14 }]}>
            <View style={styles.sarHeader}>
              <Text style={styles.sarTitle}>
                {sarCategory === "gas_station" ? "Gas stations" :
                 sarCategory === "coffee" ? "Coffee" :
                 sarCategory === "restaurant" ? "Food" :
                 sarCategory === "parking_lot" ? "Parking" : "Nearby"}
              </Text>
              <TouchableOpacity onPress={() => setSarOpen(false)} testID="sar-close">
                <Ionicons name="close" size={22} color={theme.textPrimary} />
              </TouchableOpacity>
            </View>
            {sarLoading ? (
              <ActivityIndicator color={theme.primary} style={{ marginVertical: 30 }} />
            ) : sarResults.length === 0 ? (
              <Text style={styles.sarEmpty}>No results nearby.</Text>
            ) : (
              <FlatList
                data={sarResults}
                keyExtractor={(i) => i.id}
                style={{ maxHeight: 320 }}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.sarRow}
                    onPress={() => addSarStop(item)}
                    testID={`sar-result-${item.id}`}
                  >
                    <Ionicons name="add-circle" size={20} color={theme.primary} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.sarRowTitle} numberOfLines={1}>{item.name}</Text>
                      {!!item.full_address && (
                        <Text style={styles.sarRowSub} numberOfLines={1}>{item.full_address}</Text>
                      )}
                    </View>
                  </TouchableOpacity>
                )}
              />
            )}
          </View>
        </View>
      )}

      {/* Nearby public transit departures (TransitLand) */}
      {transitOpen && (
        <View style={styles.sarSheetWrap} pointerEvents="box-none">
          <View style={[styles.sarSheet, { paddingBottom: insets.bottom + 14 }]}>
            <View style={styles.sarHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sarTitle}>Nearby transit</Text>
                {transitData?.configured && transitFetchedAt && !transitLoading && (
                  <Text style={styles.transitUpdated}>{agoLabel(transitFetchedAt, nowTick)}</Text>
                )}
              </View>
              <TouchableOpacity
                onPress={loadTransit}
                disabled={transitLoading}
                testID="transit-refresh"
                style={{ padding: 4, marginRight: 6 }}
                activeOpacity={0.7}
              >
                <Ionicons name="refresh" size={20} color={transitLoading ? theme.textMuted : theme.primary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setTransitOpen(false)} testID="transit-close" style={{ padding: 4 }}>
                <Ionicons name="close" size={22} color={theme.textPrimary} />
              </TouchableOpacity>
            </View>
            {transitLoading ? (
              <ActivityIndicator color={theme.primary} style={{ marginVertical: 30 }} />
            ) : !transitData?.configured ? (
              <Text style={styles.sarEmpty}>
                Transit isn’t set up yet. Add a free TransitLand API key
                (TRANSITLAND_API_KEY) to enable live departures.
              </Text>
            ) : transitData.departures.length === 0 ? (
              <Text style={styles.sarEmpty}>
                No upcoming departures found near you.
              </Text>
            ) : (
              <FlatList
                data={transitData.departures}
                keyExtractor={(_i, idx) => String(idx)}
                style={{ maxHeight: 360 }}
                renderItem={({ item }) => {
                  const st = transitStatus(item);
                  // Tint the countdown amber when the trip is actually running late.
                  const isLate = (item.delay ?? 0) >= 60 && item.realtime;
                  return (
                    <View style={styles.transitRow} testID="transit-departure">
                      <View style={styles.transitBadge}>
                        <Ionicons name={transitIcon(item.kind)} size={14} color="#fff" />
                        <Text style={styles.transitBadgeText} numberOfLines={1}>{item.route}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.transitHeadsign} numberOfLines={1}>
                          {item.headsign || item.route_long || "—"}
                        </Text>
                        <Text style={styles.transitStop} numberOfLines={1}>{item.stop_name}</Text>
                      </View>
                      <View style={styles.transitWhenWrap}>
                        <Text style={[styles.transitWhen, isLate && { color: theme.warning }]}>
                          {transitWhen(item)}
                        </Text>
                        {st && (
                          <View style={styles.transitLiveRow}>
                            <View style={[styles.transitLiveDot, { backgroundColor: st.color }]} />
                            <Text style={[styles.transitLiveText, { color: st.color }]}>{st.text}</Text>
                          </View>
                        )}
                      </View>
                    </View>
                  );
                }}
              />
            )}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },

  headerRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4, gap: 10,
  },
  iconBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.2)",
    alignItems: "center", justifyContent: "center",
  },
  headerTitle: {
    flex: 1, color: "#fff", fontSize: 16, fontWeight: "800",
    textAlign: "center", letterSpacing: -0.3,
    textShadowColor: "rgba(0,0,0,0.7)", textShadowRadius: 6,
  },

  topWrap: { paddingHorizontal: 16, paddingTop: 6 },
  card: {
    backgroundColor: "rgba(15,15,17,0.97)",
    borderRadius: 16,
    borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 14, paddingVertical: 7,
    shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 12, elevation: 6,
    position: "relative",
  },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  swapBtn: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  cardActions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  input: {
    flex: 1, color: theme.textPrimary, fontSize: 14,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.border, marginLeft: 22 },
  addStopBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingVertical: 8, paddingLeft: 22,
  },
  addStopText: { color: theme.primary, fontSize: 13, fontWeight: "700" },

  searchingPill: {
    position: "absolute", right: 24, top: 16,
  },
  resultsCard: {
    marginTop: 8,
    backgroundColor: "rgba(15,15,17,0.97)",
    borderWidth: 1, borderColor: theme.border,
    borderRadius: 16, overflow: "hidden", maxHeight: 260,
  },
  resultRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  resultTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "600" },
  resultSub: { color: theme.textSecondary, fontSize: 12, marginTop: 2 },

  // Navigation top card
  navTopCard: {
    marginHorizontal: 12, marginTop: 4,
    backgroundColor: theme.primary,
    borderRadius: 22,
    shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 16, elevation: 8,
    overflow: "hidden",
  },
  navBanner: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  navIconBox: {
    width: 38, height: 38, borderRadius: 11,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center", justifyContent: "center",
  },
  navDistBig: { color: "#fff", fontSize: 18, fontWeight: "800", letterSpacing: -0.4 },
  navInstr: { color: "rgba(255,255,255,0.96)", fontSize: 12.5, fontWeight: "600", marginTop: 0 },
  thenRow: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 5,
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  thenText: { color: "rgba(255,255,255,0.85)", fontSize: 10.5, fontWeight: "600", flex: 1 },
  navProgressTrack: { height: 3, backgroundColor: "rgba(255,255,255,0.22)" },
  navProgressFill: { height: 3, backgroundColor: "#fff" },
  rerouteRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  rerouteText: { color: "#fff", fontSize: 12, fontWeight: "700" },

  // Bottom panel
  bottomCard: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(10,10,12,0.97)",
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderTopWidth: 1, borderColor: theme.border,
    paddingHorizontal: 18, paddingTop: 6, gap: 8,
  },
  grabberWrap: { alignSelf: "stretch", alignItems: "center", paddingTop: 12, paddingBottom: 10, gap: 6, marginHorizontal: -20, marginTop: -10 },
  grabber: { width: 48, height: 6, borderRadius: 3, backgroundColor: theme.textMuted, opacity: 0.7 },
  grabberHint: { flexDirection: "row", alignItems: "center", gap: 4 },
  grabberHintText: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "700" },
  navCollapsedLine: { color: theme.textSecondary, fontSize: 14, fontWeight: "600", textAlign: "center", paddingVertical: 2 },
  profileRow: { gap: 8, paddingRight: 16 },
  profileChip: {
    height: 34, flexShrink: 0,
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 13, borderRadius: 17,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
  },
  profileChipActive: { borderColor: theme.primary },
  profileLabel: { fontSize: 12.5, fontWeight: "600" },

  routeOptions: { flexDirection: "row", gap: 12 },
  routeOption: {
    flex: 1, backgroundColor: theme.surface, borderRadius: 12,
    borderWidth: 1, borderColor: theme.border,
    paddingVertical: 9, paddingHorizontal: 12, alignItems: "center",
  },
  routeOptionActive: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  routeOptDur: { color: theme.textPrimary, fontSize: 14.5, fontWeight: "800" },
  routeOptDist: { color: theme.textSecondary, fontSize: 11, marginTop: 1 },
  routeOptTag: { color: theme.textMuted, fontSize: 9.5, fontWeight: "700", marginTop: 2, textTransform: "uppercase", letterSpacing: 0.3 },

  routeBox: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    backgroundColor: theme.surface, borderRadius: 16,
    paddingHorizontal: 18, paddingVertical: 15,
    borderWidth: 1, borderColor: theme.border,
  },
  stepsToggleHint: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "600" },
  routeDuration: { color: theme.textPrimary, fontSize: 22, fontWeight: "800", letterSpacing: -0.5 },
  routeDistance: { color: theme.textSecondary, fontSize: 13, marginTop: 2 },
  placeholderText: { color: theme.textMuted, fontSize: 13 },

  startBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: theme.primary,
    paddingVertical: 16, borderRadius: 16,
  },
  startBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  secondaryBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border,
    paddingVertical: 14, borderRadius: 16,
  },
  secondaryBtnText: { color: theme.primary, fontSize: 14, fontWeight: "700" },

  // Apple-style GO row
  goRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  goDur: { color: theme.textPrimary, fontSize: 20, fontWeight: "800", letterSpacing: -0.5 },
  goSub: { color: theme.textSecondary, fontSize: 12.5, marginTop: 1, fontWeight: "500" },
  goBtn: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
  },
  goText: { color: "#fff", fontSize: 17, fontWeight: "800", letterSpacing: 0.5 },
  goLinks: { flexDirection: "row", alignItems: "center", gap: 8 },
  linkText: { color: theme.primary, fontSize: 12.5, fontWeight: "600" },
  linkDot: { color: theme.textMuted, fontSize: 14 },

  // Navigation footer
  navFooter: { gap: 9, paddingTop: 4 },
  navStats: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: theme.surface, borderRadius: 14,
    borderWidth: 1, borderColor: theme.border,
    paddingVertical: 9,
  },
  navStat: { flex: 1, alignItems: "center", gap: 3 },
  navStatDivider: { width: 1, height: 22, backgroundColor: theme.border },
  navStatHero: { color: theme.primary, fontSize: 15.5, fontWeight: "800", letterSpacing: -0.3 },
  navStatValue: { color: theme.textPrimary, fontSize: 15, fontWeight: "800", letterSpacing: -0.3 },
  navStatLabel: { color: theme.textMuted, fontSize: 9.5, textTransform: "uppercase", letterSpacing: 0.3 },
  navBtnRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  iconCircle: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  endBtn: {
    flex: 1, flexDirection: "row", gap: 7,
    height: 38, borderRadius: 19,
    backgroundColor: theme.error,
    alignItems: "center", justifyContent: "center",
  },
  endBtnText: { color: "#fff", fontSize: 13.5, fontWeight: "800" },

  stepsList: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    borderWidth: 1, borderColor: theme.border,
    overflow: "hidden",
  },
  stepRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  stepRowActive: { backgroundColor: "rgba(59,130,246,0.12)" },
  stepIcon: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: "rgba(59,130,246,0.15)",
    alignItems: "center", justifyContent: "center",
  },
  stepInstr: { color: theme.textPrimary, fontSize: 13, fontWeight: "600", lineHeight: 18 },
  stepDist: { color: theme.textSecondary, fontSize: 11, marginTop: 2 },

  // ── Map-nav upgrades ──
  avoidRow: { gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  avoidChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
  },
  avoidChipOn: { borderColor: theme.primary, backgroundColor: "rgba(0,168,132,0.08)" },
  avoidText: { fontSize: 12, fontWeight: "700" },

  // Speed limit badge — white circle with red ring (US/CA road sign style)
  speedBadgeWrap: { position: "absolute", top: 96, right: 14 },
  speedBadge: {
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: "#fff",
    borderWidth: 4, borderColor: "#E11D48",
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 8, elevation: 6,
  },
  speedNum: { color: "#0F172A", fontSize: 22, fontWeight: "900", letterSpacing: -0.5, lineHeight: 22 },
  speedUnit: { color: "#475569", fontSize: 8, fontWeight: "800", letterSpacing: 0.4, marginTop: 1 },

  // Recenter (locate) pill
  navControls: {
    position: "absolute", right: 14, bottom: 220, gap: 10,
  },
  mapCtrlBtn: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 10, elevation: 6,
  },

  // SAR (search along route) chip row — floats above bottom card
  sarChips: { position: "absolute", left: 0, right: 0, bottom: 200 },
  sarChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
    backgroundColor: "rgba(20,20,28,0.85)",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
  },
  sarChipText: { color: "#fff", fontSize: 13, fontWeight: "700" },

  // SAR results sheet
  sarSheetWrap: {
    position: "absolute", left: 0, right: 0, top: 0, bottom: 0,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  sarSheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingTop: 14, paddingHorizontal: 16,
    borderTopWidth: 1, borderColor: theme.border,
  },
  sarHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  sarTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  sarEmpty: { color: theme.textMuted, textAlign: "center", marginVertical: 30, fontSize: 13 },
  sarRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingVertical: 12, paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  sarRowTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  sarRowSub: { color: theme.textSecondary, fontSize: 12, marginTop: 2 },

  // ── Transit departures ──
  transitRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingVertical: 11, paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  transitBadge: {
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: theme.primary, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 5, minWidth: 52, maxWidth: 96,
    justifyContent: "center",
  },
  transitBadgeText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  transitHeadsign: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  transitStop: { color: theme.textSecondary, fontSize: 12, marginTop: 2 },
  transitWhenWrap: { alignItems: "flex-end", minWidth: 72 },
  transitWhen: { color: theme.textPrimary, fontSize: 14, fontWeight: "800" },
  transitUpdated: { color: theme.textMuted, fontSize: 11, marginTop: 2 },
  transitLiveRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  transitLiveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.success },
  transitLiveText: { color: theme.success, fontSize: 10, fontWeight: "700" },
});
