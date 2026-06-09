import React, { useRef, useState } from "react";
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { cloudinaryEnabled, uploadToCloudinary } from "@/src/api/cloudinary";

/**
 * Full-screen, camera-only capture UI — a single shutter button, with flip and
 * close. No photo-library or files option, so roadside photos can only ever be
 * taken live with the camera. Returns a usable URI (a Cloudinary URL when
 * configured, else a base64 data URI) via `onCaptured`; `onCaptured(null)` on
 * cancel.
 */
export default function CameraCapture({
  visible, onClose, onCaptured,
}: {
  visible: boolean;
  onClose: () => void;
  onCaptured: (uri: string | null) => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [busy, setBusy] = useState(false);
  const camRef = useRef<CameraView | null>(null);

  const snap = async () => {
    if (!camRef.current || busy) return;
    setBusy(true);
    try {
      const pic = await camRef.current.takePictureAsync({ quality: 0.6, base64: true });
      let uri: string | null = null;
      if (pic) {
        if (cloudinaryEnabled() && pic.uri) {
          try {
            const up = await uploadToCloudinary(pic.uri, "image");
            if (up?.url) uri = up.url;
          } catch {
            // fall through to base64
          }
        }
        if (!uri) uri = pic.base64 ? `data:image/jpeg;base64,${pic.base64}` : (pic.uri || null);
      }
      onCaptured(uri);
    } catch {
      onCaptured(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        {!permission ? (
          <View style={styles.center}><ActivityIndicator color="#fff" /></View>
        ) : !permission.granted ? (
          <View style={styles.center}>
            <Ionicons name="camera-outline" size={52} color="#fff" />
            <Text style={styles.msg}>Camera access is needed to take a photo of your vehicle or the problem.</Text>
            <TouchableOpacity style={styles.permBtn} onPress={requestPermission} testID="cam-grant">
              <Text style={styles.permText}>Allow camera</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.linkBtn} onPress={onClose}>
              <Text style={styles.linkText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <CameraView ref={camRef} style={StyleSheet.absoluteFill} facing={facing}>
            <View style={styles.topBar}>
              <TouchableOpacity style={styles.iconBtn} onPress={onClose} testID="cam-close">
                <Ionicons name="close" size={28} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.iconBtn} onPress={() => setFacing((f) => (f === "back" ? "front" : "back"))} testID="cam-flip">
                <Ionicons name="camera-reverse" size={28} color="#fff" />
              </TouchableOpacity>
            </View>
            <View style={styles.hintWrap}>
              <Text style={styles.hint}>Frame your vehicle or the problem, then tap to capture</Text>
            </View>
            <View style={styles.bottomBar}>
              <TouchableOpacity style={styles.shutter} onPress={snap} disabled={busy} testID="cam-shutter">
                {busy ? <ActivityIndicator color="#000" /> : <View style={styles.shutterInner} />}
              </TouchableOpacity>
            </View>
          </CameraView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28, gap: 14 },
  msg: { color: "#fff", fontSize: 15, textAlign: "center", lineHeight: 21 },
  permBtn: { backgroundColor: "#fff", borderRadius: 999, paddingHorizontal: 22, paddingVertical: 12, marginTop: 4 },
  permText: { color: "#000", fontWeight: "800", fontSize: 15 },
  linkBtn: { paddingVertical: 8 },
  linkText: { color: "#fff", opacity: 0.7, fontSize: 14, fontWeight: "700" },
  topBar: { flexDirection: "row", justifyContent: "space-between", paddingTop: 52, paddingHorizontal: 18 },
  iconBtn: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.4)" },
  hintWrap: { position: "absolute", left: 0, right: 0, bottom: 150, alignItems: "center", paddingHorizontal: 24 },
  hint: { color: "#fff", fontSize: 13, fontWeight: "700", textAlign: "center", backgroundColor: "rgba(0,0,0,0.45)", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, overflow: "hidden" },
  bottomBar: { position: "absolute", left: 0, right: 0, bottom: 46, alignItems: "center" },
  shutter: { width: 78, height: 78, borderRadius: 39, borderWidth: 5, borderColor: "rgba(255,255,255,0.85)", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.25)" },
  shutterInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: "#fff" },
});
