"""Pydantic request schemas (validation happens before any endpoint code runs)."""
import re
import uuid
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

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


class SignupIn(BaseModel):
    username: str
    contact: str
    display_name: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=8, max_length=72)

    @field_validator("username")
    @classmethod
    def _username(cls, v: str) -> str:
        v = v.strip().lower().lstrip("@")
        if not USERNAME_RE.match(v):
            raise ValueError("Username must be 3-20 characters: letters, numbers, . or _")
        return v

    @field_validator("contact")
    @classmethod
    def _contact(cls, v: str) -> str:
        return normalize_contact(v)

    @field_validator("display_name")
    @classmethod
    def _dn(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Display name is required")
        return v

    @field_validator("password")
    @classmethod
    def _pw(cls, v: str) -> str:
        if len(v.encode()) > 72:  # bcrypt limit
            raise ValueError("Password is too long (max 72 bytes)")
        return v


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
    music: str = Field(default="", max_length=80)
    duration: float = Field(default=0, ge=0, le=86400)
    size: int = Field(default=0, ge=0)


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


class CommentIn(BaseModel):
    post_id: str
    body: str = Field(min_length=1, max_length=500)
    parent_id: Optional[str] = None

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
    return {"title": title, "artist": artist, "url": _safe_media_url(t.get("url")), "cover": _safe_media_url(cover) if cover else ""}


class NoteIn(BaseModel):
    text: str = Field(default="", max_length=60)
    music: str = Field(default="", max_length=60)
    track: Optional[dict] = None   # {title, artist, url (30s preview), cover} from the iTunes Search API

    @field_validator("track")
    @classmethod
    def _track(cls, v): return clean_track(v)


class ReactIn(BaseModel):
    message_id: str
    emoji: str = Field(default="", max_length=16)  # "" removes my reaction

    @field_validator("message_id")
    @classmethod
    def _id(cls, v): return check_uuid(v)
