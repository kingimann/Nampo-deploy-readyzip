import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Keyboard, Platform, ActivityIndicator, Image, Modal, Linking, Alert, ScrollView, Animated, Easing, Dimensions,
} from "react-native";

// Chat media bubbles scale with the screen so photos/videos aren't tiny.
const CHAT_MEDIA_W = Math.min(300, Math.round(Dimensions.get("window").width * 0.72));
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@/src/platform/icons";
import * as ImagePicker from "@/src/platform/image-picker";
import * as DocumentPicker from "@/src/platform/document-picker";
import * as Location from "@/src/platform/location";
import * as Clipboard from "@/src/platform/clipboard";
import {
  useAudioRecorder,
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
} from "@/src/platform/audio";
import { useLocalSearchParams, useRouter, useFocusEffect } from "@/src/platform/navigation";
import { safeBack } from "@/src/utils/nav";
import { api, Message, Post, PublicUser, CustomEmoji, FormDef, ScheduledMessage, mediaUri } from "@/src/api/client";
import MediaGrid from "@/src/components/MediaGrid";
import RestrictionBanner from "@/src/components/RestrictionBanner";
import EmojiText from "@/src/components/EmojiText";
import CustomEmojiSheet from "@/src/components/CustomEmojiSheet";
import VoiceMessage from "@/src/components/VoiceMessage";
import RichText from "@/src/components/RichText";
import LinkPreviewCard from "@/src/components/LinkPreviewCard";
import QuoteCard from "@/src/components/QuoteCard";
import GifPickerSheet from "@/src/components/GifPickerSheet";
import ContactPickerSheet from "@/src/components/ContactPickerSheet";
import FormPickerSheet from "@/src/components/FormPickerSheet";
import UnlockChatSheet from "@/src/components/UnlockChatSheet";
import FakePaymentSheet from "@/src/components/FakePaymentSheet";
import { stripeCardPay } from "@/src/lib/stripeEmbed";
import { theme } from "@/src/theme";
import { useAuth } from "@/src/context/AuthContext";
import { useConfirm } from "@/src/context/ConfirmContext";
import { ensureKeyPair, getPeerPublicKey, encryptForPeer, encryptForRecipients, encryptDataForRecipients, decryptData, isE2EMedia, isE2E, tryDecrypt, hasBackup } from "@/src/utils/e2e";

// Conversation color themes (Messenger-style). `bg` paints the thread,
// `bubble` recolors the messages you send.
const CHAT_THEMES: Record<string, { label: string; bg: string; bubble: string }> = {
  default: { label: "Default", bg: theme.bg, bubble: theme.primary },
  ocean:   { label: "Ocean",   bg: "#0b2438", bubble: "#1d9bf0" },
  sunset:  { label: "Sunset",  bg: "#2a1320", bubble: "#f0518b" },
  forest:  { label: "Forest",  bg: "#0e261b", bubble: "#1f9d57" },
  grape:   { label: "Grape",   bg: "#1c1430", bubble: "#8e5cf7" },
  rose:    { label: "Rose",    bg: "#2b1418", bubble: "#e0556a" },
  midnight:{ label: "Midnight",bg: "#0a0a16", bubble: "#3b5bdb" },
  mono:    { label: "Mono",    bg: theme.bg,  bubble: "#52525b" },
};
const THEME_KEYS = Object.keys(CHAT_THEMES);

// Disappearing-message durations (must mirror the backend's allowed set).
const DISAPPEAR_OPTIONS: { label: string; seconds: number }[] = [
  { label: "Off", seconds: 0 },
  { label: "1 minute", seconds: 60 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "1 week", seconds: 604800 },
];
const disappearLabel = (s: number) =>
  DISAPPEAR_OPTIONS.find((o) => o.seconds === s)?.label || "Off";

export default function ChatScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const msgOff = !!user?.messaging_disabled;
  const confirm = useConfirm();
  const insets = useSafeAreaInsets();
  const { id, name, draft } = useLocalSearchParams<{ id: string; name?: string; draft?: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState(typeof draft === "string" ? draft : "");
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);
  const [peerKey, setPeerKey] = useState<Uint8Array | null>(null);
  const [isGroup, setIsGroup] = useState(false);
  // Group E2E: public key per member id, and whether every other member has one.
  const [keyByUser, setKeyByUser] = useState<Record<string, Uint8Array>>({});
  const [groupRecipients, setGroupRecipients] = useState<Uint8Array[]>([]);
  const [groupOtherCount, setGroupOtherCount] = useState(0);
  const groupE2E = isGroup && groupRecipients.length > 0;
  const [decrypted, setDecrypted] = useState<Record<string, string>>({});
  // Bumped whenever the screen regains focus so that restoring/unlocking the
  // encryption key (done on a different screen) immediately re-attempts
  // decryption of the WHOLE chat — without needing an app reload.
  const [keyVersion, setKeyVersion] = useState(0);
  useFocusEffect(useCallback(() => { setKeyVersion((v) => v + 1); }, []));
  // Decrypted media/voice/file payloads (data URIs), keyed e.g. v:<id>, f:<id>, m:<id>:<idx>.
  const [blobs, setBlobs] = useState<Record<string, string>>({});
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const [sharingLocation, setSharingLocation] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [editingMsg, setEditingMsg] = useState<Message | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [actionMsg, setActionMsg] = useState<Message | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [matchPos, setMatchPos] = useState(0);
  const [recMs, setRecMs] = useState(0);
  const lastTapRef = useRef<Record<string, number>>({});
  // Messenger-style: time/read/seen stay hidden until you tap a message.
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const tapTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
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
  const [formOpen, setFormOpen] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [pollQ, setPollQ] = useState("");
  const [pollOpts, setPollOpts] = useState<string[]>(["", ""]);
  const [pollSending, setPollSending] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleText, setScheduleText] = useState("");
  const [scheduleAt, setScheduleAt] = useState<Date | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [scheduledList, setScheduledList] = useState<ScheduledMessage[]>([]);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [transcripts, setTranscripts] = useState<Record<string, string>>({});
  const [transcribingId, setTranscribingId] = useState<string | null>(null);
  const [scamResults, setScamResults] = useState<Record<string, { risk: "low" | "medium" | "high"; reason: string }>>({});
  const [scamCheckingId, setScamCheckingId] = useState<string | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryLb, setGalleryLb] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [summarizing, setSummarizing] = useState(false);
  // Conversation settings (Messenger-style): color theme, disappearing timer, group name.
  const [convTheme, setConvTheme] = useState<string>("default");
  const [disappearSecs, setDisappearSecs] = useState<number>(0);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [receiptsOn, setReceiptsOn] = useState<boolean>(true);
  const [convName, setConvName] = useState<string>(typeof name === "string" ? name : "");
  const [themeOpen, setThemeOpen] = useState(false);
  const [disappearOpen, setDisappearOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameText, setRenameText] = useState("");
  const themeColors = CHAT_THEMES[convTheme] || CHAT_THEMES.default;
  const [peer, setPeer] = useState<{ id: string; name: string } | null>(null);
  const [payEnabled, setPayEnabled] = useState(false);
  const [walletBal, setWalletBal] = useState<number | null>(null);
  useEffect(() => { api.getPaymentsConfig().then((c) => setPayEnabled(c.enabled)).catch(() => {}); }, []);
  useEffect(() => { api.getWalletBalance().then((b) => setWalletBal(b.balance)).catch(() => {}); }, []);
  const recordStartRef = useRef<number>(0);

  // Generate / load our keypair and publish public key. Then fetch peer's key.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureKeyPair();
        const convs = await api.listConversations();
        const conv = convs.find((c) => c.id === id);
        if (conv && !cancelled) {
          setConvTheme(conv.theme || "default");
          setDisappearSecs(conv.disappearing_seconds || 0);
          setReceiptsOn(conv.receipts_enabled !== false);
          setOwnerId(conv.owner_id || null);
          if (conv.kind === "group" && conv.name) setConvName(conv.name);
        }
        if (conv?.kind === "dm" && conv.other_user && conv.other_user.user_id !== user?.user_id) {
          if (!cancelled) setPeer({ id: conv.other_user.user_id, name: conv.other_user.name || name || "this user" });
          const k = await getPeerPublicKey(conv.other_user.user_id);
          if (!cancelled) setPeerKey(k);
        } else if (conv?.kind === "group") {
          if (!cancelled) { setIsGroup(true); setGroupOtherCount(((conv.members || []).filter((m) => m.user_id !== user?.user_id)).length); }
          const others = (conv.members || []).filter((m) => m.user_id !== user?.user_id);
          const map: Record<string, Uint8Array> = {};
          const recips: Uint8Array[] = [];
          for (const m of others) {
            const k = await getPeerPublicKey(m.user_id);
            if (k) { map[m.user_id] = k; recips.push(k); }
          }
          // Only enable group E2E when EVERY other member has published a key,
          // otherwise someone couldn't read the message.
          if (!cancelled) {
            setKeyByUser(map);
            setGroupRecipients(recips.length === others.length ? recips : []);
          }
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [id, user?.user_id]);

  // How many E2E text messages couldn't be decrypted on this device (key lost /
  // not yet restored). Drives the "restore your key" banner.
  const [lockedCount, setLockedCount] = useState(0);
  const [keyBackedUp, setKeyBackedUp] = useState<boolean | null>(null);
  useEffect(() => { hasBackup().then(setKeyBackedUp).catch(() => setKeyBackedUp(null)); }, [keyVersion]);
  // Show a backup nudge once the user has actually sent encrypted messages.
  const sentEncrypted = messages.some((m) => m.sender_id === user?.user_id && isE2E(m.text || ""));
  const showRestore = lockedCount > 0;
  const showBackup = !showRestore && keyBackedUp === false && sentEncrypted;

  // Decrypt any incoming ciphertext lazily.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = { ...decrypted };
      let changed = false;
      let failed = 0;
      for (const m of messages) {
        if (m.type === "text" && m.text && isE2E(m.text)) {
          if (next[m.id] === undefined) {
            // Decrypt with the sender's public key (group: per-member; DM: peer).
            const senderPub = m.sender_id === user?.user_id
              ? null                                   // self-box is tried automatically
              : (isGroup ? keyByUser[m.sender_id] || null : peerKey);
            const plain = await tryDecrypt(m.text, senderPub);
            if (plain !== null) { next[m.id] = plain; changed = true; }
            else failed += 1;
          }
        }
      }
      if (!cancelled) {
        if (changed) setDecrypted(next);
        setLockedCount(failed);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, peerKey, keyByUser, isGroup, keyVersion]);

  // Recipients to seal attachments to (DM peer or all group members), or null.
  const e2eRecipients = (): Uint8Array[] | null => {
    if (groupE2E) return groupRecipients;
    if (peerKey) return [peerKey];
    return null;
  };
  // pure-JS crypto: cap E2E attachments so encryption stays fast and within caps.
  const E2E_MEDIA_MAX = 5 * 1024 * 1024;
  const maybeEncrypt = async (dataUri: string): Promise<string> => {
    const r = e2eRecipients();
    if (!r) return dataUri;
    if ((dataUri || "").length > E2E_MEDIA_MAX) throw new Error("E2E_TOO_BIG");
    return await encryptDataForRecipients(dataUri, r);
  };

  // Decrypt any encrypted media/voice/file payloads lazily for rendering.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = { ...blobs };
      let changed = false;
      const senderKey = (m: Message) => m.sender_id === user?.user_id
        ? null : (isGroup ? keyByUser[m.sender_id] || null : peerKey);
      for (const m of messages) {
        const sk = senderKey(m);
        if (m.type === "voice" && m.audio_base64 && isE2EMedia(m.audio_base64) && next[`v:${m.id}`] === undefined) {
          const d = await decryptData(m.audio_base64, sk); if (d) { next[`v:${m.id}`] = d; changed = true; }
        }
        if (m.type === "file" && m.file_base64 && isE2EMedia(m.file_base64) && next[`f:${m.id}`] === undefined) {
          const d = await decryptData(m.file_base64, sk); if (d) { next[`f:${m.id}`] = d; changed = true; }
        }
        if (m.type === "media" && m.media) {
          for (let i = 0; i < m.media.length; i++) {
            const b = m.media[i]?.base64 || "";
            if (isE2EMedia(b) && next[`m:${m.id}:${i}`] === undefined) {
              const d = await decryptData(b, sk); if (d) { next[`m:${m.id}:${i}`] = d; changed = true; }
            }
          }
        }
      }
      if (changed && !cancelled) setBlobs(next);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, peerKey, keyByUser, isGroup, keyVersion]);

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

  // poll for new messages every 3s — detect new/edited/deleted/read/delivered
  // changes, not just count changes.
  const msgSigRef = useRef("");
  const msgSig = (arr: Message[]) =>
    arr.map((x) => `${x.id}:${x.edited_at || ""}:${x.deleted ? 1 : 0}:${x.read_at || ""}:${x.delivered_at || ""}`).join("|");
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

  // Presence: heartbeat that I'm here (and whether I'm typing), and poll the
  // peer's state to drive "active now" / "writing…" (Snapchat-style).
  const [presence, setPresence] = useState<{ typing: boolean; active: boolean }>({ typing: false, active: false });
  const typingRef = useRef(false);
  const lastTypeBeatRef = useRef(0);
  useEffect(() => {
    if (!id) return;
    const beat = async () => {
      try { await api.setPresence(id, typingRef.current); } catch {}
      try { setPresence(await api.getPresence(id)); } catch {}
    };
    beat();
    const t = setInterval(beat, 3000);
    return () => { clearInterval(t); api.setPresence(id, false).catch(() => {}); };
  }, [id]);

  const onChangeText = (v: string) => {
    setText(v);
    const typing = v.trim().length > 0;
    typingRef.current = typing;
    const now = Date.now();
    if (id && now - lastTypeBeatRef.current > 1200) {
      lastTypeBeatRef.current = now;
      api.setPresence(id, typing).catch(() => {});
    }
  };

  // Sent → Delivered → Read, per-member in groups (e.g. "Read by 3").
  const statusFor = (m: Message): { text: string; read: boolean } => {
    if (isGroup) {
      const total = groupOtherCount || 1;
      const r = m.read_by?.length || 0;
      const d = m.delivered_by?.length || 0;
      if (r >= total && total > 0) return { text: "Read", read: true };
      if (r > 0) return { text: `Read by ${r}`, read: true };
      if (d >= total && total > 0) return { text: "Delivered", read: false };
      if (d > 0) return { text: `Delivered to ${d}`, read: false };
      return { text: "Sent", read: false };
    }
    if (m.read_at) return { text: "Read", read: true };
    if (m.delivered_at) return { text: "Delivered", read: false };
    return { text: "Sent", read: false };
  };

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

  // Single tap reveals the timestamp + read/seen status (Messenger style);
  // double tap likes the message with ❤️.
  const toggleRevealed = (mid: string) =>
    setRevealedId((cur) => (cur === mid ? null : mid));
  const onBubbleTap = (m: Message) => {
    const now = Date.now();
    const last = lastTapRef.current[m.id] || 0;
    lastTapRef.current[m.id] = now;
    if (now - last < 300) {
      // Second tap within the window → react, and cancel the pending reveal.
      const t = tapTimerRef.current[m.id];
      if (t) { clearTimeout(t); delete tapTimerRef.current[m.id]; }
      lastTapRef.current[m.id] = 0;
      if (!m.deleted) toggleReaction(m);
      return;
    }
    // First tap → wait briefly to see if a double-tap follows; if not, reveal meta.
    const t = setTimeout(() => {
      delete tapTimerRef.current[m.id];
      toggleRevealed(m.id);
    }, 300);
    tapTimerRef.current[m.id] = t;
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

  const togglePin = async (m: Message) => {
    setActionMsg(null);
    if (!id) return;
    setMessages((arr) => arr.map((x) => x.id === m.id ? { ...x, pinned: !x.pinned } : x));
    try { const u = await api.pinMessage(id, m.id); setMessages((arr) => arr.map((x) => x.id === u.id ? u : x)); }
    catch { load(); }
  };
  const jumpToMessage = (m: Message) => {
    const idx = messages.findIndex((x) => x.id === m.id);
    if (idx < 0) return;
    try { listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.3 }); } catch {}
  };

  // AI summary: assemble the (decrypted, on-device) transcript and ask the
  // server's Claude endpoint to summarize it. Works for E2E chats too.
  const summarizeChat = async () => {
    setOptionsOpen(false);
    if (!id) return;
    setSummary(""); setSummarizing(true); setSummaryOpen(true);
    try {
      const lines = messages
        .filter((m) => !m.deleted)
        .slice(-150)
        .map((m) => {
          const who = m.sender_id === user?.user_id ? "You" : (isGroup ? "Member" : (peer?.name || name || "Them"));
          return `${who}: ${previewOf(m)}`;
        });
      const transcript = lines.join("\n").trim();
      if (!transcript) { setSummarizing(false); setSummary("Nothing to summarize yet."); return; }
      const r = await api.summarizeConversation(id, transcript);
      setSummary(r.summary);
    } catch (e: any) {
      setSummaryOpen(false);
      Alert.alert("Couldn't summarize", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setSummarizing(false); }
  };

  // In-chat search over the loaded thread (works with E2E, since the text is
  // already decrypted on this device).
  const matches = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    if (!q) return [] as number[];
    const out: number[] = [];
    messages.forEach((m, i) => {
      if (m.deleted) return;
      const hay = `${previewOf(m)} ${m.file_name || ""}`.toLowerCase();
      if (hay.includes(q)) out.push(i);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, searchQ, decrypted]);
  const goMatch = (dir: number) => {
    if (!matches.length) return;
    const next = (matchPos + dir + matches.length) % matches.length;
    setMatchPos(next);
    try { listRef.current?.scrollToIndex({ index: matches[next], animated: true, viewPosition: 0.4 }); } catch {}
  };
  useEffect(() => {
    setMatchPos(0);
    if (matches.length) { try { listRef.current?.scrollToIndex({ index: matches[0], animated: true, viewPosition: 0.4 }); } catch {} }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQ]);

  const saveEdit = async () => {
    if (!editingMsg || !id) return;
    const draft = text.trim();
    if (!draft) return;
    setSending(true);
    const target = editingMsg;
    setEditingMsg(null);
    setText("");
    try {
      const payload = groupE2E ? await encryptForRecipients(draft, groupRecipients)
        : peerKey ? await encryptForPeer(draft, peerKey) : draft;
      const updated = await api.editMessage(id, target.id, payload);
      if (groupE2E || peerKey) setDecrypted((d) => ({ ...d, [updated.id]: draft }));
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

  const clearConvo = async () => {
    setOptionsOpen(false);
    if (!(await confirm({ title: "Clear conversation?", message: "This hides all messages for you. The other person keeps their copy.", confirmLabel: "Clear", destructive: true }))) return;
    try { await api.clearConversation(id); setMessages([]); }
    catch (e: any) { Alert.alert("Couldn't clear", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
  };

  // ---- Conversation settings: theme, disappearing messages, group name ----
  const applyTheme = async (key: string) => {
    if (!id) return;
    const prev = convTheme;
    setConvTheme(key); setThemeOpen(false);
    try { await api.setConversationTheme(id, key); }
    catch { setConvTheme(prev); }
  };
  const applyDisappear = async (secs: number) => {
    if (!id) return;
    const prev = disappearSecs;
    setDisappearSecs(secs); setDisappearOpen(false);
    try { await api.setDisappearing(id, secs); }
    catch { setDisappearSecs(prev); }
  };
  const saveGroupName = async () => {
    const n = renameText.trim();
    if (!id || !n) return;
    setRenameOpen(false);
    const prev = convName;
    setConvName(n);
    try { await api.patchGroupChat(id, { name: n }); }
    catch (e: any) { setConvName(prev); Alert.alert("Couldn't rename", String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
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
              file_base64: await maybeEncrypt(dataUri),
              file_name: file.name,
              file_size: file.size,
              file_mime: file.type,
            });
            if (e2eRecipients()) setBlobs((b) => ({ ...b, [`f:${msg.id}`]: dataUri }));
            setMessages((m) => [...m, msg]);
          } catch (e: any) {
            if (String(e?.message) === "E2E_TOO_BIG") Alert.alert("Too large to encrypt", "Encrypted files must be under ~5 MB.");
          }
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
        file_base64: await maybeEncrypt(dataUri),
        file_name: file.name,
        file_size: file.size ?? undefined,
        file_mime: file.mimeType ?? undefined,
      });
      if (e2eRecipients()) setBlobs((b) => ({ ...b, [`f:${msg.id}`]: dataUri }));
      setMessages((m) => [...m, msg]);
    } catch (e: any) {
      Alert.alert(
        String(e?.message) === "E2E_TOO_BIG" ? "Too large to encrypt" : "Couldn't attach file",
        String(e?.message) === "E2E_TOO_BIG" ? "Encrypted files must be under ~5 MB." : "Please try again.",
      );
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

  const sendForm = async (f: FormDef) => {
    if (!id) return;
    try {
      const msg = await api.sendMessage(id, { type: "form", form_id: f.id });
      setMessages((m) => [...m, msg]);
    } catch {}
  };

  const openPoll = () => {
    setPollQ("");
    setPollOpts(["", ""]);
    setPollOpen(true);
  };

  const sendPoll = async () => {
    if (!id) return;
    const q = pollQ.trim();
    const opts = pollOpts.map((o) => o.trim()).filter(Boolean).slice(0, 6);
    if (!q || opts.length < 2) return;
    setPollSending(true);
    try {
      const msg = await api.sendMessage(id, { type: "poll", poll_question: q, poll_options: opts });
      setMessages((m) => [...m, msg]);
      setPollOpen(false);
    } catch {} finally {
      setPollSending(false);
    }
  };

  const votePollMessage = async (item: Message, option: number) => {
    if (!id) return;
    // Optimistic toggle so the bars react instantly.
    const uid = user?.user_id;
    setMessages((ms) => ms.map((m) => {
      if (m.id !== item.id) return m;
      const votes = { ...(m.poll_votes || {}) };
      if (uid) {
        if (votes[uid] === option) delete votes[uid];
        else votes[uid] = option;
      }
      return { ...m, poll_votes: votes };
    }));
    try {
      const updated = await api.votePollMessage(id, item.id, option);
      setMessages((ms) => ms.map((m) => (m.id === item.id ? updated : m)));
    } catch {}
  };

  const loadScheduled = useCallback(async () => {
    if (!id) return;
    try { setScheduledList(await api.listScheduledMessages(id)); } catch {}
  }, [id]);
  useEffect(() => { loadScheduled(); }, [loadScheduled]);

  const openSchedule = () => {
    setScheduleText(text.trim());
    // Default to one hour out, rounded to the next 5 minutes.
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    setScheduleAt(d);
    setScheduleOpen(true);
  };

  const sendScheduled = async () => {
    if (!id) return;
    const draft = scheduleText.trim();
    if (!draft || !scheduleAt) return;
    if (scheduleAt.getTime() <= Date.now() + 60 * 1000) return;
    setScheduling(true);
    try {
      const payload = groupE2E ? await encryptForRecipients(draft, groupRecipients)
        : peerKey ? await encryptForPeer(draft, peerKey) : draft;
      await api.scheduleMessage(id, { type: "text", text: payload }, scheduleAt.toISOString());
      setScheduleOpen(false);
      setText("");
      await loadScheduled();
    } catch {} finally {
      setScheduling(false);
    }
  };

  const cancelScheduled = async (sid: string) => {
    if (!id) return;
    setScheduledList((l) => l.filter((s) => s.id !== sid));
    try { await api.cancelScheduledMessage(id, sid); } catch { loadScheduled(); }
  };

  const transcribeVoice = async (item: Message) => {
    if (!id || transcribingId) return;
    if (transcripts[item.id] || item.transcript) return;  // already have one
    setTranscribingId(item.id);
    try {
      const isE2E = isE2EMedia(item.audio_base64 || "");
      const audio = isE2E ? blobs[`v:${item.id}`] : undefined;  // server has the plain copy
      if (isE2E && !audio) { setTranscribingId(null); return; }  // still decrypting
      const res = await api.transcribeVoiceMessage(id, item.id, audio);
      setTranscripts((t) => ({ ...t, [item.id]: res.text }));
    } catch (e: any) {
      const raw = (e?.message || "Couldn't transcribe").replace(/^\d+:\s*/, "");
      setTranscripts((t) => ({ ...t, [item.id]: `⚠️ ${raw}` }));
    } finally {
      setTranscribingId(null);
    }
  };

  const toggleReceipts = async () => {
    if (!id) return;
    const next = !receiptsOn;
    setReceiptsOn(next);            // optimistic
    setOptionsOpen(false);
    try { await api.setReadReceipts(id, next); } catch { setReceiptsOn(!next); }
  };

  const runScamCheck = async (item: Message) => {
    if (!id || scamCheckingId) return;
    if (scamResults[item.id]) return;
    setScamCheckingId(item.id);
    try {
      // E2E messages are opaque to the server — pass the decrypted text we already have.
      const plain = (decrypted[item.id] ?? (isE2E(item.text || "") ? "" : (item.text || ""))).trim();
      const res = await api.scamCheckMessage(id, item.id, plain || undefined);
      setScamResults((s) => ({ ...s, [item.id]: res }));
    } catch (e: any) {
      const raw = (e?.message || "Couldn't analyze").replace(/^\d+:\s*/, "");
      setScamResults((s) => ({ ...s, [item.id]: { risk: "low", reason: `⚠️ ${raw}` } }));
    } finally {
      setScamCheckingId(null);
    }
  };

  const send = async () => {
    if (editingMsg) { await saveEdit(); return; }
    if (!text.trim() || !id) return;
    setSending(true);
    const draft = text.trim();
    const replyId = replyTo?.id;
    setText("");
    setReplyTo(null);
    typingRef.current = false;
    if (id) api.setPresence(id, false).catch(() => {});
    try {
      // Encrypt the body to the recipient(s) before sending when E2E is available.
      const payload = groupE2E ? await encryptForRecipients(draft, groupRecipients)
        : peerKey ? await encryptForPeer(draft, peerKey) : draft;
      const msg = await api.sendMessage(id, { type: "text", text: payload, reply_to: replyId });
      // Pre-populate decrypted cache so the bubble shows plaintext immediately.
      if (groupE2E || peerKey) setDecrypted((d) => ({ ...d, [msg.id]: draft }));
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
      let outMedia = media;
      if (e2eRecipients()) {
        outMedia = await Promise.all(media.map(async (mm) => ({ ...mm, base64: await maybeEncrypt(mm.base64) })));
      }
      const msg = await api.sendMessage(id, { type: "media", media: outMedia });
      if (e2eRecipients()) media.forEach((mm, i) => setBlobs((b) => ({ ...b, [`m:${msg.id}:${i}`]: mm.base64 })));
      setMessages((m) => [...m, msg]);
    } catch (e: any) {
      if (String(e?.message) === "E2E_TOO_BIG") Alert.alert("Too large to encrypt", "Encrypted photos/videos must be under ~5 MB.");
    } finally { setSending(false); }
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
        audio_base64: await maybeEncrypt(dataUri),
        audio_duration_ms: elapsed,
      });
      if (e2eRecipients()) setBlobs((b) => ({ ...b, [`v:${msg.id}`]: dataUri }));
      setMessages((m) => [...m, msg]);
    } catch (e: any) {
      if (String(e?.message) === "E2E_TOO_BIG") Alert.alert("Too large to encrypt", "Encrypted voice notes must be under ~5 MB.");
    } finally {
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
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="chat-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text style={styles.title} numberOfLines={1}>{convName || name || "Chat"}</Text>
          {disappearSecs > 0 ? (
            <View style={styles.encRow}>
              <Ionicons name="timer-outline" size={11} color={theme.primary} />
              <Text style={[styles.encText, { color: theme.primary }]}>Disappears after {disappearLabel(disappearSecs)}</Text>
            </View>
          ) : presence.typing ? (
            <Text style={[styles.encText, { color: theme.primary }]}>writing…</Text>
          ) : presence.active ? (
            <View style={styles.encRow}>
              <View style={styles.activeDot} />
              <Text style={[styles.encText, { color: "#22C55E" }]}>active now</Text>
            </View>
          ) : (
            <View style={styles.encRow}>
              <Ionicons name={(peerKey || groupE2E) ? "lock-closed" : "lock-closed-outline"} size={10} color={(peerKey || groupE2E) ? theme.primary : theme.textMuted} />
              <Text style={[styles.encText, (peerKey || groupE2E) && { color: theme.primary }]}>
                {(peerKey || groupE2E) ? "End-to-end encrypted" : "Encrypted"}
              </Text>
            </View>
          )}
        </View>
        <TouchableOpacity onPress={() => setSearchOpen((v) => !v)} style={styles.iconBtn} testID="chat-search-toggle">
          <Ionicons name="search" size={19} color={theme.textPrimary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => { api.ringCall(String(id)).catch(() => {}); router.push({ pathname: "/call/[id]", params: { id: String(id), name: name || "Call" } }); }}
          style={styles.iconBtn}
          testID="chat-call"
        >
          <Ionicons name="call" size={20} color={theme.primary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => { api.ringCall(String(id)).catch(() => {}); router.push({ pathname: "/call/[id]", params: { id: String(id), name: name || "Call", video: "1" } }); }}
          style={styles.iconBtn}
          testID="chat-video"
        >
          <Ionicons name="videocam" size={20} color={theme.primary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setOptionsOpen(true)} style={styles.iconBtn} testID="chat-options">
          <Ionicons name="ellipsis-horizontal" size={22} color={theme.textPrimary} />
        </TouchableOpacity>
      </View>

      {searchOpen && (
        <View style={styles.searchBar}>
          <Ionicons name="search" size={16} color={theme.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={searchQ}
            onChangeText={setSearchQ}
            placeholder="Search in this chat"
            placeholderTextColor={theme.textMuted}
            autoFocus
            testID="chat-search-input"
          />
          {!!searchQ.trim() && (
            <Text style={styles.searchCount}>{matches.length ? `${matchPos + 1}/${matches.length}` : "0"}</Text>
          )}
          <TouchableOpacity onPress={() => goMatch(-1)} disabled={!matches.length} hitSlop={6}>
            <Ionicons name="chevron-up" size={18} color={matches.length ? theme.textPrimary : theme.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => goMatch(1)} disabled={!matches.length} hitSlop={6}>
            <Ionicons name="chevron-down" size={18} color={matches.length ? theme.textPrimary : theme.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setSearchOpen(false); setSearchQ(""); }} hitSlop={6} testID="chat-search-close">
            <Ionicons name="close" size={18} color={theme.textMuted} />
          </TouchableOpacity>
        </View>
      )}

      {(showRestore || showBackup) && (
        <TouchableOpacity
          style={styles.keyBanner}
          activeOpacity={0.85}
          onPress={() => (showRestore ? setUnlockOpen(true) : router.push("/encryption-key"))}
          testID="chat-key-banner"
        >
          <Ionicons name={showRestore ? "lock-closed" : "key-outline"} size={16} color={theme.primary} />
          <Text style={styles.keyBannerText} numberOfLines={2}>
            {showRestore
              ? `${lockedCount} message${lockedCount === 1 ? "" : "s"} locked on this device. Tap to enter your PIN and unlock.`
              : "Set a PIN to back up your encryption key so you never lose your messages."}
          </Text>
          <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
        </TouchableOpacity>
      )}

      <Modal visible={optionsOpen} transparent animationType="fade" onRequestClose={() => setOptionsOpen(false)}>
        <TouchableOpacity style={styles.optBackdrop} activeOpacity={1} onPress={() => setOptionsOpen(false)}>
          <View style={styles.optSheet}>
            {isGroup && (
              <TouchableOpacity
                style={styles.optRow}
                onPress={() => { setOptionsOpen(false); setRenameText(convName); setRenameOpen(true); }}
                testID="chat-rename"
              >
                <Ionicons name="pencil-outline" size={20} color={theme.textPrimary} />
                <Text style={styles.optText}>Change group name</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.optRow}
              onPress={() => { setOptionsOpen(false); setThemeOpen(true); }}
              testID="chat-theme"
            >
              <Ionicons name="color-palette-outline" size={20} color={theme.textPrimary} />
              <Text style={styles.optText}>Theme</Text>
              <View style={[styles.themeDot, { backgroundColor: themeColors.bubble }]} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.optRow}
              onPress={() => { setOptionsOpen(false); setGalleryOpen(true); }}
              testID="chat-shared-media"
            >
              <Ionicons name="images-outline" size={20} color={theme.textPrimary} />
              <Text style={styles.optText}>Shared media, files &amp; links</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.optRow} onPress={summarizeChat} testID="chat-summarize">
              <Ionicons name="sparkles-outline" size={20} color={theme.primary} />
              <Text style={styles.optText}>Summarize chat (AI)</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.optRow}
              onPress={() => { setOptionsOpen(false); setDisappearOpen(true); }}
              testID="chat-disappearing"
            >
              <Ionicons name="timer-outline" size={20} color={theme.textPrimary} />
              <Text style={styles.optText}>Disappearing messages</Text>
              <Text style={styles.optValue}>{disappearLabel(disappearSecs)}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.optRow} onPress={toggleReceipts} testID="chat-receipts">
              <Ionicons name={receiptsOn ? "checkmark-done-outline" : "eye-off-outline"} size={20} color={theme.textPrimary} />
              <Text style={styles.optText}>Read receipts</Text>
              <Text style={styles.optValue}>{receiptsOn ? "On" : "Off"}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.optRow} onPress={clearConvo} testID="chat-clear">
              <Ionicons name="trash-outline" size={20} color={theme.error} />
              <Text style={[styles.optText, { color: theme.error }]}>Clear conversation</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Theme picker */}
      <Modal visible={themeOpen} transparent animationType="fade" onRequestClose={() => setThemeOpen(false)}>
        <TouchableOpacity style={styles.optBackdrop} activeOpacity={1} onPress={() => setThemeOpen(false)}>
          <View style={styles.pickSheet}>
            <Text style={styles.pickTitle}>Conversation theme</Text>
            <View style={styles.swatchWrap}>
              {THEME_KEYS.map((key) => {
                const t = CHAT_THEMES[key];
                const active = key === convTheme;
                return (
                  <TouchableOpacity
                    key={key}
                    style={styles.swatchItem}
                    onPress={() => applyTheme(key)}
                    testID={`theme-${key}`}
                  >
                    <View style={[styles.swatch, { backgroundColor: t.bubble, borderColor: active ? theme.textPrimary : theme.border, borderWidth: active ? 3 : 1 }]}>
                      {active && <Ionicons name="checkmark" size={18} color="#fff" />}
                    </View>
                    <Text style={styles.swatchLabel}>{t.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Shared media / files / links gallery */}
      <Modal visible={galleryOpen} animationType="slide" onRequestClose={() => setGalleryOpen(false)}>
        <SafeAreaView edges={["top"]} style={styles.galRoot}>
          <View style={styles.galHeader}>
            <Text style={styles.galTitle}>Shared content</Text>
            <TouchableOpacity onPress={() => setGalleryOpen(false)} hitSlop={8} testID="gallery-close">
              <Ionicons name="close" size={24} color={theme.textPrimary} />
            </TouchableOpacity>
          </View>
          {(() => {
            const media: { uri: string; type: string; msgId: string }[] = [];
            const files: Message[] = [];
            const links: { url: string; msgId: string }[] = [];
            const urlRe = /(https?:\/\/[^\s]+)/gi;
            messages.forEach((m) => {
              if (m.deleted) return;
              if (m.type === "media") {
                (m.media || []).forEach((mm, i) => {
                  const resolved: any = isE2EMedia(mm.base64 || "") ? { ...mm, base64: blobs[`m:${m.id}:${i}`] } : mm;
                  const uri = mediaUri(resolved);
                  if (uri) media.push({ uri, type: mm.type, msgId: m.id });
                });
              } else if (m.type === "file") {
                files.push(m);
              }
              const found = plainOf(m).match(urlRe);
              if (found) found.forEach((u) => links.push({ url: u, msgId: m.id }));
            });
            const empty = !media.length && !files.length && !links.length;
            return (
              <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 24 }}>
                {empty && <Text style={styles.galEmpty}>No media, files or links shared yet.</Text>}
                {media.length > 0 && (
                  <>
                    <Text style={styles.galSection}>Media · {media.length}</Text>
                    <View style={styles.galGrid}>
                      {media.map((it, i) => (
                        <TouchableOpacity
                          key={i}
                          style={styles.galTile}
                          activeOpacity={0.85}
                          onPress={() => {
                            if (it.type === "video") { setGalleryOpen(false); const mm = messages.find((x) => x.id === it.msgId); if (mm) jumpToMessage(mm); }
                            else setGalleryLb(it.uri);
                          }}
                        >
                          <Image source={{ uri: it.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                          {it.type === "video" && <View style={styles.galVideo}><Ionicons name="play" size={18} color="#fff" /></View>}
                        </TouchableOpacity>
                      ))}
                    </View>
                  </>
                )}
                {files.length > 0 && (
                  <>
                    <Text style={styles.galSection}>Files · {files.length}</Text>
                    {files.map((m) => (
                      <TouchableOpacity key={m.id} style={styles.galRow} onPress={() => { setGalleryOpen(false); jumpToMessage(m); }}>
                        <Ionicons name="document-outline" size={20} color={theme.primary} />
                        <Text style={styles.galRowText} numberOfLines={1}>{m.file_name || "File"}</Text>
                        {!!m.file_size && <Text style={styles.galRowSub}>{(m.file_size / 1024 / 1024).toFixed(1)}MB</Text>}
                      </TouchableOpacity>
                    ))}
                  </>
                )}
                {links.length > 0 && (
                  <>
                    <Text style={styles.galSection}>Links · {links.length}</Text>
                    {links.map((l, i) => (
                      <TouchableOpacity key={i} style={styles.galRow} onPress={() => Linking.openURL(l.url).catch(() => {})}>
                        <Ionicons name="link-outline" size={20} color={theme.primary} />
                        <Text style={[styles.galRowText, { color: theme.primary }]} numberOfLines={1}>{l.url}</Text>
                      </TouchableOpacity>
                    ))}
                  </>
                )}
              </ScrollView>
            );
          })()}
        </SafeAreaView>
      </Modal>

      <Modal visible={!!galleryLb} transparent animationType="fade" onRequestClose={() => setGalleryLb(null)}>
        <TouchableOpacity style={styles.galLb} activeOpacity={1} onPress={() => setGalleryLb(null)}>
          {!!galleryLb && <Image source={{ uri: galleryLb }} style={{ width: "94%", height: "80%" }} resizeMode="contain" />}
        </TouchableOpacity>
      </Modal>

      <Modal visible={summaryOpen} transparent animationType="fade" onRequestClose={() => setSummaryOpen(false)}>
        <View style={styles.sumBackdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setSummaryOpen(false)} />
          <View style={styles.sumCard}>
            <View style={styles.sumHead}>
              <Ionicons name="sparkles" size={16} color={theme.primary} />
              <Text style={styles.sumTitle}>Chat summary</Text>
            </View>
            {summarizing ? (
              <View style={{ paddingVertical: 28, alignItems: "center" }}>
                <ActivityIndicator color={theme.primary} />
                <Text style={styles.sumMuted}>Summarizing…</Text>
              </View>
            ) : (
              <ScrollView style={{ maxHeight: 360 }}><Text style={styles.sumText}>{summary}</Text></ScrollView>
            )}
            <Text style={styles.sumMuted}>AI-generated from this chat. Not stored.</Text>
            <TouchableOpacity style={styles.sumDone} onPress={() => setSummaryOpen(false)}>
              <Text style={styles.sumDoneText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Disappearing messages picker */}
      <Modal visible={disappearOpen} transparent animationType="fade" onRequestClose={() => setDisappearOpen(false)}>
        <TouchableOpacity style={styles.optBackdrop} activeOpacity={1} onPress={() => setDisappearOpen(false)}>
          <View style={styles.pickSheet}>
            <Text style={styles.pickTitle}>Disappearing messages</Text>
            <Text style={styles.pickSub}>New messages vanish for everyone after the chosen time.</Text>
            {DISAPPEAR_OPTIONS.map((o) => (
              <TouchableOpacity
                key={o.seconds}
                style={styles.optRow}
                onPress={() => applyDisappear(o.seconds)}
                testID={`disappear-${o.seconds}`}
              >
                <Ionicons
                  name={o.seconds === disappearSecs ? "radio-button-on" : "radio-button-off"}
                  size={20}
                  color={o.seconds === disappearSecs ? theme.primary : theme.textMuted}
                />
                <Text style={styles.optText}>{o.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Group rename */}
      <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}>
        <TouchableOpacity style={styles.optBackdrop} activeOpacity={1} onPress={() => setRenameOpen(false)}>
          <View style={styles.pickSheet} onStartShouldSetResponder={() => true}>
            <Text style={styles.pickTitle}>Group name</Text>
            <TextInput
              style={styles.renameInput}
              value={renameText}
              onChangeText={setRenameText}
              placeholder="Group name"
              placeholderTextColor={theme.textMuted}
              maxLength={80}
              autoFocus
              testID="rename-input"
            />
            <View style={styles.renameBtns}>
              <TouchableOpacity style={styles.renameCancel} onPress={() => setRenameOpen(false)}>
                <Text style={styles.renameCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.renameSave, !renameText.trim() && { opacity: 0.5 }]} onPress={saveGroupName} disabled={!renameText.trim()} testID="rename-save">
                <Text style={styles.renameSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 50 : 0}
        style={{ flex: 1 }}
      >
        {(() => {
          const pins = messages.filter((m) => m.pinned && !m.deleted);
          if (pins.length === 0) return null;
          const top = pins[pins.length - 1];
          return (
            <TouchableOpacity style={styles.pinBanner} activeOpacity={0.85} onPress={() => jumpToMessage(top)} testID="pinned-banner">
              <Ionicons name="bookmark" size={13} color={theme.primary} />
              <Text style={styles.pinBannerText} numberOfLines={1}>
                {pins.length > 1 ? `${pins.length} pinned · ` : "Pinned · "}{previewOf(top)}
              </Text>
              <Ionicons name="chevron-forward" size={14} color={theme.textMuted} />
            </TouchableOpacity>
          );
        })()}
        {loading ? (
          <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(i) => i.id}
            onScrollToIndexFailed={() => { try { listRef.current?.scrollToEnd({ animated: true }); } catch {} }}
            style={{ backgroundColor: themeColors.bg }}
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
                      mine && !item.deleted && { backgroundColor: themeColors.bubble },
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
                      (() => {
                        const uri = isE2EMedia(item.audio_base64 || "") ? blobs[`v:${item.id}`] : item.audio_base64;
                        const tx = transcripts[item.id] || item.transcript || "";
                        return uri ? (
                          <View>
                            <VoiceMessage uri={uri} durationMs={item.audio_duration_ms} mine={mine} testID={`voice-msg-${item.id}`} />
                            {tx ? (
                              <Text style={[styles.transcriptText, mine && { color: "rgba(255,255,255,0.9)", borderTopColor: "rgba(255,255,255,0.25)" }]} testID={`transcript-${item.id}`}>
                                {tx}
                              </Text>
                            ) : (
                              <TouchableOpacity
                                style={styles.transcribeBtn}
                                onPress={() => transcribeVoice(item)}
                                disabled={transcribingId === item.id}
                                testID={`transcribe-${item.id}`}
                              >
                                {transcribingId === item.id ? (
                                  <ActivityIndicator size="small" color={mine ? "#fff" : theme.primary} />
                                ) : (
                                  <>
                                    <Ionicons name="text" size={13} color={mine ? "rgba(255,255,255,0.9)" : theme.primary} />
                                    <Text style={[styles.transcribeText, mine && { color: "rgba(255,255,255,0.9)" }]}>Transcribe</Text>
                                  </>
                                )}
                              </TouchableOpacity>
                            )}
                          </View>
                        ) : (
                          <View style={styles.sharedLoading}><ActivityIndicator color={mine ? "#fff" : theme.primary} size="small" /></View>
                        );
                      })()
                    ) : item.type === "media" && (item.media || []).length > 0 ? (
                      (() => {
                        const arr = (item.media || []).map((mm, i) =>
                          isE2EMedia(mm.base64 || "") ? { ...mm, base64: blobs[`m:${item.id}:${i}`] } : mm);
                        const ready = arr.every((mm) => mm.url || mm.base64 !== undefined);
                        return ready ? (
                          <View style={styles.mediaWrap}>
                            <MediaGrid media={arr as any} testID={`msg-${item.id}`} />
                          </View>
                        ) : (
                          <View style={styles.sharedLoading}><ActivityIndicator color={mine ? "#fff" : theme.primary} size="small" /></View>
                        );
                      })()
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
                        onPress={() => {
                          const u = isE2EMedia(item.file_base64 || "") ? blobs[`f:${item.id}`] : item.file_base64;
                          if (u) Linking.openURL(u).catch(() => {});
                        }}
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
                    ) : item.type === "poll" ? (
                      (() => {
                        const opts = item.poll_options || [];
                        const votes = item.poll_votes || {};
                        const counts = opts.map((_, i) => Object.values(votes).filter((v) => v === i).length);
                        const total = counts.reduce((a, b) => a + b, 0);
                        const myVote = user?.user_id ? votes[user.user_id] : undefined;
                        return (
                          <View style={styles.pollCard}>
                            <View style={styles.pollHead}>
                              <Ionicons name="stats-chart" size={15} color={mine ? "#fff" : theme.primary} />
                              <Text style={[styles.pollQuestion, mine && { color: "#fff" }]} numberOfLines={4}>
                                {item.poll_question || "Poll"}
                              </Text>
                            </View>
                            {opts.map((opt, i) => {
                              const pct = total > 0 ? Math.round((counts[i] / total) * 100) : 0;
                              const picked = myVote === i;
                              return (
                                <TouchableOpacity
                                  key={i}
                                  activeOpacity={0.8}
                                  style={styles.pollOpt}
                                  onPress={() => votePollMessage(item, i)}
                                  testID={`poll-opt-${item.id}-${i}`}
                                >
                                  <View style={[styles.pollBar, mine ? styles.pollBarMine : styles.pollBarOther, { width: `${pct}%` }]} />
                                  <View style={styles.pollOptRow}>
                                    <Ionicons
                                      name={picked ? "checkmark-circle" : "ellipse-outline"}
                                      size={16}
                                      color={mine ? "#fff" : picked ? theme.primary : theme.textMuted}
                                    />
                                    <Text style={[styles.pollOptText, mine && { color: "#fff" }]} numberOfLines={2}>{opt}</Text>
                                    <Text style={[styles.pollPct, mine && { color: "rgba(255,255,255,0.85)" }]}>{pct}%</Text>
                                  </View>
                                </TouchableOpacity>
                              );
                            })}
                            <Text style={[styles.pollTotal, mine && { color: "rgba(255,255,255,0.7)" }]}>
                              {total} {total === 1 ? "vote" : "votes"}
                            </Text>
                          </View>
                        );
                      })()
                    ) : item.type === "form" ? (
                      <TouchableOpacity
                        style={styles.formCard}
                        onPress={() => item.form_key && router.push({ pathname: "/f/[key]", params: { key: item.form_key } })}
                        testID={`form-msg-${item.id}`}
                      >
                        <View style={styles.formIcon}><Ionicons name="document-text" size={20} color="#fff" /></View>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.formTitle, mine && { color: "#fff" }]} numberOfLines={2}>{item.form_title || "Form"}</Text>
                          <Text style={[styles.formSub, mine && { color: "rgba(255,255,255,0.8)" }]}>Tap to open & fill out</Text>
                        </View>
                        <Ionicons name="chevron-forward" size={18} color={mine ? "rgba(255,255,255,0.8)" : theme.textMuted} />
                      </TouchableOpacity>
                    ) : (
                      <View>
                        <EmojiText text={bodyText} emojis={emojiMap} style={[styles.bubbleText, mine && { color: "#fff" }]} />
                        {!encrypted && !!item.link_preview && (
                          <LinkPreviewCard preview={item.link_preview as any} />
                        )}
                        {scamCheckingId === item.id && (
                          <View style={styles.scamChecking}>
                            <ActivityIndicator size="small" color={mine ? "#fff" : theme.primary} />
                            <Text style={[styles.scamCheckingText, mine && { color: "rgba(255,255,255,0.9)" }]}>Checking…</Text>
                          </View>
                        )}
                        {scamResults[item.id] && (() => {
                          const r = scamResults[item.id];
                          const high = r.risk === "high", med = r.risk === "medium";
                          if (!high && !med) {
                            return (
                              <View style={[styles.scamBanner, { backgroundColor: "rgba(34,197,94,0.14)", borderColor: "rgba(34,197,94,0.4)" }]}>
                                <Ionicons name="shield-checkmark" size={14} color="#16A34A" />
                                <Text style={styles.scamSafeText}>Looks safe{r.reason ? ` — ${r.reason}` : ""}</Text>
                              </View>
                            );
                          }
                          return (
                            <View style={[styles.scamBanner, { backgroundColor: high ? "rgba(239,68,68,0.16)" : "rgba(245,158,11,0.16)", borderColor: high ? "rgba(239,68,68,0.5)" : "rgba(245,158,11,0.5)" }]}>
                              <Ionicons name="warning" size={14} color={high ? "#DC2626" : "#D97706"} />
                              <Text style={[styles.scamWarnText, { color: high ? "#DC2626" : "#B45309" }]}>
                                {high ? "Likely scam" : "Possibly suspicious"}{r.reason ? ` — ${r.reason}` : ""}
                              </Text>
                            </View>
                          );
                        })()}
                      </View>
                    )}
                  </TouchableOpacity>
                  {!!reactionSummary(item) && !item.deleted && (
                    <TouchableOpacity
                      style={[styles.reactionBadge, mine ? styles.reactionBadgeMine : styles.reactionBadgeOther]}
                      onPress={() => toggleReaction(item)}
                      testID={`react-chip-${item.id}`}
                    >
                      <Text style={styles.reactionBadgeText}>{reactionSummary(item)}</Text>
                    </TouchableOpacity>
                  )}
                  {revealedId === item.id && (
                    <View style={[styles.metaRow, mine ? { justifyContent: "flex-end" } : { justifyContent: "flex-start" }]}>
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
                      {mine && !item.deleted && (() => {
                        const s = statusFor(item);
                        return <Text style={[styles.statusLabel, s.read && { color: "#53BDEB" }]}>{s.text}</Text>;
                      })()}
                    </View>
                  )}
                </View>
              );
            }}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyText}>Say hi to start the conversation 👋</Text>
              </View>
            }
            ListFooterComponent={presence.typing ? <TypingBubble /> : null}
          />
        )}

        <View>
          {/* Attachment picker — a clean bottom sheet (tap the + button). */}
          <Modal visible={attachOpen && !recording} transparent animationType="slide" onRequestClose={() => setAttachOpen(false)}>
            <View style={styles.attachSheetBackdrop}>
              <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setAttachOpen(false)} testID="attach-backdrop" />
              <View style={[styles.attachSheet, { paddingBottom: insets.bottom + 18 }]}>
                <View style={styles.attachHandle} />
                <View style={styles.attachGrid}>
                  {[
                    { key: "photo", label: "Photo & Video", icon: "image", color: "#8E5CF7", onPress: () => { setAttachOpen(false); sendMedia(); } },
                    { key: "location", label: "Location", icon: "location", color: "#23B26D", busy: sharingLocation, onPress: () => { setAttachOpen(false); shareLocation(); } },
                    { key: "gif", label: "GIF", icon: "film", color: "#EC4899", onPress: () => { setAttachOpen(false); setGifOpen(true); } },
                    { key: "file", label: "File", icon: "document", color: "#F59E0B", onPress: () => { setAttachOpen(false); pickFile(); } },
                    { key: "contact", label: "Contact", icon: "person", color: "#3B82F6", onPress: () => { setAttachOpen(false); setContactOpen(true); } },
                    { key: "form", label: "Form", icon: "document-text", color: "#0EA5A0", onPress: () => { setAttachOpen(false); setFormOpen(true); } },
                    { key: "poll", label: "Poll", icon: "stats-chart", color: "#6366F1", onPress: () => { setAttachOpen(false); openPoll(); } },
                    ...(peer ? [{ key: "tip", label: "Send tip", icon: "cash", color: theme.primary, onPress: () => { setAttachOpen(false); setTipOpen(true); } }] : []),
                  ].map((t: any) => (
                    <TouchableOpacity key={t.key} style={styles.attachTile} onPress={t.onPress} disabled={sending} testID={`attach-${t.key}`}>
                      <View style={[styles.attachTileIcon, { backgroundColor: t.color }]}>
                        {t.busy ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name={t.icon} size={24} color="#fff" />}
                      </View>
                      <Text style={styles.attachTileLabel}>{t.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>
          </Modal>

          {scheduledList.length > 0 && !editingMsg && !recording && (
            <TouchableOpacity style={styles.editBanner} onPress={() => setScheduledOpen(true)} testID="scheduled-banner">
              <Ionicons name="time-outline" size={16} color={theme.primary} />
              <Text style={styles.editBannerText} numberOfLines={1}>
                {scheduledList.length} scheduled message{scheduledList.length === 1 ? "" : "s"}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
            </TouchableOpacity>
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

          <RestrictionBanner kind="messaging" style={{ marginHorizontal: 10, marginBottom: 0 }} />

          <View
            style={[styles.composer, { paddingBottom: insets.bottom + 10 }, msgOff && { opacity: 0.45 }]}
            pointerEvents={msgOff ? "none" : "auto"}
          >
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
                  onPress={() => {
                    // Keyboard.dismiss() is a no-op on web — blur the focused
                    // input explicitly so the on-screen keyboard drops before the
                    // emoji sheet opens (otherwise it overlaps the picker).
                    Keyboard.dismiss();
                    if (Platform.OS === "web" && typeof document !== "undefined") {
                      (document.activeElement as any)?.blur?.();
                    }
                    setAttachOpen(false);
                    setEmojiOpen(true);
                  }}
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
                  onChangeText={onChangeText}
                  onFocus={() => setAttachOpen(false)}
                  multiline
                  numberOfLines={Platform.OS === "web" ? 1 : undefined}
                  testID="msg-input"
                />
                {text.trim() || editingMsg ? (
                  <TouchableOpacity
                    style={[styles.sendBtn, sending && { opacity: 0.5 }]}
                    onPress={send}
                    onLongPress={editingMsg ? undefined : openSchedule}
                    delayLongPress={350}
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
        onPick={(ins) => setText((t) => `${t}${ins}`)}
        onChanged={loadEmojis}
        text={text}
        onChangeText={onChangeText}
        onSend={send}
      />
      <GifPickerSheet visible={gifOpen} onClose={() => setGifOpen(false)} onPick={sendGif} />
      <ContactPickerSheet visible={contactOpen} onClose={() => setContactOpen(false)} onPick={sendContact} />
      <FormPickerSheet visible={formOpen} onClose={() => setFormOpen(false)} onPick={sendForm} />
      <Modal visible={pollOpen} transparent animationType="slide" onRequestClose={() => setPollOpen(false)}>
        <View style={styles.pollSheetWrap}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setPollOpen(false)} testID="poll-backdrop" />
          <View style={[styles.pollSheet, { paddingBottom: insets.bottom + 18 }]}>
            <View style={styles.attachHandle} />
            <Text style={styles.pollSheetTitle}>Create poll</Text>
            <TextInput
              style={styles.pollInput}
              placeholder="Ask a question…"
              placeholderTextColor={theme.textMuted}
              value={pollQ}
              onChangeText={setPollQ}
              maxLength={200}
              testID="poll-question"
            />
            {pollOpts.map((opt, i) => (
              <View key={i} style={styles.pollInputRow}>
                <TextInput
                  style={[styles.pollInput, { flex: 1, marginBottom: 0 }]}
                  placeholder={`Option ${i + 1}`}
                  placeholderTextColor={theme.textMuted}
                  value={opt}
                  onChangeText={(v) => setPollOpts((o) => o.map((x, j) => (j === i ? v : x)))}
                  maxLength={100}
                  testID={`poll-option-${i}`}
                />
                {pollOpts.length > 2 && (
                  <TouchableOpacity
                    onPress={() => setPollOpts((o) => o.filter((_, j) => j !== i))}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    testID={`poll-remove-${i}`}
                  >
                    <Ionicons name="close-circle" size={22} color={theme.textMuted} />
                  </TouchableOpacity>
                )}
              </View>
            ))}
            {pollOpts.length < 6 && (
              <TouchableOpacity style={styles.pollAddOpt} onPress={() => setPollOpts((o) => [...o, ""])} testID="poll-add-option">
                <Ionicons name="add-circle-outline" size={18} color={theme.primary} />
                <Text style={[styles.pollAddOptText, { color: theme.primary }]}>Add option</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.pollSendBtn, { backgroundColor: theme.primary }, (pollSending || !pollQ.trim() || pollOpts.filter((o) => o.trim()).length < 2) && { opacity: 0.5 }]}
              onPress={sendPoll}
              disabled={pollSending || !pollQ.trim() || pollOpts.filter((o) => o.trim()).length < 2}
              testID="poll-send"
            >
              {pollSending ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.pollSendText}>Send poll</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Schedule a message for later */}
      <Modal visible={scheduleOpen} transparent animationType="slide" onRequestClose={() => setScheduleOpen(false)}>
        <View style={styles.pollSheetWrap}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setScheduleOpen(false)} testID="schedule-backdrop" />
          <View style={[styles.pollSheet, { paddingBottom: insets.bottom + 18 }]}>
            <View style={styles.attachHandle} />
            <Text style={styles.pollSheetTitle}>Schedule message</Text>
            <TextInput
              style={[styles.pollInput, { minHeight: 70, textAlignVertical: "top" }]}
              placeholder="Message to send later…"
              placeholderTextColor={theme.textMuted}
              value={scheduleText}
              onChangeText={setScheduleText}
              multiline
              maxLength={2000}
              testID="schedule-text"
            />
            <Text style={styles.scheduleLabel}>When</Text>
            <View style={styles.scheduleChips}>
              {[
                { label: "In 1 hour", ms: 60 * 60 * 1000 },
                { label: "In 3 hours", ms: 3 * 60 * 60 * 1000 },
                { label: "Tonight 8 PM", at: () => { const d = new Date(); d.setHours(20, 0, 0, 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); return d; } },
                { label: "Tomorrow 9 AM", at: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
              ].map((p: any) => {
                const target = p.at ? p.at() : new Date(Date.now() + p.ms);
                const active = scheduleAt && Math.abs(scheduleAt.getTime() - target.getTime()) < 60 * 1000;
                return (
                  <TouchableOpacity
                    key={p.label}
                    style={[styles.scheduleChip, active && styles.scheduleChipActive]}
                    onPress={() => setScheduleAt(target)}
                    testID={`schedule-chip-${p.label}`}
                  >
                    <Text style={[styles.scheduleChipText, active && { color: "#fff" }]}>{p.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={styles.scheduleCustomRow}>
              <TouchableOpacity
                style={styles.scheduleStep}
                onPress={() => setScheduleAt((d) => new Date((d?.getTime() || Date.now()) - 15 * 60 * 1000))}
                testID="schedule-minus"
              >
                <Ionicons name="remove" size={18} color={theme.primary} />
              </TouchableOpacity>
              <Text style={styles.scheduleWhen} testID="schedule-when">
                {scheduleAt
                  ? scheduleAt.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
                  : "Pick a time"}
              </Text>
              <TouchableOpacity
                style={styles.scheduleStep}
                onPress={() => setScheduleAt((d) => new Date((d?.getTime() || Date.now()) + 15 * 60 * 1000))}
                testID="schedule-plus"
              >
                <Ionicons name="add" size={18} color={theme.primary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.scheduleHint}>Use −/+ to adjust by 15 minutes.</Text>
            <TouchableOpacity
              style={[styles.pollSendBtn, { backgroundColor: theme.primary }, (scheduling || !scheduleText.trim() || !scheduleAt || (scheduleAt?.getTime() || 0) <= Date.now() + 60 * 1000) && { opacity: 0.5 }]}
              onPress={sendScheduled}
              disabled={scheduling || !scheduleText.trim() || !scheduleAt || (scheduleAt?.getTime() || 0) <= Date.now() + 60 * 1000}
              testID="schedule-send"
            >
              {scheduling ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.pollSendText}>Schedule</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Manage pending scheduled messages */}
      <Modal visible={scheduledOpen} transparent animationType="slide" onRequestClose={() => setScheduledOpen(false)}>
        <View style={styles.pollSheetWrap}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setScheduledOpen(false)} testID="scheduled-list-backdrop" />
          <View style={[styles.pollSheet, { paddingBottom: insets.bottom + 18 }]}>
            <View style={styles.attachHandle} />
            <Text style={styles.pollSheetTitle}>Scheduled messages</Text>
            {scheduledList.length === 0 ? (
              <Text style={styles.scheduleHint}>Nothing scheduled.</Text>
            ) : (
              scheduledList.map((s) => (
                <View key={s.id} style={styles.scheduledRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.scheduledRowText} numberOfLines={2}>
                      {s.type === "poll" ? `📊 ${s.poll_question || "Poll"}` : s.text ? s.text : s.type === "text" ? "🔒 Encrypted message" : `📎 ${s.type}`}
                    </Text>
                    <Text style={styles.scheduledRowTime}>
                      {new Date(s.send_at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => cancelScheduled(s.id)} testID={`schedule-cancel-${s.id}`} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="trash-outline" size={20} color={theme.error} />
                  </TouchableOpacity>
                </View>
              ))
            )}
          </View>
        </View>
      </Modal>
      <UnlockChatSheet
        visible={unlockOpen}
        onClose={() => setUnlockOpen(false)}
        onUnlocked={() => setKeyVersion((v) => v + 1)}
      />
      <FakePaymentSheet
        visible={tipOpen}
        title={`Tip ${peer?.name || "this user"}`}
        subtitle="Enter what they receive"
        amount={5}
        editableAmount
        allowNote
        appleFee
        live={payEnabled}
        onCheckout={payEnabled && peer ? (amt, note) =>
          stripeCardPay({ kind: "tip", creator_id: peer.id, amount: amt, extra: { conversation_id: id, note } }) : undefined}
        onWalletFallback={peer ? (amt, note) =>
          router.push(`/pay/${peer.id}?amount=${amt}&note=${encodeURIComponent(note || "")}`) : undefined}
        walletBalance={walletBal ?? undefined}
        onPayWallet={peer ? async (amt, note) => { await api.payFromWallet({ kind: "tip", creator_id: peer.id, amount: amt, note, conversation_id: id }); await load(); } : undefined}
        onTopUp={() => router.push("/wallet")}
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
            {actionMsg && !actionMsg.deleted && (
              <TouchableOpacity
                style={styles.actionRow}
                onPress={() => { const m = actionMsg; togglePin(m); }}
                testID="msg-action-pin"
              >
                <Ionicons name={actionMsg.pinned ? "bookmark" : "bookmark-outline"} size={18} color={theme.primary} />
                <Text style={styles.actionRowText}>{actionMsg.pinned ? "Unpin" : "Pin"}</Text>
              </TouchableOpacity>
            )}
            {actionMsg && (actionMsg.type === "text" || actionMsg.type === "post") && plainOf(actionMsg).length > 0 && (
              <TouchableOpacity style={styles.actionRow} onPress={() => copyMessage(actionMsg)} testID="msg-action-copy">
                <Ionicons name="copy-outline" size={18} color={theme.textPrimary} />
                <Text style={styles.actionRowText}>Copy</Text>
              </TouchableOpacity>
            )}
            {actionMsg && actionMsg.sender_id !== user?.user_id && actionMsg.type === "text" && plainOf(actionMsg).length > 0 && (
              <TouchableOpacity
                style={styles.actionRow}
                onPress={() => { const m = actionMsg; setActionMsg(null); runScamCheck(m); }}
                testID="msg-action-scamcheck"
              >
                <Ionicons name="shield-checkmark-outline" size={18} color={theme.primary} />
                <Text style={styles.actionRowText}>Check for scam (AI)</Text>
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

// Animated "…" typing bubble shown at the bottom of the thread (Snapchat-style).
function TypingBubble() {
  const dots = [useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current];
  useEffect(() => {
    const loops = dots.map((d, i) =>
      Animated.loop(Animated.sequence([
        Animated.delay(i * 160),
        Animated.timing(d, { toValue: 1, duration: 320, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(d, { toValue: 0, duration: 320, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.delay((dots.length - i) * 160),
      ])),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, []);
  return (
    <View style={[styles.bubbleRow, styles.bubbleRowOther]} testID="typing-bubble">
      <View style={[styles.bubble, styles.bubbleOther, styles.typingBubble]}>
        {dots.map((d, i) => (
          <Animated.View
            key={i}
            style={[styles.typingDot, {
              opacity: d.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
              transform: [{ translateY: d.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) }],
            }]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  optBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  optSheet: { position: "absolute", top: 56, right: 10, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, paddingVertical: 6, minWidth: 210, shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
  optRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  optText: { fontSize: 15, fontWeight: "700", color: theme.textPrimary, flexShrink: 1 },
  optValue: { marginLeft: "auto", color: theme.textMuted, fontSize: 13, fontWeight: "700" },
  themeDot: { marginLeft: "auto", width: 18, height: 18, borderRadius: 9, borderWidth: 1, borderColor: theme.border },
  pickSheet: { position: "absolute", left: 18, right: 18, top: "30%", backgroundColor: theme.surface, borderRadius: 18, borderWidth: 1, borderColor: theme.border, padding: 18, shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 10 },
  pickTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800", marginBottom: 6 },
  pickSub: { color: theme.textMuted, fontSize: 13, lineHeight: 18, marginBottom: 10 },
  swatchWrap: { flexDirection: "row", flexWrap: "wrap", gap: 14, paddingTop: 6 },
  swatchItem: { alignItems: "center", width: 64, gap: 6 },
  swatch: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
  swatchLabel: { color: theme.textSecondary, fontSize: 12, fontWeight: "600" },
  renameInput: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: theme.textPrimary, fontSize: 15, marginTop: 4 },
  renameBtns: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 14 },
  renameCancel: { paddingHorizontal: 16, paddingVertical: 10 },
  renameCancelText: { color: theme.textMuted, fontSize: 15, fontWeight: "700" },
  renameSave: { backgroundColor: theme.primary, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10 },
  renameSaveText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "700", textAlign: "center" },
  encRow: { flexDirection: "row", alignItems: "center", gap: 3, marginTop: 1 },
  encText: { color: theme.textMuted, fontSize: 10.5, fontWeight: "600" },
  keyBanner: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: theme.surfaceAlt, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  keyBannerText: { flex: 1, color: theme.textSecondary, fontSize: 12.5, fontWeight: "600", lineHeight: 17 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { paddingTop: 60, alignItems: "center" },
  emptyText: { color: theme.textMuted, fontSize: 13 },

  bubbleRow: { flexDirection: "column" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4, paddingHorizontal: 4 },
  metaTime: { color: theme.textMuted, fontSize: 11, fontWeight: "500" },
  statusLabel: { color: theme.textMuted, fontSize: 10.5, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.3 },
  activeDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#22C55E" },
  typingBubble: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 14 },
  typingDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.textMuted },
  editedLink: { textDecorationLine: "underline" },
  historyTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "800", marginBottom: 10, paddingHorizontal: 4 },
  historyRow: { backgroundColor: theme.surfaceAlt, borderRadius: 12, padding: 12, marginBottom: 8 },
  historyMeta: { color: theme.textMuted, fontSize: 11, fontWeight: "700", marginBottom: 4 },
  historyText: { color: theme.textPrimary, fontSize: 14, lineHeight: 19 },
  bubbleRowMine: { alignItems: "flex-end" },
  bubbleRowOther: { alignItems: "flex-start" },
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
  // Reaction "bubble" that overlaps the bottom of the message (Messenger style).
  reactionBadge: {
    marginTop: -10, zIndex: 2,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2,
    shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2,
  },
  reactionBadgeMine: { marginRight: 8 },
  reactionBadgeOther: { marginLeft: 8 },
  reactionBadgeText: { color: theme.textPrimary, fontSize: 12.5, fontWeight: "600" },
  deletedRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  deletedText: { color: theme.textMuted, fontSize: 13, fontStyle: "italic" },
  mediaWrap: { width: CHAT_MEDIA_W },
  sharedWrap: { width: 250 },
  sharedLoading: { width: 200, height: 80, alignItems: "center", justifyContent: "center" },
  gifImg: { width: CHAT_MEDIA_W, height: CHAT_MEDIA_W * 0.75, borderRadius: 12, backgroundColor: theme.surfaceAlt },
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
  formCard: { flexDirection: "row", alignItems: "center", gap: 10, width: 230 },
  formIcon: { width: 38, height: 38, borderRadius: 11, backgroundColor: "#0EA5A0", alignItems: "center", justifyContent: "center" },
  formTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: "800" },
  formSub: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
  // Voice transcript
  transcribeBtn: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 6, alignSelf: "flex-start", paddingVertical: 3, paddingHorizontal: 8, borderRadius: 12, backgroundColor: "rgba(127,127,127,0.14)" },
  transcribeText: { color: theme.primary, fontSize: 12, fontWeight: "700" },
  transcriptText: { marginTop: 7, paddingTop: 7, borderTopWidth: 1, borderTopColor: theme.border, color: theme.textPrimary, fontSize: 13, lineHeight: 18, fontStyle: "italic" },
  // Scam check
  scamChecking: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 7 },
  scamCheckingText: { color: theme.textMuted, fontSize: 12, fontWeight: "600" },
  scamBanner: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 8, paddingVertical: 6, paddingHorizontal: 9, borderRadius: 10, borderWidth: 1 },
  scamWarnText: { flex: 1, fontSize: 12, fontWeight: "700", lineHeight: 16 },
  scamSafeText: { flex: 1, color: "#15803D", fontSize: 12, fontWeight: "700", lineHeight: 16 },
  // Poll bubble
  pollCard: { width: 240, gap: 7 },
  pollHead: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginBottom: 2 },
  pollQuestion: { flex: 1, color: theme.textPrimary, fontSize: 14, fontWeight: "800" },
  pollOpt: { borderRadius: 10, overflow: "hidden", backgroundColor: "rgba(127,127,127,0.14)", justifyContent: "center", minHeight: 38 },
  pollBar: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 10 },
  pollBarMine: { backgroundColor: "rgba(255,255,255,0.26)" },
  pollBarOther: { backgroundColor: "rgba(99,102,241,0.22)" },
  pollOptRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 9 },
  pollOptText: { flex: 1, color: theme.textPrimary, fontSize: 13, fontWeight: "600" },
  pollPct: { color: theme.textMuted, fontSize: 12, fontWeight: "700" },
  pollTotal: { color: theme.textMuted, fontSize: 11, marginTop: 1 },
  // Poll composer sheet
  pollSheetWrap: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.45)" },
  pollSheet: { backgroundColor: theme.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 18, paddingTop: 8 },
  pollSheetTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800", marginBottom: 14 },
  pollInput: { backgroundColor: theme.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: theme.border, color: theme.textPrimary, fontSize: 15, paddingHorizontal: 14, paddingVertical: 11, marginBottom: 10 },
  pollInputRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  pollAddOpt: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, marginBottom: 8 },
  pollAddOptText: { fontSize: 14, fontWeight: "700" },
  pollSendBtn: { borderRadius: 14, alignItems: "center", justifyContent: "center", paddingVertical: 14, marginTop: 6 },
  pollSendText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  // Schedule sheet
  scheduleLabel: { color: theme.textMuted, fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, marginTop: 2 },
  scheduleChips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  scheduleChip: { paddingHorizontal: 13, paddingVertical: 8, borderRadius: 18, backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border },
  scheduleChipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  scheduleChipText: { color: theme.textPrimary, fontSize: 13, fontWeight: "700" },
  scheduleCustomRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 4 },
  scheduleStep: { width: 40, height: 40, borderRadius: 12, backgroundColor: theme.surfaceAlt, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.border },
  scheduleWhen: { flex: 1, textAlign: "center", color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  scheduleHint: { color: theme.textMuted, fontSize: 12, marginTop: 2, marginBottom: 6 },
  scheduledRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderTopWidth: 1, borderTopColor: theme.border },
  scheduledRowText: { color: theme.textPrimary, fontSize: 14, fontWeight: "600" },
  scheduledRowTime: { color: theme.primary, fontSize: 12, fontWeight: "700", marginTop: 3 },
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
  galRoot: { flex: 1, backgroundColor: theme.bg },
  galHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  galTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  galEmpty: { color: theme.textMuted, fontSize: 14, textAlign: "center", paddingVertical: 50 },
  galSection: { color: theme.textMuted, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 14, marginBottom: 8 },
  galGrid: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  galTile: { width: "32%", aspectRatio: 1, borderRadius: 8, overflow: "hidden", backgroundColor: theme.surfaceAlt, position: "relative" },
  galVideo: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.25)" },
  galRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  galRowText: { flex: 1, color: theme.textPrimary, fontSize: 14 },
  galRowSub: { color: theme.textMuted, fontSize: 12 },
  galLb: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)", alignItems: "center", justifyContent: "center" },
  sumBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 24 },
  sumCard: { width: "100%", maxWidth: 460, backgroundColor: theme.surface, borderRadius: 18, borderWidth: 1, borderColor: theme.border, padding: 18 },
  sumHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  sumTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  sumText: { color: theme.textPrimary, fontSize: 14.5, lineHeight: 21 },
  sumMuted: { color: theme.textMuted, fontSize: 11.5, marginTop: 10, textAlign: "center" },
  sumDone: { marginTop: 14, paddingVertical: 12, borderRadius: 12, backgroundColor: theme.primary, alignItems: "center" },
  sumDoneText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  searchBar: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 14, paddingVertical: 8,
    backgroundColor: theme.surface,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  searchInput: {
    flex: 1, color: theme.textPrimary, fontSize: 15,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
  },
  searchCount: { color: theme.textMuted, fontSize: 12.5, fontWeight: "700" },
  pinBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 14, paddingVertical: 9,
    backgroundColor: theme.surface,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  pinBannerText: { flex: 1, color: theme.textSecondary, fontSize: 13, fontWeight: "600" },
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
    flex: 1, color: theme.textPrimary, fontSize: 15, lineHeight: 20,
    backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border,
    borderRadius: 22,
    paddingHorizontal: 16, paddingVertical: 11,
    maxHeight: 120, minHeight: 44,
    textAlignVertical: "center",
    ...(Platform.OS === "web" ? ({ outlineStyle: "none", resize: "none" } as object) : {}),
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: theme.primary,
    alignItems: "center", justifyContent: "center",
  },
  attachBtn: {
    width: 38, height: 44, borderRadius: 19,
    alignItems: "center", justifyContent: "center",
  },
  attachSheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  attachSheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
    paddingTop: 8, paddingHorizontal: 10,
  },
  attachHandle: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: theme.border, marginTop: 2, marginBottom: 14 },
  attachGrid: { flexDirection: "row", flexWrap: "wrap" },
  attachTile: { width: "33.33%", alignItems: "center", paddingVertical: 14, gap: 9 },
  attachTileIcon: {
    width: 58, height: 58, borderRadius: 29,
    alignItems: "center", justifyContent: "center",
  },
  attachTileLabel: { color: theme.textPrimary, fontSize: 13, fontWeight: "600", textAlign: "center" },
  recordingPill: {
    flex: 1, flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    borderRadius: 22, paddingHorizontal: 16, minHeight: 44,
  },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: theme.error },
  recTime: { color: theme.textPrimary, fontSize: 14, fontWeight: "800", fontVariant: ["tabular-nums"] },
  recText: { flex: 1, color: theme.textMuted, fontSize: 12.5, fontWeight: "500" },
});
