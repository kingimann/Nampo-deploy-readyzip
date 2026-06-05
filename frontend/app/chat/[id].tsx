import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, ActivityIndicator, Image,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import {
  useAudioRecorder,
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
} from "expo-audio";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api, Message } from "@/src/api/client";
import MediaGrid from "@/src/components/MediaGrid";
import VoiceMessage from "@/src/components/VoiceMessage";
import { theme } from "@/src/theme";
import { useAuth } from "@/src/context/AuthContext";
import { ensureKeyPair, getPeerPublicKey, encryptForPeer, isE2E, tryDecrypt } from "@/src/utils/e2e";

export default function ChatScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);
  const [peerKey, setPeerKey] = useState<Uint8Array | null>(null);
  const [decrypted, setDecrypted] = useState<Record<string, string>>({});
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const [sharingLocation, setSharingLocation] = useState(false);
  const recordStartRef = useRef<number>(0);

  // Generate / load our keypair and publish public key. Then fetch peer's key.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureKeyPair();
        // Resolve peer user id via conversation list (1:1 only).
        const convs = await api.listConversations();
        const conv = convs.find((c) => c.id === id);
        if (conv?.kind === "dm" && conv.other_user && conv.other_user.user_id !== user?.user_id) {
          const k = await getPeerPublicKey(conv.other_user.user_id);
          if (!cancelled) setPeerKey(k);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [id, user?.user_id]);

  // Decrypt any incoming ciphertext lazily.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = { ...decrypted };
      let changed = false;
      for (const m of messages) {
        if (m.type === "text" && m.text && isE2E(m.text) && next[m.id] === undefined) {
          const plain = await tryDecrypt(m.text, peerKey);
          if (plain !== null) { next[m.id] = plain; changed = true; }
        }
      }
      if (changed && !cancelled) setDecrypted(next);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, peerKey]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const m = await api.listMessages(id);
      setMessages(m);
    } catch {} finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Mark as read when entering the conversation
  useEffect(() => {
    if (!id) return;
    api.markConversationRead(id).catch(() => {});
  }, [id]);

  // poll for new messages every 3s
  useEffect(() => {
    if (!id) return;
    const t = setInterval(async () => {
      try {
        const m = await api.listMessages(id);
        if (m.length !== messages.length) setMessages(m);
      } catch {}
    }, 3000);
    return () => clearInterval(t);
  }, [id, messages.length]);

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages.length]);

  const send = async () => {
    if (!text.trim() || !id) return;
    setSending(true);
    const draft = text.trim();
    setText("");
    try {
      // If we know the peer's E2E public key, encrypt the body before sending.
      const payload = peerKey ? await encryptForPeer(draft, peerKey) : draft;
      const msg = await api.sendMessage(id, { type: "text", text: payload });
      // Pre-populate decrypted cache so the bubble shows plaintext immediately.
      if (peerKey) setDecrypted((d) => ({ ...d, [msg.id]: draft }));
      setMessages((m) => [...m, msg]);
    } catch {
      setText(draft);
    } finally {
      setSending(false);
    }
  };

  const sendMedia = async () => {
    if (!id || sending) return;
    if (Platform.OS !== "web") {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"] as any,
      allowsMultipleSelection: true,
      selectionLimit: 4,
      quality: 0.7,
      base64: true,
      videoMaxDuration: 60,
    });
    if (result.canceled) return;
    const media = (result.assets || []).map((a) => {
      const isVideo = a.type === "video";
      const uri = !isVideo && a.base64
        ? `data:image/jpeg;base64,${a.base64}`
        : a.uri;
      return {
        type: isVideo ? ("video" as const) : ("image" as const),
        base64: uri,
        width: a.width || null,
        height: a.height || null,
      };
    });
    if (!media.length) return;
    setSending(true);
    try {
      const msg = await api.sendMessage(id, { type: "media", media });
      setMessages((m) => [...m, msg]);
    } catch {} finally { setSending(false); }
  };

  // Share your current GPS position as a place bubble.
  const shareLocation = async () => {
    if (!id || sharingLocation || sending) return;
    setSharingLocation(true);
    try {
      let { status } = await Location.getForegroundPermissionsAsync();
      if (status !== "granted") {
        const req = await Location.requestForegroundPermissionsAsync();
        status = req.status;
      }
      if (status !== "granted") return;
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      // Try to reverse-geocode for a friendly address (best-effort).
      let address = "";
      try {
        const places = await Location.reverseGeocodeAsync({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        });
        const p = places?.[0];
        if (p) {
          address = [p.name, p.street, p.city, p.region]
            .filter(Boolean)
            .join(", ");
        }
      } catch {}
      const msg = await api.sendMessage(id, {
        type: "place",
        place_name: "My location",
        place_address: address,
        place_longitude: pos.coords.longitude,
        place_latitude: pos.coords.latitude,
      });
      setMessages((m) => [...m, msg]);
    } catch {} finally {
      setSharingLocation(false);
    }
  };

  // Begin recording a voice note.
  const startRecording = async () => {
    if (!id || sending || recording) return;
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) return;
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      recordStartRef.current = Date.now();
      setRecording(true);
    } catch {
      setRecording(false);
    }
  };

  // Stop, encode and send (or discard if `cancel`).
  const stopRecording = async (cancel = false) => {
    if (!recording) return;
    setRecording(false);
    const elapsed = Date.now() - recordStartRef.current;
    try {
      await audioRecorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
    } catch {}
    const uri = audioRecorder.uri;
    if (cancel || !uri || elapsed < 600) return; // ignore accidental taps
    setSending(true);
    try {
      // Read the recorded file into a base64 data URI (works web + native).
      const res = await fetch(uri);
      const blob = await res.blob();
      const dataUri: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const msg = await api.sendMessage(id!, {
        type: "voice",
        audio_base64: dataUri,
        audio_duration_ms: elapsed,
      });
      setMessages((m) => [...m, msg]);
    } catch {} finally {
      setSending(false);
    }
  };

  const openPlace = (m: Message) => {
    if (m.place_longitude == null || m.place_latitude == null) return;
    router.push({
      pathname: "/(tabs)",
      params: {
        flyLng: String(m.place_longitude),
        flyLat: String(m.place_latitude),
        flyName: m.place_name || "Shared place",
      },
    });
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="chat-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="chat-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{name || "Chat"}</Text>
        <View style={{ width: 40 }} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 50 : 0}
        style={{ flex: 1 }}
      >
        {loading ? (
          <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(i) => i.id}
            contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, gap: 6 }}
            renderItem={({ item }) => {
              const mine = item.sender_id === user?.user_id;
              const onLongPress = () => {
                if (!mine || !id) return;
                api.deleteMessage(id, item.id).then(() => {
                  setMessages((m) => m.filter((x) => x.id !== item.id));
                }).catch(() => {});
              };
              return (
                <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowOther]}>
                  <TouchableOpacity
                    onLongPress={onLongPress}
                    activeOpacity={0.9}
                    style={[
                      styles.bubble,
                      mine ? styles.bubbleMine : styles.bubbleOther,
                      item.type === "place" && styles.bubblePlace,
                    ]}
                    testID={`msg-${item.id}`}
                  >
                    {item.type === "place" ? (
                      <TouchableOpacity onPress={() => openPlace(item)} testID={`place-msg-${item.id}`}>
                        <View style={styles.placeHeader}>
                          <Ionicons name="location" size={16} color={mine ? "#fff" : theme.primary} />
                          <Text style={[styles.placeName, mine && { color: "#fff" }]} numberOfLines={1}>
                            {item.place_name}
                          </Text>
                        </View>
                        {!!item.place_address && (
                          <Text style={[styles.placeAddr, mine && { color: "rgba(255,255,255,0.8)" }]} numberOfLines={2}>
                            {item.place_address}
                          </Text>
                        )}
                        <Text style={[styles.placeTap, mine && { color: "rgba(255,255,255,0.85)" }]}>
                          Tap to view on map →
                        </Text>
                      </TouchableOpacity>
                    ) : item.type === "voice" && item.audio_base64 ? (
                      <VoiceMessage
                        uri={item.audio_base64}
                        durationMs={item.audio_duration_ms}
                        mine={mine}
                        testID={`voice-msg-${item.id}`}
                      />
                    ) : item.type === "media" && (item.media || []).length > 0 ? (
                      <View style={{ width: 240 }}>
                        <MediaGrid media={item.media || []} testID={`msg-${item.id}`} />
                      </View>
                    ) : (
                      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, flexWrap: "wrap" }}>
                        <Text style={[styles.bubbleText, mine && { color: "#fff" }]}>
                          {isE2E(item.text || "") ? (decrypted[item.id] ?? "🔒 Encrypted") : item.text}
                        </Text>
                        {isE2E(item.text || "") && (
                          <Ionicons name="lock-closed" size={10} color={mine ? "rgba(255,255,255,0.6)" : theme.textMuted} />
                        )}
                      </View>
                    )}
                  </TouchableOpacity>
                  <View style={[styles.metaRow, mine ? { justifyContent: "flex-end" } : { justifyContent: "flex-start" }]}>
                    <Text style={styles.metaTime}>
                      {new Date(item.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </Text>
                    {mine && (
                      <Ionicons
                        name={item.read_at ? "checkmark-done" : "checkmark"}
                        size={14}
                        color={item.read_at ? "#53BDEB" : theme.textMuted}
                      />
                    )}
                  </View>
                </View>
              );
            }}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyText}>Say hi to start the conversation 👋</Text>
              </View>
            }
          />
        )}

        <View style={[styles.composer, { paddingBottom: insets.bottom + 10 }]}>
          {recording ? (
            <>
              <TouchableOpacity
                style={styles.attachBtn}
                onPress={() => stopRecording(true)}
                testID="voice-cancel-btn"
              >
                <Ionicons name="trash-outline" size={22} color={theme.error} />
              </TouchableOpacity>
              <View style={styles.recordingPill}>
                <View style={styles.recDot} />
                <Text style={styles.recText}>Recording… release to send</Text>
              </View>
              <TouchableOpacity
                style={styles.sendBtn}
                onPress={() => stopRecording(false)}
                testID="voice-send-btn"
              >
                <Ionicons name="send" size={18} color="#fff" />
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity
                style={styles.attachBtn}
                onPress={shareLocation}
                disabled={sending || sharingLocation}
                testID="location-btn"
              >
                {sharingLocation ? (
                  <ActivityIndicator size="small" color={theme.primary} />
                ) : (
                  <Ionicons name="location-outline" size={22} color={theme.primary} />
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.attachBtn}
                onPress={sendMedia}
                disabled={sending}
                testID="attach-btn"
              >
                <Ionicons name="image-outline" size={22} color={theme.primary} />
              </TouchableOpacity>
              <TextInput
                style={styles.composerInput}
                placeholder="Message..."
                placeholderTextColor={theme.textMuted}
                value={text}
                onChangeText={setText}
                multiline
                testID="msg-input"
              />
              {text.trim() ? (
                <TouchableOpacity
                  style={[styles.sendBtn, sending && { opacity: 0.5 }]}
                  onPress={send}
                  disabled={sending}
                  testID="send-btn"
                >
                  <Ionicons name="send" size={18} color="#fff" />
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.sendBtn, sending && { opacity: 0.5 }]}
                  onPress={startRecording}
                  disabled={sending}
                  testID="mic-btn"
                >
                  <Ionicons name="mic" size={20} color="#fff" />
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 17, fontWeight: "700", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { paddingTop: 60, alignItems: "center" },
  emptyText: { color: theme.textMuted, fontSize: 13 },

  bubbleRow: { flexDirection: "row" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2, paddingHorizontal: 4 },
  metaTime: { color: theme.textMuted, fontSize: 10.5, fontWeight: "500" },
  bubbleRowMine: { justifyContent: "flex-end" },
  bubbleRowOther: { justifyContent: "flex-start" },
  bubble: {
    maxWidth: "76%",
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 18,
  },
  bubbleMine: { backgroundColor: theme.primary, borderBottomRightRadius: 6 },
  bubbleOther: {
    backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border,
    borderBottomLeftRadius: 6,
  },
  bubblePlace: { paddingVertical: 12 },
  bubbleText: { color: theme.textPrimary, fontSize: 15, lineHeight: 20 },
  placeHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  placeName: { color: theme.textPrimary, fontSize: 14, fontWeight: "700", flex: 1 },
  placeAddr: { color: theme.textSecondary, fontSize: 12 },
  placeTap: { marginTop: 6, color: theme.primary, fontSize: 12, fontWeight: "600" },

  composer: {
    flexDirection: "row", gap: 8, alignItems: "flex-end",
    paddingHorizontal: 12, paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border,
    backgroundColor: theme.bg,
  },
  composerInput: {
    flex: 1, color: theme.textPrimary, fontSize: 15,
    backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border,
    borderRadius: 22,
    paddingHorizontal: 16, paddingVertical: 10,
    maxHeight: 120, minHeight: 44,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
  },
  attachBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    alignItems: "center", justifyContent: "center",
  },
  recordingPill: {
    flex: 1, flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    borderRadius: 22, paddingHorizontal: 16, minHeight: 44,
  },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: theme.error },
  recText: { color: theme.textSecondary, fontSize: 14, fontWeight: "500" },
});
