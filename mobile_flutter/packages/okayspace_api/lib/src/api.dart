import 'package:http/http.dart' as http;

import 'api_client.dart';
import 'models.dart';
import 'token_store.dart';

/// Typed facade over the OkaySpace backend — the Dart counterpart of the `api`
/// object in `frontend/src/api/client.ts`.
///
/// The most-used flows (auth, feed/posts, users, messaging, notifications,
/// wallet) are typed below. Every *other* endpoint (the backend exposes ~425)
/// is still reachable through [raw] (an [ApiClient]) using getJson/postJson/...,
/// so you never have to wait for a typed wrapper to ship a feature.
///
/// ```dart
/// final api = OkaySpaceApi(baseUrl: 'https://okayspace.ca');
/// await api.login(identifier: 'me@example.com', password: '••••');
/// final feed = await api.homeFeed();
/// // not-yet-typed endpoint:
/// final places = await api.raw.getJson('/places');
/// ```
class OkaySpaceApi {
  OkaySpaceApi({
    required String baseUrl,
    TokenStore? tokenStore,
    http.Client? httpClient,
  }) : raw = ApiClient(baseUrl: baseUrl, tokenStore: tokenStore, httpClient: httpClient);

  /// Low-level client. Use `raw.getJson('/path')` etc. for untyped endpoints,
  /// and `raw.tokenStore` to read/clear the session token.
  final ApiClient raw;

  // ---------------------------------------------------------------------------
  // Auth & profile
  // ---------------------------------------------------------------------------
  Future<User> me() async => User.fromJson(await raw.getJson('/auth/me'));

  Future<AuthResult> login({required String identifier, required String password}) =>
      _handleAuth(raw.postJson('/auth/login', body: {'identifier': identifier, 'password': password}));

  Future<AuthResult> register({
    required String email,
    required String password,
    required String name,
    required String username,
  }) =>
      _handleAuth(raw.postJson('/auth/register',
          body: {'email': email, 'password': password, 'name': name, 'username': username}));

  /// Complete a 2FA login with the texted code.
  Future<AuthResult> verify2fa({required String identifier, required String code}) =>
      _handleAuth(raw.postJson('/auth/login/2fa', body: {'identifier': identifier, 'code': code}));

  Future<void> logout() async {
    try {
      await raw.postJson('/auth/logout');
    } finally {
      await raw.tokenStore.clear();
    }
  }

  Future<User> updateMe(Map<String, dynamic> patch) async =>
      User.fromJson(await raw.patchJson('/auth/me', body: patch));

  Future<bool> usernameAvailable(String u) async {
    final r = await raw.getJson('/auth/username-available?u=${Uri.encodeComponent(u)}');
    return r['available'] == true;
  }

  Future<User> setUsername(String username) async =>
      User.fromJson(await raw.postJson('/auth/username', body: {'username': username}));

  Future<AuthResult> _handleAuth(Future<dynamic> future) async {
    final r = await future;
    if (r is Map && r['twofa_required'] == true) {
      return AuthResult.twofa(TwofaChallenge.fromJson(Map<String, dynamic>.from(r)));
    }
    final token = r['session_token'] as String;
    await raw.tokenStore.write(token);
    return AuthResult.success(token, User.fromJson(Map<String, dynamic>.from(r['user'])));
  }

  // ---------------------------------------------------------------------------
  // Feed & posts
  // ---------------------------------------------------------------------------
  Future<List<Post>> homeFeed() async => _posts(await raw.getJson('/feed/home'));
  Future<List<Post>> exploreFeed() async => _posts(await raw.getJson('/feed/explore'));
  Future<List<Post>> popularPosts() async => _posts(await raw.getJson('/posts/popular'));
  Future<List<Post>> bookmarks() async => _posts(await raw.getJson('/bookmarks'));
  Future<List<Post>> hashtagPosts(String tag) async =>
      _posts(await raw.getJson('/hashtags/${Uri.encodeComponent(tag.replaceFirst(RegExp(r'^#'), ''))}'));

  Future<Post> getPost(String id) async => Post.fromJson(await raw.getJson('/posts/$id'));
  Future<List<Post>> listReplies(String id) async => _posts(await raw.getJson('/posts/$id/replies'));
  Future<List<Post>> userPosts(String userId) async => _posts(await raw.getJson('/posts/user/$userId'));

  Future<Post> createPost(Map<String, dynamic> body) async =>
      Post.fromJson(await raw.postJson('/posts', body: body));
  Future<void> deletePost(String id) async => raw.deleteJson('/posts/$id');

  Future<Post> toggleLike(String id) async => Post.fromJson(await raw.postJson('/posts/$id/like'));
  Future<Post> toggleDislike(String id) async => Post.fromJson(await raw.postJson('/posts/$id/dislike'));
  Future<Post> toggleRepost(String id) async => Post.fromJson(await raw.postJson('/posts/$id/repost'));
  Future<Post> toggleBookmark(String id) async => Post.fromJson(await raw.postJson('/posts/$id/bookmark'));
  Future<Post> reactToPost(String id, String emoji) async =>
      Post.fromJson(await raw.postJson('/posts/$id/react', body: {'emoji': emoji}));

  List<Post> _posts(dynamic r) =>
      (r as List).map((e) => Post.fromJson(Map<String, dynamic>.from(e))).toList();

  // ---------------------------------------------------------------------------
  // Users, follows, search
  // ---------------------------------------------------------------------------
  Future<List<PublicUser>> searchUsers(String q) async =>
      _users(await raw.getJson('/users/search?q=${Uri.encodeComponent(q)}'));

  Future<PublicUser> getPublicUser(String userId) async =>
      PublicUser.fromJson(await raw.getJson('/users/$userId/public'));

  /// Returns the new following state.
  Future<bool> toggleFollow(String userId) async {
    final r = await raw.postJson('/users/$userId/follow');
    return r['following'] == true;
  }

  Future<List<PublicUser>> followers(String userId) async =>
      _users(await raw.getJson('/users/$userId/followers'));
  Future<List<PublicUser>> following(String userId) async =>
      _users(await raw.getJson('/users/$userId/following'));

  List<PublicUser> _users(dynamic r) =>
      (r as List).map((e) => PublicUser.fromJson(Map<String, dynamic>.from(e))).toList();

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------
  Future<List<ConversationView>> listConversations() async =>
      (await raw.getJson('/conversations') as List)
          .map((e) => ConversationView.fromJson(Map<String, dynamic>.from(e)))
          .toList();

  Future<ConversationView> getOrCreateConversation(String recipientUserId) async =>
      ConversationView.fromJson(
          await raw.postJson('/conversations', body: {'recipient_user_id': recipientUserId}));

  Future<ConversationView> createGroupChat({
    required String name,
    required List<String> memberIds,
    String? avatar,
  }) async =>
      ConversationView.fromJson(await raw.postJson('/conversations/groups',
          body: {'name': name, 'member_ids': memberIds, if (avatar != null) 'avatar': avatar}));

  Future<void> deleteConversation(String convId) async => raw.deleteJson('/conversations/$convId');

  Future<List<Message>> listMessages(String convId) async =>
      (await raw.getJson('/conversations/$convId/messages') as List)
          .map((e) => Message.fromJson(Map<String, dynamic>.from(e)))
          .toList();

  Future<Message> sendMessage(String convId, MessageCreate body) async =>
      Message.fromJson(await raw.postJson('/conversations/$convId/messages', body: body.toJson()));

  /// Convenience for the common case.
  Future<Message> sendText(String convId, String text, {String? replyTo}) =>
      sendMessage(convId, MessageCreate(type: 'text', text: text, replyTo: replyTo));

  Future<void> markConversationRead(String convId) async =>
      raw.postJson('/conversations/$convId/read');

  Future<Message> reactToMessage(String convId, String msgId, String emoji) async => Message.fromJson(
      await raw.postJson('/conversations/$convId/messages/$msgId/react', body: {'emoji': emoji}));

  Future<Message> editMessage(String convId, String msgId, String text) async => Message.fromJson(
      await raw.patchJson('/conversations/$convId/messages/$msgId', body: {'text': text}));

  Future<void> deleteMessage(String convId, String msgId) async =>
      raw.deleteJson('/conversations/$convId/messages/$msgId');

  Future<Message> pinMessage(String convId, String msgId) async =>
      Message.fromJson(await raw.postJson('/conversations/$convId/messages/$msgId/pin'));

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------
  Future<List<AppNotification>> listNotifications() async =>
      (await raw.getJson('/notifications') as List)
          .map((e) => AppNotification.fromJson(Map<String, dynamic>.from(e)))
          .toList();

  Future<int> unreadNotificationsCount() async {
    final r = await raw.getJson('/notifications/unread');
    return asInt(r['count']);
  }

  Future<void> markNotificationRead(String id) async => raw.postJson('/notifications/$id/read');
  Future<void> markAllNotificationsRead() async => raw.postJson('/notifications/read-all');

  // ---------------------------------------------------------------------------
  // Wallet & gamification
  // ---------------------------------------------------------------------------
  Future<WalletBalance> getWalletBalance() async =>
      WalletBalance.fromJson(await raw.getJson('/wallet/balance'));

  Future<List<LeaderboardEntry>> pointsLeaderboard() async {
    final r = await raw.getJson('/points/leaderboard');
    return (r['leaders'] as List)
        .map((e) => LeaderboardEntry.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }

  /// Heartbeat (call periodically while the app is foregrounded).
  Future<void> presencePing() async => raw.postJson('/presence/ping');

  void close() => raw.close();
}
