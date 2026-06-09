/**
 * Location seam — browser geolocation (web stack).
 *
 * `navigator.geolocation` for position/permissions; reverse geocoding (which the
 * browser lacks) is backed by Mapbox, reusing the app's existing token.
 */
import { MAPBOX_TOKEN } from "@/src/api/client";

export enum Accuracy {
  Lowest = 1, Low = 2, Balanced = 3, High = 4, Highest = 5, BestForNavigation = 6,
}

export type LocationObject = {
  coords: {
    latitude: number; longitude: number; altitude: number | null;
    accuracy: number | null; altitudeAccuracy: number | null;
    heading: number | null; speed: number | null;
  };
  timestamp: number;
};
export type LocationSubscription = { remove: () => void };
type Perm = { status: "granted" | "denied" | "undetermined"; granted: boolean; canAskAgain: boolean; expires: "never" };

function toObject(pos: GeolocationPosition): LocationObject {
  const c = pos.coords;
  return {
    coords: {
      latitude: c.latitude, longitude: c.longitude, altitude: c.altitude,
      accuracy: c.accuracy, altitudeAccuracy: c.altitudeAccuracy,
      heading: c.heading, speed: c.speed,
    },
    timestamp: pos.timestamp,
  };
}

function opts(o?: { accuracy?: Accuracy }): PositionOptions {
  const hi = (o?.accuracy ?? Accuracy.Balanced) >= Accuracy.High;
  return { enableHighAccuracy: hi, timeout: 15000, maximumAge: 10000 };
}

export async function getCurrentPositionAsync(o?: { accuracy?: Accuracy }): Promise<LocationObject> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation unavailable"));
    navigator.geolocation.getCurrentPosition((p) => resolve(toObject(p)), (e) => reject(new Error(e.message)), opts(o));
  });
}

export async function watchPositionAsync(
  o: { accuracy?: Accuracy } | undefined,
  cb: (loc: LocationObject) => void,
): Promise<LocationSubscription> {
  if (!navigator.geolocation) return { remove: () => {} };
  const id = navigator.geolocation.watchPosition((p) => cb(toObject(p)), undefined, opts(o));
  return { remove: () => navigator.geolocation.clearWatch(id) };
}

async function queryPerm(): Promise<Perm> {
  try {
    const r = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    if (r.state === "granted") return { status: "granted", granted: true, canAskAgain: true, expires: "never" };
    if (r.state === "denied") return { status: "denied", granted: false, canAskAgain: false, expires: "never" };
  } catch {}
  // "prompt" / unknown — let the browser ask on getCurrentPosition.
  return { status: "granted", granted: true, canAskAgain: true, expires: "never" };
}
export const requestForegroundPermissionsAsync = queryPerm;
export const getForegroundPermissionsAsync = queryPerm;

export type LocationGeocodedAddress = {
  name: string | null; street: string | null; city: string | null;
  region: string | null; subregion: string | null; district: string | null;
  postalCode: string | null; country: string | null; isoCountryCode: string | null;
  formattedAddress: string | null; timezone: string | null;
};

export async function reverseGeocodeAsync(
  loc: { latitude: number; longitude: number },
): Promise<LocationGeocodedAddress[]> {
  if (!MAPBOX_TOKEN) return [];
  try {
    const params = new URLSearchParams({
      longitude: String(loc.longitude), latitude: String(loc.latitude),
      limit: "1", access_token: MAPBOX_TOKEN,
    });
    const res = await fetch(`https://api.mapbox.com/search/geocode/v6/reverse?${params.toString()}`);
    if (!res.ok) return [];
    const f = ((await res.json()).features || [])[0];
    if (!f) return [];
    const p = f.properties || {};
    const ctx = p.context || {};
    return [{
      name: p.name || ctx.address?.name || null,
      street: ctx.address?.name || ctx.street?.name || null,
      city: ctx.place?.name || ctx.locality?.name || null,
      region: ctx.region?.name || null,
      subregion: ctx.district?.name || null,
      district: ctx.neighborhood?.name || ctx.district?.name || null,
      postalCode: ctx.postcode?.name || null,
      country: ctx.country?.name || null,
      isoCountryCode: ctx.country?.country_code || null,
      formattedAddress: p.full_address || p.place_formatted || p.name || null,
      timezone: null,
    }];
  } catch {
    return [];
  }
}
