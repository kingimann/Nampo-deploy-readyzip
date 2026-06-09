/**
 * Camera seam — browser implementation (web stack).
 *
 * Mirrors the parts of expo-camera the app uses:
 *  - useCameraPermissions() -> [permission, requestPermission]
 *  - <CameraView facing barcodeScannerSettings onBarcodeScanned style ref> with
 *    ref.takePictureAsync({ base64 })
 *
 * Live preview via getUserMedia; QR scanning via the BarcodeDetector API where
 * available (Chrome/Edge; degrades to no auto-scan elsewhere). Photo capture
 * draws the current frame to a canvas.
 */
import React, {
  forwardRef, useEffect, useImperativeHandle, useRef, useState, useCallback,
} from "react";
import { View, type ViewProps } from "react-native";

type Permission = { granted: boolean; status: "granted" | "denied" | "undetermined"; canAskAgain: boolean };
const UNDET: Permission = { granted: false, status: "undetermined", canAskAgain: true };

export function useCameraPermissions(): [Permission | null, () => Promise<Permission>] {
  const [perm, setPerm] = useState<Permission | null>(UNDET);
  const request = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach((t) => t.stop());
      const p: Permission = { granted: true, status: "granted", canAskAgain: true };
      setPerm(p);
      return p;
    } catch {
      const p: Permission = { granted: false, status: "denied", canAskAgain: false };
      setPerm(p);
      return p;
    }
  }, []);
  return [perm, request];
}

export type CameraViewHandle = {
  takePictureAsync: (opts?: { base64?: boolean; quality?: number }) => Promise<{ uri: string; base64?: string; width: number; height: number } | undefined>;
};

type Barcode = { data: string; type: string; cornerPoints?: any };
type CameraViewProps = ViewProps & {
  facing?: "back" | "front";
  barcodeScannerSettings?: { barcodeTypes?: string[] };
  onBarcodeScanned?: (b: Barcode) => void;
  children?: React.ReactNode;
};

export const CameraView = forwardRef<CameraViewHandle, CameraViewProps>(function CameraView(
  { facing = "back", barcodeScannerSettings, onBarcodeScanned, style, children, ...rest },
  ref,
) {
  const hostRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanRef = useRef<number | null>(null);
  const lastScan = useRef(0);

  useImperativeHandle(ref, () => ({
    takePictureAsync: async (opts) => {
      const v = videoRef.current;
      if (!v || !v.videoWidth) return undefined;
      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return undefined;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", opts?.quality ?? 0.7);
      return {
        uri: dataUrl,
        base64: opts?.base64 ? dataUrl.split(",")[1] : undefined,
        width: canvas.width,
        height: canvas.height,
      };
    },
  }));

  useEffect(() => {
    let cancelled = false;
    const video = document.createElement("video");
    video.playsInline = true;
    (video as any).webkitPlaysInline = true;
    video.muted = true;
    video.autoplay = true;
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.objectFit = "cover";
    videoRef.current = video;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing === "front" ? "user" : "environment" },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        video.srcObject = stream;
        await video.play().catch(() => {});
        const host = hostRef.current as HTMLElement | null;
        if (host && video.parentNode !== host) host.insertBefore(video, host.firstChild);

        // QR scanning via BarcodeDetector when available.
        const BD: any = (window as any).BarcodeDetector;
        if (onBarcodeScanned && BD) {
          const detector = new BD({ formats: (barcodeScannerSettings?.barcodeTypes || ["qr"]).map((t) => (t === "qr" ? "qr_code" : t)) });
          const loop = async () => {
            if (cancelled) return;
            try {
              const codes = await detector.detect(video);
              const now = Date.now();
              if (codes?.length && now - lastScan.current > 1200) {
                lastScan.current = now;
                onBarcodeScanned({ data: codes[0].rawValue, type: "qr", cornerPoints: codes[0].cornerPoints });
              }
            } catch {}
            scanRef.current = requestAnimationFrame(loop);
          };
          scanRef.current = requestAnimationFrame(loop);
        }
      } catch {
        /* permission denied / no camera — host stays empty */
      }
    })();

    return () => {
      cancelled = true;
      if (scanRef.current) cancelAnimationFrame(scanRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (video.parentNode) video.parentNode.removeChild(video);
      videoRef.current = null;
    };
  }, [facing, onBarcodeScanned, barcodeScannerSettings]);

  return (
    <View ref={hostRef} style={style} {...rest}>
      {children}
    </View>
  );
});

export default CameraView;
