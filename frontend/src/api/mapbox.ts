import { MAPBOX_TOKEN } from "@/src/api/client";

export type GeocodeFeature = {
  id: string;
  name: string;
  full_address: string;
  longitude: number;
  latitude: number;
  category?: string;
  maki?: string;
  distance?: number; // meters from the user (when known, e.g. Foursquare results)
};

export async function forwardGeocode(
  query: string,
  proximity?: [number, number],
): Promise<GeocodeFeature[]> {
  if (!query.trim()) return [];
  const params = new URLSearchParams({
    q: query,
    limit: "6",
    access_token: MAPBOX_TOKEN,
  });
  if (proximity) params.set("proximity", `${proximity[0]},${proximity[1]}`);
  const url = `https://api.mapbox.com/search/geocode/v6/forward?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  return (json.features || []).map((f: any) => ({
    id: f.id || `${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}`,
    name: f.properties?.name || f.properties?.full_address || "Unknown",
    full_address:
      f.properties?.full_address ||
      f.properties?.place_formatted ||
      f.properties?.name ||
      "",
    longitude: f.geometry.coordinates[0],
    latitude: f.geometry.coordinates[1],
  }));
}

export async function categorySearch(
  category: string,
  proximity: [number, number],
  limit = 12,
): Promise<GeocodeFeature[]> {
  // Mapbox Search Box: category endpoint
  const params = new URLSearchParams({
    access_token: MAPBOX_TOKEN,
    limit: String(limit),
    proximity: `${proximity[0]},${proximity[1]}`,
  });
  const url = `https://api.mapbox.com/search/searchbox/v1/category/${encodeURIComponent(
    category,
  )}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  return (json.features || []).map((f: any) => ({
    id:
      f.properties?.mapbox_id ||
      `${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}`,
    name: f.properties?.name || "Unknown",
    full_address:
      f.properties?.full_address ||
      f.properties?.place_formatted ||
      f.properties?.address ||
      "",
    longitude: f.geometry.coordinates[0],
    latitude: f.geometry.coordinates[1],
    category: f.properties?.poi_category?.[0],
    maki: f.properties?.maki,
  }));
}

export type Profile = "driving" | "walking" | "cycling" | "driving-traffic";

export type Step = {
  instruction: string;
  distance: number;
  duration: number;
  modifier?: string;
  type?: string;
};

export type Leg = {
  distance: number;
  duration: number;
  steps: Step[];
  summary?: string;
  /** Distance (m) of each sub-segment between consecutive route coords. */
  segment_distances?: number[];
  /** Posted speed limit per sub-segment (km/h). null = unknown. */
  maxspeeds?: (number | null)[];
  /** maxspeed unit per sub-segment ("km/h" | "mph" | undefined). */
  maxspeed_units?: (string | undefined)[];
};

export type RouteResult = {
  geometry: { type: "LineString"; coordinates: [number, number][] };
  distance: number;
  duration: number;
  legs: Leg[];
};

export type FetchRouteOptions = {
  /** Avoid one or more road types — Mapbox `exclude` param. */
  exclude?: ("toll" | "motorway" | "ferry")[];
  /** Request maxspeed annotations (driving profiles only). */
  annotations?: boolean;
  /** Ask Mapbox for up to 2 alternate routes in addition to the primary. */
  alternatives?: boolean;
};

/** Convert one Mapbox route object into our RouteResult shape. */
function parseRoute(r: any): RouteResult {
  const legs: Leg[] = (r.legs || []).map((l: any) => {
    const ann = l.annotation || {};
    const ms: any[] = Array.isArray(ann.maxspeed) ? ann.maxspeed : [];
    const dists: number[] = Array.isArray(ann.distance) ? ann.distance : [];
    return {
      distance: l.distance,
      duration: l.duration,
      summary: l.summary,
      segment_distances: dists,
      maxspeeds: ms.map((x) => (typeof x?.speed === "number" ? x.speed : null)),
      maxspeed_units: ms.map((x) => (typeof x?.unit === "string" ? x.unit : undefined)),
      steps: (l.steps || []).map((s: any) => ({
        instruction: s.maneuver?.instruction || "",
        distance: s.distance,
        duration: s.duration,
        modifier: s.maneuver?.modifier,
        type: s.maneuver?.type,
      })),
    };
  });
  return { geometry: r.geometry, distance: r.distance, duration: r.duration, legs };
}

/**
 * Fetch one or more routes. Returns every route Mapbox provides (the primary
 * first, then alternates when `options.alternatives` is set), ordered as
 * returned by the API. Empty array on failure.
 */
export async function fetchRoutes(
  coordinates: [number, number][],
  profile: Profile = "driving",
  options: FetchRouteOptions = {},
): Promise<RouteResult[]> {
  if (coordinates.length < 2) return [];
  const coordStr = coordinates.map((c) => `${c[0]},${c[1]}`).join(";");
  const params = new URLSearchParams({
    access_token: MAPBOX_TOKEN,
    geometries: "geojson",
    overview: "full",
    steps: "true",
  });
  if (options.alternatives) params.set("alternatives", "true");
  if (options.exclude && options.exclude.length) {
    params.set("exclude", options.exclude.join(","));
  }
  // Annotations only on driving profiles
  if (options.annotations && profile.startsWith("driving")) {
    params.set("annotations", "maxspeed,distance");
  }
  const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coordStr}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  if (!json.routes?.length) return [];
  return (json.routes as any[]).map(parseRoute);
}

export async function fetchRoute(
  coordinates: [number, number][],
  profile: Profile = "driving",
  options: FetchRouteOptions = {},
): Promise<RouteResult | null> {
  const routes = await fetchRoutes(coordinates, profile, options);
  return routes[0] || null;
}
