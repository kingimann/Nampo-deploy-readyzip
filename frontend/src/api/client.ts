import { Platform } from "react-native";
import { storage } from "@/src/utils/storage";

// On web, use relative paths so the Metro proxy (dev) or same-origin server (prod)
// handles routing — avoids CORS issues and works without knowing the backend URL.
// On native (Expo Go / device), we need the full configured backend URL.
const BASE_URL: string =
  Platform.OS === "web" ? "" : (process.env.EXPO_PUBLIC_BACKEND_URL as string) || "";
export const SESSION_TOKEN_KEY = "session_token";

async function getToken(): Promise<string | null> {
  return (await storage.secureGet<string>(SESSION_TOKEN_KEY, "")) || null;
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((opts.headers as Record<string, string>) || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}/api${path}`, { ...opts, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => request<User>("/auth/me"),
  updateMe: (p: ProfilePatch) =>
    request<User>("/auth/me", { method: "PATCH", body: JSON.stringify(p) }),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  registerLocal: (body: { email: string; password: string; name: string; username: string }) =>
    request<{ session_token: string; user: User }>("/auth/register", { method: "POST", body: JSON.stringify(body) }),
  loginLocal: (body: { identifier: string; password: string }) =>
    request<{ session_token: string; user: User }>("/auth/login", { method: "POST", body: JSON.stringify(body) }),
  usernameAvailable: (u: string) =>
    request<{ available: boolean; reason?: string }>(`/auth/username-available?u=${encodeURIComponent(u)}`),
  setUsername: (username: string) =>
    request<User>("/auth/username", { method: "POST", body: JSON.stringify({ username }) }),
  uploadE2EKey: (public_key: string) =>
    request<{ ok: boolean }>("/auth/keys", { method: "POST", body: JSON.stringify({ public_key }) }),
  getUserE2EKey: (user_id: string) =>
    request<{ public_key: string | null }>(`/users/${user_id}/key`),
  recordPostView: (id: string) =>
    request<{ viewed: boolean }>(`/posts/${id}/view`, { method: "POST" }),
  reelsFeed: () => request<Post[]>("/feed/reels"),
  listUserPostsAll: (uid: string) => request<Post[]>(`/posts/user/${uid}/all`),

  searchUsers: (q: string) => request<PublicUser[]>(`/users/search?q=${encodeURIComponent(q)}`),
  getPublicUser: (id: string) => request<PublicUser>(`/users/${id}/public`),

  listPlaces: () => request<Place[]>("/places"),
  getPlace: (id: string) => request<Place>(`/places/${id}`),
  createPlace: (place: PlaceCreate) =>
    request<Place>("/places", { method: "POST", body: JSON.stringify(place) }),
  deletePlace: (id: string) =>
    request<{ ok: boolean }>(`/places/${id}`, { method: "DELETE" }),

  listRecents: () => request<Recent[]>("/recents"),
  addRecent: (r: RecentCreate) =>
    request<Recent>("/recents", { method: "POST", body: JSON.stringify(r) }),
  deleteRecent: (id: string) =>
    request<{ ok: boolean }>(`/recents/${id}`, { method: "DELETE" }),
  clearRecents: () => request<{ ok: boolean }>("/recents", { method: "DELETE" }),

  listGuides: () => request<Guide[]>("/guides"),
  createGuide: (g: GuideCreate) =>
    request<Guide>("/guides", { method: "POST", body: JSON.stringify(g) }),
  patchGuide: (id: string, patch: GuidePatch) =>
    request<Guide>(`/guides/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteGuide: (id: string) =>
    request<{ ok: boolean }>(`/guides/${id}`, { method: "DELETE" }),
  addPlaceToGuide: (gid: string, pid: string) =>
    request<Guide>(`/guides/${gid}/places/${pid}`, { method: "POST" }),
  removePlaceFromGuide: (gid: string, pid: string) =>
    request<Guide>(`/guides/${gid}/places/${pid}`, { method: "DELETE" }),

  getPublicGuide: (slug: string) => request<PublicGuide>(`/public/guides/${slug}`),
  clonePublicGuide: (slug: string) =>
    request<Guide>(`/public/guides/${slug}/clone`, { method: "POST" }),

  listReviews: (place_key: string) =>
    request<Review[]>(`/reviews?place_key=${encodeURIComponent(place_key)}`),
  upsertReview: (r: ReviewCreate) =>
    request<Review>("/reviews", { method: "POST", body: JSON.stringify(r) }),
  deleteReview: (id: string) =>
    request<{ ok: boolean }>(`/reviews/${id}`, { method: "DELETE" }),

  fsqMatch: (name: string, lng: number, lat: number) =>
    request<FsqProfile | null>(
      `/foursquare/match?name=${encodeURIComponent(name)}&lng=${lng}&lat=${lat}`,
    ),

  getOrCreateConversation: (recipient_user_id: string) =>
    request<ConversationView>("/conversations", {
      method: "POST", body: JSON.stringify({ recipient_user_id }),
    }),
  listConversations: () => request<ConversationView[]>("/conversations"),
  listMessages: (conv_id: string) =>
    request<Message[]>(`/conversations/${conv_id}/messages`),
  sendMessage: (conv_id: string, body: MessageCreate) =>
    request<Message>(`/conversations/${conv_id}/messages`, {
      method: "POST", body: JSON.stringify(body),
    }),
  markConversationRead: (conv_id: string) =>
    request<{ ok: boolean }>(`/conversations/${conv_id}/read`, { method: "POST" }),
  editMessage: (conv_id: string, msg_id: string, text: string) =>
    request<Message>(`/conversations/${conv_id}/messages/${msg_id}`, {
      method: "PATCH", body: JSON.stringify({ text }),
    }),
  deleteMessage: (conv_id: string, msg_id: string) =>
    request<{ ok: boolean }>(`/conversations/${conv_id}/messages/${msg_id}`, {
      method: "DELETE",
    }),
  deleteConversation: (conv_id: string) =>
    request<{ ok: boolean }>(`/conversations/${conv_id}`, { method: "DELETE" }),

  // Group chats
  createGroupChat: (body: { name: string; member_ids: string[]; avatar?: string }) =>
    request<ConversationView>("/conversations/groups", {
      method: "POST", body: JSON.stringify(body),
    }),
  patchGroupChat: (
    conv_id: string,
    body: { name?: string; avatar?: string; add_member_ids?: string[]; remove_member_ids?: string[] },
  ) =>
    request<ConversationView>(`/conversations/${conv_id}`, {
      method: "PATCH", body: JSON.stringify(body),
    }),
  leaveGroupChat: (conv_id: string) =>
    request<{ ok: boolean }>(`/conversations/${conv_id}/leave`, { method: "POST" }),

  // Notifications
  listNotifications: () => request<Notification[]>("/notifications"),
  unreadNotificationsCount: () =>
    request<{ count: number }>("/notifications/unread"),
  markNotificationRead: (id: string) =>
    request<{ ok: boolean }>(`/notifications/${id}/read`, { method: "POST" }),
  markAllNotificationsRead: () =>
    request<{ ok: boolean }>("/notifications/read-all", { method: "POST" }),
  deleteNotification: (id: string) =>
    request<{ ok: boolean }>(`/notifications/${id}`, { method: "DELETE" }),

  // ETA sharing
  createEta: (body: EtaShareCreate) =>
    request<EtaShare>("/eta", { method: "POST", body: JSON.stringify(body) }),
  updateEta: (share_id: string, body: EtaUpdateBody) =>
    request<EtaShare>(`/eta/${share_id}/update`, { method: "POST", body: JSON.stringify(body) }),
  stopEta: (share_id: string) =>
    request<EtaShare>(`/eta/${share_id}/stop`, { method: "POST" }),

  // Posts / Feed / Follows
  createPost: (body: PostCreate) =>
    request<Post>("/posts", { method: "POST", body: JSON.stringify(body) }),
  editPost: (id: string, body: { text?: string; media?: PostMedia[] }) =>
    request<Post>(`/posts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  reportPost: (id: string, reason?: string) =>
    request<{ ok: boolean }>(`/posts/${id}/report`, {
      method: "POST", body: JSON.stringify({ reason: reason || "other" }),
    }),
  deletePost: (id: string) =>
    request<{ ok: boolean }>(`/posts/${id}`, { method: "DELETE" }),
  getPost: (id: string) => request<Post>(`/posts/${id}`),
  listReplies: (id: string) => request<Post[]>(`/posts/${id}/replies`),
  listUserPosts: (uid: string) => request<Post[]>(`/posts/user/${uid}`),
  homeFeed: () => request<Post[]>("/feed/home"),
  exploreFeed: () => request<Post[]>("/feed/explore"),
  toggleLike: (id: string) =>
    request<Post>(`/posts/${id}/like`, { method: "POST" }),
  toggleRepost: (id: string) =>
    request<Post>(`/posts/${id}/repost`, { method: "POST" }),
  toggleBookmark: (id: string) =>
    request<Post>(`/posts/${id}/bookmark`, { method: "POST" }),
  listBookmarks: () => request<Post[]>("/bookmarks"),
  listPostLikers: (id: string) => request<PublicUser[]>(`/posts/${id}/likers`),
  listPostReposters: (id: string) => request<PublicUser[]>(`/posts/${id}/reposters`),
  votePoll: (id: string, option_id: string) =>
    request<Post>(`/posts/${id}/vote`, {
      method: "POST", body: JSON.stringify({ option_id }),
    }),
  hashtagPosts: (tag: string) =>
    request<Post[]>(`/hashtags/${encodeURIComponent(tag.replace(/^#/, ""))}`),
  hashtagCount: (tag: string) =>
    request<{ tag: string; count: number }>(
      `/hashtags/${encodeURIComponent(tag.replace(/^#/, ""))}/count`),
  toggleFollow: (uid: string) =>
    request<{ following: boolean }>(`/users/${uid}/follow`, { method: "POST" }),
  listFollowers: (uid: string) => request<PublicUser[]>(`/users/${uid}/followers`),
  listFollowing: (uid: string) => request<PublicUser[]>(`/users/${uid}/following`),
  sendFriendRequest: (uid: string) =>
    request<{ status: "request_sent" | "friends" }>(`/friends/request/${uid}`, { method: "POST" }),
  cancelFriendRequest: (uid: string) =>
    request<{ status: "none" }>(`/friends/request/${uid}`, { method: "DELETE" }),
  acceptFriend: (uid: string) =>
    request<{ status: "friends" }>(`/friends/accept/${uid}`, { method: "POST" }),
  rejectFriend: (uid: string) =>
    request<{ status: "rejected" }>(`/friends/reject/${uid}`, { method: "POST" }),
  unfriend: (uid: string) =>
    request<{ removed: boolean }>(`/friends/${uid}`, { method: "DELETE" }),
  listFriends: () => request<PublicUser[]>(`/friends`),
  listFriendRequests: () => request<PublicUser[]>(`/friends/requests`),

  // Marketplace
  listListings: (params?: { category?: string; q?: string; condition?: string; min_price?: number; max_price?: number; sort?: string }) => {
    const qs = new URLSearchParams();
    if (params?.category) qs.set("category", params.category);
    if (params?.q) qs.set("q", params.q);
    if (params?.condition) qs.set("condition", params.condition);
    if (params?.min_price != null) qs.set("min_price", String(params.min_price));
    if (params?.max_price != null) qs.set("max_price", String(params.max_price));
    if (params?.sort) qs.set("sort", params.sort);
    return request<Listing[]>(`/listings${qs.toString() ? "?" + qs.toString() : ""}`);
  },
  listSavedListings: () => request<Listing[]>("/listings/saved"),
  getListing: (id: string) => request<Listing>(`/listings/${id}`),
  createListing: (body: ListingCreate) =>
    request<Listing>("/listings", { method: "POST", body: JSON.stringify(body) }),
  updateListing: (id: string, body: Partial<ListingCreate> & { status?: string }) =>
    request<Listing>(`/listings/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  saveListing: (id: string) =>
    request<{ ok: boolean; saved: boolean }>(`/listings/${id}/save`, { method: "POST" }),
  unsaveListing: (id: string) =>
    request<{ ok: boolean; saved: boolean }>(`/listings/${id}/save`, { method: "DELETE" }),
  deleteListing: (id: string) =>
    request<{ ok: boolean }>(`/listings/${id}`, { method: "DELETE" }),
  contactSeller: (id: string) =>
    request<ConversationView>(`/listings/${id}/contact`, { method: "POST" }),

  // Groups
  listGroupsAll: () => request<Group[]>("/groups"),
  createGroup: (body: { name: string; description?: string; color?: string; is_private?: boolean }) =>
    request<Group>("/groups", { method: "POST", body: JSON.stringify(body) }),
  joinGroup: (id: string) =>
    request<Group>(`/groups/${id}/join`, { method: "POST" }),
  leaveGroup: (id: string) =>
    request<Group>(`/groups/${id}/leave`, { method: "POST" }),
  deleteGroupNew: (id: string) =>
    request<{ ok: boolean }>(`/groups/${id}`, { method: "DELETE" }),
  getGroup: (id: string) => request<Group>(`/groups/${id}`),
  listGroupPosts: (id: string) => request<Post[]>(`/groups/${id}/posts`),
  createGroupPost: (id: string, body: PostCreate) =>
    request<Post>(`/groups/${id}/posts`, { method: "POST", body: JSON.stringify(body) }),
  listGroupMembers: (id: string) =>
    request<{ user_id: string; name: string; username?: string | null; picture?: string | null; role: string; joined_at: string }[]>(`/groups/${id}/members`),
  updateGroup: (id: string, body: { name?: string; description?: string; color?: string; cover_image?: string | null; is_private?: boolean }) =>
    request<Group>(`/groups/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  listGroupPins: (id: string) => request<Post[]>(`/groups/${id}/pins`),
  pinGroupPost: (id: string, postId: string) =>
    request<Group>(`/groups/${id}/pins/${postId}`, { method: "POST" }),
  unpinGroupPost: (id: string, postId: string) =>
    request<Group>(`/groups/${id}/pins/${postId}`, { method: "DELETE" }),
  promoteMember: (groupId: string, userId: string) =>
    request<Group>(`/groups/${groupId}/members/${userId}/promote`, { method: "POST" }),
  demoteMember: (groupId: string, userId: string) =>
    request<Group>(`/groups/${groupId}/members/${userId}/demote`, { method: "POST" }),
  kickMember: (groupId: string, userId: string) =>
    request<Group>(`/groups/${groupId}/members/${userId}`, { method: "DELETE" }),
  listJoinRequests: (id: string) =>
    request<{ user_id: string; name: string; username?: string | null; picture?: string | null; created_at: string }[]>(`/groups/${id}/requests`),
  approveJoinRequest: (groupId: string, userId: string) =>
    request<Group>(`/groups/${groupId}/requests/${userId}/approve`, { method: "POST" }),
  rejectJoinRequest: (groupId: string, userId: string) =>
    request<Group>(`/groups/${groupId}/requests/${userId}/reject`, { method: "POST" }),

  // ── Stories ──
  createStory: (body: { media: { type: "image" | "video"; base64: string; duration_ms?: number }; caption?: string }) =>
    request<Story>(`/stories`, { method: "POST", body: JSON.stringify(body) }),
  storiesTray: () => request<StoryTrayItem[]>(`/stories/tray`),
  listUserStories: (userId: string) => request<Story[]>(`/stories/user/${userId}`),
  viewStory: (id: string) => request<{ viewed: boolean }>(`/stories/${id}/view`, { method: "POST" }),
  listStoryViewers: (id: string) => request<StoryViewer[]>(`/stories/${id}/viewers`),
  deleteStory: (id: string) => request<{ ok: boolean }>(`/stories/${id}`, { method: "DELETE" }),
  replyToStory: (id: string, text: string) =>
    request<{ ok: boolean; conversation_id: string }>(`/stories/${id}/reply`, { method: "POST", body: JSON.stringify({ text }) }),
};

export type Story = {
  id: string; user_id: string; user_name: string; user_picture?: string | null;
  user_username?: string | null;
  type: "image" | "video"; media_base64: string;
  caption?: string; duration_ms?: number | null;
  view_count: number; viewed_by_me: boolean;
  created_at: string; expires_at: string;
};
export type StoryTrayItem = {
  user_id: string; user_name: string; user_picture?: string | null;
  user_username?: string | null;
  has_unviewed: boolean; story_count: number; latest_at: string;
};
export type StoryViewer = {
  user_id: string; name: string; username?: string | null;
  picture?: string | null; viewed_at: string;
};

export type Group = {
  id: string; name: string; description?: string; color: string;
  cover_image?: string | null;
  is_private?: boolean;
  owner_id: string; member_count: number; is_member: boolean;
  membership_pending?: boolean;
  my_role?: "owner" | "admin" | "member";
  pending_request_count?: number;
  pinned_post_ids?: string[];
  created_at: string;
};

export type Listing = {
  id: string; user_id: string;
  seller: PostAuthor;
  title: string; price: number; currency: string; category: string;
  condition?: string | null;
  description?: string | null;
  photo_base64?: string | null;
  photos?: string[];
  longitude?: number | null; latitude?: number | null; locality?: string | null;
  status: string;
  views_count?: number;
  saved_count?: number;
  saved_by_me?: boolean;
  created_at: string;
};
export type ListingCreate = {
  title: string; price?: number; currency?: string; category?: string;
  condition?: string;
  description?: string; photo_base64?: string; photos?: string[];
  longitude?: number; latitude?: number; locality?: string;
};

export async function fetchPublicEta(share_id: string): Promise<EtaShare | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/public/eta/${share_id}`);
    if (!res.ok) return null;
    return (await res.json()) as EtaShare;
  } catch {
    return null;
  }
}

export type User = {
  user_id: string;
  email: string;
  name: string;
  username?: string | null;
  picture?: string | null;
  bio?: string;
  home_name?: string | null;
  home_longitude?: number | null;
  home_latitude?: number | null;
  work_name?: string | null;
  work_longitude?: number | null;
  work_latitude?: number | null;
};
export type ProfilePatch = {
  name?: string; bio?: string; picture?: string;
  home_name?: string | null; home_longitude?: number | null; home_latitude?: number | null;
  work_name?: string | null; work_longitude?: number | null; work_latitude?: number | null;
};
export type FriendStatus = "none" | "request_sent" | "request_received" | "friends";
export type PublicUser = {
  user_id: string;
  name: string;
  username?: string | null;
  picture?: string | null;
  bio?: string;
  stats?: { places?: number; guides?: number; reviews?: number; followers?: number; following?: number; friends?: number };
  is_following?: boolean;
  is_followed_by?: boolean;
  friend_status?: FriendStatus;
};
export type Place = {
  id: string; user_id: string; title: string; notes?: string;
  longitude: number; latitude: number; address?: string; category: string; created_at: string;
};
export type PlaceCreate = {
  title: string; notes?: string; longitude: number; latitude: number; address?: string; category?: string;
};
export type Recent = {
  id: string; user_id: string; name: string; full_address?: string;
  longitude: number; latitude: number; created_at: string;
};
export type RecentCreate = { name: string; full_address?: string; longitude: number; latitude: number };
export type Guide = {
  id: string; user_id: string; name: string; color: string; icon: string;
  place_ids: string[]; is_public: boolean; slug?: string | null; created_at: string;
};
export type GuideCreate = { name: string; color?: string; icon?: string };
export type GuidePatch = { name?: string; color?: string; is_public?: boolean };
export type PublicGuide = {
  id: string; slug: string; name: string; color: string; icon: string;
  owner: PublicUser; places: Place[]; created_at: string;
};
export type Review = {
  id: string; user_id: string; user_name: string; user_picture?: string | null;
  place_key: string; place_name: string; longitude: number; latitude: number;
  rating: number; text?: string; created_at: string;
};
export type ReviewCreate = {
  place_key: string; place_name: string; longitude: number; latitude: number;
  rating: number; text?: string;
};

export type FsqProfile = {
  fsq_id: string;
  name: string;
  address?: string | null;
  locality?: string | null;
  category?: string | null;
  rating?: number | null;
  price?: number | null;
  phone?: string | null;
  website?: string | null;
  hours_display?: string | null;
  open_now?: boolean | null;
  photo?: string | null;
  distance?: number | null;
};
export type MsgType = "text" | "place" | "media" | "voice" | "post" | "gif" | "file" | "contact";
export type Message = {
  id: string; conversation_id: string; sender_id: string;
  type: MsgType; text?: string;
  place_name?: string; place_address?: string;
  place_longitude?: number; place_latitude?: number;
  media?: PostMedia[];
  audio_base64?: string | null;
  audio_duration_ms?: number | null;
  post_id?: string | null;
  gif_url?: string | null;
  file_base64?: string | null; file_name?: string | null; file_size?: number | null; file_mime?: string | null;
  contact_user_id?: string | null; contact_name?: string | null; contact_picture?: string | null;
  link_preview?: LinkPreview | null;
  deleted?: boolean;
  edited_at?: string | null;
  read_at?: string | null;
  created_at: string;
};
export type MessageCreate = {
  type: MsgType; text?: string;
  place_name?: string; place_address?: string;
  place_longitude?: number; place_latitude?: number;
  media?: PostMedia[];
  audio_base64?: string;
  audio_duration_ms?: number;
  post_id?: string;
  gif_url?: string;
  file_base64?: string; file_name?: string; file_size?: number; file_mime?: string;
  contact_user_id?: string; contact_name?: string; contact_picture?: string;
};
export type ConversationView = {
  id: string;
  kind: "dm" | "group";
  name?: string | null;
  avatar?: string | null;
  other_user?: PublicUser | null;
  members?: PublicUser[];
  owner_id?: string | null;
  last_message?: Message | null;
  last_message_at?: string | null;
  unread_count?: number;
  created_at: string;
};

export type Notification = {
  id: string;
  user_id: string;
  type: "like" | "repost" | "reply" | "message" | "group_invite" | "group_message";
  actor_id?: string | null;
  actor_name?: string | null;
  actor_picture?: string | null;
  post_id?: string | null;
  conversation_id?: string | null;
  group_id?: string | null;
  message?: string | null;
  read: boolean;
  created_at: string;
};

export type EtaShareCreate = {
  name?: string;
  destination_name?: string;
  destination_longitude: number;
  destination_latitude: number;
  initial_longitude: number;
  initial_latitude: number;
  eta_minutes?: number;
  ttl_minutes?: number;
};
export type EtaShare = {
  id: string;
  share_id: string;
  user_id: string;
  name?: string;
  destination_name?: string;
  destination_longitude: number;
  destination_latitude: number;
  current_longitude: number;
  current_latitude: number;
  eta_minutes?: number | null;
  active: boolean;
  expires_at: string;
  updated_at: string;
  created_at: string;
};
export type EtaUpdateBody = {
  current_longitude: number;
  current_latitude: number;
  eta_minutes?: number;
};

export type LinkPreview = {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  site_name?: string | null;
};
export type PollOption = { id: string; text: string; votes: number };
export type Poll = {
  options: PollOption[];
  total_votes: number;
  voted_option_id?: string | null;
  ends_at: string;
  closed: boolean;
};
export type PollCreate = { options: string[]; duration_hours: number };
export type PostAuthor = { user_id: string; name: string; picture?: string | null };
export type PostMedia = {
  type: "image" | "video";
  base64: string;
  thumbnail?: string | null;
  width?: number | null;
  height?: number | null;
};
export type Post = {
  id: string; user_id: string; author: PostAuthor; text: string;
  parent_id?: string | null;
  repost_of?: string | null;
  quote_of?: string | null;
  reposted_post?: Post | null;
  quoted_post?: Post | null;
  place_name?: string | null; place_longitude?: number | null; place_latitude?: number | null;
  media?: PostMedia[];
  link_preview?: LinkPreview | null;
  poll?: Poll | null;
  hashtags?: string[];
  likes_count: number; replies_count: number; reposts_count?: number;
  quotes_count?: number;
  bookmarks_count?: number;
  views_count?: number;
  liked_by_me: boolean; reposted_by_me?: boolean; bookmarked_by_me?: boolean;
  edited_at?: string | null;
  created_at: string;
};
export type PostCreate = {
  text?: string; parent_id?: string;
  quote_of?: string;
  place_name?: string; place_longitude?: number; place_latitude?: number;
  media?: PostMedia[];
  poll?: PollCreate;
};

export const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN as string;

export function buildPlaceKey(name: string, lng: number, lat: number): string {
  return `${name.trim().toLowerCase()}|${lng.toFixed(5)}|${lat.toFixed(5)}`;
}
