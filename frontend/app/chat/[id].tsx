import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, ActivityIndicator, Image, Modal, Linking,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import {
  useAudioRecorder,
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
} from "expo-audio";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api, Message, Post, PublicUser } from "@/src/api/client";
import MediaGrid from "@/src/components/MediaGrid";
import VoiceMessage from "@/src/components/VoiceMessage";
import RichText from "@/src/components/RichText";
import LinkPreviewCard from "@/src/components/LinkPreviewCard";
import QuoteCard from "@/src/components/QuoteCard";
import GifPickerSheet from "@/src/components/GifPickerSheet";
import ContactPickerSheet from "@/src/components/ContactPickerSheet";
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
  const [actionMsg, setActionMsg] = useState<Message | null>(null);
  const [sharedPosts, setSharedPosts] = useState<Record<string, Post>>({});
  const [gifOpen, setGifOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
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

  // Plaintext for a message (handles E2E decryption cache).
  const plainOf = (m: Message): string =>
    isE2E(m.text || "") ? (decrypted[m.id] ?? "") : (m.text || "");

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

  const pickFile = async () => {
    if (!id) return;
    try {
      const res: any = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
      if (res.canceled) return;
      const asset = res.assets?.[0];
      if (!asset?.uri) return;
      // Read the file into a base64 data URI (works web + native).
      const blob = await (await fetch(asset.uri)).blob();
      const dataUri: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      if (dataUri.length > 8 * 1024 * 1024) { return; }
      const msg = await api.sendMessage(id, {
        type: "file",
        file_base64: dataUri,
        file_name: asset.name || "file",
        file_size: asset.size || blob.size,
        file_mime: asset.mimeType || blob.type,
      });
      setMessages((m) => [...m, msg]);
    } catch {}
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
              const encrypted = isE2E(item.text || "");
              const bodyText = encrypted ? (decrypted[item.id] ?? "🔒 Encrypted") : (item.text || "");
              return (
                <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowOther]}>
                  <TouchableOpacity
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
                    ) : (
                      <View>
                        <RichText text={bodyText} style={[styles.bubbleText, mine && { color: "#fff" }]} />
                        {!encrypted && !!item.link_preview && (
                          <LinkPreviewCard preview={item.link_preview as any} />
                        )}
                      </View>
                    )}
                  </TouchableOpacity>
                  <View style={[styles.metaRow, mine ? { justifyContent: "flex-end" } : { justifyContent: "flex-start" }]}>
                    <Text style={styles.metaTime}>
                      {new Date(item.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </Text>
                    {!!item.edited_at && !item.deleted && <Text style={styles.metaTime}>· edited</Text>}
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

      <GifPickerSheet visible={gifOpen} onClose={() => setGifOpen(false)} onPick={sendGif} />
      <ContactPickerSheet visible={contactOpen} onClose={() => setContactOpen(false)} onPick={sendContact} />

      {/* Message action sheet (long-press a bubble) */}
      <Modal
        visible={!!actionMsg}
        transparent
        animationType="fade"
        onRequestClose={() => setActionMsg(null)}
      >
        <TouchableOpacity style={styles.actionBackdrop} activeOpacity={1} onPress={() => setActionMsg(null)}>
          <View style={[styles.actionSheet, { paddingBottom: insets.bottom + 16 }]}>
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
  bubbleDeleted: { backgroundColor: "transparent", borderWidth: 1, borderColor: theme.border, borderStyle: "dashed" },
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
  recText: { color: theme.textSecondary, fontSize: 14, fontWeight: "500" },
});
