import React, { useRef, useState } from "react";
import {
  View, TouchableOpacity, StyleSheet, Image, Modal, Pressable, Dimensions,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";
import { PostMedia } from "@/src/api/client";
import { theme } from "@/src/theme";

const { width: SCREEN_W } = Dimensions.get("window");

function VideoTile({ uri, style, onPress }: { uri: string; style: any; onPress?: () => void }) {
  const player = useVideoPlayer(uri, (p) => { p.loop = true; p.muted = true; });
  const [playing, setPlaying] = useState(false);
  // When onPress is provided (feed → Reels), show a poster + play button and
  // hand the tap off instead of playing inline.
  const handle = () => {
    if (onPress) { onPress(); return; }
    if (playing) { player.pause(); setPlaying(false); }
    else { player.play(); setPlaying(true); }
  };
  return (
    <Pressable onPress={handle} style={style}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        nativeControls={false}
        contentFit="cover"
      />
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
    const uri = m.base64;
    if (m.type === "video") {
      return (
        <View key={idx} style={[styles.tile, style]}>
          <VideoTile uri={uri} style={StyleSheet.absoluteFill} onPress={onVideoPress} />
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
    layout = <View style={[styles.grid, { aspectRatio: 16 / 10 }]}>
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
              source={{ uri: media[openIndex].base64 }}
              style={{ width: SCREEN_W, height: SCREEN_W }}
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
