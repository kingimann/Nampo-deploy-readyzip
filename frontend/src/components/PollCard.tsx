import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Animated } from "react-native";
import { api, Poll, Post } from "@/src/api/client";
import { theme } from "@/src/theme";

function fmtRemaining(iso: string, closed: boolean) {
  if (closed) return "Final results";
  const d = new Date(iso); const diff = d.getTime() - Date.now();
  if (diff <= 0) return "Final results";
  const h = Math.floor(diff / 3_600_000);
  if (h >= 24) return `${Math.floor(h / 24)}d left`;
  if (h >= 1) return `${h}h left`;
  return `${Math.max(1, Math.floor(diff / 60_000))}m left`;
}

export default function PollCard({
  postId, poll, onUpdated,
}: { postId: string; poll: Poll; onUpdated: (p: Post) => void }) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const closed = !!poll.closed;
  const voted = !!poll.voted_option_id || closed;
  const total = poll.total_votes || 1;

  const vote = async (option_id: string) => {
    if (closed) return;
    setSubmitting(option_id);
    try {
      const p = await api.votePoll(postId, option_id);
      onUpdated(p);
    } catch {} finally { setSubmitting(null); }
  };

  return (
    <View style={styles.box}>
      {poll.options.map((o) => {
        const pct = voted ? Math.round((o.votes * 100) / total) : 0;
        const mine = poll.voted_option_id === o.id;
        return (
          <TouchableOpacity
            key={o.id}
            disabled={closed || submitting !== null}
            onPress={() => vote(o.id)}
            activeOpacity={0.85}
            style={[styles.row, mine && styles.rowMine]}
            testID={`poll-${postId}-opt-${o.id}`}
          >
            {voted && (
              <View style={[styles.bar, { width: `${pct}%` }, mine && styles.barMine]} />
            )}
            <Text style={[styles.text, mine && { fontWeight: "800" }]} numberOfLines={2}>
              {o.text}
            </Text>
            {voted && (
              <Text style={[styles.pct, mine && { color: "#fff" }]}>{pct}%</Text>
            )}
          </TouchableOpacity>
        );
      })}
      <Text style={styles.meta}>
        {poll.total_votes} vote{poll.total_votes === 1 ? "" : "s"} · {fmtRemaining(poll.ends_at, closed)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 10, gap: 8 },
  row: {
    position: "relative",
    backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    flexDirection: "row", alignItems: "center", overflow: "hidden",
  },
  rowMine: { borderColor: theme.primary },
  bar: {
    position: "absolute", left: 0, top: 0, bottom: 0,
    backgroundColor: "#1F2A44",
  },
  barMine: { backgroundColor: theme.primary },
  text: { color: theme.textPrimary, fontSize: 14, flex: 1 },
  pct: { color: theme.textSecondary, fontSize: 13, fontWeight: "700", marginLeft: 8 },
  meta: { color: theme.textMuted, fontSize: 11, fontWeight: "600", marginTop: 2 },
});
