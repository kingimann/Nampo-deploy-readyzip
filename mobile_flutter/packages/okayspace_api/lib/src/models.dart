// Dart models mirroring the TypeScript types in `frontend/src/api/client.ts`.
//
// They parse leniently: known fields are typed, and the original decoded map is
// kept on `.raw` so nothing is lost if the backend returns extra fields (the
// JSONB store is loosely typed). Class names that would clash with Flutter's
// Material widgets are prefixed (UserBadge, AppNotification).

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------
String? asStr(dynamic v) => v?.toString();
String str(dynamic v, [String d = '']) => v?.toString() ?? d;

int asInt(dynamic v, [int d = 0]) => v is int
    ? v
    : v is num
        ? v.toInt()
        : v is String
            ? int.tryParse(v) ?? d
            : d;

double asDouble(dynamic v, [double d = 0]) => v is num
    ? v.toDouble()
    : v is String
        ? double.tryParse(v) ?? d
        : d;

bool asBool(dynamic v, [bool d = false]) => v is bool ? v : d;

Map<String, dynamic> asMap(dynamic v) =>
    v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};

List<T> asList<T>(dynamic v, T Function(dynamic) f) =>
    v is List ? v.map(f).toList() : <T>[];

Map<String, String> asStrMap(dynamic v) => v is Map
    ? v.map((k, val) => MapEntry(k.toString(), val.toString()))
    : <String, String>{};

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
class User {
  User.fromJson(Map<String, dynamic> j)
      : raw = j,
        userId = str(j['user_id']),
        email = str(j['email']),
        name = str(j['name']),
        username = asStr(j['username']),
        picture = asStr(j['picture']),
        bio = str(j['bio']),
        coverPhoto = asStr(j['cover_photo']),
        accentColor = asStr(j['accent_color']),
        verified = asBool(j['verified']),
        role = str(j['role'], 'user'),
        points = asInt(j['points']),
        level = asInt(j['level']),
        levelTitle = asStr(j['level_title']),
        isPrivate = asBool(j['is_private']),
        emailVerified = asBool(j['email_verified']),
        phoneVerified = asBool(j['phone_verified']),
        idVerified = asBool(j['id_verified']),
        messagingDisabled = asBool(j['messaging_disabled']),
        postingDisabled = asBool(j['posting_disabled']),
        marketplaceDisabled = asBool(j['marketplace_disabled']),
        needsPolicyAgreement = asBool(j['needs_policy_agreement']);

  final Map<String, dynamic> raw;
  final String userId;
  final String email;
  final String name;
  final String? username;
  final String? picture;
  final String bio;
  final String? coverPhoto;
  final String? accentColor;
  final bool verified;
  final String role; // user | mod | admin
  final int points;
  final int level;
  final String? levelTitle;
  final bool isPrivate;
  final bool emailVerified;
  final bool phoneVerified;
  final bool idVerified;
  final bool messagingDisabled;
  final bool postingDisabled;
  final bool marketplaceDisabled;
  final bool needsPolicyAgreement;

  bool get isAdmin => role == 'admin';
  bool get isStaff => role == 'admin' || role == 'mod';
}

class PublicUser {
  PublicUser.fromJson(Map<String, dynamic> j)
      : raw = j,
        userId = str(j['user_id']),
        name = str(j['name']),
        username = asStr(j['username']),
        picture = asStr(j['picture']),
        bio = str(j['bio']),
        verified = asBool(j['verified']),
        online = asBool(j['online']),
        lastSeen = asStr(j['last_seen']),
        role = asStr(j['role']),
        isFollowing = asBool(j['is_following']),
        isFollowedBy = asBool(j['is_followed_by']),
        friendStatus = asStr(j['friend_status']),
        isSubscribed = asBool(j['is_subscribed']),
        points = asInt(j['points']),
        level = asInt(j['level']),
        badges = asList(j['badges'], (e) => UserBadge.fromJson(asMap(e)));

  final Map<String, dynamic> raw;
  final String userId;
  final String name;
  final String? username;
  final String? picture;
  final String bio;
  final bool verified;
  final bool online;
  final String? lastSeen;
  final String? role;
  final bool isFollowing;
  final bool isFollowedBy;
  final String? friendStatus; // none | requested | incoming | friends
  final bool isSubscribed;
  final int points;
  final int level;
  final List<UserBadge> badges;
}

class UserBadge {
  UserBadge.fromJson(Map<String, dynamic> j)
      : raw = j,
        id = str(j['id']),
        label = str(j['label']),
        icon = str(j['icon']),
        color = asStr(j['color']);

  final Map<String, dynamic> raw;
  final String id;
  final String label;
  final String icon;
  final String? color;
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------
class PostAuthor {
  PostAuthor.fromJson(Map<String, dynamic> j)
      : raw = j,
        userId = str(j['user_id']),
        name = str(j['name']),
        username = asStr(j['username']),
        picture = asStr(j['picture']),
        verified = asBool(j['verified']);

  final Map<String, dynamic> raw;
  final String userId;
  final String name;
  final String? username;
  final String? picture;
  final bool verified;
}

class PostMedia {
  PostMedia.fromJson(Map<String, dynamic> j)
      : raw = j,
        type = str(j['type'], 'image'), // image | video
        // `base64` holds either a data URI or a CDN/Cloudinary URL.
        source = str(j['base64'] ?? j['url']),
        width = j['width'] == null ? null : asInt(j['width']),
        height = j['height'] == null ? null : asInt(j['height']);

  final Map<String, dynamic> raw;
  final String type;
  final String source;
  final int? width;
  final int? height;

  bool get isVideo => type == 'video';
}

class Post {
  Post.fromJson(Map<String, dynamic> j)
      : raw = j,
        id = str(j['id']),
        userId = str(j['user_id']),
        author = PostAuthor.fromJson(asMap(j['author'])),
        text = str(j['text']),
        title = asStr(j['title']),
        parentId = asStr(j['parent_id']),
        repostOf = asStr(j['repost_of']),
        quoteOf = asStr(j['quote_of']),
        media = asList(j['media'], (e) => PostMedia.fromJson(asMap(e))),
        hashtags = asList(j['hashtags'], (e) => e.toString()),
        likesCount = asInt(j['likes_count']),
        repliesCount = asInt(j['replies_count']),
        repostsCount = asInt(j['reposts_count']),
        bookmarksCount = asInt(j['bookmarks_count']),
        viewsCount = asInt(j['views_count']),
        reactionsTotal = asInt(j['reactions_total']),
        myReaction = asStr(j['my_reaction']),
        likedByMe = asBool(j['liked_by_me']),
        repostedByMe = asBool(j['reposted_by_me']),
        bookmarkedByMe = asBool(j['bookmarked_by_me']),
        pinned = asBool(j['pinned']),
        promoted = asBool(j['promoted']),
        locked = asBool(j['locked']),
        communityName = asStr(j['community_name']),
        createdAt = asStr(j['created_at']),
        editedAt = asStr(j['edited_at']);

  final Map<String, dynamic> raw;
  final String id;
  final String userId;
  final PostAuthor author;
  final String text;
  final String? title;
  final String? parentId;
  final String? repostOf;
  final String? quoteOf;
  final List<PostMedia> media;
  final List<String> hashtags;
  final int likesCount;
  final int repliesCount;
  final int repostsCount;
  final int bookmarksCount;
  final int viewsCount;
  final int reactionsTotal;
  final String? myReaction;
  final bool likedByMe;
  final bool repostedByMe;
  final bool bookmarkedByMe;
  final bool pinned;
  final bool promoted;
  final bool locked;
  final String? communityName;
  final String? createdAt;
  final String? editedAt;
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------
class Message {
  Message.fromJson(Map<String, dynamic> j)
      : raw = j,
        id = str(j['id']),
        conversationId = str(j['conversation_id']),
        senderId = str(j['sender_id']),
        type = str(j['type'], 'text'),
        text = asStr(j['text']),
        amount = j['amount'] == null ? null : asDouble(j['amount']),
        media = asList(j['media'], (e) => PostMedia.fromJson(asMap(e))),
        audioBase64 = asStr(j['audio_base64']),
        audioDurationMs = j['audio_duration_ms'] == null ? null : asInt(j['audio_duration_ms']),
        gifUrl = asStr(j['gif_url']),
        fileName = asStr(j['file_name']),
        placeName = asStr(j['place_name']),
        placeLongitude = j['place_longitude'] == null ? null : asDouble(j['place_longitude']),
        placeLatitude = j['place_latitude'] == null ? null : asDouble(j['place_latitude']),
        postId = asStr(j['post_id']),
        replyToId = asStr(j['reply_to_id']),
        reactions = asStrMap(j['reactions']),
        pollQuestion = asStr(j['poll_question']),
        pollOptions = asList(j['poll_options'], (e) => e.toString()),
        deleted = asBool(j['deleted']),
        pinned = asBool(j['pinned']),
        readAt = asStr(j['read_at']),
        deliveredAt = asStr(j['delivered_at']),
        editedAt = asStr(j['edited_at']),
        createdAt = str(j['created_at']);

  final Map<String, dynamic> raw;
  final String id;
  final String conversationId;
  final String senderId;
  final String type; // text | media | voice | gif | file | place | post | contact | form | poll | tip
  final String? text;
  final double? amount;
  final List<PostMedia> media;
  final String? audioBase64;
  final int? audioDurationMs;
  final String? gifUrl;
  final String? fileName;
  final String? placeName;
  final double? placeLongitude;
  final double? placeLatitude;
  final String? postId;
  final String? replyToId;
  final Map<String, String> reactions; // { userId: emoji }
  final String? pollQuestion;
  final List<String> pollOptions;
  final bool deleted;
  final bool pinned;
  final String? readAt;
  final String? deliveredAt;
  final String? editedAt;
  final String createdAt;
}

class ConversationView {
  ConversationView.fromJson(Map<String, dynamic> j)
      : raw = j,
        id = str(j['id']),
        kind = str(j['kind'], 'dm'), // dm | group
        name = asStr(j['name']),
        avatar = asStr(j['avatar']),
        theme = asStr(j['theme']),
        disappearingSeconds = asInt(j['disappearing_seconds']),
        receiptsEnabled = asBool(j['receipts_enabled'], true),
        ownerId = asStr(j['owner_id']),
        listingId = asStr(j['listing_id']),
        listingTitle = asStr(j['listing_title']),
        unreadCount = asInt(j['unread_count']),
        lastMessageAt = asStr(j['last_message_at']),
        createdAt = asStr(j['created_at']),
        otherUser = j['other_user'] == null ? null : PublicUser.fromJson(asMap(j['other_user'])),
        members = asList(j['members'], (e) => PublicUser.fromJson(asMap(e))),
        lastMessage = j['last_message'] == null ? null : Message.fromJson(asMap(j['last_message']));

  final Map<String, dynamic> raw;
  final String id;
  final String kind;
  final String? name;
  final String? avatar;
  final String? theme;
  final int disappearingSeconds;
  final bool receiptsEnabled;
  final String? ownerId;
  final String? listingId;
  final String? listingTitle;
  final int unreadCount;
  final String? lastMessageAt;
  final String? createdAt;
  final PublicUser? otherUser;
  final List<PublicUser> members;
  final Message? lastMessage;

  bool get isGroup => kind == 'group';
}

/// Builder for the message-send body (`MessageCreate` in TS). Only set the
/// fields relevant to [type]. Pre-encrypt text/base64 fields yourself when using
/// E2E (see the README note on porting `src/utils/e2e.ts`).
class MessageCreate {
  MessageCreate({
    required this.type,
    this.text,
    this.amount,
    this.media,
    this.audioBase64,
    this.audioDurationMs,
    this.postId,
    this.gifUrl,
    this.fileBase64,
    this.fileName,
    this.fileSize,
    this.fileMime,
    this.contactUserId,
    this.contactName,
    this.contactPicture,
    this.formId,
    this.placeName,
    this.placeAddress,
    this.placeLongitude,
    this.placeLatitude,
    this.pollQuestion,
    this.pollOptions,
    this.replyTo,
  });

  final String type;
  final String? text;
  final double? amount;
  final List<Map<String, dynamic>>? media;
  final String? audioBase64;
  final int? audioDurationMs;
  final String? postId;
  final String? gifUrl;
  final String? fileBase64;
  final String? fileName;
  final int? fileSize;
  final String? fileMime;
  final String? contactUserId;
  final String? contactName;
  final String? contactPicture;
  final String? formId;
  final String? placeName;
  final String? placeAddress;
  final double? placeLongitude;
  final double? placeLatitude;
  final String? pollQuestion;
  final List<String>? pollOptions;
  final String? replyTo;

  Map<String, dynamic> toJson() => {
        'type': type,
        if (text != null) 'text': text,
        if (amount != null) 'amount': amount,
        if (media != null) 'media': media,
        if (audioBase64 != null) 'audio_base64': audioBase64,
        if (audioDurationMs != null) 'audio_duration_ms': audioDurationMs,
        if (postId != null) 'post_id': postId,
        if (gifUrl != null) 'gif_url': gifUrl,
        if (fileBase64 != null) 'file_base64': fileBase64,
        if (fileName != null) 'file_name': fileName,
        if (fileSize != null) 'file_size': fileSize,
        if (fileMime != null) 'file_mime': fileMime,
        if (contactUserId != null) 'contact_user_id': contactUserId,
        if (contactName != null) 'contact_name': contactName,
        if (contactPicture != null) 'contact_picture': contactPicture,
        if (formId != null) 'form_id': formId,
        if (placeName != null) 'place_name': placeName,
        if (placeAddress != null) 'place_address': placeAddress,
        if (placeLongitude != null) 'place_longitude': placeLongitude,
        if (placeLatitude != null) 'place_latitude': placeLatitude,
        if (pollQuestion != null) 'poll_question': pollQuestion,
        if (pollOptions != null) 'poll_options': pollOptions,
        if (replyTo != null) 'reply_to': replyTo,
      };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
class AppNotification {
  AppNotification.fromJson(Map<String, dynamic> j)
      : raw = j,
        id = str(j['id']),
        type = str(j['type']),
        read = asBool(j['read']),
        text = asStr(j['text'] ?? j['message']),
        createdAt = asStr(j['created_at']);

  final Map<String, dynamic> raw;
  final String id;
  final String type;
  final bool read;
  final String? text;
  final String? createdAt;
}

class WalletBalance {
  WalletBalance.fromJson(Map<String, dynamic> j)
      : raw = j,
        balance = asDouble(j['balance']),
        currency = asStr(j['currency']);

  final Map<String, dynamic> raw;
  final double balance;
  final String? currency;
}

/// A Stripe Checkout session from `POST /payments/checkout` (tip / subscription
/// / promote / topup). Open [url] in a browser (hosted), or use [clientSecret]
/// with Stripe's embedded checkout when [embedded] is true.
class CheckoutSession {
  CheckoutSession.fromJson(Map<String, dynamic> j)
      : raw = j,
        id = asStr(j['id']),
        url = asStr(j['url']),
        clientSecret = asStr(j['client_secret']),
        embedded = asBool(j['embedded']);

  final Map<String, dynamic> raw;
  final String? id;

  /// Hosted Stripe Checkout URL to open (null when [embedded]).
  final String? url;

  /// Client secret for Stripe's embedded checkout (null when hosted).
  final String? clientSecret;
  final bool embedded;
}

/// A PaymentIntent for a native PaymentSheet top-up (`POST /wallet/topup/intent`).
class TopupIntent {
  TopupIntent.fromJson(Map<String, dynamic> j)
      : raw = j,
        clientSecret = str(j['client_secret']),
        publishableKey = str(j['publishable_key']),
        intentId = str(j['intent_id']);

  final Map<String, dynamic> raw;
  final String clientSecret;
  final String publishableKey;
  final String intentId;
}

/// Result of crediting a PaymentSheet top-up (`POST /wallet/topup/confirm-intent`).
class TopupConfirm {
  TopupConfirm.fromJson(Map<String, dynamic> j)
      : raw = j,
        ok = asBool(j['ok']),
        paid = asBool(j['paid']),
        credited = asBool(j['credited']),
        status = asStr(j['status']),
        balance = asDouble(j['balance']),
        display = asDouble(j['display']),
        symbol = asStr(j['symbol']),
        currency = asStr(j['currency']);

  final Map<String, dynamic> raw;
  final bool ok;
  final bool paid;

  /// True when this call is the one that actually credited the wallet (the
  /// confirm is idempotent, so a retry returns paid=true but credited=false).
  final bool credited;
  final String? status; // Stripe PaymentIntent status, e.g. "succeeded"
  final double balance; // canonical USD balance
  final double display; // balance in the user's chosen currency
  final String? symbol;
  final String? currency;
}

/// Onboarding/status of the caller's Stripe Connect account (`POST /stripe/account`).
class StripeAccountStatus {
  StripeAccountStatus.fromJson(Map<String, dynamic> j)
      : raw = j,
        accountId = asStr(j['account_id']),
        chargesEnabled = asBool(j['charges_enabled']),
        payoutsEnabled = asBool(j['payouts_enabled']),
        detailsSubmitted = asBool(j['details_submitted']),
        defaultCurrency = asStr(j['default_currency']),
        country = asStr(j['country']),
        onboardingUrl = asStr(j['onboarding_url']);

  final Map<String, dynamic> raw;
  final String? accountId;
  final bool chargesEnabled;
  final bool payoutsEnabled;
  final bool detailsSubmitted;
  final String? defaultCurrency;
  final String? country;

  /// Hosted onboarding link to finish (or update) setup. Null once the account
  /// is fully onboarded (payouts enabled + details submitted).
  final String? onboardingUrl;

  /// Ready to send/receive and cash out.
  bool get ready => payoutsEnabled && detailsSubmitted;
}

/// A per-currency available/pending pair from `GET /stripe/balance`.
class StripeCurrencyBalance {
  StripeCurrencyBalance.fromJson(Map<String, dynamic> j)
      : currency = str(j['currency']),
        available = asDouble(j['available']),
        pending = asDouble(j['pending']);

  final String currency;
  final double available;
  final double pending;
}

/// The connected account's Stripe balance (`GET /stripe/balance`) — the
/// Stripe-native wallet balance.
class StripeBalance {
  StripeBalance.fromJson(Map<String, dynamic> j)
      : raw = j,
        connected = asBool(j['connected']),
        currency = str(j['currency'], 'usd'),
        available = asDouble(j['available']),
        pending = asDouble(j['pending']),
        byCurrency = asList(j['by_currency'], (e) => StripeCurrencyBalance.fromJson(asMap(e)));

  final Map<String, dynamic> raw;

  /// False when the user hasn't started Stripe onboarding (all amounts are 0).
  final bool connected;
  final String currency;
  final double available;
  final double pending;
  final List<StripeCurrencyBalance> byCurrency;
}

/// One Stripe balance transaction from `GET /stripe/transactions`.
class StripeTxn {
  StripeTxn.fromJson(Map<String, dynamic> j)
      : raw = j,
        id = str(j['id']),
        type = str(j['type']),
        amount = asDouble(j['amount']),
        net = asDouble(j['net']),
        fee = asDouble(j['fee']),
        currency = str(j['currency'], 'usd'),
        status = asStr(j['status']),
        description = asStr(j['description']),
        created = asStr(j['created']);

  final Map<String, dynamic> raw;
  final String id;

  /// charge | payout | transfer | payment | … (Stripe balance-transaction type).
  final String type;
  final double amount;
  final double net;
  final double fee;
  final String currency;
  final String? status; // available | pending
  final String? description;
  final String? created; // ISO-8601
}

/// A page of Stripe transactions plus the cursor flag for `starting_after`.
class StripeTxnPage {
  StripeTxnPage.fromJson(Map<String, dynamic> j)
      : connected = asBool(j['connected']),
        transactions = asList(j['transactions'], (e) => StripeTxn.fromJson(asMap(e))),
        hasMore = asBool(j['has_more']);

  final bool connected;
  final List<StripeTxn> transactions;
  final bool hasMore;
}

/// Result of `POST /stripe/transfer` (platform-mediated user→user send).
class StripeTransferResult {
  StripeTransferResult.fromJson(Map<String, dynamic> j)
      : ok = asBool(j['ok']),
        amount = asDouble(j['amount']),
        transferId = asStr(j['transfer_id']),
        balance = asDouble(j['balance']); // sender's remaining in-app balance

  final bool ok;
  final double amount;
  final String? transferId;
  final double balance;
}

/// Result of `POST /stripe/payout` (cash the Stripe balance out).
class StripePayoutResult {
  StripePayoutResult.fromJson(Map<String, dynamic> j)
      : ok = asBool(j['ok']),
        amount = asDouble(j['amount']),
        currency = str(j['currency'], 'USD'),
        payoutId = asStr(j['payout_id']),
        status = asStr(j['status']),
        arrivalDate = asStr(j['arrival_date']);

  final bool ok;
  final double amount;
  final String currency;
  final String? payoutId;
  final String? status;
  final String? arrivalDate; // ISO-8601
}

class LeaderboardEntry {
  LeaderboardEntry.fromJson(Map<String, dynamic> j)
      : raw = j,
        userId = str(j['user_id']),
        name = str(j['name']),
        username = asStr(j['username']),
        picture = asStr(j['picture']),
        points = asInt(j['points']),
        level = asInt(j['level']),
        levelTitle = asStr(j['level_title']),
        rank = asInt(j['rank']);

  final Map<String, dynamic> raw;
  final String userId;
  final String name;
  final String? username;
  final String? picture;
  final int points;
  final int level;
  final String? levelTitle;
  final int rank;
}

// ---------------------------------------------------------------------------
// Auth result (login/register may succeed or require 2FA)
// ---------------------------------------------------------------------------
class TwofaChallenge {
  TwofaChallenge.fromJson(Map<String, dynamic> j)
      : raw = j,
        identifier = str(j['identifier']),
        maskedPhone = str(j['masked_phone']),
        sent = asBool(j['sent']);

  final Map<String, dynamic> raw;
  final String identifier;
  final String maskedPhone;
  final bool sent;
}

/// Result of [OkaySpaceApi.login] / [OkaySpaceApi.register]: either a session
/// (token already stored) or a two-factor challenge to complete.
class AuthResult {
  AuthResult.success(this.token, this.user) : twofa = null;
  AuthResult.twofa(this.twofa)
      : token = null,
        user = null;

  final String? token;
  final User? user;
  final TwofaChallenge? twofa;

  bool get needsTwofa => twofa != null;
}
