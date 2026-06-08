// @ts-nocheck
import React, { forwardRef, useImperativeHandle, useRef } from "react";
import { View, StyleSheet, Platform } from "react-native";
import { WebView } from "react-native-webview";

export type GameEvent = { type: "ready" | "score" | "exit" | "getPlayer"; score?: number };
export type GameWebViewHandle = { sendPlayer: (player: { name: string }) => void };

/**
 * Hosts an uploaded game (loaded from /api/pub/game/{id}) and bridges the Nami
 * Games SDK: the game posts {namiGame:true,type} messages (ready/score/exit/
 * getPlayer); the host replies via sendPlayer(). WebView on native, iframe on web.
 */
const GameWebView = forwardRef<GameWebViewHandle, { uri: string; onEvent: (e: GameEvent) => void }>(
  function GameWebView({ uri, onEvent }, ref) {
    const webRef = useRef<WebView>(null);
    const iframeRef = useRef<HTMLIFrameElement | null>(null);

    const reply = (msg: object) => {
      const payload = JSON.stringify({ namiHost: true, ...msg });
      if (Platform.OS === "web") {
        iframeRef.current?.contentWindow?.postMessage(payload, "*");
      } else {
        webRef.current?.injectJavaScript(`window.__namiHost && window.__namiHost(${JSON.stringify(payload)}); true;`);
      }
    };

    useImperativeHandle(ref, () => ({
      sendPlayer: (player) => reply({ type: "player", player }),
    }));

    const handleRaw = (raw: string) => {
      try { const d = JSON.parse(raw); if (d && d.namiGame) onEvent(d); } catch {}
    };

    if (Platform.OS === "web") {
      return (
        <View style={styles.fill} testID="game-view">
          <iframe
            ref={(el) => { iframeRef.current = el; }}
            src={uri}
            style={{ border: "none", width: "100%", height: "100%", background: "#000" }}
            allow="fullscreen; gamepad; accelerometer; gyroscope; autoplay"
          />
          <WebBridge onEvent={onEvent} />
        </View>
      );
    }
    return (
      <View style={styles.fill} testID="game-view">
        <WebView
          ref={webRef}
          source={{ uri }}
          style={styles.fill}
          originWhitelist={["*"]}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          onMessage={(e) => handleRaw(e.nativeEvent.data)}
        />
      </View>
    );
  },
);

const WebBridge: React.FC<{ onEvent: (e: GameEvent) => void }> = ({ onEvent }) => {
  React.useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const handler = (e: MessageEvent) => {
      try {
        const d = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
        if (d && d.namiGame) onEvent(d);
      } catch {}
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onEvent]);
  return null;
};

const styles = StyleSheet.create({ fill: { flex: 1, backgroundColor: "#000" } });

export default GameWebView;
