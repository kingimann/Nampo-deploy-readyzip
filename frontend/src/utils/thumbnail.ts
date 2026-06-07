import { Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { cloudinaryEnabled, uploadToCloudinary } from "@/src/api/cloudinary";

/**
 * Let the user pick an image to use as a reel/video cover and return a usable
 * URI string (a Cloudinary URL when configured, otherwise a base64 data URI).
 *
 * Returns `null` when the user cancels or permission is denied. Throws on a
 * real failure so callers can surface an alert.
 */
export async function pickThumbnailUri(): Promise<string | null> {
  if (Platform.OS !== "web") {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return null;
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"] as any,
    quality: 0.7,
    base64: true,
    allowsEditing: true,
  });
  if (result.canceled) return null;
  const a = result.assets?.[0];
  if (!a) return null;

  // Preferred: push the cover to the CDN and store only its URL.
  if (cloudinaryEnabled()) {
    try {
      const up = await uploadToCloudinary(a.uri, "image");
      if (up?.url) return up.url;
    } catch {
      // fall through to the base64 path below
    }
  }
  if (a.base64) return `data:image/jpeg;base64,${a.base64}`;
  return a.uri || null;
}

async function _toUri(a: ImagePicker.ImagePickerAsset): Promise<string | null> {
  if (cloudinaryEnabled()) {
    try {
      const up = await uploadToCloudinary(a.uri, "image");
      if (up?.url) return up.url;
    } catch {
      // fall through to base64
    }
  }
  if (a.base64) return `data:image/jpeg;base64,${a.base64}`;
  return a.uri || null;
}

/**
 * Pick one or more images from the library and return usable URI strings
 * (Cloudinary URLs when configured, else base64 data URIs). Empty array on
 * cancel / denied permission.
 */
export async function pickImages(max = 6): Promise<string[]> {
  if (Platform.OS !== "web") {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return [];
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"] as any,
    quality: 0.6,
    base64: true,
    allowsMultipleSelection: true,
    selectionLimit: max,
  });
  if (result.canceled) return [];
  const out: string[] = [];
  for (const a of (result.assets || []).slice(0, max)) {
    const u = await _toUri(a);
    if (u) out.push(u);
  }
  return out;
}

/**
 * Capture a photo with the camera (native) or pick one (web — no camera), and
 * return a usable URI string. `null` on cancel / denied permission.
 */
export async function captureImage(): Promise<string | null> {
  if (Platform.OS === "web") return pickThumbnailUri();
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return null;
  const result = await ImagePicker.launchCameraAsync({ quality: 0.6, base64: true });
  if (result.canceled) return null;
  const a = result.assets?.[0];
  if (!a) return null;
  return _toUri(a);
}
