"""Pydantic request schemas (validation happens before any endpoint code runs)."""
import re
import uuid
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

USERNAME_RE = re.compile(r"^[a-z0-9_.]{3,20}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE_RE = re.compile(r"^\+?[0-9]{7,15}$")


def normalize_contact(value: str) -> str:
    v = value.strip()
    if EMAIL_RE.match(v):
        return v.lower()
    p = re.sub(r"[\s\-()]", "", v)
    if PHONE_RE.match(p):
        return p
    raise ValueError("Enter a valid email address or phone number")


def contact_kind(contact: str) -> str:
    return "email" if "@" in contact else "phone"


def check_uuid(v: str) -> str:
    try:
        return str(uuid.UUID(str(v)))
    except ValueError:
        raise ValueError("invalid id")


Code = Field(pattern=r"^\d{6}$")
CTA_LABELS = ("Watch", "Visit site", "Learn more")
# v7: post `format` is derived from the upload type (the Create studio picks the type from the file)
FORMAT_BY_TYPE = {"video": "video", "clip": "reel", "photo": "post", "community": "post", "story": "post"}


def clean_username(v: str) -> str:
    v = v.strip().lower().lstrip("@")
    if not USERNAME_RE.match(v):
        raise ValueError("Username must be 3-20 characters: letters, numbers, . or _")
    return v


def clean_display_name(v: str) -> str:
    v = v.strip()
    if not v:
        raise ValueError("Display name is required")
    return v


class SignupIn(BaseModel):
    username: str
    contact: str
    display_name: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=8, max_length=72)

    @field_validator("username")
    @classmethod
    def _username(cls, v: str) -> str:
        return clean_username(v)

    @field_validator("contact")
    @classmethod
    def _contact(cls, v: str) -> str:
        return normalize_contact(v)

    @field_validator("display_name")
    @classmethod
    def _dn(cls, v: str) -> str:
        return clean_display_name(v)

    @field_validator("password")
    @classmethod
    def _pw(cls, v: str) -> str:
        if len(v.encode()) > 72:  # bcrypt limit
            raise ValueError("Password is too long (max 72 bytes)")
        return v


class GoogleIn(BaseModel):
    """v7: the Supabase Auth access token the browser got after 'Continue with Google' (verified server-side)."""
    access_token: str = Field(min_length=20, max_length=4000)


class GoogleSetupIn(BaseModel):
    """v7: onboarding for a brand-new Google user - they pick @username + display name."""
    setup_token: str = Field(min_length=20, max_length=4000)
    username: str
    display_name: str = Field(min_length=1, max_length=40)

    @field_validator("username")
    @classmethod
    def _username(cls, v: str) -> str:
        return clean_username(v)

    @field_validator("display_name")
    @classmethod
    def _dn(cls, v: str) -> str:
        return clean_display_name(v)


class LoginIn(BaseModel):
    identifier: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=72)


class VerifyOtpIn(BaseModel):
    code: str = Code
    identifier: Optional[str] = Field(default=None, max_length=120)  # signup flow
    mfa_token: Optional[str] = None                                  # login flow


class ResendIn(BaseModel):
    identifier: Optional[str] = Field(default=None, max_length=120)
    mfa_token: Optional[str] = None


class TwoFAVerifyIn(BaseModel):
    code: str = Code
    mfa_token: Optional[str] = None


class TwoFADisableIn(BaseModel):
    password: str = Field(min_length=1, max_length=72)
    code: str = Code


class FollowIn(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    follow: bool = True


class ProfileUpdate(BaseModel):
    display_name: Optional[str] = Field(default=None, min_length=1, max_length=40)
    bio: Optional[str] = Field(default=None, max_length=160)
    avatar_path: Optional[str] = Field(default=None, max_length=300)


class KeyIn(BaseModel):
    public_key: str = Field(min_length=20, max_length=2000)
    key_backup: Optional[str] = Field(default=None, max_length=4000)  # password-encrypted private key (opaque)


class KeysIn(BaseModel):
    usernames: List[str] = Field(min_length=1, max_length=50)


class PostCreate(BaseModel):
    type: Literal["video", "clip", "photo", "story", "community"]
    title: str = Field(default="", max_length=100)
    caption: str = Field(default="", max_length=1000)
    visibility: Literal["public", "followers"] = "public"
    media_path: Optional[str] = Field(default=None, min_length=3, max_length=300)
    poster_path: Optional[str] = Field(default=None, max_length=300)
    mime: Optional[str] = Field(default=None, max_length=100)
    music: str = Field(default="", max_length=800)
    duration: float = Field(default=0, ge=0, le=86400)
    size: int = Field(default=0, ge=0)
    is_sponsored: bool = False                                  # v6: creator promotes this upload as a Sponsored ad
    cta_label: str = Field(default="", max_length=24)           # v6: Watch / Visit site / Learn more
    cta_url: str = Field(default="", max_length=400)            # v6: https link for the CTA button (optional for 'Watch')
    format: Optional[Literal["video", "reel", "post"]] = None   # v7: omitted = derived from type; must match the type if sent
    allow_download: bool = True                                 # v7: creator can hide the Download button
    ad_placement: Literal["none", "feed", "preroll", "midroll"] = "none"   # v7: where the promoted post is shown
    ad_budget: float = Field(default=0, ge=0, le=1_000_000)     # v7: creator-declared budget (no payments are processed)

    @field_validator("ad_budget")
    @classmethod
    def _budget(cls, v): return round(v, 2)

    @field_validator("music")
    @classmethod
    def _music(cls, v): return clean_music(v)

    @field_validator("cta_label")
    @classmethod
    def _cta_label(cls, v):
        v = (v or "").strip()
        if v and v not in CTA_LABELS:
            raise ValueError("Button must be Watch, Visit site or Learn more")
        return v

    @field_validator("cta_url")
    @classmethod
    def _cta_url(cls, v):
        v = (v or "").strip()
        if not v:
            return ""
        from urllib.parse import urlparse
        u = urlparse(v)
        if u.scheme != "https" or not u.hostname or "." not in u.hostname:
            raise ValueError("Ad links must be https:// URLs")
        return v


class LikeIn(BaseModel):
    post_id: str

    @field_validator("post_id")
    @classmethod
    def _id(cls, v): return check_uuid(v)


class ViewIn(BaseModel):
    post_id: str
    position: float = Field(default=0, ge=0)
    duration: float = Field(default=0, ge=0)
    count: bool = True  # False when only updating the resume position

    @field_validator("post_id")
    @classmethod
    def _id(cls, v): return check_uuid(v)


class ChatMemberKey(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    wrapped_key: Optional[str] = Field(default=None, max_length=2000)


class ChatCreate(BaseModel):
    type: Literal["direct", "group", "channel"]
    title: str = Field(default="", max_length=60)
    description: str = Field(default="", max_length=200)
    members: List[ChatMemberKey] = Field(default_factory=list, max_length=50)
    my_wrapped_key: Optional[str] = Field(default=None, max_length=2000)


class SendIn(BaseModel):
    conversation_id: str
    ciphertext: str = Field(min_length=1, max_length=12000)
    iv: str = Field(default="", max_length=100)

    @field_validator("conversation_id")
    @classmethod
    def _id(cls, v): return check_uuid(v)


def clean_gif(v) -> str:
    """A comment GIF is an https GIPHY/Tenor URL, or a built-in sticker written as 'sticker:<emoji>'. '' = none."""
    v = (v or "").strip()
    if not v:
        return ""
    if v.startswith("sticker:"):
        if not 0 < len(v) - 8 <= 12:
            raise ValueError("Invalid sticker")
        return v
    from urllib.parse import urlparse
    u = urlparse(v)
    host = (u.hostname or "").lower()
    ok = u.scheme == "https" and any(host == d or host.endswith("." + d) for d in ("giphy.com", "tenor.com", "tenor.googleapis.com"))
    if not ok or len(v) > 400:
        raise ValueError("Unsupported GIF link")
    return v


class CommentIn(BaseModel):
    post_id: str
    body: str = Field(default="", max_length=500)
    parent_id: Optional[str] = None
    gif_url: str = Field(default="", max_length=420)   # v6: GIF / sticker comment

    @field_validator("gif_url")
    @classmethod
    def _gif(cls, v): return clean_gif(v)

    @model_validator(mode="after")
    def _non_empty(self):
        if not self.body.strip() and not self.gif_url:
            raise ValueError("Write a comment or pick a GIF")
        return self

    @field_validator("post_id")
    @classmethod
    def _p(cls, v): return check_uuid(v)

    @field_validator("parent_id")
    @classmethod
    def _c(cls, v): return check_uuid(v) if v else None


class CommentLikeIn(BaseModel):
    comment_id: str

    @field_validator("comment_id")
    @classmethod
    def _id(cls, v): return check_uuid(v)


class SaveIn(BaseModel):
    post_id: str

    @field_validator("post_id")
    @classmethod
    def _id(cls, v): return check_uuid(v)


def _safe_media_url(v) -> str:
    """Only https URLs on Apple's preview/artwork hosts (iTunes Search API) are accepted for music tracks."""
    from urllib.parse import urlparse
    u = urlparse(str(v or ""))
    host = (u.hostname or "").lower()
    ok = u.scheme == "https" and (host == "apple.com" or host.endswith(".apple.com") or host.endswith(".mzstatic.com"))
    if not ok or len(str(v)) > 400:
        raise ValueError("Unsupported music link")
    return str(v)


def clean_track(t) -> Optional[dict]:
    """Normalise a music track {title, artist, url, cover}; None when empty. Raises ValueError for bad links."""
    if not t:
        return None
    if not isinstance(t, dict):
        raise ValueError("Invalid track")
    title, artist = str(t.get("title") or "").strip()[:80], str(t.get("artist") or "").strip()[:80]
    if not title:
        raise ValueError("Track needs a title")
    cover = str(t.get("cover") or "")
    out = {"title": title, "artist": artist, "url": _safe_media_url(t.get("url")), "cover": _safe_media_url(cover) if cover else ""}
    # v6: the part of the 30 s preview the user picked in the clip selector (seconds)
    try:
        start, length = float(t.get("start") or 0), float(t.get("len") or 0)
    except (TypeError, ValueError):
        start, length = 0.0, 0.0
    if length > 0:
        out["start"] = round(min(max(start, 0.0), 30.0), 1)
        out["len"] = round(min(max(length, 3.0), 30.0), 1)
    return out


def clean_music(v: str) -> str:
    """Post music tag: plain text (max 80 chars) or a JSON track {title, artist, url, cover, start, len} from the Music Library."""
    import json
    v = (v or "").strip()
    if v.startswith("{"):
        try:
            t = clean_track(json.loads(v))
        except (ValueError, TypeError):
            raise ValueError("Invalid music track")
        return json.dumps(t, separators=(",", ":"))
    return v[:80]


class NoteIn(BaseModel):
    text: str = Field(default="", max_length=60)
    music: str = Field(default="", max_length=60)
    track: Optional[dict] = None   # {title, artist, url (30s preview), cover} from the iTunes Search API

    @field_validator("track")
    @classmethod
    def _track(cls, v): return clean_track(v)


class PinCommentIn(BaseModel):
    comment_id: str

    @field_validator("comment_id")
    @classmethod
    def _id(cls, v): return check_uuid(v)


class EditMessageIn(BaseModel):
    """Edit own message: the client re-encrypts the new text and sends the new ciphertext + iv."""
    message_id: str
    ciphertext: str = Field(min_length=1, max_length=12000)
    iv: str = Field(default="", max_length=100)

    @field_validator("message_id")
    @classmethod
    def _id(cls, v): return check_uuid(v)


class PinMessageIn(BaseModel):
    conversation_id: str
    message_id: Optional[str] = None   # None / null unpins

    @field_validator("conversation_id")
    @classmethod
    def _c(cls, v): return check_uuid(v)

    @field_validator("message_id")
    @classmethod
    def _m(cls, v): return check_uuid(v) if v else None


class AudioIn(BaseModel):
    """Save / unsave a song (iTunes preview metadata) in 'Saved Audios'."""
    title: str = Field(min_length=1, max_length=80)
    artist: str = Field(default="", max_length=80)
    url: str
    cover: str = ""

    @field_validator("url")
    @classmethod
    def _u(cls, v): return _safe_media_url(v)

    @field_validator("cover")
    @classmethod
    def _c(cls, v): return _safe_media_url(v) if v else ""


class ReactIn(BaseModel):
    message_id: str
    emoji: str = Field(default="", max_length=16)  # "" removes my reaction

    @field_validator("message_id")
    @classmethod
    def _id(cls, v): return check_uuid(v)
