import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, ActivityIndicator, Image, Modal, Linking, Alert, ScrollView,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as Location from "expo-location";
import * as Clipboard from "expo-clipboard";
import {
  useAudioRecorder,
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
} from "expo-audio";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api, Message, Post, PublicUser, CustomEmoji } from "@/src/api/client";
import MediaGrid from "@/src/components/MediaGrid";
import EmojiText from "@/src/components/EmojiText";
import CustomEmojiSheet from "@/src/components/CustomEmojiSheet";
import VoiceMessage from "@/src/components/VoiceMessage";
import RichText from "@/src/components/RichText";
import LinkPreviewCard from "@/src/components/LinkPreviewCard";
import QuoteCard from "@/src/components/QuoteCard";
import GifPickerSheet from "@/src/components/GifPickerSheet";
import ContactPickerSheet from "@/src/components/ContactPickerSheet";
import FakePaymentSheet from "@/src/components/FakePaymentSheet";
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
  const [attachOpen, setAttachOpen] = useState(false);
  const [editingMsg, setEditingMsg] = useState<Message | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [actionMsg, setActionMsg] = useState<Message | null>(null);
  const [recMs, setRecMs] = useState(0);
  const lastTapRef = useRef<Record<string, number>>({});
  const [emojis, setEmojis] = useState<CustomEmoji[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiMap = useMemo(
    () => Object.fromEntries(emojis.map((e) => [e.shortcode, e.image_base64])),
    [emojis],
  );
  const [historyItems, setHistoryItems] = useState<{ text: string; edited_at?: string | null }[] | null>(null);

  const openHistory = async (m: Message) => {
    const raw = [...(m.edit_history || []), { text: m.text || "", edited_at: m.edited_at }];
    const items = await Promise.all(raw.map(async (h) => {
      let t = h.text || "";
      if (isE2E(t)) { const d = await tryDecrypt(t, peerKey); t = d ?? "🔒 Encrypted"; }
      return { text: t, edited_at: h.edited_at };
    }));
    setHistoryItems(items);
  };
  const loadEmojis = useCallback(() => {
    api.listCustomEmojis().then(setEmojis).catch(() => {});
  }, []);
  useEffect(() => { loadEmojis(); }, [loadEmojis]);
  const [sharedPosts, setSharedPosts] = useState<Record<string, Post>>({});
  const [gifOpen, setGifOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const [peer, setPeer] = useState<{ id: string; name: string } | null>(null);
  const [payEnabled, setPayEnabled] = useState(false);
  useEffect(() => { api.getPaymentsConfig().then((c) => setPayEnabled(c.enabled)).catch(() => {}); }, []);
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
          if (!cancelled) setPeer({ id: conv.other_user.user_id, name: conv.other_user.name || name || "this user" });
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

  // poll for new messages every 3s — detect new/edited/deleted/read changes,
  // not just count changes, so the peer's edits and deletions show up.
  const msgSigRef = useRef("");
  const msgSig = (arr: Message[]) =>
    arr.map((x) => `${x.id}:${x.edited_at || ""}:${x.deleted ? 1 : 0}:${x.read_at || ""}`).join("|");
  useEffect(() => {
    if (!id) return;
    const t = setInterval(async () => {
      try {
        const m = await api.listMessages(id);
        const s = msgSig(m);
        if (s !== msgSigRef.current) { msgSigRef.current = s; setMessages(m); }
      } catch {}
    }, 3000);
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages.length]);

  // Lazily hydrate any shared-post messages so they render as a preview card.
  useEffect(() => {
    const ids = Array.from(new Set(
      messages.filter((m) => m.type === "post" && m.post_id && !sharedPosts[m.post_id!]).map((m) => m.post_id!),
    ));
    if (!ids.length) return;
    let cancelled = false;
    (async () => {
      for (const pid of ids) {
        try {
          const p = await api.getPost(pid);
          if (!cancelled) setSharedPosts((c) => ({ ...c, [pid]: p }));
        } catch {}
      }
    })();
    return () => { cancelled = true; };
  }, [messages, sharedPosts]);

  // Live timer while recording a voice note.
  useEffect(() => {
    if (!recording) { setRecMs(0); return; }
    const start = recordStartRef.current || Date.now();
    const t = setInterval(() => setRecMs(Date.now() - start), 200);
    return () => clearInterval(t);
  }, [recording]);

  // Plaintext for a message (handles E2E decryption cache).
  const plainOf = (m: Message): string =>
    isE2E(m.text || "") ? (decrypted[m.id] ?? "") : (m.text || "");

  // Short one-line description of a message (for reply previews & banners).
  const previewOf = (m: Message): string => {
    if (m.deleted) return "Deleted message";
    switch (m.type) {
      case "text": return plainOf(m) || "Message";
      case "media": return "📷 Photo";
      case "voice": return "🎤 Voice message";
      case "gif": return "🎞️ GIF";
      case "file": return `📎 ${m.file_name || "File"}`;
      case "place": return "📍 Location";
      case "post": return "📄 Shared post";
      case "contact": return `👤 ${m.contact_name || "Contact"}`;
      case "tip": return `💸 $${(m.amount || 0).toFixed(2)} tip`;
      default: return "Message";
    }
  };

  // Compact summary of a message's reactions, e.g. "❤️ 2".
  const reactionSummary = (m: Message): string => {
    const vals = Object.values(m.reactions || {});
    if (!vals.length) return "";
    const counts: Record<string, number> = {};
    for (const e of vals) counts[e] = (counts[e] || 0) + 1;
    return Object.entries(counts).map(([e, c]) => (c > 1 ? `${e} ${c}` : e)).join(" ");
  };
  const myReaction = (m: Message): string => (m.reactions || {})[user?.user_id || ""] || "";

  const fmtDur = (ms: number): string => {
    const total = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
  };

  // Toggle a reaction (defaults to ❤️) on a message — optimistic, then synced.
  const toggleReaction = async (m: Message, emoji = "❤️") => {
    if (!id || m.deleted) return;
    const uid = user?.user_id || "";
    setMessages((arr) => arr.map((x) => {
      if (x.id !== m.id) return x;
      const r = { ...(x.reactions || {}) };
      if (r[uid] === emoji) delete r[uid]; else r[uid] = emoji;
      return { ...x, reactions: r };
    }));
    try {
      const updated = await api.reactToMessage(id, m.id, emoji);
      setMessages((arr) => arr.map((x) => (x.id === updated.id ? updated : x)));
    } catch { load(); }
  };

  // Double-tap a bubble to like it (Instagram/Messenger style).
  const onBubbleTap = (m: Message) => {
    if (m.deleted) return;
    const now = Date.now();
    const last = lastTapRef.current[m.id] || 0;
    lastTapRef.current[m.id] = now;
    if (now - last < 300) { toggleReaction(m); lastTapRef.current[m.id] = 0; }
  };

  const beginEdit = (m: Message) => {
    setActionMsg(null);
    setEditingMsg(m);
    setText(plainOf(m));
  };
  const cancelEdit = () => { setEditingMsg(null); setText(""); };

  const copyMessage = async (m: Message) => {
    setActionMsg(null);
    try { await Clipboard.setStringAsync(plainOf(m)); } catch {}
  };

  const deleteMessage = async (m: Message) => {
    setActionMsg(null);
    if (!id) return;
    // Optimistically show the tombstone; server soft-deletes.
    setMessages((arr) => arr.map((x) => x.id === m.id ? { ...x, deleted: true } : x));
    try { await api.deleteMessage(id, m.id); } catch { load(); }
  };

  const saveEdit = async () => {
    if (!editingMsg || !id) return;
    const draft = text.trim();
    if (!draft) return;
    setSending(true);
    const target = editingMsg;
    setEditingMsg(null);
    setText("");
    try {
      const payload = peerKey ? await encryptForPeer(draft, peerKey) : draft;
      const updated = await api.editMessage(id, target.id, payload);
      if (peerKey) setDecrypted((d) => ({ ...d, [updated.id]: draft }));
      setMessages((m) => m.map((x) => x.id === updated.id ? updated : x));
    } catch {
      setEditingMsg(target);
      setText(draft);
    } finally {
      setSending(false);
    }
  };

  const sendGif = async (gifUrl: string) => {
    if (!id || !gifUrl) return;
    try {
      const msg = await api.sendMessage(id, { type: "gif", gif_url: gifUrl });
      setMessages((m) => [...m, msg]);
    } catch {}
  };

  // Tip the other person in the DM. The backend credits their wallet and stores
  // a tip message that renders inline in the thread.
  const sendTip = async (amount: number, note?: string) => {
    if (!id) return;
    const msg = await api.sendMessage(id, { type: "tip", amount, text: note || "" });
    setMessages((m) => [...m, msg]);
  };

  const pickFile = async () => {
    if (!id) return;
    if (Platform.OS === "web") {
      // Web: a plain <input type=file> needs no extra module.
      try {
        const doc: any = (globalThis as any).document;
        if (!doc) return;
        const input = doc.createElement("input");
        input.type = "file";
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return;
          const dataUri: string = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          if (dataUri.length > 8 * 1024 * 1024) {
            Alert.alert("File too large", "Please pick a file under ~6 MB.");
            return;
          }
          try {
            const msg = await api.sendMessage(id, {
              type: "file",
              file_base64: dataUri,
              file_name: file.name,
              file_size: file.size,
              file_mime: file.type,
            });
            setMessages((m) => [...m, msg]);
          } catch {}
        };
        input.click();
      } catch {}
      return;
    }
    // Native: pick a document, then read its bytes into a data URI (the same
    // fetch + FileReader path used for voice notes and videos).
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: "*/*", copyToCacheDirectory: true, multiple: false,
      });
      if (res.canceled) return;
      const file = res.assets?.[0];
      if (!file) return;
      const r = await fetch(file.uri);
      const blob = await r.blob();
      const dataUri: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      if (dataUri.length > 8 * 1024 * 1024) {
        Alert.alert("File too large", "Please pick a file under ~6 MB.");
        return;
      }
      const msg = await api.sendMessage(id, {
        type: "file",
        file_base64: dataUri,
        file_name: file.name,
        file_size: file.size ?? undefined,
        file_mime: file.mimeType ?? undefined,
      });
      setMessages((m) => [...m, msg]);
    } catch {
      Alert.alert("Couldn't attach file", "Please try again.");
    }
  };

  const sendContact = async (u: PublicUser) => {
    if (!id) return;
    try {
      const msg = await api.sendMessage(id, {
        type: "contact",
        contact_user_id: u.user_id,
        contact_name: u.name,
        contact_picture: u.picture || undefined,
      });
      setMessages((m) => [...m, msg]);
    } catch {}
  };

  const send = async () => {
    if (editingMsg) { await saveEdit(); return; }
    if (!text.trim() || !id) return;
    setSending(true);
    const draft = text.trim();
    const replyId = replyTo?.id;
    setText("");
    setReplyTo(null);
    try {
      // If we know the peer's E2E public key, encrypt the body before sending.
      const payload = peerKey ? await encryptForPeer(draft, peerKey) : draft;
      const msg = await api.sendMessage(id, { type: "text", text: payload, reply_to: replyId });
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
    setAttachOpen(false);
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
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text style={styles.title} numberOfLines={1}>{name || "Chat"}</Text>
          <View style={styles.encRow}>
            <Ionicons name={peerKey ? "lock-closed" : "lock-closed-outline"} size={10} color={peerKey ? theme.primary : theme.textMuted} />
            <Text style={[styles.encText, peerKey && { color: theme.primary }]}>
              {peerKey ? "End-to-end encrypted" : "Encrypted"}
            </Text>
          </View>
        </View>
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
            contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 16, gap: 12 }}
            renderItem={({ item }) => {
              const mine = item.sender_id === user?.user_id;
              const encrypted = isE2E(item.text || "");
              const bodyText = encrypted ? (decrypted[item.id] ?? "🔒 Encrypted") : (item.text || "");
              return (
                <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowOther]}>
                  <TouchableOpacity
                    onPress={() => onBubbleTap(item)}
                    onLongPress={() => { if (!item.deleted) setActionMsg(item); }}
                    delayLongPress={300}
                    activeOpacity={0.9}
                    style={[
                      styles.bubble,
                      mine ? styles.bubbleMine : styles.bubbleOther,
                      item.type === "place" && !item.deleted && styles.bubblePlace,
                      item.deleted && styles.bubbleDeleted,
                    ]}
                    testID={`msg-${item.id}`}
                  >
                    {!!item.reply_to_id && !item.deleted && (() => {
                      const ref = messages.find((x) => x.id === item.reply_to_id);
                      return (
                        <View style={[styles.quoted, mine ? styles.quotedMine : styles.quotedOther]}>
                          <Text style={[styles.quotedName, mine && { color: "rgba(255,255,255,0.95)" }]} numberOfLines={1}>
                            {ref ? (ref.sender_id === user?.user_id ? "You" : (name || "Them")) : "Message"}
                          </Text>
                          <Text style={[styles.quotedText, mine && { color: "rgba(255,255,255,0.85)" }]} numberOfLines={1}>
                            {ref ? previewOf(ref) : "Original message"}
                          </Text>
                        </View>
                      );
                    })()}
                    {item.deleted ? (
                      <View style={styles.deletedRow}>
                        <Ionicons name="ban-outline" size={14} color={mine ? "rgba(255,255,255,0.75)" : theme.textMuted} />
                        <Text style={[styles.deletedText, mine && { color: "rgba(255,255,255,0.8)" }]}>
                          {mine ? "You deleted this message" : "This message was deleted"}
                        </Text>
                      </View>
                    ) : item.type === "place" ? (
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
                      <View style={styles.mediaWrap}>
                        <MediaGrid media={item.media || []} testID={`msg-${item.id}`} />
                      </View>
                    ) : item.type === "post" && item.post_id ? (
                      sharedPosts[item.post_id] ? (
                        <View style={styles.sharedWrap}>
                          <QuoteCard post={sharedPosts[item.post_id]} />
                        </View>
                      ) : (
                        <View style={styles.sharedLoading}>
                          <ActivityIndicator color={mine ? "#fff" : theme.primary} size="small" />
                        </View>
                      )
                    ) : item.type === "gif" && item.gif_url ? (
                      <Image source={{ uri: item.gif_url }} style={styles.gifImg} resizeMode="cover" />
                    ) : item.type === "file" ? (
                      <TouchableOpacity
                        style={styles.fileRow}
                        onPress={() => item.file_base64 && Linking.openURL(item.file_base64).catch(() => {})}
                        testID={`file-msg-${item.id}`}
                      >
                        <View style={[styles.fileIcon, { backgroundColor: mine ? "rgba(255,255,255,0.2)" : theme.surfaceAlt }]}>
                          <Ionicons name="document-text" size={20} color={mine ? "#fff" : theme.primary} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.fileName, mine && { color: "#fff" }]} numberOfLines={1}>{item.file_name || "File"}</Text>
                          {!!item.file_size && (
                            <Text style={[styles.fileSize, mine && { color: "rgba(255,255,255,0.75)" }]}>
                              {(item.file_size / 1024).toFixed(0)} KB
                            </Text>
                          )}
                        </View>
                      </TouchableOpacity>
                    ) : item.type === "contact" ? (
                      <TouchableOpacity
                        style={styles.contactRow}
                        onPress={() => item.contact_name && router.push({ pathname: "/user/[name]", params: { name: item.contact_name } })}
                        testID={`contact-msg-${item.id}`}
                      >
                        <View style={styles.contactAvatar}>
                          {item.contact_picture ? (
                            <Image source={{ uri: item.contact_picture }} style={{ width: "100%", height: "100%" }} />
                          ) : (
                            <Text style={styles.contactInit}>{(item.contact_name?.[0] || "?").toUpperCase()}</Text>
                          )}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.contactName, mine && { color: "#fff" }]} numberOfLines={1}>{item.contact_name}</Text>
                          <Text style={[styles.contactSub, mine && { color: "rgba(255,255,255,0.75)" }]}>Tap to view profile</Text>
                        </View>
                      </TouchableOpacity>
                    ) : item.type === "tip" ? (
                      <View style={styles.tipCard}>
                        <View style={styles.tipIcon}><Ionicons name="cash" size={20} color="#fff" /></View>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.tipAmount, mine && { color: "#fff" }]}>${(item.amount || 0).toFixed(2)} tip</Text>
                          <Text style={[styles.tipSub, mine && { color: "rgba(255,255,255,0.8)" }]}>
                            {mine ? "You sent a tip" : "Sent you a tip"}
                          </Text>
                          {!encrypted && !!bodyText && (
                            <Text style={[styles.tipNote, mine && { color: "rgba(255,255,255,0.9)" }]}>“{bodyText}”</Text>
                          )}
                        </View>
                      </View>
                    ) : (
                      <View>
                        <EmojiText text={bodyText} emojis={emojiMap} style={[styles.bubbleText, mine && { color: "#fff" }]} />
                        {!encrypted && !!item.link_preview && (
                          <LinkPreviewCard preview={item.link_preview as any} />
                        )}
                      </View>
                    )}
                  </TouchableOpacity>
                  <View style={[styles.metaRow, mine ? { justifyContent: "flex-end" } : { justifyContent: "flex-start" }]}>
                    {!!reactionSummary(item) && !item.deleted && (
                      <TouchableOpacity onPress={() => toggleReaction(item)} testID={`react-chip-${item.id}`}>
                        <Text style={styles.reactionChip}>{reactionSummary(item)}</Text>
                      </TouchableOpacity>
                    )}
                    <Text style={styles.metaTime}>
                      {new Date(item.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </Text>
                    {!!item.edited_at && !item.deleted && (
                      <TouchableOpacity onPress={() => openHistory(item)} testID={`edited-${item.id}`} hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}>
                        <Text style={[styles.metaTime, styles.editedLink]}>· edited</Text>
                      </TouchableOpacity>
                    )}
                    {encrypted && !item.deleted && (
                      <Ionicons name="lock-closed" size={10} color={theme.textMuted} />
                    )}
                    {mine && !item.deleted && (
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

        <View>
          {/* Attachment menu (tap the + button). WhatsApp-style popup. */}
          {attachOpen && !recording && (
            <>
              <TouchableOpacity
                style={styles.attachBackdrop}
                activeOpacity={1}
                onPress={() => setAttachOpen(false)}
                testID="attach-backdrop"
              />
              <View style={[styles.attachMenu, { bottom: insets.bottom + 66 }]}>
                <TouchableOpacity
                  style={styles.attachItem}
                  onPress={() => { setAttachOpen(false); sendMedia(); }}
                  disabled={sending}
                  testID="attach-photo"
                >
                  <View style={[styles.attachItemIcon, { backgroundColor: "#8E5CF7" }]}>
                    <Ionicons name="image" size={20} color="#fff" />
                  </View>
                  <Text style={styles.attachItemLabel}>Photo &amp; Video</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.attachItem}
                  onPress={() => { setAttachOpen(false); shareLocation(); }}
                  disabled={sending || sharingLocation}
                  testID="attach-location"
                >
                  <View style={[styles.attachItemIcon, { backgroundColor: "#23B26D" }]}>
                    {sharingLocation ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Ionicons name="location" size={20} color="#fff" />
                    )}
                  </View>
                  <Text style={styles.attachItemLabel}>Location</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.attachItem}
                  onPress={() => { setAttachOpen(false); setGifOpen(true); }}
                  testID="attach-gif"
                >
                  <View style={[styles.attachItemIcon, { backgroundColor: "#EC4899" }]}>
                    <Ionicons name="film" size={20} color="#fff" />
                  </View>
                  <Text style={styles.attachItemLabel}>GIF</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.attachItem}
                  onPress={() => { setAttachOpen(false); pickFile(); }}
                  testID="attach-file"
                >
                  <View style={[styles.attachItemIcon, { backgroundColor: "#F59E0B" }]}>
                    <Ionicons name="document" size={20} color="#fff" />
                  </View>
                  <Text style={styles.attachItemLabel}>File</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.attachItem}
                  onPress={() => { setAttachOpen(false); setContactOpen(true); }}
                  testID="attach-contact"
                >
                  <View style={[styles.attachItemIcon, { backgroundColor: "#3B82F6" }]}>
                    <Ionicons name="person" size={20} color="#fff" />
                  </View>
                  <Text style={styles.attachItemLabel}>Contact</Text>
                </TouchableOpacity>
                {!!peer && (
                  <TouchableOpacity
                    style={styles.attachItem}
                    onPress={() => { setAttachOpen(false); setTipOpen(true); }}
                    testID="attach-tip"
                  >
                    <View style={[styles.attachItemIcon, { backgroundColor: theme.primary }]}>
                      <Ionicons name="cash" size={20} color="#fff" />
                    </View>
                    <Text style={styles.attachItemLabel}>Send tip</Text>
                  </TouchableOpacity>
                )}
              </View>
            </>
          )}

          {editingMsg && !recording && (
            <View style={styles.editBanner}>
              <Ionicons name="create-outline" size={16} color={theme.primary} />
              <Text style={styles.editBannerText} numberOfLines={1}>Editing message</Text>
              <TouchableOpacity onPress={cancelEdit} testID="cancel-edit" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={18} color={theme.textMuted} />
              </TouchableOpacity>
            </View>
          )}

          {replyTo && !editingMsg && !recording && (
            <View style={styles.replyBanner}>
              <View style={styles.replyBar} />
              <View style={{ flex: 1 }}>
                <Text style={styles.replyName} numberOfLines={1}>
                  Replying to {replyTo.sender_id === user?.user_id ? "yourself" : (name || "them")}
                </Text>
                <Text style={styles.replySnippet} numberOfLines={1}>{previewOf(replyTo)}</Text>
              </View>
              <TouchableOpacity onPress={() => setReplyTo(null)} testID="cancel-reply" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={18} color={theme.textMuted} />
              </TouchableOpacity>
            </View>
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
                  <Text style={styles.recTime}>{fmtDur(recMs)}</Text>
                  <Text style={styles.recText} numberOfLines={1}>Tap ✓ to send · trash to cancel</Text>
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
                  onPress={() => setAttachOpen((o) => !o)}
                  disabled={sending}
                  testID="attach-btn"
                >
                  <Ionicons
                    name={attachOpen ? "close" : "add"}
                    size={26}
                    color={theme.primary}
                  />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.attachBtn}
                  onPress={() => { setAttachOpen(false); setEmojiOpen(true); }}
                  disabled={sending}
                  testID="emoji-btn"
                >
                  <Ionicons name="happy-outline" size={23} color={theme.primary} />
                </TouchableOpacity>
                <TextInput
                  style={styles.composerInput}
                  placeholder="Message..."
                  placeholderTextColor={theme.textMuted}
                  value={text}
                  onChangeText={setText}
                  onFocus={() => setAttachOpen(false)}
                  multiline
                  testID="msg-input"
                />
                {text.trim() || editingMsg ? (
                  <TouchableOpacity
                    style={[styles.sendBtn, sending && { opacity: 0.5 }]}
                    onPress={send}
                    disabled={sending}
                    testID="send-btn"
                  >
                    <Ionicons name={editingMsg ? "checkmark" : "send"} size={18} color="#fff" />
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
        </View>
      </KeyboardAvoidingView>

      <CustomEmojiSheet
        visible={emojiOpen}
        emojis={emojis}
        myUserId={user?.user_id}
        onClose={() => setEmojiOpen(false)}
        onPick={(c) => setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}:${c}: `)}
        onChanged={loadEmojis}
      />
      <GifPickerSheet visible={gifOpen} onClose={() => setGifOpen(false)} onPick={sendGif} />
      <ContactPickerSheet visible={contactOpen} onClose={() => setContactOpen(false)} onPick={sendContact} />
      <FakePaymentSheet
        visible={tipOpen}
        title={`Tip ${peer?.name || "this user"}`}
        subtitle="Enter what they receive"
        amount={5}
        editableAmount
        allowNote
        appleFee
        onCheckout={payEnabled && peer ? async (amt, note) => {
          try { return (await api.createCheckout("tip", peer.id, amt, { conversation_id: id, note })).url; } catch { return null; }
        } : undefined}
        cta="Send tip"
        successText={`Your tip was sent to ${peer?.name || "them"}.`}
        onClose={() => setTipOpen(false)}
        onPaid={async (amount, note) => { await sendTip(amount, note); }}
      />

      {/* Message action sheet (long-press a bubble) */}
      <Modal
        visible={!!actionMsg}
        transparent
        animationType="fade"
        onRequestClose={() => setActionMsg(null)}
      >
        <TouchableOpacity style={styles.actionBackdrop} activeOpacity={1} onPress={() => setActionMsg(null)}>
          <View style={[styles.actionSheet, { paddingBottom: insets.bottom + 16 }]}>
            {actionMsg && !actionMsg.deleted && (
              <TouchableOpacity
                style={styles.actionRow}
                onPress={() => { const m = actionMsg; setActionMsg(null); toggleReaction(m); }}
                testID="msg-action-react"
              >
                <Ionicons name={myReaction(actionMsg) ? "heart" : "heart-outline"} size={18} color="#EF4444" />
                <Text style={styles.actionRowText}>{myReaction(actionMsg) ? "Remove like" : "Like"}</Text>
              </TouchableOpacity>
            )}
            {actionMsg && !actionMsg.deleted && (
              <TouchableOpacity
                style={styles.actionRow}
                onPress={() => { const m = actionMsg; setActionMsg(null); setReplyTo(m); }}
                testID="msg-action-reply"
              >
                <Ionicons name="arrow-undo-outline" size={18} color={theme.textPrimary} />
                <Text style={styles.actionRowText}>Reply</Text>
              </TouchableOpacity>
            )}
            {actionMsg && (actionMsg.type === "text" || actionMsg.type === "post") && plainOf(actionMsg).length > 0 && (
              <TouchableOpacity style={styles.actionRow} onPress={() => copyMessage(actionMsg)} testID="msg-action-copy">
                <Ionicons name="copy-outline" size={18} color={theme.textPrimary} />
                <Text style={styles.actionRowText}>Copy</Text>
              </TouchableOpacity>
            )}
            {actionMsg && actionMsg.sender_id === user?.user_id && actionMsg.type === "text" && (
              <TouchableOpacity style={styles.actionRow} onPress={() => beginEdit(actionMsg)} testID="msg-action-edit">
                <Ionicons name="create-outline" size={18} color={theme.textPrimary} />
                <Text style={styles.actionRowText}>Edit</Text>
              </TouchableOpacity>
            )}
            {actionMsg && actionMsg.sender_id === user?.user_id && (
              <TouchableOpacity style={styles.actionRow} onPress={() => deleteMessage(actionMsg)} testID="msg-action-delete">
                <Ionicons name="trash-outline" size={18} color={theme.error} />
                <Text style={[styles.actionRowText, { color: theme.error }]}>Delete</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.actionRow, { justifyContent: "center" }]} onPress={() => setActionMsg(null)}>
              <Text style={[styles.actionRowText, { color: theme.textMuted }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={!!historyItems} transparent animationType="fade" onRequestClose={() => setHistoryItems(null)}>
        <TouchableOpacity style={styles.actionBackdrop} activeOpacity={1} onPress={() => setHistoryItems(null)}>
          <View style={[styles.actionSheet, { paddingBottom: insets.bottom + 16, maxHeight: "70%" }]}>
            <Text style={styles.historyTitle}>Edit history</Text>
            <ScrollView>
              {(historyItems || []).map((h, i, arr) => {
                const current = i === arr.length - 1;
                return (
                  <View key={i} style={styles.historyRow}>
                    <Text style={styles.historyMeta}>
                      {current ? "Current" : `Version ${i + 1}`}
                      {h.edited_at ? ` · ${new Date(h.edited_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
                    </Text>
                    <Text style={styles.historyText}>{h.text}</Text>
                  </View>
                );
              })}
            </ScrollView>
            <TouchableOpacity style={[styles.actionRow, { justifyContent: "center", marginTop: 6 }]} onPress={() => setHistoryItems(null)}>
              <Text style={[styles.actionRowText, { color: theme.textMuted }]}>Close</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
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
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "700", textAlign: "center" },
  encRow: { flexDirection: "row", alignItems: "center", gap: 3, marginTop: 1 },
  encText: { color: theme.textMuted, fontSize: 10.5, fontWeight: "600" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { paddingTop: 60, alignItems: "center" },
  emptyText: { color: theme.textMuted, fontSize: 13 },

  bubbleRow: { flexDirection: "row" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4, paddingHorizontal: 4 },
  metaTime: { color: theme.textMuted, fontSize: 11, fontWeight: "500" },
  editedLink: { textDecorationLine: "underline" },
  historyTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "800", marginBottom: 10, paddingHorizontal: 4 },
  historyRow: { backgroundColor: theme.surfaceAlt, borderRadius: 12, padding: 12, marginBottom: 8 },
  historyMeta: { color: theme.textMuted, fontSize: 11, fontWeight: "700", marginBottom: 4 },
  historyText: { color: theme.textPrimary, fontSize: 14, lineHeight: 19 },
  bubbleRowMine: { justifyContent: "flex-end" },
  bubbleRowOther: { justifyContent: "flex-start" },
  bubble: {
    maxWidth: "78%",
    paddingHorizontal: 15, paddingVertical: 11,
    borderRadius: 20,
  },
  bubbleMine: { backgroundColor: theme.primary, borderBottomRightRadius: 7 },
  bubbleOther: {
    backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border,
    borderBottomLeftRadius: 7,
  },
  bubblePlace: { paddingVertical: 13 },
  bubbleText: { color: theme.textPrimary, fontSize: 15, lineHeight: 21 },
  bubbleDeleted: { backgroundColor: "transparent", borderWidth: 1, borderColor: theme.border, borderStyle: "dashed" },
  quoted: {
    borderLeftWidth: 3, paddingLeft: 10, paddingRight: 10, paddingVertical: 7, marginBottom: 8,
    borderRadius: 8,
  },
  quotedMine: { borderLeftColor: "rgba(255,255,255,0.9)", backgroundColor: "rgba(255,255,255,0.12)" },
  quotedOther: { borderLeftColor: theme.primary, backgroundColor: theme.surfaceAlt },
  quotedName: { color: theme.primary, fontSize: 12.5, fontWeight: "800", marginBottom: 2 },
  quotedText: { color: theme.textSecondary, fontSize: 12.5, lineHeight: 17 },
  reactionChip: {
    color: theme.textPrimary, fontSize: 12.5, fontWeight: "600",
    backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, overflow: "hidden", paddingHorizontal: 8, paddingVertical: 3,
  },
  deletedRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  deletedText: { color: theme.textMuted, fontSize: 13, fontStyle: "italic" },
  mediaWrap: { width: 250 },
  sharedWrap: { width: 250 },
  sharedLoading: { width: 200, height: 80, alignItems: "center", justifyContent: "center" },
  gifImg: { width: 200, height: 200, borderRadius: 12, backgroundColor: theme.surfaceAlt },
  fileRow: { flexDirection: "row", alignItems: "center", gap: 10, width: 220 },
  fileIcon: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  fileName: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  fileSize: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
  contactRow: { flexDirection: "row", alignItems: "center", gap: 10, width: 220 },
  contactAvatar: { width: 42, height: 42, borderRadius: 21, overflow: "hidden", backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  contactInit: { color: "#fff", fontSize: 17, fontWeight: "700" },
  contactName: { color: theme.textPrimary, fontSize: 14, fontWeight: "800" },
  contactSub: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
  tipCard: { flexDirection: "row", alignItems: "center", gap: 10, minWidth: 170 },
  tipIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },
  tipAmount: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  tipSub: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
  tipNote: { color: theme.textSecondary, fontSize: 13, marginTop: 3, fontStyle: "italic" },
  placeHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  placeName: { color: theme.textPrimary, fontSize: 14, fontWeight: "700", flex: 1 },
  placeAddr: { color: theme.textSecondary, fontSize: 12 },
  placeTap: { marginTop: 6, color: theme.primary, fontSize: 12, fontWeight: "600" },

  editBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 12, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: theme.surface, borderRadius: 12,
    borderWidth: 1, borderColor: theme.border,
  },
  editBannerText: { flex: 1, color: theme.textSecondary, fontSize: 13, fontWeight: "600" },
  replyBanner: {
    flexDirection: "row", alignItems: "center", gap: 10,
    marginHorizontal: 12, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: theme.surface, borderRadius: 12,
    borderWidth: 1, borderColor: theme.border,
  },
  replyBar: { width: 3, alignSelf: "stretch", borderRadius: 2, backgroundColor: theme.primary },
  replyName: { color: theme.primary, fontSize: 12.5, fontWeight: "800" },
  replySnippet: { color: theme.textSecondary, fontSize: 13, marginTop: 1 },

  actionBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  actionSheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingTop: 12, paddingHorizontal: 16, gap: 6,
    borderTopWidth: 1, borderColor: theme.border,
  },
  actionRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surfaceAlt, borderRadius: 12,
    paddingVertical: 14, paddingHorizontal: 16,
  },
  actionRowText: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },

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
  attachBackdrop: {
    position: "absolute", left: 0, right: 0, bottom: 0, top: -1000,
  },
  attachMenu: {
    position: "absolute", left: 12,
    backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border,
    borderRadius: 16, paddingVertical: 6, minWidth: 200,
    shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 }, elevation: 8,
  },
  attachItem: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  attachItemIcon: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: "center", justifyContent: "center",
  },
  attachItemLabel: { color: theme.textPrimary, fontSize: 15, fontWeight: "600" },
  recordingPill: {
    flex: 1, flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    borderRadius: 22, paddingHorizontal: 16, minHeight: 44,
  },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: theme.error },
  recTime: { color: theme.textPrimary, fontSize: 14, fontWeight: "800", fontVariant: ["tabular-nums"] },
  recText: { flex: 1, color: theme.textMuted, fontSize: 12.5, fontWeight: "500" },
});
