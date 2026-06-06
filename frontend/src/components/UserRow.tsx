import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Image } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api, PublicUser, FriendStatus } from "@/src/api/client";
import { theme } from "@/src/theme";
import PresenceDot from "./PresenceDot";
import UserBadges from "./UserBadges";

const friendLabel = (s?: FriendStatus): string => {
  switch (s) {
    case "friends": return "Friends";
    case "request_sent": return "Requested";
    case "request_received": return "Accept";
    default: return "Add";
  }
};
const friendIcon = (s?: FriendStatus): keyof typeof Ionicons.glyphMap => {
  switch (s) {
    case "friends": return "people";
    case "request_sent": return "time";
    case "request_received": return "checkmark";
    default: return "person-add";
  }
};
const friendGhost = (s?: FriendStatus) => s === "friends" || s === "request_sent";

export default function UserRow({
  user,
  currentUserId,
  onChanged,
}: {
  user: PublicUser;
  currentUserId?: string;
  onChanged?: (u: PublicUser) => void;
}) {
  const router = useRouter();
  const [u, setU] = useState<PublicUser>(user);
  useEffect(() => { setU(user); }, [user]);
  const [busy, setBusy] = useState(false);
  const isMe = !!currentUserId && u.user_id === currentUserId;

  const update = (patch: Partial<PublicUser>) => {
    const next = { ...u, ...patch };
    setU(next);
    onChanged?.(next);
  };

  const onFollow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.toggleFollow(u.user_id);
      update({ is_following: r.following });
    } catch {} finally { setBusy(false); }
  };

  const onFriend = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (u.friend_status === "friends") {
        await api.unfriend(u.user_id);
        update({ friend_status: "none" });
      } else if (u.friend_status === "request_sent") {
        await api.cancelFriendRequest(u.user_id);
        update({ friend_status: "none" });
      } else if (u.friend_status === "request_received") {
        await api.acceptFriend(u.user_id);
        update({ friend_status: "friends" });
      } else {
        const r = await api.sendFriendRequest(u.user_id);
        update({ friend_status: r.status });
      }
    } catch {} finally { setBusy(false); }
  };

  const ghost = friendGhost(u.friend_status);

  return (
    <TouchableOpacity
      style={styles.row}
      activeOpacity={0.8}
      onPress={() => router.push({ pathname: "/user/[name]", params: { name: u.name } })}
      testID={`user-row-${u.user_id}`}
    >
      <View style={styles.avatarWrap}>
        <View style={styles.avatar}>
          {u.picture ? (
            <Image source={{ uri: u.picture }} style={{ width: "100%", height: "100%" }} />
          ) : (
            <Text style={styles.avatarInit}>{(u.name?.[0] || "?").toUpperCase()}</Text>
          )}
        </View>
        <PresenceDot online={u.online} size={13} borderColor={theme.surface} style={{ right: 0, bottom: 0 }} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={styles.name} numberOfLines={1}>{u.name}</Text>
          <UserBadges badges={u.badges} size={14} />
        </View>
        {!!u.username && <Text style={styles.handle} numberOfLines={1}>@{u.username}</Text>}
      </View>
      {!isMe && (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.followBtn, u.is_following && styles.ghostBtn]}
            onPress={onFollow}
            disabled={busy}
            testID={`follow-${u.user_id}`}
          >
            <Text style={[styles.followText, u.is_following && styles.ghostText]}>
              {u.is_following ? "Following" : "Follow"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.friendBtn, ghost && styles.ghostBtn]}
            onPress={onFriend}
            disabled={busy}
            testID={`friend-${u.user_id}`}
          >
            <Ionicons name={friendIcon(u.friend_status)} size={14} color={ghost ? theme.textPrimary : "#fff"} />
            <Text style={[styles.friendText, ghost && styles.ghostText]}>{friendLabel(u.friend_status)}</Text>
          </TouchableOpacity>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingVertical: 10, paddingHorizontal: 14,
    backgroundColor: theme.surface, borderRadius: 14,
    borderWidth: 1, borderColor: theme.border,
  },
  avatarWrap: { width: 46, height: 46 },
  avatar: {
    width: 46, height: 46, borderRadius: 23, overflow: "hidden",
    backgroundColor: theme.primary, alignItems: "center", justifyContent: "center",
  },
  avatarInit: { color: "#fff", fontSize: 18, fontWeight: "800" },
  name: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  handle: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
  actions: { flexDirection: "row", alignItems: "center", gap: 6 },
  followBtn: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    backgroundColor: theme.primary,
  },
  followText: { color: "#fff", fontWeight: "700", fontSize: 12 },
  friendBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999,
    backgroundColor: theme.primary,
  },
  friendText: { color: "#fff", fontWeight: "700", fontSize: 12 },
  ghostBtn: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border },
  ghostText: { color: theme.textPrimary },
});
