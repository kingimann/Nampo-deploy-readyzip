// Native: register a device push token so calls (and other alerts) can ring in
// the background, and route a tapped call notification straight into the call
// screen. Requires a dev/production build (push isn't available in Expo Go on
// iOS, and needs the project's EAS credentials).
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { router } from "expo-router";
import Constants from "@/src/platform/constants";
import * as Device from "@/src/platform/device";
import * as Notifications from "@/src/platform/notifications";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";

// Show incoming pushes (incl. calls) while the app is foregrounded.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function openFromData(data: any) {
  if (!data) return;
  if (data.type === "call" && data.conversation_id) {
    router.push({ pathname: "/call/[id]", params: { id: String(data.conversation_id), name: String(data.caller || "Call") } });
  } else if (data.conversation_id) {
    router.push({ pathname: "/chat/[id]", params: { id: String(data.conversation_id) } });
  }
}

export default function PushManager() {
  const { user } = useAuth();
  const tokenRef = useRef<string | null>(null);

  // Register / unregister the device token with the backend.
  useEffect(() => {
    if (!user) return;
    let active = true;
    (async () => {
      try {
        if (!Device.isDevice) return;
        const cur = await Notifications.getPermissionsAsync();
        let status = cur.status;
        if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
        if (status !== "granted") return;
        if (Platform.OS === "android") {
          await Notifications.setNotificationChannelAsync("calls", {
            name: "Calls",
            importance: Notifications.AndroidImportance.MAX,
            sound: "default",
            vibrationPattern: [0, 250, 250, 250],
            bypassDnd: true,
          });
        }
        const projectId =
          (Constants?.expoConfig as any)?.extra?.eas?.projectId ||
          (Constants as any)?.easConfig?.projectId;
        const t = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
        if (!active) return;
        tokenRef.current = t.data;
        await api.registerPush(t.data, Platform.OS, "expo");
      } catch {}
    })();
    return () => {
      active = false;
      const tok = tokenRef.current;
      if (tok) { api.unregisterPush(tok).catch(() => {}); tokenRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.user_id]);

  // Route taps on a call/chat notification (cold start + warm).
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      openFromData(resp?.notification?.request?.content?.data);
    });
    Notifications.getLastNotificationResponseAsync().then((resp) => {
      if (resp) openFromData(resp.notification.request.content.data);
    });
    return () => sub.remove();
  }, []);

  return null;
}
