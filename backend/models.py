"""All Pydantic models used across the API."""
from __future__ import annotations

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel


class User(BaseModel):
    user_id: str
    email: str
    name: str
    username: Optional[str] = None
    picture: Optional[str] = None
    bio: Optional[str] = ""
    home_name: Optional[str] = None
    home_longitude: Optional[float] = None
    home_latitude: Optional[float] = None
    work_name: Optional[str] = None
    work_longitude: Optional[float] = None
    work_latitude: Optional[float] = None
    created_at: datetime


class PublicUser(BaseModel):
    user_id: str
    name: str
    username: Optional[str] = None
    picture: Optional[str] = None
    bio: Optional[str] = ""
    stats: dict = {}
    is_following: bool = False
    is_followed_by: bool = False
    friend_status: str = "none"  # none | request_sent | request_received | friends


class AuthResponse(BaseModel):
    session_token: str
    user: User


class ProfilePatch(BaseModel):
    name: Optional[str] = None
    bio: Optional[str] = None
    picture: Optional[str] = None
    home_name: Optional[str] = None
    home_longitude: Optional[float] = None
    home_latitude: Optional[float] = None
    work_name: Optional[str] = None
    work_longitude: Optional[float] = None
    work_latitude: Optional[float] = None


class PlaceCreate(BaseModel):
    title: str
    notes: Optional[str] = ""
    longitude: float
    latitude: float
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
    longitude: float
    latitude: float


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
    longitude: float
    latitude: float
    rating: int  # 1..5
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


class MessageCreate(BaseModel):
    type: Literal["text", "place", "media", "voice"] = "text"
    text: Optional[str] = ""
    place_name: Optional[str] = None
    place_address: Optional[str] = None
    place_longitude: Optional[float] = None
    place_latitude: Optional[float] = None
    media: Optional[List["PostMedia"]] = None
    audio_base64: Optional[str] = None       # voice note (data URI or raw base64)
    audio_duration_ms: Optional[int] = None  # length of the voice note


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
    media: List["PostMedia"] = []
    audio_base64: Optional[str] = None       # voice note
    audio_duration_ms: Optional[int] = None  # length of the voice note
    reactions: dict = {}              # {user_id: emoji}
    edited_at: Optional[datetime] = None
    read_at: Optional[datetime] = None  # last_read[peer] >= created_at
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
    other_user: Optional[PublicUser] = None  # only for DM
    members: List[PublicUser] = []           # group members (empty for DM)
    owner_id: Optional[str] = None           # group owner
    last_message: Optional[Message] = None
    last_message_at: Optional[datetime] = None
    unread_count: int = 0
    created_at: datetime


class EtaShareCreate(BaseModel):
    name: Optional[str] = None
    destination_name: Optional[str] = None
    destination_longitude: float
    destination_latitude: float
    initial_longitude: float
    initial_latitude: float
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
    current_longitude: float
    current_latitude: float
    eta_minutes: Optional[int] = None


# ---------- Marketplace ----------
class ListingCreate(BaseModel):
    title: str
    price: float = 0
    currency: str = "USD"
    category: str = "other"
    description: Optional[str] = ""
    photo_base64: Optional[str] = None
    longitude: Optional[float] = None
    latitude: Optional[float] = None
    locality: Optional[str] = None


class ListingPatch(BaseModel):
    title: Optional[str] = None
    price: Optional[float] = None
    currency: Optional[str] = None
    category: Optional[str] = None
    description: Optional[str] = None
    photo_base64: Optional[str] = None
    status: Optional[Literal["active", "sold"]] = None


class Listing(BaseModel):
    id: str
    user_id: str
    seller: "PostAuthor"
    title: str
    price: float
    currency: str = "USD"
    category: str
    description: Optional[str] = ""
    photo_base64: Optional[str] = None
    longitude: Optional[float] = None
    latitude: Optional[float] = None
    locality: Optional[str] = None
    status: str = "active"
    created_at: datetime


# ---------- Posts (Newsfeed) ----------
class PostMedia(BaseModel):
    type: Literal["image", "video"] = "image"
    base64: str          # data URI or raw base64
    thumbnail: Optional[str] = None  # for videos
    width: Optional[int] = None
    height: Optional[int] = None


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
    place_name: Optional[str] = None
    place_longitude: Optional[float] = None
    place_latitude: Optional[float] = None
    media: Optional[List[PostMedia]] = None
    poll: Optional[PollCreate] = None  # NEW


class PostPatch(BaseModel):
    text: Optional[str] = None
    media: Optional[List[PostMedia]] = None


class PostAuthor(BaseModel):
    user_id: str
    name: str
    picture: Optional[str] = None


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
    link_preview: Optional[LinkPreview] = None
    poll: Optional[Poll] = None
    hashtags: List[str] = []
    likes_count: int = 0
    replies_count: int = 0
    reposts_count: int = 0
    quotes_count: int = 0
    bookmarks_count: int = 0
    views_count: int = 0
    liked_by_me: bool = False
    bookmarked_by_me: bool = False
    edited_at: Optional[datetime] = None
    reposted_by_me: bool = False
    created_at: datetime


Listing.model_rebuild()
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
