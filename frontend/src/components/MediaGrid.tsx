import React, { useRef, useState } from "react";
import {
  View, TouchableOpacity, StyleSheet, Image, Modal, Pressable, Dimensions,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";
import { PostMedia, mediaUri } from "@/src/api/client";
import ReelPoster from "@/src/components/ReelPoster";
import { theme } from "@/src/theme";

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function VideoTile({ uri, poster, style, onPress }: { uri: string; poster?: string | null; style: any; onPress?: () => void }) {
  // For reel previews (onPress set) we don't mount a player at all — just show
  // the cover (custom thumbnail or the branded "Nami Social" default) + a play
  // badge, and hand the tap off to the Reels player.
  const player = useVideoPlayer(onPress ? null : uri, (p) => { p.loop = true; p.muted = true; });
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const handle = () => {
    if (onPress) { onPress(); return; }
    if (playing) { player.pause(); setPlaying(false); }
    else { player.play(); setPlaying(true); setStarted(true); }
  };
  return (
    <Pressable onPress={handle} style={style}>
      {onPress ? (
        <ReelPoster uri={poster} compact />
      ) : (
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          nativeControls={false}
          contentFit="cover"
        />
      )}
      {!onPress && !started && (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <ReelPoster uri={poster} compact />
        </View>
      )}
      {(!playing || !!onPress) && (
        <View style={styles.playOverlay}>
          <Ionicons name="play" size={32} color="#fff" />
        </View>
      )}
    </Pressable>
  );
}

export default function MediaGrid({
  media,
  testID,
  onVideoPress,
}: {
  media: PostMedia[];
  testID?: string;
  /** If set, tapping a video opens this (e.g. the Reels player) instead of inline play. */
  onVideoPress?: () => void;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  if (!media || media.length === 0) return null;
  const n = media.length;

  const renderTile = (m: PostMedia, idx: number, style: any) => {
    const uri = mediaUri(m);
    if (m.type === "video") {
      return (
        <View key={idx} style={[styles.tile, style]}>
          <VideoTile uri={uri} poster={m.thumbnail} style={StyleSheet.absoluteFill} onPress={onVideoPress} />
        </View>
      );
    }
    return (
      <TouchableOpacity
        key={idx}
        style={[styles.tile, style]}
        activeOpacity={0.9}
        onPress={() => setOpenIndex(idx)}
        testID={`${testID}-media-${idx}`}
      >
        <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      </TouchableOpacity>
    );
  };

  let layout;
  if (n === 1) {
    // A single photo/video keeps its own aspect ratio (clamped so very tall or
    // very wide media stays readable) instead of being cropped to a fixed box.
    const m0 = media[0];
    const ar = m0.width && m0.height ? clamp(m0.width / m0.height, 0.8, 1.91) : 16 / 10;
    layout = <View style={[styles.grid, { aspectRatio: ar }]}>
      {renderTile(media[0], 0, { flex: 1 })}
    </View>;
  } else if (n === 2) {
    layout = <View style={[styles.grid, styles.row, { aspectRatio: 16 / 10 }]}>
      {renderTile(media[0], 0, styles.col)}
      {renderTile(media[1], 1, styles.col)}
    </View>;
  } else if (n === 3) {
    layout = <View style={[styles.grid, styles.row, { aspectRatio: 16 / 10 }]}>
      {renderTile(media[0], 0, styles.col)}
      <View style={[styles.col, styles.columnStack]}>
        {renderTile(media[1], 1, styles.colHalf)}
        {renderTile(media[2], 2, styles.colHalf)}
      </View>
    </View>;
  } else {
    layout = <View style={[styles.grid, { aspectRatio: 1 }]}>
      <View style={styles.row}>
        {renderTile(media[0], 0, styles.col)}
        {renderTile(media[1], 1, styles.col)}
      </View>
      <View style={styles.row}>
        {renderTile(media[2], 2, styles.col)}
        {renderTile(media[3], 3, styles.col)}
      </View>
    </View>;
  }

  return (
    <>
      {layout}
      <Modal
        visible={openIndex !== null && media[openIndex!]?.type === "image"}
        transparent
        animationType="fade"
        onRequestClose={() => setOpenIndex(null)}
      >
        <View style={styles.lightbox}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpenIndex(null)} />
          {openIndex !== null && (
            <Image
              source={{ uri: mediaUri(media[openIndex]) }}
              style={{ width: SCREEN_W, height: SCREEN_H }}
              resizeMode="contain"
            />
          )}
          <TouchableOpacity
            style={styles.lightboxClose}
            onPress={() => setOpenIndex(null)}
          >
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  grid: {
    width: "100%",
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: theme.surface,
    marginTop: 10,
    gap: 2,
  },
  row: { flexDirection: "row", flex: 1, gap: 2 },
  col: { flex: 1, position: "relative" },
  colHalf: { flex: 1, position: "relative" },
  columnStack: { flexDirection: "column", gap: 2 },
  tile: { position: "relative", overflow: "hidden", backgroundColor: "#111" },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.3)",
    alignItems: "center", justifyContent: "center",
  },
  lightbox: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.95)",
    alignItems: "center", justifyContent: "center",
  },
  lightboxClose: {
    position: "absolute", top: 50, right: 20,
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center", justifyContent: "center",
  },
});
