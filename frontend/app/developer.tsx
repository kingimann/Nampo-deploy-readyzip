import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  ActivityIndicator, Platform, Alert, Linking,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import * as Clipboard from "expo-clipboard";
import { api, ApiKey, DevWebhook, OAuthApp, WebhookDelivery } from "@/src/api/client";
import { useConfirm } from "@/src/context/ConfirmContext";
import { theme } from "@/src/theme";

const BASE = (process.env.EXPO_PUBLIC_BACKEND_URL as string) || "https://okayspace-v0vx.onrender.com";
const API_BASE = `${BASE}/api/v1`;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Endpoint = { method: Method; path: string; desc: string; body?: string; auth?: boolean };
type Group = { title: string; icon: keyof typeof import("@expo/vector-icons/build/Ionicons").default.glyphMap; endpoints: Endpoint[] };

const GROUPS: Group[] = [
  {
    title: "Forms", icon: "document-text",
    endpoints: [
      { method: "POST", path: "/forms", desc: "Create a form.", auth: true, body: `{"title","description","notify_email","fields":[{"type","label","required","options"}]}` },
      { method: "GET", path: "/forms", desc: "List your forms.", auth: true },
      { method: "GET", path: "/forms/{id}", desc: "Get a form definition.", auth: true },
      { method: "POST", path: "/forms/{id}", desc: "Update a form (title, fields, notify_email, …).", auth: true },
      { method: "DELETE", path: "/forms/{id}", desc: "Delete a form and its responses.", auth: true },
      { method: "GET", path: "/forms/{id}/submissions", desc: "List responses (paginated).", auth: true },
      { method: "GET", path: "/forms/{id}/submissions.csv", desc: "Download all responses as CSV.", auth: true },
      { method: "GET", path: "/pub/form?form=KEY", desc: "Public: get a form's fields (no auth).", auth: false },
      { method: "POST", path: "/pub/form-submit?form=KEY", desc: "Public: submit a form (no auth). Fires the form.submission webhook.", auth: false, body: `{"values":{...},"hp":""}` },
      { method: "GET", path: "/pub/form-embed.js?form=KEY", desc: "Public: <script> loader; theme via data-theme/accent/bg/radius/redirect/prefill.", auth: false },
      { method: "GET", path: "/pub/form-unit?form=KEY", desc: "Public: hosted form page. Params: theme, accent, bg, radius, hide_title, redirect, pf_<id>.", auth: false },
    ],
  },
  {
    title: "Authentication", icon: "key",
    endpoints: [
      { method: "POST", path: "/auth/register", desc: "Create an account. Returns a session_token + user.", auth: false, body: `{"email","password","name","username"}` },
      { method: "POST", path: "/auth/login", desc: "Log in with email or username. Returns session_token + user.", auth: false, body: `{"identifier","password"}` },
      { method: "GET", path: "/auth/me", desc: "Get the current authenticated user.", auth: true },
      { method: "PATCH", path: "/auth/me", desc: "Update profile (name, bio, picture, home/work, sub_price).", auth: true, body: `{"name","bio",...}` },
      { method: "POST", path: "/auth/logout", desc: "Invalidate the current session token.", auth: true },
      { method: "GET", path: "/auth/api-keys", desc: "List your Developer API keys.", auth: true },
      { method: "POST", path: "/auth/api-keys", desc: "Create an API key (shown once). scope: read | write.", auth: true, body: `{"label","scope":"write"}` },
      { method: "DELETE", path: "/auth/api-keys/{id}", desc: "Revoke an API key.", auth: true },
      { method: "POST", path: "/auth/username", desc: "Set/change your username (your vanity URL).", auth: true, body: `{"username"}` },
      { method: "GET", path: "/auth/username-available", desc: "Check if a username is free (?username=).", auth: false },
      { method: "PATCH", path: "/auth/me/email", desc: "Change your email.", auth: true, body: `{"email","password"}` },
      { method: "PATCH", path: "/auth/me/password", desc: "Change your password.", auth: true, body: `{"current","new"}` },
      { method: "PATCH", path: "/auth/me/phone", desc: "Set/verify your phone number.", auth: true, body: `{"phone","code"}` },
      { method: "POST", path: "/auth/email/send-code", desc: "Send yourself an email verification code.", auth: true },
      { method: "POST", path: "/auth/email/verify", desc: "Verify your email with the code.", auth: true, body: `{"code"}` },
      { method: "POST", path: "/auth/phone/send-code", desc: "Send yourself an SMS verification code.", auth: true },
      { method: "POST", path: "/auth/phone/verify", desc: "Verify your phone with the code.", auth: true, body: `{"code"}` },
      { method: "POST", path: "/auth/2fa", desc: "Enable/disable SMS two-factor.", auth: true, body: `{"enabled":true}` },
      { method: "POST", path: "/auth/accept-policies", desc: "Accept the current ToS / Privacy policy.", auth: true },
      { method: "POST", path: "/auth/login/2fa", desc: "Complete a 2FA login with the texted code.", auth: false, body: `{"identifier","code"}` },
      { method: "POST", path: "/auth/login/phone/start", desc: "Start phone-OTP login.", auth: false, body: `{"phone"}` },
      { method: "POST", path: "/auth/login/phone/verify", desc: "Verify phone-OTP login.", auth: false, body: `{"phone","code"}` },
      { method: "POST", path: "/auth/forgot-password", desc: "Email a password-reset link.", auth: false, body: `{"email"}` },
      { method: "POST", path: "/auth/forgot-password/sms", desc: "Text a password-reset code.", auth: false, body: `{"phone"}` },
      { method: "POST", path: "/auth/reset-password", desc: "Reset password with an email token.", auth: false, body: `{"token","new_password"}` },
      { method: "POST", path: "/auth/reset-password/code", desc: "Reset password with an SMS code.", auth: false, body: `{"phone","code","new_password"}` },
      { method: "POST", path: "/auth/recover-password", desc: "Recover an account via the recovery flow.", auth: false },
      { method: "GET", path: "/auth/keys/backup", desc: "Fetch your encrypted E2E key backup.", auth: true },
      { method: "POST", path: "/auth/keys/backup", desc: "Store an encrypted E2E key backup.", auth: true },
      { method: "DELETE", path: "/auth/keys/backup", desc: "Delete your E2E key backup.", auth: true },
    ],
  },
  {
    title: "Posts & Feed", icon: "newspaper",
    endpoints: [
      { method: "GET", path: "/feed/home", desc: "Home feed of posts (paginated).", auth: true },
      { method: "POST", path: "/posts", desc: "Create a post. Supports text, media[], poll, parent_id (reply), quote_of, community_id.", auth: true, body: `{"text","media":[{"type","url"}]}` },
      { method: "GET", path: "/posts/{id}", desc: "Fetch a single post with its replies.", auth: true },
      { method: "DELETE", path: "/posts/{id}", desc: "Delete one of your posts.", auth: true },
      { method: "POST", path: "/posts/{id}/like", desc: "Toggle like (blocked when likes are disabled on the post).", auth: true },
      { method: "POST", path: "/posts/{id}/bookmark", desc: "Toggle bookmark on a post.", auth: true },
      { method: "POST", path: "/posts/{id}/repost", desc: "Toggle repost.", auth: true },
      { method: "POST", path: "/posts/{id}/promote", desc: "Promote a post (days, optional budget/cpc).", auth: true, body: `{"days":7}` },
      { method: "POST", path: "/posts/{id}/view", desc: "Record a unique view.", auth: true },
      { method: "GET", path: "/posts/{id}/viewers", desc: "Who viewed the post (author only).", auth: true },
      { method: "PATCH", path: "/posts/{id}/privacy", desc: "Per-post likes_disabled + comment_policy.", auth: true, body: `{"likes_disabled":false,"comment_policy":"everyone"}` },
      { method: "GET", path: "/hashtags/trending", desc: "Most-used hashtags in the last 30 days.", auth: true },
      { method: "GET", path: "/feed/explore", desc: "Explore feed — public posts beyond who you follow.", auth: true },
      { method: "GET", path: "/feed/reels", desc: "Vertical video (reels) feed.", auth: true },
      { method: "GET", path: "/posts/popular", desc: "Currently popular posts.", auth: true },
      { method: "PATCH", path: "/posts/{id}", desc: "Edit one of your posts.", auth: true, body: `{"text"}` },
      { method: "GET", path: "/posts/{id}/thread", desc: "Full thread — the author's connected chain.", auth: true },
      { method: "GET", path: "/posts/{id}/replies", desc: "Replies to a post.", auth: true },
      { method: "POST", path: "/posts/{id}/dislike", desc: "Toggle dislike (mutually exclusive with like).", auth: true },
      { method: "POST", path: "/posts/{id}/react", desc: "Add/remove an emoji reaction.", auth: true, body: `{"emoji":"🔥"}` },
      { method: "POST", path: "/posts/{id}/vote", desc: "Vote in a poll.", auth: true, body: `{"option":0}` },
      { method: "POST", path: "/posts/{id}/pin", desc: "Pin/unpin a post to your profile.", auth: true },
      { method: "POST", path: "/posts/{id}/report", desc: "Report a post (one per user).", auth: true, body: `{"reason"}` },
      { method: "POST", path: "/posts/{id}/not-interested", desc: "Tell the feed you're not interested.", auth: true },
      { method: "GET", path: "/posts/{id}/likers", desc: "Users who liked a post.", auth: true },
      { method: "GET", path: "/posts/{id}/reposters", desc: "Users who reposted a post.", auth: true },
      { method: "GET", path: "/posts/{id}/analytics", desc: "Per-post analytics (author only).", auth: true },
      { method: "GET", path: "/posts/user/{user_id}/replies", desc: "A user's replies.", auth: true },
      { method: "GET", path: "/posts/user/{user_id}/reposts", desc: "A user's reposts.", auth: true },
      { method: "GET", path: "/posts/user/{user_id}/likes", desc: "Posts a user liked.", auth: true },
      { method: "GET", path: "/bookmarks", desc: "Your bookmarked posts.", auth: true },
      { method: "GET", path: "/drafts", desc: "Your saved post drafts.", auth: true },
      { method: "POST", path: "/drafts", desc: "Save a draft.", auth: true, body: `{"text","media":[]}` },
      { method: "PATCH", path: "/drafts/{id}", desc: "Update a draft.", auth: true },
      { method: "DELETE", path: "/drafts/{id}", desc: "Delete a draft.", auth: true },
      { method: "GET", path: "/hashtags/{tag}", desc: "Posts for a hashtag.", auth: true },
      { method: "GET", path: "/hashtags/{tag}/count", desc: "Post count for a hashtag.", auth: true },
      { method: "GET", path: "/reels/popular", desc: "Currently popular reels.", auth: true },
      { method: "POST", path: "/posts/delete-bulk", desc: "Delete several of your posts at once.", auth: true, body: `{"ids":[]}` },
      { method: "GET", path: "/posts/user/{user_id}/all", desc: "A user's posts incl. replies & reposts (combined).", auth: true },
      { method: "POST", path: "/media/resolve-video", desc: "Resolve a video link (imgur/streamable/…) to a playable file.", auth: true, body: `{"url"}` },
    ],
  },
  {
    title: "Users & Social", icon: "people",
    endpoints: [
      { method: "GET", path: "/users/search?q=", desc: "Search users by name or username.", auth: true },
      { method: "GET", path: "/posts/user/{user_id}", desc: "List a user's posts.", auth: true },
      { method: "POST", path: "/users/{user_id}/follow", desc: "Toggle follow on a user.", auth: true },
      { method: "POST", path: "/friends/request/{user_id}", desc: "Send a friend request.", auth: true },
      { method: "POST", path: "/friends/accept/{user_id}", desc: "Accept a friend request.", auth: true },
      { method: "POST", path: "/users/{user_id}/tip", desc: "Send a tip to a user.", auth: true, body: `{"amount","message"}` },
      { method: "POST", path: "/users/{user_id}/poke", desc: "Poke a user (Facebook-style).", auth: true },
      { method: "GET", path: "/subscription-tiers", desc: "The three fixed subscription tiers.", auth: false },
      { method: "POST", path: "/users/{user_id}/subscribe", desc: "Subscribe to a user (choose a tier).", auth: true, body: `{"tier":"plus"}` },
      { method: "GET", path: "/wallet", desc: "Your wallet: earnings, subscribers, and money sent.", auth: true },
      { method: "GET", path: "/friends", desc: "Your friends list.", auth: true },
      { method: "GET", path: "/friends/requests", desc: "Pending incoming/outgoing friend requests.", auth: true },
      { method: "POST", path: "/friends/reject/{user_id}", desc: "Reject an incoming friend request.", auth: true },
      { method: "DELETE", path: "/friends/request/{user_id}", desc: "Cancel a friend request you sent.", auth: true },
      { method: "DELETE", path: "/friends/{user_id}", desc: "Remove a friend.", auth: true },
      { method: "GET", path: "/circles", desc: "Your circles (custom audiences).", auth: true },
      { method: "POST", path: "/circles", desc: "Create a circle.", auth: true, body: `{"name","member_ids":[]}` },
      { method: "PATCH", path: "/circles/{id}", desc: "Rename a circle or edit its members.", auth: true },
      { method: "DELETE", path: "/circles/{id}", desc: "Delete a circle.", auth: true },
      { method: "GET", path: "/circles/{id}/members", desc: "Members of a circle.", auth: true },
      { method: "GET", path: "/recents", desc: "Recently viewed profiles.", auth: true },
      { method: "POST", path: "/recents", desc: "Record a recently viewed profile.", auth: true, body: `{"user_id"}` },
      { method: "DELETE", path: "/recents/{id}", desc: "Remove a recent.", auth: true },
      { method: "DELETE", path: "/recents", desc: "Clear all recents.", auth: true },
      { method: "GET", path: "/users/{user_id}/public", desc: "A user's public profile (relationship-aware).", auth: true },
      { method: "GET", path: "/users/by-username/{username}", desc: "Resolve a username → public profile.", auth: true },
      { method: "GET", path: "/users/{user_id}/followers", desc: "A user's followers.", auth: true },
      { method: "GET", path: "/users/{user_id}/following", desc: "Who a user follows.", auth: true },
      { method: "POST", path: "/users/{user_id}/view", desc: "Record a profile view.", auth: true },
      { method: "DELETE", path: "/users/{user_id}/subscribe", desc: "Unsubscribe from a creator.", auth: true },
      { method: "POST", path: "/users/me/unfollow-bulk", desc: "Unfollow many users at once.", auth: true, body: `{"user_ids":[]}` },
    ],
  },
  {
    title: "Communities", icon: "chatbubbles",
    endpoints: [
      { method: "GET", path: "/communities", desc: "List/search communities.", auth: true },
      { method: "POST", path: "/communities", desc: "Create a community.", auth: true, body: `{"name","title","description"}` },
      { method: "GET", path: "/communities/{name}", desc: "Get a community by handle.", auth: true },
      { method: "POST", path: "/communities/{name}/join", desc: "Join a community.", auth: true },
      { method: "GET", path: "/communities/{name}/posts?sort=hot", desc: "List threads (hot | new | top).", auth: true },
      { method: "GET", path: "/communities/feed", desc: "Cross-community feed of communities you've joined.", auth: true },
      { method: "PATCH", path: "/communities/{name}", desc: "Edit a community (mods only).", auth: true },
      { method: "DELETE", path: "/communities/{name}/join", desc: "Leave a community.", auth: true },
      { method: "POST", path: "/communities/{name}/favorite", desc: "Favorite a community.", auth: true },
      { method: "DELETE", path: "/communities/{name}/favorite", desc: "Unfavorite a community.", auth: true },
      { method: "GET", path: "/communities/{name}/members", desc: "List members.", auth: true },
      { method: "GET", path: "/communities/{name}/top", desc: "Top posts in a community.", auth: true },
      { method: "POST", path: "/communities/{name}/mods/{user_id}", desc: "Add a moderator (mods only).", auth: true },
      { method: "DELETE", path: "/communities/{name}/mods/{user_id}", desc: "Remove a moderator (mods only).", auth: true },
      { method: "DELETE", path: "/communities/{name}/members/{user_id}", desc: "Ban/remove a member (mods only).", auth: true },
      { method: "POST", path: "/communities/{name}/posts/{id}/pin", desc: "Pin a thread (mods only).", auth: true },
      { method: "POST", path: "/communities/{name}/posts/{id}/remove", desc: "Remove a thread (mods only).", auth: true },
    ],
  },
  {
    title: "Marketplace", icon: "pricetag",
    endpoints: [
      { method: "GET", path: "/listings", desc: "Browse listings (filter by category, location, radius).", auth: true },
      { method: "POST", path: "/listings", desc: "Create a listing.", auth: true, body: `{"title","price","category","photos":[]}` },
      { method: "GET", path: "/listings/{id}", desc: "Get a single listing.", auth: true },
      { method: "DELETE", path: "/listings/{id}", desc: "Remove your listing.", auth: true },
      { method: "PATCH", path: "/listings/{id}", desc: "Edit your listing.", auth: true },
      { method: "GET", path: "/listings/saved", desc: "Listings you've saved.", auth: true },
      { method: "GET", path: "/listings/user/{user_id}", desc: "A seller's listings.", auth: true },
      { method: "POST", path: "/listings/{id}/save", desc: "Save a listing.", auth: true },
      { method: "DELETE", path: "/listings/{id}/save", desc: "Unsave a listing.", auth: true },
      { method: "POST", path: "/listings/{id}/like", desc: "Toggle like on a listing.", auth: true },
      { method: "POST", path: "/listings/{id}/report", desc: "Report a listing.", auth: true, body: `{"reason"}` },
      { method: "POST", path: "/listings/{id}/contact", desc: "Start a DM with the seller.", auth: true },
      { method: "GET", path: "/listings/{id}/comments", desc: "Comments on a listing.", auth: true },
      { method: "POST", path: "/listings/{id}/comments", desc: "Comment on a listing.", auth: true, body: `{"text"}` },
      { method: "POST", path: "/listings/{id}/trade/start", desc: "Start a trade for a listing.", auth: true },
      { method: "POST", path: "/trades/confirm", desc: "Confirm a trade (both parties confirm).", auth: true, body: `{"trade_id"}` },
      { method: "GET", path: "/marketplace/users/{user_id}", desc: "A seller's public marketplace profile.", auth: true },
      { method: "GET", path: "/marketplace/users/{user_id}/reviews", desc: "Reviews for a seller.", auth: true },
      { method: "POST", path: "/marketplace/users/{user_id}/reviews", desc: "Leave a seller review (1–5★).", auth: true, body: `{"rating":5,"text"}` },
      { method: "GET", path: "/marketplace/business/me", desc: "Your business storefront.", auth: true },
      { method: "PUT", path: "/marketplace/business", desc: "Create/update your business storefront.", auth: true, body: `{"name","logo","bio"}` },
      { method: "DELETE", path: "/marketplace/business", desc: "Delete your business storefront.", auth: true },
      { method: "GET", path: "/marketplace/business/{id}", desc: "A business storefront (public).", auth: true },
      { method: "GET", path: "/marketplace/business/{id}/reviews", desc: "Reviews for a business.", auth: true },
      { method: "POST", path: "/marketplace/business/{id}/reviews", desc: "Review a business (1–5★).", auth: true, body: `{"rating":5,"text"}` },
      { method: "PATCH", path: "/listings/{id}/comments/{comment_id}", desc: "Edit your listing comment.", auth: true, body: `{"text"}` },
      { method: "DELETE", path: "/listings/{id}/comments/{comment_id}", desc: "Delete your listing comment.", auth: true },
      { method: "POST", path: "/listings/{id}/comments/{comment_id}/like", desc: "Like a listing comment.", auth: true },
    ],
  },
  {
    title: "Messaging", icon: "send",
    endpoints: [
      { method: "GET", path: "/conversations", desc: "List your conversations.", auth: true },
      { method: "POST", path: "/conversations", desc: "Open/create a DM with a user.", auth: true, body: `{"recipient_user_id"}` },
      { method: "POST", path: "/conversations/groups", desc: "Create a group chat.", auth: true, body: `{"name","member_ids":[]}` },
      { method: "GET", path: "/conversations/{id}/messages", desc: "Fetch messages (each has delivered_at / read_at).", auth: true },
      { method: "POST", path: "/conversations/{id}/messages", desc: "Send a message (text, media, voice, place, post, gif, file, contact, tip).", auth: true, body: `{"type":"text","text"}` },
      { method: "POST", path: "/conversations/{id}/read", desc: "Mark the conversation read (read receipts).", auth: true },
      { method: "POST", path: "/conversations/{id}/presence", desc: "Heartbeat — am I here / typing (Snapchat-style).", auth: true, body: `{"typing":true}` },
      { method: "GET", path: "/conversations/{id}/presence", desc: "Peer state: { typing, active }.", auth: true },
      { method: "POST", path: "/auth/keys", desc: "Publish your E2E X25519 public key.", auth: true, body: `{"public_key"}` },
      { method: "GET", path: "/users/{id}/key", desc: "Fetch a peer's E2E public key.", auth: true },
      { method: "PATCH", path: "/conversations/{id}", desc: "Rename/edit a group conversation.", auth: true },
      { method: "DELETE", path: "/conversations/{id}", desc: "Delete a conversation for you.", auth: true },
      { method: "POST", path: "/conversations/{id}/leave", desc: "Leave a group chat.", auth: true },
      { method: "POST", path: "/conversations/{id}/clear", desc: "Clear all messages for you.", auth: true },
      { method: "POST", path: "/conversations/{id}/theme", desc: "Set the conversation theme.", auth: true, body: `{"theme"}` },
      { method: "POST", path: "/conversations/{id}/disappearing", desc: "Toggle disappearing messages.", auth: true, body: `{"seconds":86400}` },
      { method: "PATCH", path: "/conversations/{id}/messages/{message_id}", desc: "Edit a message.", auth: true, body: `{"text"}` },
      { method: "DELETE", path: "/conversations/{id}/messages/{message_id}", desc: "Delete a message (tombstone).", auth: true },
      { method: "POST", path: "/conversations/{id}/messages/{message_id}/react", desc: "React to a message.", auth: true, body: `{"emoji":"❤️"}` },
      { method: "POST", path: "/conversations/{id}/messages/{message_id}/pin", desc: "Pin/unpin a message.", auth: true },
      { method: "GET", path: "/conversations/{id}/pinned", desc: "Pinned messages in a conversation.", auth: true },
      { method: "GET", path: "/conversations/{id}/scheduled", desc: "Your scheduled messages.", auth: true },
      { method: "POST", path: "/conversations/{id}/scheduled", desc: "Schedule a message to send later.", auth: true, body: `{"type":"text","text","send_at"}` },
      { method: "DELETE", path: "/conversations/{id}/scheduled/{scheduled_id}", desc: "Cancel a scheduled message.", auth: true },
      { method: "POST", path: "/conversations/{id}/summarize", desc: "AI summary of the conversation.", auth: true },
      { method: "POST", path: "/conversations/{id}/receipts", desc: "Fetch read receipts for messages.", auth: true },
      { method: "POST", path: "/conversations/{id}/messages/{message_id}/vote", desc: "Vote in an in-chat poll.", auth: true, body: `{"option":0}` },
      { method: "POST", path: "/conversations/{id}/messages/{message_id}/transcribe", desc: "Transcribe a voice note to text.", auth: true },
      { method: "POST", path: "/conversations/{id}/messages/{message_id}/scam-check", desc: "AI scam/safety check on a message.", auth: true },
    ],
  },
  {
    title: "Money (P2P)", icon: "swap-horizontal",
    endpoints: [
      { method: "GET", path: "/money/security", desc: "Whether your transfer security question is set.", auth: true },
      { method: "POST", path: "/money/security", desc: "Set the sender's security question + answer.", auth: true, body: `{"question","answer"}` },
      { method: "POST", path: "/money/send", desc: "Send money → pending transfer the recipient accepts.", auth: true, body: `{"to_user_id","amount","answer"}` },
      { method: "GET", path: "/money/transfers", desc: "Incoming (to accept) + outgoing transfers.", auth: true },
      { method: "POST", path: "/money/transfers/{id}/accept", desc: "Accept money sent to you (decline also available).", auth: true },
      { method: "POST", path: "/money/request", desc: "Request money from someone.", auth: true, body: `{"to_user_id","amount","note"}` },
      { method: "GET", path: "/money/requests", desc: "Incoming + outgoing money requests.", auth: true },
      { method: "POST", path: "/money/requests/{id}/pay", desc: "Pay a request (needs your security answer).", auth: true, body: `{"answer"}` },
      { method: "POST", path: "/money/requests/{id}/decline", desc: "Decline an incoming money request.", auth: true },
      { method: "POST", path: "/money/requests/{id}/cancel", desc: "Cancel a request you sent.", auth: true },
      { method: "GET", path: "/money/transfers/history", desc: "Full transfer history.", auth: true },
      { method: "POST", path: "/money/transfers/{id}/decline", desc: "Decline an incoming transfer.", auth: true },
      { method: "POST", path: "/money/transfers/{id}/reverse", desc: "Reverse a transfer within the 5-minute window.", auth: true },
    ],
  },
  {
    title: "Ads & Advertising", icon: "megaphone",
    endpoints: [
      { method: "GET", path: "/promoted/next?placement=feed&slot=0", desc: "Next sponsored post for a slot.", auth: true },
      { method: "POST", path: "/promoted/{id}/event", desc: "Record an impression or click.", auth: true, body: `{"type":"click","host_user_id"}` },
      { method: "GET", path: "/promoted/campaigns", desc: "Analytics for your promoted posts.", auth: true },
      { method: "GET", path: "/promoted/account", desc: "Prepaid ad-account balance + rates.", auth: true },
      { method: "POST", path: "/promoted/account/topup", desc: "Add funds to your ad account.", auth: true, body: `{"amount":25}` },
      { method: "POST", path: "/promoted/links", desc: "Advertise a link to your website.", auth: true, body: `{"url","headline","days":7}` },
      { method: "GET", path: "/promoted/links", desc: "Your link ads + analytics.", auth: true },
      { method: "DELETE", path: "/promoted/links/{ad_id}", desc: "Delete a link ad.", auth: true },
      { method: "POST", path: "/promoted/links/{ad_id}/event", desc: "Record a link-ad impression/click.", auth: true, body: `{"type":"click"}` },
      { method: "POST", path: "/promoted/reels", desc: "Create a reel (video) ad.", auth: true, body: `{"video_url","days":7}` },
      { method: "GET", path: "/promoted/reels", desc: "Your reel ads + analytics.", auth: true },
      { method: "GET", path: "/promoted/reels/serve", desc: "Next reel ad to show in the reels feed.", auth: true },
      { method: "DELETE", path: "/promoted/reels/{ad_id}", desc: "Delete a reel ad.", auth: true },
      { method: "POST", path: "/promoted/reels/{ad_id}/event", desc: "Record a reel-ad impression/click.", auth: true, body: `{"type":"click"}` },
      { method: "POST", path: "/promoted/{id}/hide", desc: "Hide a sponsored post.", auth: true },
      { method: "POST", path: "/promoted/{id}/report", desc: "Report a sponsored post.", auth: true },
    ],
  },
  {
    title: "Publisher Network", icon: "globe",
    endpoints: [
      { method: "POST", path: "/pub/sites", desc: "Register a site to show OkaySpace ads & earn. Returns a site_key.", auth: true, body: `{"name","domain"}` },
      { method: "GET", path: "/pub/sites", desc: "Your publisher sites + earnings.", auth: true },
      { method: "DELETE", path: "/pub/sites/{id}", desc: "Remove a publisher site.", auth: true },
      { method: "GET", path: "/pub/embed.js?site=KEY", desc: "Drop-in <script> embed; style via data-theme/accent/radius/label/width/height.", auth: false },
      { method: "GET", path: "/pub/unit?site=KEY", desc: "Hosted ad unit. Params: theme, accent, radius, label.", auth: false },
      { method: "GET", path: "/pub/ad?site=KEY", desc: "Public JSON ad for custom integrations.", auth: false },
    ],
  },
  {
    title: "Webhooks", icon: "git-network",
    endpoints: [
      { method: "GET", path: "/webhooks/events", desc: "List subscribable event types + descriptions.", auth: false },
      { method: "GET", path: "/webhooks", desc: "Your registered webhooks.", auth: true },
      { method: "POST", path: "/webhooks", desc: "Register an endpoint (Pro+). Returns a signing secret once.", auth: true, body: `{"url","events":[]}` },
      { method: "POST", path: "/webhooks/{id}/test", desc: "Send a signed sample ping; returns your endpoint's status.", auth: true },
      { method: "GET", path: "/webhooks/{id}/deliveries", desc: "Recent delivery attempts (status, retries, errors).", auth: true },
      { method: "POST", path: "/webhooks/{id}/deliveries/{delivery_id}/redeliver", desc: "Re-send a past delivery's original payload.", auth: true },
      { method: "DELETE", path: "/webhooks/{id}", desc: "Delete a webhook.", auth: true },
    ],
  },
  {
    title: "Embed content", icon: "share-social",
    endpoints: [
      { method: "GET", path: "/pub/post/{id}", desc: "Public JSON for a post (public posts only).", auth: false },
      { method: "GET", path: "/pub/profile/{username}", desc: "Public JSON for a user profile.", auth: false },
      { method: "GET", path: "/pub/profile/{username}/posts", desc: "A user's public posts (cursor paginated: ?limit=&cursor=).", auth: false },
      { method: "GET", path: "/pub/listing/{id}", desc: "Public JSON for an active marketplace listing.", auth: false },
      { method: "GET", path: "/pub/guide/{slug}", desc: "Public JSON for a public guide (places + owner).", auth: false },
      { method: "GET", path: "/pub/community/{name}", desc: "Public JSON for a community (title, members).", auth: false },
      { method: "GET", path: "/pub/post-card?post=ID", desc: "Themeable iframe card for a post (theme/accent/radius).", auth: false },
      { method: "GET", path: "/pub/profile-card?profile=USER", desc: "Themeable iframe card for a profile.", auth: false },
      { method: "GET", path: "/pub/listing-card?listing=ID", desc: "Themeable iframe card for a listing.", auth: false },
      { method: "GET", path: "/pub/guide-card?guide=SLUG", desc: "Themeable iframe card for a guide.", auth: false },
      { method: "GET", path: "/pub/community-card?community=NAME", desc: "Themeable iframe card for a community.", auth: false },
      { method: "GET", path: "/pub/content-embed.js", desc: "<script> loader; data-post / -profile / -listing / -guide / -community + data-theme/accent/radius.", auth: false },
      { method: "GET", path: "/pub/oembed?url=URL", desc: "oEmbed provider — paste a OkaySpace link into WordPress/Discourse to auto-embed.", auth: false },
      { method: "GET", path: "/public/guides/{slug}", desc: "Public JSON for a public guide.", auth: false },
      { method: "POST", path: "/public/guides/{slug}/clone", desc: "Clone a public guide into your account.", auth: true },
      { method: "GET", path: "/pub/click", desc: "Link-ad click redirector (tracks + forwards).", auth: false },
      { method: "GET", path: "/pub/geocode", desc: "Public geocoding proxy (?q=).", auth: false },
      { method: "POST", path: "/pub/form-checkout", desc: "Start checkout for a paid form submission.", auth: false },
      { method: "GET", path: "/pub/form-paid", desc: "Confirm a paid form submission after checkout.", auth: false },
    ],
  },
  {
    title: "Login with OkaySpace (OAuth2)", icon: "log-in",
    endpoints: [
      { method: "GET", path: "/oauth/apps", desc: "List your OAuth client apps.", auth: true },
      { method: "POST", path: "/oauth/apps", desc: "Register an OAuth client.", auth: true, body: `{"name","redirect_uris":[]}` },
      { method: "POST", path: "/oauth/authorize", desc: "Approve an app and get an authorization code (consent step).", auth: true },
      { method: "GET", path: "/oauth/app/{client_id}", desc: "Public info for an OAuth app (shown on the consent screen).", auth: false },
      { method: "GET", path: "/oauth/connections", desc: "Apps you've authorized to access your account.", auth: true },
      { method: "DELETE", path: "/oauth/connections/{id}", desc: "Revoke an app's access.", auth: true },
      { method: "POST", path: "/oauth/revoke", desc: "Revoke an access token.", auth: false, body: `{"token"}` },
      { method: "DELETE", path: "/oauth/apps/{id}", desc: "Delete one of your OAuth client apps.", auth: true },
      { method: "POST", path: "/oauth/token", desc: "Exchange a code for an access token.", auth: false, body: `{"grant_type":"authorization_code","code"}` },
      { method: "GET", path: "/oauth/userinfo", desc: "Profile for a Login-with-OkaySpace token.", auth: true },
    ],
  },
  {
    title: "Places & Directions", icon: "map",
    endpoints: [
      { method: "GET", path: "/places", desc: "List your saved places.", auth: true },
      { method: "POST", path: "/places", desc: "Save a place.", auth: true, body: `{"title","latitude","longitude","category"}` },
      { method: "POST", path: "/eta", desc: "Create a shareable live-ETA link.", auth: true, body: `{"destination_name","eta_minutes"}` },
      { method: "POST", path: "/eta/{id}/update", desc: "Push a live location update to an ETA share.", auth: true },
      { method: "GET", path: "/public/eta/{share_id}", desc: "Public ETA status (no auth).", auth: false },
    ],
  },
  {
    title: "Stories", icon: "ellipse",
    endpoints: [
      { method: "GET", path: "/stories/tray", desc: "Story tray (who has active stories).", auth: true },
      { method: "POST", path: "/stories", desc: "Post a 24h story.", auth: true, body: `{"media":{"type","url"}}` },
      { method: "POST", path: "/stories/{id}/view", desc: "Mark a story viewed.", auth: true },
      { method: "GET", path: "/stories/user/{user_id}", desc: "A user's active stories.", auth: true },
      { method: "GET", path: "/stories/{id}/viewers", desc: "Who viewed your story (author only).", auth: true },
      { method: "POST", path: "/stories/{id}/reply", desc: "Reply to a story (opens a DM).", auth: true, body: `{"text"}` },
      { method: "DELETE", path: "/stories/{id}", desc: "Delete your story.", auth: true },
    ],
  },
  {
    title: "Guides", icon: "book",
    endpoints: [
      { method: "GET", path: "/guides", desc: "Your saved guides (curated place collections).", auth: true },
      { method: "POST", path: "/guides", desc: "Create a guide.", auth: true, body: `{"title","description","public":true}` },
      { method: "PATCH", path: "/guides/{id}", desc: "Edit a guide.", auth: true },
      { method: "DELETE", path: "/guides/{id}", desc: "Delete a guide.", auth: true },
      { method: "POST", path: "/guides/{id}/places/{place_id}", desc: "Add a place to a guide.", auth: true },
      { method: "DELETE", path: "/guides/{id}/places/{place_id}", desc: "Remove a place from a guide.", auth: true },
    ],
  },
  {
    title: "Reviews", icon: "star",
    endpoints: [
      { method: "GET", path: "/reviews", desc: "Reviews for a place (?place_id=).", auth: true },
      { method: "POST", path: "/reviews", desc: "Write a place review (1–5★).", auth: true, body: `{"place_id","rating":5,"text"}` },
      { method: "DELETE", path: "/reviews/{id}", desc: "Delete your review.", auth: true },
    ],
  },
  {
    title: "Custom emojis", icon: "happy",
    endpoints: [
      { method: "GET", path: "/emojis", desc: "The global custom-emoji registry (:shortcode:).", auth: true },
      { method: "POST", path: "/emojis", desc: "Upload a custom emoji.", auth: true, body: `{"shortcode","url"}` },
      { method: "DELETE", path: "/emojis/{id}", desc: "Remove a custom emoji you added.", auth: true },
    ],
  },
  {
    title: "Notifications", icon: "notifications",
    endpoints: [
      { method: "GET", path: "/notifications", desc: "Your notification feed.", auth: true },
      { method: "GET", path: "/notifications/unread", desc: "Unread count.", auth: true },
      { method: "POST", path: "/notifications/read-all", desc: "Mark all as read.", auth: true },
      { method: "GET", path: "/notifications/activity", desc: "Engagement activity on your posts (likes/replies/reposts).", auth: true },
      { method: "POST", path: "/notifications/{id}/read", desc: "Mark one notification read.", auth: true },
      { method: "DELETE", path: "/notifications/{id}", desc: "Delete a notification.", auth: true },
    ],
  },
  {
    title: "Payments", icon: "card",
    endpoints: [
      { method: "GET", path: "/payments/config", desc: "Whether real (Stripe) payments are enabled (+ fees, publishable key).", auth: false },
      { method: "POST", path: "/payments/payouts/setup", desc: "Start Stripe Connect payout onboarding.", auth: true },
      { method: "GET", path: "/payments/payouts/status", desc: "Your payout-account status.", auth: true },
      { method: "POST", path: "/payments/checkout", desc: "Create a checkout (tip / subscription / promote).", auth: true, body: `{"kind","creator_id","amount"}` },
      { method: "POST", path: "/payments/pay-intent", desc: "Create a Stripe PaymentIntent for inline card payment.", auth: true, body: `{"amount","kind"}` },
      { method: "POST", path: "/payments/pay-intent/confirm", desc: "Confirm a PaymentIntent.", auth: true },
      { method: "POST", path: "/payments/pay-wallet", desc: "Pay using your wallet balance instead of a card.", auth: true, body: `{"amount","kind"}` },
      { method: "GET", path: "/payments/payouts/requirements", desc: "Outstanding Stripe Connect requirements.", auth: true },
      { method: "POST", path: "/payments/payouts/account-session", desc: "Stripe embedded onboarding account session.", auth: true },
      { method: "POST", path: "/payments/payouts/bank-account", desc: "Add a payout bank account.", auth: true },
      { method: "POST", path: "/payments/payouts/debit-card", desc: "Add a payout debit card (instant payouts).", auth: true },
      { method: "POST", path: "/payments/payouts/cashout", desc: "Cash out your balance to your payout method.", auth: true, body: `{"amount"}` },
      { method: "POST", path: "/payments/payouts/verification", desc: "Submit identity verification for payouts.", auth: true },
      { method: "POST", path: "/payments/payouts/verification-document", desc: "Upload a verification document.", auth: true },
      { method: "POST", path: "/payments/identity/start", desc: "Start Stripe Identity verification.", auth: true },
      { method: "GET", path: "/payments/identity/status", desc: "Identity-verification status.", auth: true },
      { method: "GET", path: "/payments/api-plan", desc: "Your Developer-API plan + limits.", auth: true },
      { method: "POST", path: "/payments/api-plan/checkout", desc: "Checkout to upgrade your API plan.", auth: true, body: `{"plan":"pro"}` },
      { method: "POST", path: "/payments/api-plan/activate", desc: "Activate a purchased API plan.", auth: true },
      { method: "GET", path: "/payments/api-usage", desc: "Your API usage + remaining quota.", auth: true },
      { method: "POST", path: "/payments/api-usage/buy", desc: "Buy a pay-as-you-go request pack.", auth: true, body: `{"packs":1}` },
      { method: "POST", path: "/payments/api-usage/activate", desc: "Activate a purchased usage pack.", auth: true },
      { method: "GET", path: "/payouts", desc: "Your payout history.", auth: true },
      { method: "POST", path: "/payouts/run", desc: "Trigger queued payouts (cron — needs X-Cron-Key).", auth: false },
    ],
  },
  {
    title: "Factcheck (community notes)", icon: "shield-checkmark",
    endpoints: [
      { method: "GET", path: "/posts/{id}/factchecks", desc: "List a post's notes with your rating + the helpfulness threshold.", auth: true },
      { method: "POST", path: "/posts/{id}/factchecks", desc: "Add a note (source link required).", auth: true, body: `{"text","source_url"}` },
      { method: "POST", path: "/factchecks/{id}/rate", desc: "Rate a note. helpful=true/false, or null to clear.", auth: true, body: `{"helpful":true}` },
      { method: "DELETE", path: "/factchecks/{id}", desc: "Delete a note (author or staff).", auth: true },
    ],
  },
  {
    title: "Hazards (driver reports)", icon: "warning",
    endpoints: [
      { method: "GET", path: "/hazards?longitude=&latitude=&radius=", desc: "Active hazards near a point (+ your own pending).", auth: true },
      { method: "POST", path: "/hazards", desc: "Report a hazard; clusters with nearby same-type reports.", auth: true, body: `{"type","longitude","latitude"}` },
      { method: "POST", path: "/hazards/{id}/confirm", desc: "Confirm a hazard is still there.", auth: true },
      { method: "POST", path: "/hazards/{id}/dismiss", desc: "Vote that a hazard is gone.", auth: true },
    ],
  },
  {
    title: "Roadside assistance", icon: "car-sport",
    endpoints: [
      { method: "GET", path: "/roadside/eligibility", desc: "Whether you can request help (verification + restrictions).", auth: true },
      { method: "GET", path: "/roadside/quote", desc: "Price quote for a tow/service (?lat&lng&type&dest_lat&dest_lng).", auth: true },
      { method: "POST", path: "/roadside/requests", desc: "Request roadside help — a tow (with destination) or light service.", auth: true, body: `{"type":"tow","lat","lng","vehicle","notes"}` },
      { method: "GET", path: "/roadside/requests/{id}", desc: "Full request detail (phone revealed to the helper after accept).", auth: true },
      { method: "POST", path: "/roadside/requests/{id}/accept", desc: "Accept an open request (helper).", auth: true },
      { method: "POST", path: "/roadside/requests/{id}/enroute", desc: "Mark en route to the requester.", auth: true },
      { method: "POST", path: "/roadside/requests/{id}/arrived", desc: "Mark on location (GPS proximity-gated).", auth: true },
      { method: "POST", path: "/roadside/requests/{id}/cancel", desc: "Cancel a request.", auth: true },
      { method: "POST", path: "/roadside/requests/{id}/edit", desc: "Edit a request's details.", auth: true },
      { method: "POST", path: "/roadside/requests/{id}/photos", desc: "Attach photos to a request.", auth: true },
      { method: "POST", path: "/roadside/requests/{id}/review", desc: "Review the other party after completion (1–5★).", auth: true, body: `{"rating":5,"text"}` },
      { method: "POST", path: "/roadside/requests/{id}/dispute", desc: "Open a dispute (recorded only with a support ticket).", auth: true },
      { method: "POST", path: "/roadside/requests/{id}/verify", desc: "Verify arrival / completion.", auth: true },
      { method: "GET", path: "/roadside/nearby", desc: "Open requests near you (?lat&lng) to accept.", auth: true },
      { method: "GET", path: "/roadside/mine", desc: "Requests you've made.", auth: true },
      { method: "GET", path: "/roadside/helping", desc: "Requests you're helping with.", auth: true },
      { method: "GET", path: "/roadside/active", desc: "Your current active request/job.", auth: true },
      { method: "GET", path: "/roadside/history", desc: "Your past roadside calls.", auth: true },
      { method: "POST", path: "/roadside/check-photo", desc: "AI check that a photo is automotive (Claude vision).", auth: true },
      { method: "GET", path: "/roadside/verification", desc: "Your helper-verification status.", auth: true },
      { method: "POST", path: "/roadside/verification", desc: "Submit helper verification documents.", auth: true },
      { method: "POST", path: "/roadside/check", desc: "AI check on a roadside request's details/photos.", auth: true },
      { method: "GET", path: "/roadside/admin/calls", desc: "Dispatch console: the day's calls (admin).", auth: true },
      { method: "POST", path: "/roadside/admin/calls", desc: "Create a test/real call (admin).", auth: true },
      { method: "DELETE", path: "/roadside/admin/calls/{id}", desc: "Delete a call (admin).", auth: true },
    ],
  },
  {
    title: "Groups (chat communities)", icon: "people-circle",
    endpoints: [
      { method: "GET", path: "/groups", desc: "List/search groups you can see.", auth: true },
      { method: "POST", path: "/groups", desc: "Create a group.", auth: true, body: `{"name","privacy":"public"}` },
      { method: "GET", path: "/groups/{id}", desc: "Get a group.", auth: true },
      { method: "PATCH", path: "/groups/{id}", desc: "Edit a group (admins).", auth: true },
      { method: "DELETE", path: "/groups/{id}", desc: "Delete a group (owner).", auth: true },
      { method: "POST", path: "/groups/{id}/join", desc: "Join (or request to join) a group.", auth: true },
      { method: "POST", path: "/groups/{id}/leave", desc: "Leave a group.", auth: true },
      { method: "GET", path: "/groups/{id}/members", desc: "List members.", auth: true },
      { method: "DELETE", path: "/groups/{id}/members/{user_id}", desc: "Remove a member (admins).", auth: true },
      { method: "POST", path: "/groups/{id}/members/{user_id}/promote", desc: "Promote a member to admin.", auth: true },
      { method: "POST", path: "/groups/{id}/members/{user_id}/demote", desc: "Demote an admin.", auth: true },
      { method: "GET", path: "/groups/{id}/posts", desc: "Group posts.", auth: true },
      { method: "POST", path: "/groups/{id}/posts", desc: "Post in a group.", auth: true, body: `{"text","media":[]}` },
      { method: "GET", path: "/groups/{id}/pins", desc: "Pinned posts.", auth: true },
      { method: "POST", path: "/groups/{id}/pins/{post_id}", desc: "Pin a post (admins).", auth: true },
      { method: "DELETE", path: "/groups/{id}/pins/{post_id}", desc: "Unpin a post.", auth: true },
      { method: "GET", path: "/groups/{id}/events", desc: "Group events.", auth: true },
      { method: "POST", path: "/groups/{id}/events", desc: "Create an event.", auth: true, body: `{"title","starts_at"}` },
      { method: "DELETE", path: "/groups/{id}/events/{event_id}", desc: "Delete an event.", auth: true },
      { method: "POST", path: "/groups/{id}/events/{event_id}/rsvp", desc: "RSVP to an event.", auth: true, body: `{"going":true}` },
      { method: "GET", path: "/groups/{id}/requests", desc: "Pending join requests (admins).", auth: true },
      { method: "POST", path: "/groups/{id}/requests/{user_id}/approve", desc: "Approve a join request.", auth: true },
      { method: "POST", path: "/groups/{id}/requests/{user_id}/reject", desc: "Reject a join request.", auth: true },
    ],
  },
  {
    title: "Wallet & top-ups", icon: "wallet",
    endpoints: [
      { method: "GET", path: "/wallet/balance", desc: "Your wallet balance.", auth: true },
      { method: "GET", path: "/wallet/activity", desc: "Wallet transaction history.", auth: true },
      { method: "GET", path: "/wallet/export", desc: "Export wallet activity (CSV).", auth: true },
      { method: "POST", path: "/wallet/currency", desc: "Set your display currency.", auth: true, body: `{"currency":"USD"}` },
      { method: "GET", path: "/wallet/topups", desc: "Your top-up history.", auth: true },
      { method: "POST", path: "/wallet/topup", desc: "Top up your wallet (test-mode or Stripe).", auth: true, body: `{"amount":25}` },
      { method: "POST", path: "/wallet/topup/intent", desc: "Create a Stripe PaymentIntent for a top-up.", auth: true, body: `{"amount":25}` },
      { method: "POST", path: "/wallet/topup/confirm", desc: "Confirm a top-up.", auth: true },
      { method: "POST", path: "/wallet/topup/confirm-intent", desc: "Confirm a PaymentIntent top-up.", auth: true },
      { method: "POST", path: "/wallet/topup/sync", desc: "Reconcile a top-up's status with Stripe.", auth: true },
      { method: "POST", path: "/wallet/topup/{id}/cancel", desc: "Cancel a pending top-up.", auth: true },
    ],
  },
  {
    title: "Support tickets", icon: "help-buoy",
    endpoints: [
      { method: "GET", path: "/support/tickets", desc: "Your support tickets / disputes.", auth: true },
      { method: "POST", path: "/support/tickets", desc: "Open a ticket.", auth: true, body: `{"category","subject","message"}` },
      { method: "GET", path: "/support/tickets/{id}", desc: "A ticket with its messages.", auth: true },
      { method: "POST", path: "/support/tickets/{id}/messages", desc: "Reply on a ticket.", auth: true, body: `{"message"}` },
      { method: "POST", path: "/support/tickets/{id}/status", desc: "Change a ticket's status (staff).", auth: true, body: `{"status":"resolved"}` },
      { method: "GET", path: "/support/unread-count", desc: "Unread support-message count.", auth: true },
    ],
  },
  {
    title: "Maps, transit & calls", icon: "navigate",
    endpoints: [
      { method: "GET", path: "/places/{id}", desc: "Get a saved place.", auth: true },
      { method: "DELETE", path: "/places/{id}", desc: "Delete a saved place.", auth: true },
      { method: "POST", path: "/eta/{id}/stop", desc: "Stop sharing a live-ETA.", auth: true },
      { method: "GET", path: "/transit/nearby", desc: "Nearby transit stops + next departures (?lat&lng).", auth: true },
      { method: "GET", path: "/transit/plan", desc: "Plan a transit trip (?from&to).", auth: true },
      { method: "GET", path: "/foursquare/search", desc: "Search places via Foursquare (?q&lat&lng).", auth: true },
      { method: "GET", path: "/foursquare/match", desc: "Match a pin to a Foursquare business profile.", auth: true },
      { method: "POST", path: "/calls/{id}/token", desc: "LiveKit room token for a voice/video call.", auth: true },
      { method: "POST", path: "/calls/{id}/ring", desc: "Ring the other participant.", auth: true },
    ],
  },
  {
    title: "Games", icon: "game-controller",
    endpoints: [
      { method: "GET", path: "/games", desc: "List games (?mine=true for your own).", auth: true },
      { method: "POST", path: "/games", desc: "Publish a game (inline html or a hosted url).", auth: true, body: `{"title","description","url","html","thumbnail"}` },
      { method: "GET", path: "/games/{id}", desc: "Get a game.", auth: true },
      { method: "DELETE", path: "/games/{id}", desc: "Delete a game (owner or staff).", auth: true },
      { method: "POST", path: "/games/{id}/score", desc: "Submit a score (host-mediated; best is kept).", auth: true, body: `{"score":100}` },
      { method: "GET", path: "/games/{id}/leaderboard", desc: "Top scores for a game.", auth: true },
      { method: "GET", path: "/pub/games/sdk.js", desc: "Public: the OkaySpace Games SDK (OkaySpaceGames.ready/submitScore/getPlayer/exit + create3D).", auth: false },
      { method: "GET", path: "/pub/game/{id}", desc: "Public: the playable game frame (SDK injected for inline games).", auth: false },
    ],
  },
  {
    title: "Meta", icon: "information-circle",
    endpoints: [
      { method: "GET", path: "/version", desc: "API name + version.", auth: false },
      { method: "GET", path: "/v1/info", desc: "Machine-readable API overview & capabilities.", auth: false },
      { method: "GET", path: "/public/app-config", desc: "Public client config (no auth).", auth: false },
      { method: "GET", path: "/currencies", desc: "Supported display currencies + rates.", auth: false },
      { method: "GET", path: "/badges", desc: "The catalog of profile badges.", auth: true },
      { method: "GET", path: "/points/leaderboard", desc: "Global activity-points leaderboard.", auth: true },
      { method: "GET", path: "/policies", desc: "Current ToS / Privacy policy text + version.", auth: false },
      { method: "POST", path: "/presence/ping", desc: "Mark yourself active now (presence heartbeat).", auth: true },
      { method: "POST", path: "/push/register", desc: "Register a device push token.", auth: true, body: `{"token","platform"}` },
      { method: "DELETE", path: "/push/register", desc: "Unregister a device push token.", auth: true },
    ],
  },
];

type Lang = "curl" | "js" | "python" | "dart";
const SAMPLE: Record<Lang, (base: string) => string> = {
  curl: (b) => `curl ${b}/feed/home \\\n  -H "Authorization: Bearer $OKAYSPACE_KEY"`,
  js: (b) => `const res = await fetch("${b}/feed/home", {\n  headers: { Authorization: \`Bearer \${process.env.OKAYSPACE_KEY}\` },\n});\nconst feed = await res.json();`,
  python: (b) => `import requests\nr = requests.get(\n  "${b}/feed/home",\n  headers={"Authorization": f"Bearer {OKAYSPACE_KEY}"},\n)\nfeed = r.json()`,
  dart: (b) => `import 'package:http/http.dart' as http;\nimport 'dart:convert';\n\nfinal res = await http.get(\n  Uri.parse("${b}/feed/home"),\n  headers: {"Authorization": "Bearer $OKAYSPACE_KEY"},\n);\nfinal feed = jsonDecode(res.body);`,
};
const LANG_LABEL: Record<Lang, string> = { curl: "cURL", js: "JavaScript", python: "Python", dart: "Dart / Flutter" };

const METHOD_COLOR: Record<Method, string> = {
  GET: "#22C55E", POST: "#0EA5E9", PUT: "#8B5CF6", PATCH: "#EAB308", DELETE: "#F15C6D",
};

// Drop-in embed examples for the "Embed & SDKs" section. Customizable via
// data-* attributes (web) or query params (anywhere, incl. a Flutter WebView).
const EMBED_SNIPPET = `<script async
  src="${BASE}/api/pub/form-embed.js?form=YOUR_FORM_KEY"
  data-theme="dark"
  data-accent="7C3AED"
  data-height="620"
  data-redirect="https://yoursite.com/thanks"
  data-prefill='{"email":"user@site.com"}'>
</script>`;
const FLUTTER_WEBVIEW = `// pubspec.yaml → webview_flutter: ^4.0.0
import 'package:webview_flutter/webview_flutter.dart';

final c = WebViewController()
  ..loadRequest(Uri.parse(
    "${BASE}/api/pub/form-unit?form=YOUR_FORM_KEY"
    "&theme=dark&accent=7C3AED"));

// in build(): WebViewWidget(controller: c)`;

// ── Flutter & Dart kit ──────────────────────────────────────────────────────
const DART_CLIENT = `// pubspec.yaml → http: ^1.0.0
import 'dart:convert';
import 'package:http/http.dart' as http;

class OkaySpace {
  OkaySpace(this.apiKey, {this.base = '${API_BASE}'});
  final String apiKey;
  final String base;

  Map<String, String> get _h => {
        'Authorization': 'Bearer \$apiKey',
        'Content-Type': 'application/json',
      };

  Future<dynamic> _check(http.Response r) {
    final body = r.body.isEmpty ? null : jsonDecode(r.body);
    if (r.statusCode >= 400) {
      final e = (body?['error'] ?? {}) as Map;
      throw OkaySpaceError(
          e['code'] ?? '\${r.statusCode}', e['message'] ?? 'request failed');
    }
    return Future.value(body);
  }

  Future<dynamic> get(String path) async =>
      _check(await http.get(Uri.parse('\$base\$path'), headers: _h));

  Future<dynamic> post(String path, [Map<String, dynamic>? body]) async =>
      _check(await http.post(Uri.parse('\$base\$path'),
          headers: _h, body: jsonEncode(body ?? {})));
}

class OkaySpaceError implements Exception {
  OkaySpaceError(this.code, this.message);
  final String code, message;
  @override
  String toString() => 'OkaySpaceError(\$code): \$message';
}

// Usage
final api = OkaySpace('YOUR_API_KEY');
final feed = await api.get('/feed/home');
await api.post('/posts', {'text': 'Hello from Flutter 👋'});`;

const DART_WS = `// pubspec.yaml → web_socket_channel: ^2.4.0
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';

// Live ETA stream (public). Messaging/calls use
// wss://.../ws/conversations/<id>?token=<session_token>
final ch = WebSocketChannel.connect(
  Uri.parse('${BASE.replace(/^https/, "wss")}/ws/eta/\$shareId'),
);
ch.stream.listen((raw) {
  final data = jsonDecode(raw);   // { lat, lng, eta_minutes, ... }
  // update your map marker…
});
// ch.sink.add(jsonEncode({...}));  // send
// ch.sink.close();`;

const DART_SECURE = `// pubspec.yaml → flutter_secure_storage: ^9.0.0
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const storage = FlutterSecureStorage();
// Never hard-code the key — store it in the platform keystore/keychain.
await storage.write(key: 'okayspace_key', value: apiKey);
final key = await storage.read(key: 'okayspace_key');`;

const DART_CARD = `// Render any PUBLIC content card natively — no API key needed.
final c = WebViewController()
  ..loadRequest(Uri.parse(
    '${BASE}/api/pub/post-card?post=POST_ID'
    '&theme=dark&accent=00A884&radius=16'));
// build(): SizedBox(height: 320, child: WebViewWidget(controller: c))`;

const DART_PAGINATE = `// Walk every page of a list. Cursor where supported, else offset.
Future<List<dynamic>> fetchAll(OkaySpace api, String path) async {
  final out = <dynamic>[];
  String? cursor;
  do {
    final sep = path.contains('?') ? '&' : '?';
    final q = cursor != null ? '\${sep}cursor=\$cursor' : '';
    final page = await api.get('\$path\$q');
    final items = page is List ? page : (page['items'] as List? ?? const []);
    out.addAll(items);
    cursor = page is Map ? page['next_cursor'] as String? : null;
  } while (cursor != null);
  return out;
}
// Or simple offset paging:
//   await api.get('/feed/home?limit=20&offset=40');`;

const DART_OAUTH = `// "Sign in with OkaySpace" (OAuth2 authorization-code).
// 1) Send the user to the consent page (url_launcher / flutter_web_auth_2):
final authUrl = Uri.parse('${BASE}/api/oauth/authorize').replace(queryParameters: {
  'client_id': 'YOUR_CLIENT_ID',
  'redirect_uri': 'https://yourapp.com/callback',
  'response_type': 'code',
});
// …open authUrl, then capture ?code=… from the redirect.

// 2) Exchange the code on YOUR SERVER (keep client_secret off the device):
final r = await http.post(Uri.parse('${BASE}/api/oauth/token'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({
      'grant_type': 'authorization_code',
      'code': code,
      'client_id': 'YOUR_CLIENT_ID',
      'client_secret': 'YOUR_CLIENT_SECRET',   // server only!
      'redirect_uri': 'https://yourapp.com/callback',
    }));
final token = jsonDecode(r.body)['access_token'];

// 3) Use the token like any key:
final me = await OkaySpace(token).get('/oauth/userinfo'); // {sub,name,picture,…}`;

const DART_WEBHOOK = `// pubspec.yaml → crypto: ^3.0.0   (verify in your Dart backend)
import 'dart:convert';
import 'package:crypto/crypto.dart';

bool verifyWebhook(String rawBody, String sigHeader, String secret) {
  // X-OkaySpace-Signature looks like "sha256=<hex>"
  final expected = 'sha256=' +
      Hmac(sha256, utf8.encode(secret)).convert(utf8.encode(rawBody)).toString();
  if (sigHeader.length != expected.length) return false;
  var diff = 0;                                   // constant-time compare
  for (var i = 0; i < expected.length; i++) {
    diff |= sigHeader.codeUnitAt(i) ^ expected.codeUnitAt(i);
  }
  return diff == 0;
}
// Reject with 401 if it doesn't match. Use the RAW request body, not re-encoded JSON.`;

const CONTENT_SNIPPET = `<!-- Embed a OkaySpace post, profile, listing, guide, or community -->
<!-- swap data-post for data-profile / data-listing / data-guide / data-community -->
<script async src="${BASE}/api/pub/content-embed.js"
  data-post="POST_ID" data-theme="dark" data-accent="7C3AED"></script>`;
const WEBHOOK_VERIFY = `// Verify the X-OkaySpace-Signature header (Node / Express)
import crypto from "crypto";

app.post("/hook", express.raw({ type: "*/*" }), (req, res) => {
  const sig = req.header("X-OkaySpace-Signature") || "";           // "sha256=<hex>"
  const expected = "sha256=" + crypto
    .createHmac("sha256", process.env.OKAYSPACE_WEBHOOK_SECRET)
    .update(req.body)                                          // the RAW body
    .digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
    return res.status(401).end();
  const event = JSON.parse(req.body);                          // { event, data, created_at }
  res.sendStatus(200);
});`;
const EMBED_ATTRS: [string, string][] = [
  ["theme", "light (default) or dark"],
  ["accent", "button colour, 3/6-digit hex (no #)"],
  ["bg", "background colour, hex"],
  ["radius", "corner radius in px (0–28)"],
  ["hide_title", "1 to hide the title & description"],
  ["redirect", "URL to send users to after submit"],
  ["pf_<field_id>", "pre-fill a field (query param)"],
];

export default function DeveloperScreen() {
  const router = useRouter();
  const confirm = useConfirm();
  const insets = useSafeAreaInsets();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [openGroup, setOpenGroup] = useState<string | null>("Authentication");
  const [epQuery, setEpQuery] = useState("");
  const [lang, setLang] = useState<Lang>("curl");
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof api.getApiPlan>> | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [writeScope, setWriteScope] = useState(true);
  const [webhooks, setWebhooks] = useState<DevWebhook[]>([]);
  const [whUrl, setWhUrl] = useState("");
  const [whBusy, setWhBusy] = useState(false);
  const [whTesting, setWhTesting] = useState<string | null>(null);
  const [whEvents, setWhEvents] = useState<{ event: string; description: string }[]>([]);
  const [whSelected, setWhSelected] = useState<string[]>([]);
  const [openLogs, setOpenLogs] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, WebhookDelivery[]>>({});
  const [logsBusy, setLogsBusy] = useState(false);
  const [redelivering, setRedelivering] = useState<string | null>(null);
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof api.getApiUsage>> | null>(null);
  const [buyingPack, setBuyingPack] = useState<string | null>(null);
  const [oauthApps, setOauthApps] = useState<OAuthApp[]>([]);
  const [appName, setAppName] = useState("");
  const [appUri, setAppUri] = useState("");
  const [appBusy, setAppBusy] = useState(false);
  const [freshApp, setFreshApp] = useState<{ client_id: string; client_secret: string } | null>(null);

  const active = !!plan?.current.active;
  const planFeatures = plan?.plans.find((p) => p.id === plan?.current.plan);

  const load = useCallback(async () => {
    try { setKeys((await api.listApiKeys()).keys); } catch {} finally { setLoading(false); }
    try { setPlan(await api.getApiPlan()); } catch {}
    try { setWebhooks((await api.listWebhooks()).webhooks); } catch {}
    try {
      const r = await api.listWebhookEvents();
      setWhEvents(r.event_info || (r.events || []).map((e) => ({ event: e, description: "" })));
    } catch {}
    try { setUsage(await api.getApiUsage()); } catch {}
    try { setOauthApps((await api.listOAuthApps()).apps); } catch {}
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const createOAuthApp = async () => {
    if (!appName.trim() || !appUri.trim()) return;
    setAppBusy(true);
    try {
      const res = await api.createOAuthApp(appName.trim(), [appUri.trim()]);
      setFreshApp(res);
      setAppName(""); setAppUri("");
      await load();
    } catch (e: any) {
      Alert.alert("Couldn't create app", errText(e));
    } finally { setAppBusy(false); }
  };
  const removeOAuthApp = async (clientId: string) => {
    if (!(await confirm({
      title: "Delete OAuth app",
      message: "Sites using it will stop being able to sign users in.",
      confirmLabel: "Delete",
      destructive: true,
    }))) return;
    try { await api.deleteOAuthApp(clientId); await load(); } catch {}
  };

  const buyPack = async (packId: string) => {
    setBuyingPack(packId);
    try {
      if (usage?.stripe_enabled) {
        const { url } = await api.buyUsage(packId);
        await Linking.openURL(url);
      } else {
        await api.activateUsage(packId);
        await load();
      }
    } catch (e: any) {
      Alert.alert("Couldn't buy pack", errText(e));
    } finally { setBuyingPack(null); }
  };

  const copy = async (text: string, what = "Copied") => {
    try { await Clipboard.setStringAsync(text); Alert.alert(what, "Copied to clipboard."); } catch {}
  };

  const buyPlan = async (planId: string) => {
    setBuying(planId);
    try {
      if (plan?.stripe_enabled) {
        const { url } = await api.apiPlanCheckout(planId);
        await Linking.openURL(url);
      } else {
        await api.apiPlanActivate(planId);   // test mode
        await load();
      }
    } catch (e: any) {
      Alert.alert("Couldn't start plan", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setBuying(null); }
  };

  const generate = async () => {
    setCreating(true);
    try {
      const scopes = writeScope && planFeatures?.write ? ["read", "write"] : ["read"];
      const res = await api.createApiKey(label.trim() || "API key", scopes);
      setFreshToken(res.token);
      setLabel("");
      await load();
    } catch (e: any) {
      Alert.alert("Couldn't create key", errText(e));
    } finally { setCreating(false); }
  };

  const addWebhook = async () => {
    if (!whUrl.trim()) return;
    setWhBusy(true);
    try {
      const w = await api.createWebhook(whUrl.trim(), whSelected.length ? whSelected : undefined);
      setFreshSecret(w.secret || null);
      setWhUrl(""); setWhSelected([]);
      await load();
    } catch (e: any) {
      Alert.alert("Couldn't add webhook", errText(e));
    } finally { setWhBusy(false); }
  };

  const toggleEvent = (e: string) =>
    setWhSelected((s) => (s.includes(e) ? s.filter((x) => x !== e) : [...s, e]));

  const loadLogs = async (id: string) => {
    try { const r = await api.listWebhookDeliveries(id); setLogs((m) => ({ ...m, [id]: r.deliveries })); } catch {}
  };

  const toggleLogs = async (id: string) => {
    if (openLogs === id) { setOpenLogs(null); return; }
    setOpenLogs(id);
    if (!logs[id]) { setLogsBusy(true); try { await loadLogs(id); } finally { setLogsBusy(false); } }
  };

  const redeliver = async (webhookId: string, deliveryId: string) => {
    setRedelivering(deliveryId);
    try {
      const r = await api.redeliverWebhook(webhookId, deliveryId);
      await loadLogs(webhookId);
      Alert.alert(r.ok ? "Re-sent" : "Re-send failed", r.ok ? `Your endpoint replied ${r.status}.` : r.status ? `Your endpoint replied ${r.status}.` : "Couldn't reach the endpoint.");
    } catch (e: any) {
      Alert.alert("Re-send failed", errText(e));
    } finally { setRedelivering(null); }
  };

  const removeWebhook = async (id: string) => {
    if (!(await confirm({
      title: "Delete webhook",
      message: "Stop sending events to this URL?",
      confirmLabel: "Delete",
      destructive: true,
    }))) return;
    try { await api.deleteWebhook(id); await load(); } catch {}
  };

  const testWebhook = async (id: string) => {
    setWhTesting(id);
    try {
      const r = await api.testWebhook(id);
      Alert.alert(
        r.ok ? "Test delivered" : "Test failed",
        r.ok ? `Your endpoint replied ${r.status}. Check for the signed "ping" event.`
             : r.status ? `Your endpoint replied ${r.status}.` : `Couldn't reach the endpoint.${r.error ? `\n${r.error}` : ""}`,
      );
    } catch (e: any) {
      Alert.alert("Test failed", errText(e));
    } finally { setWhTesting(null); }
  };

  const revoke = async (k: ApiKey) => {
    if (!(await confirm({
      title: "Revoke key",
      message: `Revoke "${k.label}"? Apps using it will stop working.`,
      confirmLabel: "Revoke",
      destructive: true,
    }))) return;
    try { await api.revokeApiKey(k.id); await load(); } catch {}
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="developer-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.backBtn} testID="developer-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Developer API</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
        <Text style={styles.lede}>
          Build on top of OkaySpace. The REST API uses JSON over HTTPS and bearer-token auth.
        </Text>
        <View style={styles.docLinks}>
          <TouchableOpacity style={styles.docLink} onPress={() => Linking.openURL(`${BASE}/docs`)} testID="open-swagger">
            <Ionicons name="book-outline" size={15} color={theme.primary} />
            <Text style={styles.docLinkText}>Interactive docs</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.docLink} onPress={() => Linking.openURL(`${BASE}/openapi.json`)} testID="open-openapi">
            <Ionicons name="code-download-outline" size={15} color={theme.primary} />
            <Text style={styles.docLinkText}>OpenAPI schema</Text>
          </TouchableOpacity>
        </View>

        {/* Base URL + auth */}
        <Text style={styles.groupTitle}>Base URL</Text>
        <TouchableOpacity style={styles.codeRow} onPress={() => copy(API_BASE, "Base URL")} activeOpacity={0.7}>
          <Text style={styles.code} selectable>{API_BASE}</Text>
          <Ionicons name="copy-outline" size={16} color={theme.textMuted} />
        </TouchableOpacity>
        <Text style={[styles.body, { marginTop: 8 }]}>
          Versioned and stable — build against <Text style={styles.codeInline}>/api/v1</Text>. The unversioned <Text style={styles.codeInline}>/api</Text> still works as a legacy alias.
        </Text>

        <Text style={styles.groupTitle}>Authentication</Text>
        <Text style={styles.body}>
          Send your API key (or a session token) as a bearer token on every request:
        </Text>
        <TouchableOpacity style={styles.codeRow} onPress={() => copy("Authorization: Bearer YOUR_API_KEY", "Header")} activeOpacity={0.7}>
          <Text style={styles.code} selectable>Authorization: Bearer YOUR_API_KEY</Text>
          <Ionicons name="copy-outline" size={16} color={theme.textMuted} />
        </TouchableOpacity>

        {/* Plan */}
        <Text style={styles.groupTitle}>Your plan</Text>
        {active ? (
          <View style={styles.planActive}>
            <Ionicons name="checkmark-circle" size={18} color={theme.primary} />
            <Text style={styles.planActiveText}>
              {plan?.current.name} active{plan?.current.until ? ` · renews ${fmtDate(plan.current.until)}` : ""}
            </Text>
          </View>
        ) : (
          <Text style={styles.body}>
            The Developer API is a paid add-on — higher tiers unlock more keys, write access, webhooks and rate limits.
            {plan && !plan.stripe_enabled ? " (Test mode — no real charge.)" : ""}
          </Text>
        )}
        <View style={styles.planRow}>
          {(plan?.plans || []).map((p) => {
            const isCurrent = active && plan?.current.plan === p.id;
            return (
              <View key={p.id} style={[styles.planCard, isCurrent && styles.planCardOn]}>
                <Text style={styles.planName}>{p.name}</Text>
                <Text style={styles.planPrice}>${p.price.toFixed(2)}<Text style={styles.planPer}>/mo</Text></Text>
                <Text style={styles.planFeat}>{p.max_keys} API keys</Text>
                <Text style={styles.planFeat}>{p.write ? "Read + write" : "Read-only"}</Text>
                <Text style={styles.planFeat}>{p.webhooks ? "Webhooks" : "No webhooks"}</Text>
                <Text style={styles.planFeat}>{p.rate_per_min.toLocaleString()} req/min</Text>
                <TouchableOpacity
                  style={[styles.planBtn, isCurrent && { backgroundColor: theme.surfaceAlt }]}
                  onPress={() => buyPlan(p.id)}
                  disabled={!!buying || isCurrent}
                  testID={`plan-${p.id}`}
                >
                  {buying === p.id ? <ActivityIndicator color="#fff" size="small" /> :
                    <Text style={[styles.planBtnText, isCurrent && { color: theme.textSecondary }]}>{isCurrent ? "Current" : active ? "Switch" : "Choose"}</Text>}
                </TouchableOpacity>
              </View>
            );
          })}
        </View>

        {/* Usage */}
        {active && usage && (
          <>
            <Text style={styles.groupTitle}>Usage this period</Text>
            <View style={styles.usageCard}>
              <View style={styles.usageHead}>
                <Text style={styles.usageNums}>{usage.used.toLocaleString()} / {usage.limit.toLocaleString()}</Text>
                <Text style={styles.usageReset}>{usage.resets_at ? `resets ${fmtDate(usage.resets_at)}` : ""}</Text>
              </View>
              <View style={styles.usageTrack}>
                <View style={[styles.usageFill, { width: `${Math.min(100, usage.limit ? (usage.used / usage.limit) * 100 : 0)}%` }, usage.used >= usage.limit && { backgroundColor: theme.error }]} />
              </View>
              {usage.extra_credits > 0 && <Text style={styles.usageExtra}>+{usage.extra_credits.toLocaleString()} pay-as-you-go credits included</Text>}
              <Text style={styles.body}>
                {usage.used >= usage.limit
                  ? "Quota reached — buy more requests to keep going, or wait for the reset."
                  : "Hit your quota? Buy a pay-as-you-go pack instead of waiting for the reset."}
              </Text>
              <View style={styles.packRow}>
                {usage.packs.map((pk) => (
                  <TouchableOpacity key={pk.id} style={styles.packCard} onPress={() => buyPack(pk.id)} disabled={!!buyingPack} testID={`pack-${pk.id}`}>
                    {buyingPack === pk.id ? <ActivityIndicator color={theme.primary} size="small" /> : (
                      <>
                        <Text style={styles.packName}>{pk.name}</Text>
                        <Text style={styles.packPrice}>${pk.price.toFixed(2)}</Text>
                      </>
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </>
        )}

        {/* API keys */}
        <Text style={styles.groupTitle}>Your API keys</Text>
        {!active ? (
          <Text style={styles.empty}>Subscribe to a plan above to create API keys.</Text>
        ) : (
        <>
        {freshToken && (
          <View style={styles.freshCard}>
            <Text style={styles.freshLabel}>New key — copy it now, it won't be shown again:</Text>
            <TouchableOpacity style={styles.freshTokenRow} onPress={() => copy(freshToken, "API key")} activeOpacity={0.7}>
              <Text style={styles.freshToken} selectable numberOfLines={1}>{freshToken}</Text>
              <Ionicons name="copy" size={16} color={theme.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setFreshToken(null)}><Text style={styles.dismiss}>Done</Text></TouchableOpacity>
          </View>
        )}
        <View style={styles.scopeRow}>
          <TouchableOpacity
            style={[styles.scopeChip, !writeScope && styles.scopeChipOn]}
            onPress={() => setWriteScope(false)}
            testID="scope-read"
          >
            <Ionicons name="eye-outline" size={14} color={!writeScope ? theme.primary : theme.textMuted} />
            <Text style={[styles.scopeText, !writeScope && { color: theme.primary }]}>Read-only</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.scopeChip, writeScope && styles.scopeChipOn, !planFeatures?.write && { opacity: 0.4 }]}
            onPress={() => planFeatures?.write && setWriteScope(true)}
            disabled={!planFeatures?.write}
            testID="scope-write"
          >
            <Ionicons name="create-outline" size={14} color={writeScope ? theme.primary : theme.textMuted} />
            <Text style={[styles.scopeText, writeScope && { color: theme.primary }]}>Read &amp; write</Text>
          </TouchableOpacity>
          {!planFeatures?.write && <Text style={styles.scopeHint}>Write needs Pro+</Text>}
        </View>
        <View style={styles.keyInputRow}>
          <TextInput
            style={styles.keyInput} placeholder="Key label (e.g. My bot)" placeholderTextColor={theme.textMuted}
            value={label} onChangeText={setLabel} maxLength={60} testID="api-key-label"
          />
          <TouchableOpacity style={[styles.genBtn, creating && { opacity: 0.6 }]} onPress={generate} disabled={creating} testID="api-key-generate">
            {creating ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.genBtnText}>Generate</Text>}
          </TouchableOpacity>
        </View>
        {loading ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 14 }} />
        ) : keys.length === 0 ? (
          <Text style={styles.empty}>No API keys yet. Generate one to start building.</Text>
        ) : (
          keys.map((k) => (
            <View key={k.id} style={styles.keyRow}>
              <View style={styles.keyIcon}><Ionicons name="key" size={15} color={theme.primary} /></View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={styles.keyLabel} numberOfLines={1}>{k.label}</Text>
                  <Text style={styles.scopeBadge}>{(k.scopes || []).includes("write") ? "read+write" : "read"}</Text>
                </View>
                <Text style={styles.keyMeta}>
                  {k.key_prefix}··· · {fmtDate(k.created_at)}{k.last_used_at ? ` · used ${fmtDate(k.last_used_at)}` : " · never used"}
                </Text>
              </View>
              <TouchableOpacity onPress={() => revoke(k)} hitSlop={8} testID={`api-key-revoke-${k.id}`}>
                <Ionicons name="trash-outline" size={18} color={theme.error} />
              </TouchableOpacity>
            </View>
          ))
        )}
        </>
        )}

        {/* Webhooks */}
        <Text style={styles.groupTitle}>Webhooks</Text>
        {!planFeatures?.webhooks ? (
          <Text style={styles.empty}>
            {active ? "Webhooks require the Pro plan or higher." : "Subscribe to Pro+ to receive event webhooks."}
          </Text>
        ) : (
          <>
            <Text style={styles.body}>We POST signed events (follows, messages, tips, form submissions, …) to your URL with up to 3 retries, and keep a delivery log. Always verify the `X-OkaySpace-Signature` header — it's `sha256=` followed by the HMAC-SHA256 (hex) of the raw request body, keyed with your signing secret:</Text>
            <TouchableOpacity style={styles.codeBlock} onPress={() => copy(WEBHOOK_VERIFY, "Verification")} activeOpacity={0.7}>
              <Text style={styles.codeBlockText} selectable>{WEBHOOK_VERIFY}</Text>
            </TouchableOpacity>
            {freshSecret && (
              <View style={styles.freshCard}>
                <Text style={styles.freshLabel}>Signing secret — copy it now, shown once:</Text>
                <TouchableOpacity style={styles.freshTokenRow} onPress={() => copy(freshSecret, "Webhook secret")} activeOpacity={0.7}>
                  <Text style={styles.freshToken} selectable numberOfLines={1}>{freshSecret}</Text>
                  <Ionicons name="copy" size={16} color={theme.primary} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setFreshSecret(null)}><Text style={styles.dismiss}>Done</Text></TouchableOpacity>
              </View>
            )}
            {whEvents.length > 0 && (
              <>
                <Text style={[styles.body, { marginBottom: 6 }]}>Choose events to subscribe to (none = all {whEvents.length}):</Text>
                <View style={styles.eventWrap}>
                  {whEvents.map((e) => {
                    const on = whSelected.includes(e.event);
                    return (
                      <TouchableOpacity key={e.event} style={[styles.eventChip, on && styles.eventChipOn]} onPress={() => toggleEvent(e.event)} testID={`wh-ev-${e.event}`}>
                        <Text style={[styles.eventChipText, on && { color: theme.primary }]}>{e.event}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </>
            )}
            <View style={[styles.keyInputRow, { marginTop: 10 }]}>
              <TextInput
                style={styles.keyInput} placeholder="https://your-server.com/hook" placeholderTextColor={theme.textMuted}
                value={whUrl} onChangeText={setWhUrl} autoCapitalize="none" autoCorrect={false} testID="webhook-url"
              />
              <TouchableOpacity style={[styles.genBtn, whBusy && { opacity: 0.6 }]} onPress={addWebhook} disabled={whBusy} testID="webhook-add">
                {whBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.genBtnText}>Add</Text>}
              </TouchableOpacity>
            </View>
            {webhooks.length === 0 ? (
              <Text style={styles.empty}>No webhooks yet.</Text>
            ) : webhooks.map((w) => (
              <View key={w.id}>
                <View style={styles.keyRow}>
                  <View style={styles.keyIcon}><Ionicons name="git-network-outline" size={15} color={theme.primary} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.keyLabel} numberOfLines={1}>{w.url}</Text>
                    <Text style={styles.keyMeta}>{(w.events || []).length} events · {fmtDate(w.created_at)}</Text>
                  </View>
                  <TouchableOpacity onPress={() => toggleLogs(w.id)} hitSlop={8} style={styles.whTestBtn} testID={`webhook-logs-${w.id}`}>
                    <Text style={styles.whTestText}>{openLogs === w.id ? "Hide" : "Logs"}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => testWebhook(w.id)} disabled={whTesting === w.id} hitSlop={8} style={styles.whTestBtn} testID={`webhook-test-${w.id}`}>
                    {whTesting === w.id ? <ActivityIndicator color={theme.primary} size="small" /> : <Text style={styles.whTestText}>Test</Text>}
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => removeWebhook(w.id)} hitSlop={8} testID={`webhook-del-${w.id}`}>
                    <Ionicons name="trash-outline" size={18} color={theme.error} />
                  </TouchableOpacity>
                </View>
                {openLogs === w.id && (
                  <View style={styles.logsBox}>
                    {logsBusy && !logs[w.id] ? (
                      <ActivityIndicator color={theme.primary} size="small" />
                    ) : (logs[w.id] || []).length === 0 ? (
                      <Text style={styles.empty}>No deliveries yet. Use Test to send a ping.</Text>
                    ) : (logs[w.id] || []).map((d) => (
                      <View key={d.id} style={styles.logRow}>
                        <View style={[styles.logDot, { backgroundColor: d.ok ? theme.success : theme.error }]} />
                        <Text style={styles.logEvent} numberOfLines={1}>{d.event}</Text>
                        <Text style={styles.logMeta}>{d.status || "—"}{d.attempts > 1 ? ` ·${d.attempts}x` : ""} · {fmtDate(d.created_at)}</Text>
                        <TouchableOpacity onPress={() => redeliver(w.id, d.id)} disabled={redelivering === d.id} hitSlop={6} testID={`wh-redeliver-${d.id}`}>
                          {redelivering === d.id ? <ActivityIndicator color={theme.primary} size="small" /> : <Ionicons name="refresh" size={15} color={theme.primary} />}
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            ))}
          </>
        )}

        {/* Login with OkaySpace (OAuth apps) */}
        <Text style={styles.groupTitle}>Login with OkaySpace</Text>
        <Text style={styles.body}>
          Let other sites add a "Sign in with OkaySpace" button. Register an app to get a client ID + secret, then use the OAuth2 authorization-code flow.
        </Text>
        {freshApp && (
          <View style={styles.freshCard}>
            <Text style={styles.freshLabel}>Client ID</Text>
            <TouchableOpacity style={styles.freshTokenRow} onPress={() => copy(freshApp.client_id, "Client ID")} activeOpacity={0.7}>
              <Text style={styles.freshToken} selectable numberOfLines={1}>{freshApp.client_id}</Text>
              <Ionicons name="copy" size={16} color={theme.primary} />
            </TouchableOpacity>
            <Text style={styles.freshLabel}>Client secret — copy it now, shown once:</Text>
            <TouchableOpacity style={styles.freshTokenRow} onPress={() => copy(freshApp.client_secret, "Client secret")} activeOpacity={0.7}>
              <Text style={styles.freshToken} selectable numberOfLines={1}>{freshApp.client_secret}</Text>
              <Ionicons name="copy" size={16} color={theme.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setFreshApp(null)}><Text style={styles.dismiss}>Done</Text></TouchableOpacity>
          </View>
        )}
        <TextInput
          style={[styles.keyInput, { marginBottom: 8 }]} placeholder="App name" placeholderTextColor={theme.textMuted}
          value={appName} onChangeText={setAppName} maxLength={80} testID="oauth-app-name"
        />
        <View style={styles.keyInputRow}>
          <TextInput
            style={styles.keyInput} placeholder="https://yoursite.com/callback" placeholderTextColor={theme.textMuted}
            value={appUri} onChangeText={setAppUri} autoCapitalize="none" autoCorrect={false} testID="oauth-app-uri"
          />
          <TouchableOpacity style={[styles.genBtn, appBusy && { opacity: 0.6 }]} onPress={createOAuthApp} disabled={appBusy} testID="oauth-app-create">
            {appBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.genBtnText}>Create</Text>}
          </TouchableOpacity>
        </View>
        {oauthApps.length === 0 ? (
          <Text style={styles.empty}>No OAuth apps yet.</Text>
        ) : oauthApps.map((a) => (
          <View key={a.client_id} style={styles.keyRow}>
            <View style={styles.keyIcon}><Ionicons name="log-in-outline" size={15} color={theme.primary} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.keyLabel} numberOfLines={1}>{a.name}</Text>
              <Text style={styles.keyMeta} numberOfLines={1}>{a.client_id}</Text>
            </View>
            <TouchableOpacity onPress={() => removeOAuthApp(a.client_id)} hitSlop={8} testID={`oauth-del-${a.client_id}`}>
              <Ionicons name="trash-outline" size={18} color={theme.error} />
            </TouchableOpacity>
          </View>
        ))}

        {/* Quickstart */}
        <Text style={styles.groupTitle}>Quickstart</Text>
        <View style={styles.langRow}>
          {(["curl", "js", "python", "dart"] as Lang[]).map((l) => (
            <TouchableOpacity key={l} onPress={() => setLang(l)} style={[styles.langTab, lang === l && styles.langTabOn]} testID={`lang-${l}`}>
              <Text style={[styles.langText, lang === l && { color: theme.primary }]}>{LANG_LABEL[l]}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(SAMPLE[lang](API_BASE), "Example")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{SAMPLE[lang](API_BASE)}</Text>
        </TouchableOpacity>

        {/* Embed & SDKs */}
        <Text style={styles.groupTitle}>Embed & customize</Text>
        <Text style={styles.body}>
          Drop a OkaySpace form into any website or app and theme it to match your brand — no auth, no backend. Paste the snippet and tweak the <Text style={styles.codeInline}>data-*</Text> attributes:
        </Text>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(EMBED_SNIPPET, "Embed snippet")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{EMBED_SNIPPET}</Text>
        </TouchableOpacity>
        <View style={[styles.convCard, { marginTop: 10 }]}>
          {EMBED_ATTRS.map(([k, v]) => (
            <Text key={k} style={styles.convItem}><Text style={styles.convKey}>{k} </Text>{v}</Text>
          ))}
        </View>
        <Text style={[styles.body, { marginTop: 12 }]}>
          The same knobs work as query params on <Text style={styles.codeInline}>/pub/form-unit</Text>, so you can embed the form in a native app — e.g. a Flutter <Text style={styles.codeInline}>WebView</Text>:
        </Text>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(FLUTTER_WEBVIEW, "Flutter snippet")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{FLUTTER_WEBVIEW}</Text>
        </TouchableOpacity>

        <Text style={[styles.body, { marginTop: 12 }]}>
          You can also embed OkaySpace <Text style={styles.codeInline}>content</Text> — posts and profiles — as themeable cards, or rely on <Text style={styles.codeInline}>oEmbed</Text> so a pasted OkaySpace link auto-expands in WordPress, Discourse, Notion and other oEmbed-aware tools:
        </Text>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(CONTENT_SNIPPET, "Content embed")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{CONTENT_SNIPPET}</Text>
        </TouchableOpacity>
        <Text style={[styles.body, { marginTop: 8 }]}>
          oEmbed endpoint: <Text style={styles.codeInline}>{`${BASE}/api/pub/oembed?url=<okayspace link>`}</Text> — only public content is served (no subscriber-only posts, no banned users).
        </Text>

        <Text style={[styles.groupTitle, { marginTop: 22 }]}>SDKs & client generation</Text>
        <Text style={styles.body}>
          OkaySpace is a plain JSON+HTTPS API, so it works from any language — Dart/Flutter, Swift, Kotlin, Go, Rust and more. For a fully-typed client, generate one from the OpenAPI schema:
        </Text>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(`# Dart/Flutter client from the OpenAPI schema\ndart pub global activate openapi_generator_cli\nopenapi-generator generate \\\n  -i ${BASE}/openapi.json \\\n  -g dart-dio -o ./okayspace_client`, "Codegen")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{`# Dart/Flutter client from the OpenAPI schema\ndart pub global activate openapi_generator_cli\nopenapi-generator generate \\\n  -i ${BASE}/openapi.json \\\n  -g dart-dio -o ./okayspace_client`}</Text>
        </TouchableOpacity>
        <Text style={[styles.body, { marginTop: 8 }]}>
          Swap <Text style={styles.codeInline}>-g dart-dio</Text> for <Text style={styles.codeInline}>swift5</Text>, <Text style={styles.codeInline}>kotlin</Text>, <Text style={styles.codeInline}>go</Text>, <Text style={styles.codeInline}>typescript-fetch</Text>, etc. CORS is open, so browser and mobile apps can call the API directly.
        </Text>

        {/* Flutter & Dart */}
        <Text style={[styles.groupTitle, { marginTop: 22 }]}>Flutter & Dart</Text>
        <Text style={styles.body}>A tiny client (just `http`) with the Bearer auth and the `{"{"}error{"}"}` envelope handled — paste it in and go. Tap any block to copy.</Text>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(DART_CLIENT, "Dart client")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{DART_CLIENT}</Text>
        </TouchableOpacity>
        <Text style={[styles.body, { marginTop: 8 }]}>Realtime (live ETA, messaging presence, calls) over WebSockets:</Text>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(DART_WS, "Dart WebSocket")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{DART_WS}</Text>
        </TouchableOpacity>
        <Text style={[styles.body, { marginTop: 8 }]}>Store your key in the platform keystore, never in source:</Text>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(DART_SECURE, "Dart secure storage")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{DART_SECURE}</Text>
        </TouchableOpacity>
        <Text style={[styles.body, { marginTop: 8 }]}>Drop a OkaySpace post / profile / listing card into a Flutter screen (no key needed):</Text>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(DART_CARD, "Flutter card")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{DART_CARD}</Text>
        </TouchableOpacity>
        <Text style={[styles.body, { marginTop: 8 }]}>Page through any list (cursor where supported, else offset):</Text>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(DART_PAGINATE, "Dart pagination")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{DART_PAGINATE}</Text>
        </TouchableOpacity>
        <Text style={[styles.body, { marginTop: 8 }]}>“Sign in with OkaySpace” (OAuth2) — exchange the code server-side so the client secret never ships in the app:</Text>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(DART_OAUTH, "Dart OAuth")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{DART_OAUTH}</Text>
        </TouchableOpacity>
        <Text style={[styles.body, { marginTop: 8 }]}>Verify incoming webhooks (HMAC-SHA256 of the raw body) in a Dart backend:</Text>
        <TouchableOpacity style={styles.codeBlock} onPress={() => copy(DART_WEBHOOK, "Dart webhook verify")} activeOpacity={0.7}>
          <Text style={styles.codeBlockText} selectable>{DART_WEBHOOK}</Text>
        </TouchableOpacity>
        <Text style={[styles.body, { marginTop: 8 }]}>
          Packages: <Text style={styles.codeInline}>http</Text> or <Text style={styles.codeInline}>dio</Text> (REST), <Text style={styles.codeInline}>web_socket_channel</Text> (realtime), <Text style={styles.codeInline}>flutter_secure_storage</Text> (keys), <Text style={styles.codeInline}>webview_flutter</Text> (embeds). For a fully-typed client, use the dart-dio codegen above.
        </Text>

        {/* Conventions */}
        <Text style={styles.groupTitle}>Conventions</Text>
        <View style={styles.convCard}>
          <Text style={styles.convItem}><Text style={styles.convKey}>Format </Text>JSON request & response bodies; `Content-Type: application/json`.</Text>
          <Text style={styles.convItem}><Text style={styles.convKey}>Versioning </Text>The stable base is `/api/v1`. The unversioned `/api` is kept as a legacy alias so existing keys keep working.</Text>
          <Text style={styles.convItem}><Text style={styles.convKey}>Pagination </Text>List endpoints accept `?limit=` and `?offset=`. Some also support cursor paging — pass the returned `next_cursor` as `?cursor=` (null = end).</Text>
          <Text style={styles.convItem}><Text style={styles.convKey}>Idempotency </Text>Send an `Idempotency-Key` header (any unique value) on writes (POST/PUT/PATCH/DELETE). Retries with the same key replay the first response (header `Idempotent-Replay: true`) — safe against double-submits.</Text>
          <Text style={styles.convItem}><Text style={styles.convKey}>Errors </Text>Every non-2xx reply uses one shape: `{"{"}"error":{"{"}"code","message"{"}"}{"}"}` (also mirrored under `detail`). e.g. 401 unauthorized, 403 forbidden, 404 not_found, 413 payload_too_large, 422 validation_error, 429 rate_limited.</Text>
          <Text style={styles.convItem}><Text style={styles.convKey}>Rate limits </Text>Fair-use; heavy automated traffic may be throttled (429).</Text>
        </View>

        {/* Endpoint reference */}
        <Text style={styles.groupTitle}>Endpoint reference</Text>
        <View style={styles.epSearch}>
          <Ionicons name="search" size={15} color={theme.textMuted} />
          <TextInput
            style={[styles.epSearchInput, Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null]}
            value={epQuery}
            onChangeText={setEpQuery}
            placeholder="Search endpoints — path, method or words"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            testID="ep-search"
          />
          {!!epQuery && (
            <TouchableOpacity onPress={() => setEpQuery("")} hitSlop={8} testID="ep-search-clear">
              <Ionicons name="close-circle" size={16} color={theme.textMuted} />
            </TouchableOpacity>
          )}
        </View>
        {(() => {
          const q = epQuery.trim().toLowerCase();
          const groups = q
            ? GROUPS.map((g) => ({
                ...g,
                endpoints: g.endpoints.filter((e) =>
                  e.path.toLowerCase().includes(q) ||
                  e.method.toLowerCase().includes(q) ||
                  e.desc.toLowerCase().includes(q)),
              })).filter((g) => g.endpoints.length > 0)
            : GROUPS;
          if (q && groups.length === 0) {
            return <Text style={styles.epEmpty}>No endpoints match “{epQuery.trim()}”.</Text>;
          }
          return groups.map((g) => {
            const open = q ? true : openGroup === g.title;  // searching auto-expands matches
            return (
              <View key={g.title} style={styles.refGroup}>
                <TouchableOpacity style={styles.refHeader} onPress={() => { if (!q) setOpenGroup(open ? null : g.title); }} activeOpacity={q ? 1 : 0.7}>
                  <Ionicons name={g.icon} size={17} color={theme.primary} />
                  <Text style={styles.refTitle}>{g.title}</Text>
                  <Text style={styles.refCount}>{g.endpoints.length}</Text>
                  {!q && <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={theme.textMuted} />}
                </TouchableOpacity>
                {open && g.endpoints.map((e, i) => (
                  <View key={i} style={styles.epRow}>
                    <View style={styles.epLine}>
                      <Text style={[styles.method, { color: METHOD_COLOR[e.method], borderColor: METHOD_COLOR[e.method] + "66" }]}>{e.method}</Text>
                      <Text style={styles.epPath} selectable>{e.path}</Text>
                      {e.auth === false && <Text style={styles.publicTag}>public</Text>}
                    </View>
                    <Text style={styles.epDesc}>{e.desc}</Text>
                    {!!e.body && <Text style={styles.epBody} selectable>body {e.body}</Text>}
                  </View>
                ))}
              </View>
            );
          });
        })()}

        <Text style={styles.footer}>
          Keep your API keys and signing secrets safe — treat them like passwords. Heavy automated traffic may be rate-limited (429).
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function errText(e: any): string {
  return String(e?.message || e || "Something went wrong").replace(/^\d{3}:\s*/, "");
}
function fmtDate(iso: string) {
  try { return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }); } catch { return ""; }
}

const styles = StyleSheet.create({
  docLinks: { flexDirection: "row", gap: 10, marginTop: 12 },
  docLink: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  docLinkText: { color: theme.primary, fontSize: 13, fontWeight: "700" },
  langRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  langTab: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  langTabOn: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  langText: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "700" },
  convCard: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, padding: 14, gap: 9 },
  convItem: { color: theme.textSecondary, fontSize: 13, lineHeight: 19 },
  convKey: { color: theme.textPrimary, fontWeight: "800" },
  planActive: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(0,168,132,0.10)", borderWidth: 1, borderColor: theme.primary, borderRadius: 12, padding: 12, marginBottom: 10 },
  planActiveText: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  planRow: { flexDirection: "row", gap: 10, marginTop: 6 },
  planCard: { flex: 1, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, padding: 12, gap: 3 },
  planCardOn: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  planName: { color: theme.textPrimary, fontSize: 14, fontWeight: "800" },
  planPrice: { color: theme.textPrimary, fontSize: 18, fontWeight: "900", marginBottom: 4 },
  planPer: { color: theme.textMuted, fontSize: 11, fontWeight: "700" },
  planFeat: { color: theme.textSecondary, fontSize: 11.5 },
  planBtn: { backgroundColor: theme.primary, borderRadius: 10, paddingVertical: 9, alignItems: "center", marginTop: 8 },
  planBtnText: { color: "#fff", fontWeight: "800", fontSize: 12.5 },
  scopeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  scopeChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  scopeChipOn: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  scopeText: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "700" },
  scopeHint: { color: theme.textMuted, fontSize: 11 },
  scopeBadge: { color: theme.textMuted, fontSize: 10, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.3, borderWidth: 1, borderColor: theme.border, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1 },
  usageCard: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, padding: 14, gap: 8 },
  usageHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  usageNums: { color: theme.textPrimary, fontSize: 16, fontWeight: "800" },
  usageReset: { color: theme.textMuted, fontSize: 12 },
  usageTrack: { height: 8, borderRadius: 4, backgroundColor: theme.surfaceAlt, overflow: "hidden" },
  usageFill: { height: 8, borderRadius: 4, backgroundColor: theme.primary },
  usageExtra: { color: theme.primary, fontSize: 12, fontWeight: "600" },
  packRow: { flexDirection: "row", gap: 8 },
  packCard: { flex: 1, backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, borderRadius: 10, paddingVertical: 10, alignItems: "center", gap: 2 },
  packName: { color: theme.textPrimary, fontSize: 12, fontWeight: "700" },
  packPrice: { color: theme.primary, fontSize: 14, fontWeight: "800" },
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  backBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },

  lede: { color: theme.textSecondary, fontSize: 14, lineHeight: 20, marginTop: 4 },
  groupTitle: { color: theme.textMuted, fontSize: 13, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 26, marginBottom: 10 },
  body: { color: theme.textSecondary, fontSize: 13.5, lineHeight: 19, marginBottom: 8 },

  codeRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  code: { flex: 1, color: theme.textPrimary, fontSize: 13, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  codeInline: { color: theme.textPrimary, fontSize: 12.5, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  codeBlock: { backgroundColor: "#0E0E10", borderWidth: 1, borderColor: theme.border, borderRadius: 12, padding: 14 },
  codeBlockText: { color: "#9FE7C8", fontSize: 12.5, lineHeight: 19, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },

  freshCard: { backgroundColor: "rgba(0,168,132,0.10)", borderWidth: 1, borderColor: theme.primary, borderRadius: 14, padding: 14, marginBottom: 12, gap: 8 },
  freshLabel: { color: theme.textSecondary, fontSize: 12.5 },
  freshTokenRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.surfaceAlt, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  freshToken: { flex: 1, color: theme.textPrimary, fontSize: 12.5, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  dismiss: { color: theme.primary, fontSize: 13, fontWeight: "700", alignSelf: "flex-end" },

  keyInputRow: { flexDirection: "row", gap: 10 },
  keyInput: { flex: 1, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, height: 46, color: theme.textPrimary, fontSize: 14, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  genBtn: { backgroundColor: theme.primary, borderRadius: 12, paddingHorizontal: 20, height: 46, alignItems: "center", justifyContent: "center" },
  genBtnText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  empty: { color: theme.textMuted, fontSize: 13, marginTop: 12 },
  keyRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  whTestBtn: { borderWidth: 1, borderColor: theme.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, minWidth: 52, alignItems: "center", justifyContent: "center" },
  whTestText: { color: theme.primary, fontSize: 12.5, fontWeight: "800" },
  eventWrap: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  eventChip: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5 },
  eventChipOn: { borderColor: theme.primary, backgroundColor: "rgba(0,168,132,0.10)" },
  eventChipText: { color: theme.textSecondary, fontSize: 11.5, fontWeight: "700", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  logsBox: { backgroundColor: theme.surfaceAlt, borderRadius: 10, padding: 10, marginTop: -2, marginBottom: 8, gap: 6 },
  logRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  logDot: { width: 7, height: 7, borderRadius: 4 },
  logEvent: { flex: 1, color: theme.textPrimary, fontSize: 12.5, fontWeight: "700", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  logMeta: { color: theme.textMuted, fontSize: 11.5 },
  keyIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: theme.surfaceAlt, alignItems: "center", justifyContent: "center" },
  keyLabel: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  keyMeta: { color: theme.textMuted, fontSize: 12, marginTop: 1, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },

  epSearch: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 12, height: 42, marginBottom: 12 },
  epSearchInput: { flex: 1, color: theme.textPrimary, fontSize: 14, paddingVertical: 0 },
  epEmpty: { color: theme.textMuted, fontSize: 13, paddingVertical: 18, textAlign: "center" },
  refGroup: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, marginBottom: 10, overflow: "hidden" },
  refHeader: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 14 },
  refTitle: { flex: 1, color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  refCount: { color: theme.textMuted, fontSize: 12, fontWeight: "700" },
  epRow: { paddingHorizontal: 14, paddingVertical: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border, gap: 4 },
  epLine: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  method: { fontSize: 10.5, fontWeight: "900", letterSpacing: 0.5, borderWidth: 1, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, overflow: "hidden" },
  epPath: { color: theme.textPrimary, fontSize: 13, fontWeight: "600", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", flexShrink: 1 },
  publicTag: { color: theme.textMuted, fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4, borderWidth: 1, borderColor: theme.border, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1 },
  epDesc: { color: theme.textSecondary, fontSize: 13, lineHeight: 18 },
  epBody: { color: theme.textMuted, fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  footer: { color: theme.textMuted, fontSize: 12, lineHeight: 18, marginTop: 24 },
});
