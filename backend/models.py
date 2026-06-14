"""All Pydantic models used across the API."""
from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

# Reusable coordinate fields — reject out-of-range values at the edge instead of
# silently storing garbage (e.g. a swapped lat/lng or a bad GPS fix).
def _Lng(default=...):
    return Field(default, ge=-180, le=180)


def _Lat(default=...):
    return Field(default, ge=-90, le=90)


class User(BaseModel):
    user_id: str
    email: str
    name: str
    username: Optional[str] = None
    picture: Optional[str] = None
    phone: Optional[str] = None
    phone_verified: bool = False
    email_verified: bool = False       # confirmed via emailed code
    id_verified: bool = False          # government-ID verified (via Stripe identity)
    twofa_enabled: bool = False        # SMS two-factor on login
    sms_notifications: bool = False    # mirror in-app notifications to SMS
    bio: Optional[str] = ""
    # Public profile details users fill in to display on their profile.
    status: Optional[str] = None        # short status (emoji + text), e.g. "🎯 Focusing"
    headline: Optional[str] = None      # short tagline shown under the name
    shop_policies: Optional[str] = None # marketplace storefront note (shipping/returns/handoff)
    # Storefront identity — marketplace-only branding, independent of the social
    # profile (falls back to the profile's name/picture/cover/accent when unset).
    shop_name: Optional[str] = None
    shop_tagline: Optional[str] = None
    shop_logo: Optional[str] = None
    shop_banner: Optional[str] = None
    shop_accent: Optional[str] = None
    location: Optional[str] = None      # city / country
    pronouns: Optional[str] = None      # e.g. she/her, they/them
    birthday: Optional[str] = None      # YYYY-MM-DD (chosen via date picker)
    socials: Optional[dict] = None      # {platform: handle/url}
    cover_photo: Optional[str] = None   # profile banner image (URL / data URI)
    accent_color: Optional[str] = None  # profile theme color, hex like #7C3AED
    interests: List[str] = []           # interest / skill tags shown as chips
    featured_links: List[dict] = []     # link-in-bio: [{label, url}]
    avatar_frame: Optional[str] = None  # Steam-style decorative ring preset key
    profile_background: Optional[str] = None  # full-profile background preset key
    home_name: Optional[str] = None
    home_longitude: Optional[float] = None
    home_latitude: Optional[float] = None
    work_name: Optional[str] = None
    work_longitude: Optional[float] = None
    work_latitude: Optional[float] = None
    verified: bool = False
    role: str = "user"            # user | mod | admin
    # Admin-set capability locks (apply to this user only).
    messaging_disabled: bool = False     # can't send chat messages
    marketplace_disabled: bool = False   # can't create marketplace listings
    posting_disabled: bool = False       # can't create newsfeed posts
    sub_price: float = 4.99       # monthly subscription price others pay this user
    payout_frequency: str = "monthly"  # biweekly | monthly
    payout_threshold: float = 0   # hold earnings until balance reaches this
    ad_balance: float = 0         # prepaid ad-account balance (funds campaigns)
    wallet_balance: float = 0     # spendable wallet balance (top up to send money)
    currency: str = "USD"         # preferred display currency
    # Privacy defaults applied to new posts.
    default_comment_policy: str = "everyone"   # everyone | followers | friends | nobody
    default_likes_disabled: bool = False       # turn off likes on new posts by default
    message_policy: str = "everyone"           # who can start a DM: everyone | followers | friends | nobody
    # Account privacy.
    is_private: bool = False             # only followers can see your profile posts
    searchable: bool = True              # appear in user search
    hide_online: bool = False            # hide your online / last-seen status from others
    connections_visibility: str = "everyone"  # who can see your followers/following: everyone | followers | nobody
    hide_likes: bool = False             # hide the list of posts you've liked from others
    tag_policy: str = "everyone"         # who can tag/mention you in a post: everyone | followers | nobody
    show_points: bool = True             # show your activity points/score on your profile
    muted_keywords: List[str] = []       # feed filter: hide posts whose text/hashtags match any of these
    boost_keywords: List[str] = []       # feed prioritize: surface posts whose text/hashtags match these higher
    needs_policy_agreement: bool = False  # must accept current ToS/Privacy before use
    points: int = 0                       # Snapscore-style activity points
    level: int = 1                        # derived level from points
    level_title: str = ""                 # title for the current level
    created_at: datetime


class Badge(BaseModel):
    id: str
    label: str = ""
    icon: str = ""          # an emoji character, or an image URL / data URI
    color: str = "#3B82F6"


class PublicUser(BaseModel):
    user_id: str
    name: str
    username: Optional[str] = None
    picture: Optional[str] = None
    bio: Optional[str] = ""
    status: Optional[str] = None
    headline: Optional[str] = None
    shop_policies: Optional[str] = None
    shop_name: Optional[str] = None
    shop_tagline: Optional[str] = None
    shop_logo: Optional[str] = None
    shop_banner: Optional[str] = None
    shop_accent: Optional[str] = None
    location: Optional[str] = None
    pronouns: Optional[str] = None
    birthday: Optional[str] = None
    socials: Optional[dict] = None
    cover_photo: Optional[str] = None
    accent_color: Optional[str] = None
    interests: List[str] = []
    featured_links: List[dict] = []
    avatar_frame: Optional[str] = None
    profile_background: Optional[str] = None
    show_points: bool = True
    verified: bool = False
    phone_verified: bool = False
    email_verified: bool = False
    id_verified: bool = False
    role: str = "user"
    badges: List[Badge] = []
    online: bool = False             # active within the presence window
    last_seen: Optional[str] = None  # ISO timestamp of last activity
    sub_price: float = 4.99
    is_subscribed: bool = False    # is the viewer subscribed to this user?
    subscriber_count: int = 0
    stats: dict = {}
    is_following: bool = False
    is_followed_by: bool = False
    friend_status: str = "none"  # none | request_sent | request_received | friends
    poked_me: bool = False        # this user has an active poke waiting for the viewer
    points: int = 0               # Snapscore-style activity points
    level: int = 1                # derived level from points
    level_title: str = ""         # title for the current level


class AdminUserPatch(BaseModel):
    verified: Optional[bool] = None
    role: Optional[str] = None    # user | mod | admin


class AuthResponse(BaseModel):
    session_token: str
    user: User


class LoginResultOut(BaseModel):
    """`/auth/login` returns one of two shapes, so the spec documents both (and
    extra="allow" keeps any extra field rather than dropping it):
      • success     → session_token + user
      • 2FA needed  → twofa_required + identifier + masked_phone + sent
    Declaring session_token here means the app stops key-probing the token."""
    model_config = ConfigDict(extra="allow")
    session_token: Optional[str] = None
    user: Optional[User] = None
    twofa_required: Optional[bool] = None
    identifier: Optional[str] = None
    masked_phone: Optional[str] = None
    sent: Optional[bool] = None


class ProfilePatch(BaseModel):
    name: Optional[str] = None
    bio: Optional[str] = None
    picture: Optional[str] = None
    status: Optional[str] = None
    headline: Optional[str] = None
    shop_policies: Optional[str] = None
    shop_name: Optional[str] = None
    shop_tagline: Optional[str] = None
    shop_logo: Optional[str] = None
    shop_banner: Optional[str] = None
    shop_accent: Optional[str] = None
    location: Optional[str] = None
    pronouns: Optional[str] = None
    birthday: Optional[str] = None
    socials: Optional[dict] = None
    cover_photo: Optional[str] = None    # banner image; "" clears it
    accent_color: Optional[str] = None   # hex like #7C3AED; "" clears it
    interests: Optional[List[str]] = None
    featured_links: Optional[List[dict]] = None
    avatar_frame: Optional[str] = None
    profile_background: Optional[str] = None
    home_name: Optional[str] = None
    home_longitude: Optional[float] = None
    home_latitude: Optional[float] = None
    work_name: Optional[str] = None
    work_longitude: Optional[float] = None
    work_latitude: Optional[float] = None
    sub_price: Optional[float] = None
    payout_frequency: Optional[str] = None   # biweekly | monthly
    payout_threshold: Optional[float] = None
    default_comment_policy: Optional[str] = None  # everyone | followers | friends | nobody
    message_policy: Optional[str] = None          # who can start a DM with you
    default_likes_disabled: Optional[bool] = None
    is_private: Optional[bool] = None
    searchable: Optional[bool] = None
    hide_online: Optional[bool] = None
    connections_visibility: Optional[str] = None  # everyone | followers | nobody
    hide_likes: Optional[bool] = None             # hide your liked-posts list from others
    tag_policy: Optional[str] = None              # who can tag you: everyone | followers | nobody
    muted_keywords: Optional[List[str]] = None    # feed keyword/topic filters
    boost_keywords: Optional[List[str]] = None     # feed topics to prioritize
    show_points: Optional[bool] = None             # show your points/score on profile
    currency: Optional[str] = None   # preferred display currency (USD, EUR, ...)
    sms_notifications: Optional[bool] = None  # mirror notifications to SMS (needs verified phone)


class TipCreate(BaseModel):
    amount: float
    message: Optional[str] = ""


class Tip(BaseModel):
    id: str
    from_user_id: str
    from_name: str
    to_user_id: str
    amount: float
    currency: str = "USD"
    message: Optional[str] = ""
    created_at: datetime


class WalletTxn(BaseModel):
    id: str
    kind: str                 # tip | subscription
    amount: float
    from_user_id: str         # counterparty: payer (received) or recipient (sent)
    from_name: str
    source: str = "test"      # how it was paid: stripe | test | transfer
    message: Optional[str] = ""   # note the payer attached
    created_at: datetime


class WalletSummary(BaseModel):
    currency: str = "USD"
    balance: float = 0            # spendable wallet balance (top-up funds), USD
    total_earned: float = 0
    tips_total: float = 0
    subs_total: float = 0
    ads_total: float = 0
    tips_count: int = 0
    active_subscribers: int = 0
    sub_price: float = 4.99
    recent: List[WalletTxn] = []
    # Money the user has sent to others (tips given + subscriptions they pay).
    total_spent: float = 0
    tips_sent_total: float = 0
    subs_sent_total: float = 0
    subscriptions_count: int = 0   # active subscriptions the user pays for
    sent: List[WalletTxn] = []


class PlaceCreate(BaseModel):
    title: str
    notes: Optional[str] = ""
    longitude: float = _Lng()
    latitude: float = _Lat()
    address: Optional[str] = ""
    category: str = "marker"


class Place(BaseModel):
    id: str
    user_id: str
    title: str
    notes: Optional[str] = ""
    longitude: float
    latitude: float
    address: Optional[str] = ""
    category: str
    created_at: datetime


class RecentCreate(BaseModel):
    name: str
    full_address: Optional[str] = ""
    longitude: float = _Lng()
    latitude: float = _Lat()


class Recent(BaseModel):
    id: str
    user_id: str
    name: str
    full_address: Optional[str] = ""
    longitude: float
    latitude: float
    created_at: datetime


class GuideCreate(BaseModel):
    name: str
    color: Optional[str] = "#3B82F6"
    icon: Optional[str] = "bookmark"


class GuidePatch(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    is_public: Optional[bool] = None


class Guide(BaseModel):
    id: str
    user_id: str
    name: str
    color: str = "#3B82F6"
    icon: str = "bookmark"
    place_ids: List[str] = []
    is_public: bool = False
    slug: Optional[str] = None
    created_at: datetime


class PublicGuide(BaseModel):
    id: str
    slug: str
    name: str
    color: str
    icon: str
    owner: PublicUser
    places: List[Place]
    created_at: datetime


class ReviewCreate(BaseModel):
    place_key: str
    place_name: str
    longitude: float = _Lng()
    latitude: float = _Lat()
    rating: int = Field(..., ge=1, le=5)
    text: Optional[str] = ""


class Review(BaseModel):
    id: str
    user_id: str
    user_name: str
    user_picture: Optional[str] = None
    place_key: str
    place_name: str
    longitude: float
    latitude: float
    rating: int
    text: Optional[str] = ""
    created_at: datetime


class ReviewSummary(BaseModel):
    place_key: str
    count: int
    average: float  # mean rating, 0.0 when there are no reviews
    distribution: Dict[str, int]  # {"1": n, ..., "5": n}


class NearbyRatedPlace(BaseModel):
    place_key: str
    place_name: str
    longitude: float
    latitude: float
    count: int
    average: float
    distance_km: float


class MessageCreate(BaseModel):
    type: Literal["text", "place", "media", "voice", "post", "gif", "file", "contact", "tip", "form", "poll"] = "text"
    text: Optional[str] = ""
    poll_question: Optional[str] = None      # type == "poll"
    poll_options: Optional[List[str]] = None # type == "poll"
    amount: Optional[float] = None           # type == "tip"
    place_name: Optional[str] = None
    place_address: Optional[str] = None
    place_longitude: Optional[float] = None
    place_latitude: Optional[float] = None
    media: Optional[List["PostMedia"]] = None
    audio_base64: Optional[str] = None       # voice note (data URI or raw base64)
    audio_duration_ms: Optional[int] = None  # length of the voice note
    post_id: Optional[str] = None            # shared post (type == "post")
    gif_url: Optional[str] = None            # type == "gif"
    file_base64: Optional[str] = None        # type == "file" (data URI)
    file_name: Optional[str] = None
    file_size: Optional[int] = None
    file_mime: Optional[str] = None
    contact_user_id: Optional[str] = None    # type == "contact" (an app user)
    contact_name: Optional[str] = None
    contact_picture: Optional[str] = None
    form_id: Optional[str] = None            # type == "form" (a shared saved form)
    reply_to: Optional[str] = None           # id of the message being replied to


class MessageEdit(BaseModel):
    text: str


class MessageReact(BaseModel):
    emoji: Optional[str] = "❤️"              # empty/None clears the reaction


class CustomEmojiCreate(BaseModel):
    shortcode: str                # e.g. "pepe" -> used as :pepe:
    image_base64: str             # data URI


class CustomEmoji(BaseModel):
    id: str
    shortcode: str
    image_base64: str
    owner_id: str
    created_at: datetime


class ReportCreate(BaseModel):
    reason: Optional[str] = "other"


class Message(BaseModel):
    id: str
    conversation_id: str
    sender_id: str
    type: str
    text: Optional[str] = ""
    place_name: Optional[str] = None
    place_address: Optional[str] = None
    place_longitude: Optional[float] = None
    place_latitude: Optional[float] = None
    live_share_id: Optional[str] = None      # type == "live_location": the share to poll
    live_expires_at: Optional[datetime] = None  # when the live share stops
    live_active: Optional[bool] = None       # False once stopped/expired
    game_id: Optional[str] = None            # type == "game": the game to poll/play
    game_type: Optional[str] = None          # e.g. "tictactoe"
    media: List["PostMedia"] = []
    audio_base64: Optional[str] = None       # voice note
    audio_duration_ms: Optional[int] = None  # length of the voice note
    transcript: Optional[str] = None         # cached speech-to-text (non-E2E voice notes)
    post_id: Optional[str] = None            # shared post (type == "post")
    gif_url: Optional[str] = None            # type == "gif"
    file_base64: Optional[str] = None        # type == "file"
    file_name: Optional[str] = None
    file_size: Optional[int] = None
    file_mime: Optional[str] = None
    contact_user_id: Optional[str] = None    # type == "contact"
    contact_name: Optional[str] = None
    contact_picture: Optional[str] = None
    form_id: Optional[str] = None            # type == "form" (a shared saved form)
    form_key: Optional[str] = None           # public key to open the shared form
    form_title: Optional[str] = None         # denormalized title of the shared form
    amount: Optional[float] = None           # type == "tip"
    link_preview: Optional[dict] = None      # OpenGraph preview for links in text
    poll_question: Optional[str] = None      # type == "poll"
    poll_options: List[str] = []             # type == "poll"
    poll_votes: dict = {}                    # {user_id: option_index}
    deleted: bool = False                    # soft-deleted tombstone
    reactions: dict = {}              # {user_id: emoji}
    reply_to_id: Optional[str] = None        # id of the message this replies to
    edit_history: list = []                  # [{text, edited_at}] prior versions
    edited_at: Optional[datetime] = None
    read_at: Optional[datetime] = None  # all recipients read it (last_read >= created_at)
    delivered_at: Optional[datetime] = None  # all recipients fetched it
    read_by: List[str] = []        # which recipients have read it (group receipts)
    delivered_by: List[str] = []   # which recipients have received it
    expires_at: Optional[datetime] = None  # disappearing messages: auto-hidden after this
    pinned: bool = False                    # pinned to the top of the conversation
    created_at: datetime


class ConversationCreate(BaseModel):
    recipient_user_id: str


class GroupConversationCreate(BaseModel):
    name: str
    member_ids: List[str]
    avatar: Optional[str] = None


class GroupConversationPatch(BaseModel):
    name: Optional[str] = None
    avatar: Optional[str] = None
    add_member_ids: Optional[List[str]] = None
    remove_member_ids: Optional[List[str]] = None


class ConversationView(BaseModel):
    id: str
    kind: str = "dm"           # "dm" or "group"
    name: Optional[str] = None  # group name (None for DM)
    avatar: Optional[str] = None  # group avatar (None for DM)
    theme: Optional[str] = None  # conversation color theme key (Messenger-style)
    disappearing_seconds: int = 0  # 0 = off; otherwise messages auto-vanish after N seconds
    receipts_enabled: bool = True   # whether the viewer sends/sees read receipts here
    other_user: Optional[PublicUser] = None  # only for DM
    members: List[PublicUser] = []           # group members (empty for DM)
    owner_id: Optional[str] = None           # group owner
    listing_id: Optional[str] = None         # set when the DM started from a marketplace listing
    listing_title: Optional[str] = None
    last_message: Optional[Message] = None
    last_message_at: Optional[datetime] = None
    unread_count: int = 0
    created_at: datetime


class EtaShareCreate(BaseModel):
    name: Optional[str] = None
    destination_name: Optional[str] = None
    destination_longitude: float = _Lng()
    destination_latitude: float = _Lat()
    initial_longitude: float = _Lng()
    initial_latitude: float = _Lat()
    eta_minutes: Optional[int] = None
    ttl_minutes: int = 120


class EtaShare(BaseModel):
    id: str
    share_id: str
    user_id: str
    name: Optional[str] = None
    destination_name: Optional[str] = None
    destination_longitude: float
    destination_latitude: float
    current_longitude: float
    current_latitude: float
    eta_minutes: Optional[int] = None
    active: bool = True
    expires_at: datetime
    updated_at: datetime
    created_at: datetime


class EtaUpdate(BaseModel):
    current_longitude: float = _Lng()
    current_latitude: float = _Lat()
    eta_minutes: Optional[int] = None


class LiveLocationCreate(BaseModel):
    minutes: int = 60                 # how long to keep sharing (1 .. 1440)
    latitude: float = _Lat()
    longitude: float = _Lng()


class LiveLocationUpdate(BaseModel):
    latitude: float = _Lat()
    longitude: float = _Lng()


class LiveLocationView(BaseModel):
    share_id: str
    user_id: str
    name: Optional[str] = None
    latitude: float
    longitude: float
    active: bool = True
    expires_at: datetime
    updated_at: datetime


class GameCreate(BaseModel):
    game_type: str = "tictactoe"
    vs_cpu: bool = False               # play the computer (forced on in notes-to-self)


class GameMove(BaseModel):
    cell: int                          # 0..8 (tic-tac-toe board index)


class GameView(BaseModel):
    game_id: str
    conversation_id: str
    game_type: str
    board: List[str]                   # 9 cells: "", "X" or "O"
    x_player: str
    o_player: str
    turn: str                          # user_id whose move it is
    status: str = "active"             # active | won | draw
    winner: Optional[str] = None       # user_id of the winner (None on draw/active)
    updated_at: datetime


# ---------- Marketplace ----------
class ListingCreate(BaseModel):
    title: str
    price: float = 0
    currency: str = "USD"
    category: str = "other"
    condition: Optional[str] = "used"   # new | like_new | good | fair | used
    description: Optional[str] = ""
    photo_base64: Optional[str] = None   # back-compat single photo
    photos: Optional[List[str]] = None   # gallery (data URIs)
    longitude: Optional[float] = None
    latitude: Optional[float] = None
    locality: Optional[str] = None
    negotiable: bool = False
    quantity: int = 1
    brand: Optional[str] = None
    delivery: Optional[str] = "pickup"   # pickup | shipping | both
    contact_email: Optional[str] = None  # optional public contact shown on the listing
    contact_phone: Optional[str] = None
    business_id: Optional[str] = None    # list under a business storefront ("" / None = personal)


class ListingPatch(BaseModel):
    title: Optional[str] = None
    price: Optional[float] = None
    currency: Optional[str] = None
    category: Optional[str] = None
    condition: Optional[str] = None
    description: Optional[str] = None
    photo_base64: Optional[str] = None
    photos: Optional[List[str]] = None
    status: Optional[Literal["active", "sold"]] = None
    locality: Optional[str] = None
    longitude: Optional[float] = None
    latitude: Optional[float] = None
    negotiable: Optional[bool] = None
    quantity: Optional[int] = None
    brand: Optional[str] = None
    delivery: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    business_id: Optional[str] = None    # move between personal / a business storefront


class Listing(BaseModel):
    id: str
    user_id: str
    seller: "PostAuthor"
    title: str
    price: float
    currency: str = "USD"
    category: str
    condition: Optional[str] = "used"
    description: Optional[str] = ""
    photo_base64: Optional[str] = None
    photos: List[str] = []
    longitude: Optional[float] = None
    latitude: Optional[float] = None
    locality: Optional[str] = None
    negotiable: bool = False
    quantity: int = 1
    brand: Optional[str] = None
    delivery: Optional[str] = "pickup"
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    business_id: Optional[str] = None
    business: Optional["BusinessBrand"] = None   # storefront brand, when sold by a business
    distance_km: Optional[float] = None   # set when the viewer shares a location
    status: str = "active"
    flag_reasons: Optional[List[str]] = None   # why an automated check unpublished it
    views_count: int = 0
    saved_count: int = 0
    saved_by_me: bool = False
    likes_count: int = 0
    liked_by_me: bool = False
    comments_count: int = 0
    created_at: datetime


class ListingComment(BaseModel):
    id: str
    listing_id: str
    author: "PostAuthor"
    text: str
    parent_id: Optional[str] = None     # reply target (one level of nesting)
    likes_count: int = 0
    liked_by_me: bool = False
    replies_count: int = 0
    edited_at: Optional[datetime] = None
    mine: bool = False
    created_at: datetime


class MarketplaceReviewCreate(BaseModel):
    rating: Optional[int] = None
    ratings: Optional[dict] = None   # granular per-category stars (1-5 each)
    text: Optional[str] = ""


class MarketplaceReview(BaseModel):
    id: str
    subject_user_id: Optional[str] = None       # personal seller/buyer review
    subject_business_id: Optional[str] = None   # business storefront review (separate)
    reviewer: "PostAuthor"
    rating: int
    ratings: dict = {}               # granular per-category stars
    verified: bool = True            # backed by a verified trade between the two
    role: str = "seller"             # subject's role in the trade: "seller" | "buyer"
    text: Optional[str] = ""
    created_at: datetime


class SellerProfile(BaseModel):
    user: PublicUser
    rating: float = 0.0
    review_count: int = 0
    seller_rating: float = 0.0       # rating earned acting as a seller
    seller_review_count: int = 0
    buyer_rating: float = 0.0        # rating earned acting as a buyer
    buyer_review_count: int = 0
    category_ratings: dict = {}      # avg stars per granular category
    listing_count: int = 0
    listings: List[Listing] = []
    reviewed_by_me: bool = False
    can_review: bool = False   # viewer has a verified trade with this seller


# ---------- Business storefronts ----------
# A business profile is a separate selling identity owned by a user. It is kept
# apart from the user's personal/social profile, but its lifecycle is tied to the
# owner: if the owner's personal account is banned, the business is banned too
# (the cascade is enforced on read — a banned owner's storefront is hidden).
class BusinessBrand(BaseModel):
    """Lightweight brand shown on listing cards sold by a business."""
    id: str
    name: str
    logo: Optional[str] = None
    accent: Optional[str] = None
    verified: bool = False


class BusinessProfilePatch(BaseModel):
    name: Optional[str] = None
    tagline: Optional[str] = None
    bio: Optional[str] = None
    logo: Optional[str] = None
    banner: Optional[str] = None
    accent: Optional[str] = None          # hex like #7C3AED; "" clears it
    category: Optional[str] = None
    policies: Optional[str] = None
    location: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    website: Optional[str] = None


class BusinessProfile(BaseModel):
    id: str
    owner_id: str
    owner: Optional["PostAuthor"] = None  # the personal account behind the storefront
    name: str
    tagline: Optional[str] = None
    bio: Optional[str] = None
    logo: Optional[str] = None
    banner: Optional[str] = None
    accent: Optional[str] = None
    category: Optional[str] = None
    policies: Optional[str] = None
    location: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    website: Optional[str] = None
    listing_count: int = 0
    rating: float = 0.0                     # from the business's OWN reviews (separate from the owner)
    review_count: int = 0
    is_owner: bool = False                 # viewer owns this storefront
    reviewed_by_me: bool = False           # viewer already reviewed this business
    can_review: bool = False               # viewer has a verified trade with this business
    listings: List["Listing"] = []
    created_at: datetime


class TradeStart(BaseModel):
    pass


class TradeConfirm(BaseModel):
    code: str


# ---------- Posts (Newsfeed) ----------
class PostMedia(BaseModel):
    type: Literal["image", "video"] = "image"
    base64: str = ""     # data URI or raw base64 (empty when `url` is set)
    url: Optional[str] = None  # CDN URL (e.g. Cloudinary) — preferred over base64
    thumbnail: Optional[str] = None  # for videos
    width: Optional[int] = None
    height: Optional[int] = None
    duration: Optional[float] = None  # video length in seconds (drives a duration badge)


class LinkPreview(BaseModel):
    url: str
    title: Optional[str] = None
    description: Optional[str] = None
    image: Optional[str] = None
    site_name: Optional[str] = None


class PollOption(BaseModel):
    id: str
    text: str
    votes: int = 0


class Poll(BaseModel):
    options: List[PollOption]
    total_votes: int = 0
    voted_option_id: Optional[str] = None  # filled per viewer
    ends_at: datetime
    closed: bool = False


class PollCreate(BaseModel):
    options: List[str]
    duration_hours: int = 24


class PostCreate(BaseModel):
    text: str = ""
    parent_id: Optional[str] = None
    quote_of: Optional[str] = None     # NEW: quote-repost target id
    kind: Optional[Literal["post", "reel", "video"]] = None  # explicit media kind; derived from media+title when omitted
    place_name: Optional[str] = None
    place_longitude: Optional[float] = None
    place_latitude: Optional[float] = None
    media: Optional[List[PostMedia]] = None
    poll: Optional[PollCreate] = None  # NEW
    community_id: Optional[str] = None  # forum: post belongs to a community
    title: Optional[str] = None         # forum thread title
    flair: Optional[str] = None         # forum: post flair (must be one of the community's flairs)
    likes_disabled: Optional[bool] = None              # turn off likes for this post
    comment_policy: Optional[str] = None               # everyone | followers | friends | nobody
    min_sub_tier: Optional[int] = None                 # 0 = public; 1-3 = subscribers-only (Twitch-style)
    tagged_user_ids: Optional[List[str]] = None        # people tagged in this post
    audience_circle_id: Optional[str] = None           # if set, only this circle's members (+ you) can see it


class CommunityCreate(BaseModel):
    name: str                          # url slug, unique
    title: Optional[str] = None
    description: Optional[str] = ""
    color: Optional[str] = "#3B82F6"
    icon: Optional[str] = "people"
    rules: Optional[List[str]] = None
    flairs: Optional[List[str]] = None
    banner: Optional[str] = None


class CommunityPatch(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None
    icon: Optional[str] = None
    rules: Optional[List[str]] = None
    flairs: Optional[List[str]] = None
    banner: Optional[str] = None       # "" clears the banner image
    wiki: Optional[str] = None         # long-form about/wiki page ("" clears)
    banned_keywords: Optional[List[str]] = None  # auto-mod: block posts containing these


class Community(BaseModel):
    id: str
    name: str
    title: str
    description: str = ""
    color: str = "#3B82F6"
    icon: str = "people"
    banner: Optional[str] = None       # cover image (URL / data URI)
    rules: List[str] = []              # community rules shown in the sidebar
    flairs: List[str] = []             # post flair options
    wiki: Optional[str] = None         # long-form about/wiki page
    banned_keywords: List[str] = []    # auto-mod blocklist (visible to mods only)
    owner_id: str
    member_count: int = 0
    post_count: int = 0
    is_member: bool = False
    is_favorite: bool = False          # viewer has favorited this community
    role: Optional[str] = None         # owner | mod | member | None
    can_moderate: bool = False         # viewer is owner or mod
    created_at: datetime


class PostPatch(BaseModel):
    text: Optional[str] = None
    media: Optional[List[PostMedia]] = None
    place_name: Optional[str] = None
    place_longitude: Optional[float] = None
    place_latitude: Optional[float] = None
    comment_policy: Optional[str] = None               # everyone | followers | friends | nobody
    tagged_user_ids: Optional[List[str]] = None        # full replacement of tagged people


class PostPrivacyPatch(BaseModel):
    likes_disabled: Optional[bool] = None
    comment_policy: Optional[str] = None   # everyone | followers | friends | nobody
    min_sub_tier: Optional[int] = None     # 0 = public; 1-3 = subscribers-only


class PostAuthor(BaseModel):
    user_id: str
    name: str
    username: Optional[str] = None
    picture: Optional[str] = None
    verified: bool = False
    badges: List[Badge] = []
    # Marketplace trust signals (populated for listing sellers; default False elsewhere).
    id_verified: bool = False
    phone_verified: bool = False
    email_verified: bool = False


class TaggedUser(BaseModel):
    user_id: str
    name: str
    username: Optional[str] = None
    picture: Optional[str] = None


class ReactionCount(BaseModel):
    emoji: str
    count: int = 0


class Post(BaseModel):
    id: str
    user_id: str
    author: PostAuthor
    text: str
    parent_id: Optional[str] = None
    repost_of: Optional[str] = None
    quote_of: Optional[str] = None
    reposted_post: Optional["Post"] = None
    quoted_post: Optional["Post"] = None
    place_name: Optional[str] = None
    place_longitude: Optional[float] = None
    place_latitude: Optional[float] = None
    media: List[PostMedia] = []
    kind: str = "post"                 # "post" | "reel" (untitled video) | "video" (titled video)
    tagged_users: List[TaggedUser] = []
    link_preview: Optional[LinkPreview] = None
    poll: Optional[Poll] = None
    hashtags: List[str] = []
    likes_count: int = 0
    dislikes_count: int = 0
    reactions: List["ReactionCount"] = []   # emoji reaction tallies (desc by count)
    reactions_total: int = 0
    my_reaction: Optional[str] = None        # the emoji the viewer reacted with, if any
    replies_count: int = 0
    thread_count: int = 0              # self-replies under this post (author continuing their own thread)
    reposts_count: int = 0
    quotes_count: int = 0
    bookmarks_count: int = 0
    views_count: int = 0
    likes_disabled: bool = False
    comment_policy: str = "everyone"   # everyone | followers | friends | nobody
    min_sub_tier: int = 0              # 0 = public; 1-3 = subscribers-only (Twitch-style)
    audience_circle_id: Optional[str] = None   # posted to an audience circle (only members + author see it)
    audience_circle_name: Optional[str] = None # the circle's name, for a badge
    locked: bool = False              # gated content the viewer hasn't unlocked (content stripped)
    can_comment: bool = True           # may the current viewer comment?
    liked_by_me: bool = False
    disliked_by_me: bool = False
    bookmarked_by_me: bool = False
    promoted: bool = False
    promoted_until: Optional[datetime] = None
    edited_at: Optional[datetime] = None
    reposted_by_me: bool = False
    pinned: bool = False
    community_id: Optional[str] = None
    community_name: Optional[str] = None
    title: Optional[str] = None
    flair: Optional[str] = None        # forum post flair
    author_karma: Optional[int] = None # author's karma in this community (forum context)
    factcheck: Optional[dict] = None   # shown community Factcheck note {id, text, source_url}
    created_at: datetime


class PromoteCreate(BaseModel):
    days: int = 7
    budget: Optional[float] = None   # campaign budget in $ (pay-per-click)
    cpc: Optional[float] = None      # cost per click in $


Listing.model_rebuild()
ListingComment.model_rebuild()
MarketplaceReview.model_rebuild()
SellerProfile.model_rebuild()
BusinessProfile.model_rebuild()
Post.model_rebuild()


class GroupCreate(BaseModel):
    name: str
    description: Optional[str] = ""
    color: Optional[str] = "#3B82F6"
    is_private: Optional[bool] = False


# ───────── Stories ─────────

class StoryMedia(BaseModel):
    type: Literal["image", "video"] = "image"
    base64: str
    duration_ms: Optional[int] = None  # for videos


class StoryCreate(BaseModel):
    media: StoryMedia
    caption: Optional[str] = ""


class Story(BaseModel):
    id: str
    user_id: str
    user_name: str
    user_picture: Optional[str] = None
    user_username: Optional[str] = None
    type: Literal["image", "video"]
    media_base64: str
    caption: Optional[str] = ""
    duration_ms: Optional[int] = None
    view_count: int = 0
    viewed_by_me: bool = False
    created_at: datetime
    expires_at: datetime


class StoryTrayItem(BaseModel):
    user_id: str
    user_name: str
    user_picture: Optional[str] = None
    user_username: Optional[str] = None
    has_unviewed: bool
    story_count: int
    latest_at: datetime


class StoryViewer(BaseModel):
    user_id: str
    name: str
    username: Optional[str] = None
    picture: Optional[str] = None
    viewed_at: datetime


class StoryReply(BaseModel):
    text: str


class Group(BaseModel):
    id: str
    name: str
    description: Optional[str] = ""
    color: str = "#3B82F6"
    cover_image: Optional[str] = None
    is_private: bool = False
    rules: List[str] = []
    owner_id: str
    member_count: int = 1
    is_member: bool = False
    membership_pending: bool = False
    my_role: str = "member"
    pending_request_count: int = 0
    pinned_post_ids: List[str] = []
    created_at: datetime


class GroupPostCreate(BaseModel):
    text: str


class GroupEventCreate(BaseModel):
    title: str
    description: Optional[str] = ""
    location: Optional[str] = None
    starts_at: str                      # ISO 8601 start time


class GroupEvent(BaseModel):
    id: str
    group_id: str
    creator_id: str
    creator_name: str = ""
    title: str
    description: str = ""
    location: Optional[str] = None
    starts_at: str
    going_count: int = 0
    going: bool = False                  # is the viewer attending?
    can_manage: bool = False             # viewer is the creator or a group admin/owner
    created_at: datetime


class FsqProfile(BaseModel):
    fsq_id: str
    name: str
    address: Optional[str] = None
    locality: Optional[str] = None
    category: Optional[str] = None
    rating: Optional[float] = None
    price: Optional[int] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    hours_display: Optional[str] = None
    open_now: Optional[bool] = None
    photo: Optional[str] = None
    distance: Optional[int] = None
