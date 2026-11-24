"""Authentication building blocks: password hashing, JWTs (compatible with
Supabase RLS), email/SMS OTP codes, RFC 6238 TOTP, delivery and rate limiting."""
import base64
import hashlib
import hmac
import logging
import secrets
import smtplib
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from typing import Optional

import pyotp
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from jose import JWTError, jwt
from passlib.context import CryptContext

from config import settings
from database import first, table
from models import contact_kind

log = logging.getLogger("lokachat.auth")
_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
_DUMMY_HASH = _pwd.hash("lokachat-dummy-password")  # equalises timing for unknown users


# ---------------------------------------------------------------- passwords
def hash_password(password: str) -> str:
    return _pwd.hash(password)


def verify_password(password: str, hashed: Optional[str]) -> bool:
    ok = _pwd.verify(password, hashed or _DUMMY_HASH)
    return bool(hashed) and ok


# --------------------------------------------------------------------- JWTs
def _now() -> datetime:
    return datetime.now(timezone.utc)


def create_token(user: dict, scope: str, ttl_seconds: int, extra: Optional[dict] = None) -> str:
    """HS256 token signed with the Supabase JWT secret.

    Session tokens carry role=authenticated + sub=<user id>, so Supabase Realtime,
    Storage and PostgREST accept them and evaluate RLS with auth.uid().
    Short-lived "mfa" tokens use role=anon so they never grant data access.
    """
    now = int(time.time())
    claims = {
        "sub": user["id"], "aud": "authenticated",
        "role": "authenticated" if scope == "session" else "anon",
        "iat": now, "exp": now + ttl_seconds, "scope": scope, "username": user["username"],
    }
    claims.update(extra or {})
    return jwt.encode(claims, settings.SUPABASE_JWT_SECRET, algorithm="HS256")


def create_session_token(user: dict) -> str:
    return create_token(user, "session", settings.SESSION_TTL_HOURS * 3600)


def create_mfa_token(user: dict, kind: str) -> str:
    return create_token(user, "mfa", 300, {"kind": kind})


def decode_token(token: str, scope: str) -> dict:
    try:
        claims = jwt.decode(token, settings.SUPABASE_JWT_SECRET, algorithms=["HS256"], audience="authenticated")
    except JWTError:
        raise HTTPException(401, "Invalid or expired token")
    if claims.get("scope") != scope:
        raise HTTPException(401, "Invalid token")
    return claims


# ---------------------------------------------------------------- email OTP
def _otp_hash(user_id: str, purpose: str, code: str) -> str:
    return hmac.new(settings.SUPABASE_JWT_SECRET.encode(), f"{user_id}:{purpose}:{code}".encode(), hashlib.sha256).hexdigest()


def issue_otp(user_id: str, purpose: str) -> str:
    """Create a fresh 6-digit code (replacing any previous one); only a keyed hash is stored."""
    code = f"{secrets.randbelow(10 ** 6):06d}"
    table("otp_codes").delete().eq("user_id", user_id).eq("purpose", purpose).execute()
    table("otp_codes").insert({
        "user_id": user_id, "purpose": purpose, "code_hash": _otp_hash(user_id, purpose, code),
        "expires_at": (_now() + timedelta(minutes=settings.OTP_TTL_MINUTES)).isoformat(), "attempts": 0,
    }).execute()
    return code


def check_otp(user_id: str, purpose: str, code: str) -> bool:
    row = first(table("otp_codes").select("*").eq("user_id", user_id).eq("purpose", purpose).order("created_at", desc=True))
    if not row:
        return False
    expired = datetime.fromisoformat(row["expires_at"].replace("Z", "+00:00")) < _now()
    if expired or row["attempts"] >= settings.OTP_MAX_ATTEMPTS:
        table("otp_codes").delete().eq("id", row["id"]).execute()
        return False
    if hmac.compare_digest(row["code_hash"], _otp_hash(user_id, purpose, code)):
        table("otp_codes").delete().eq("id", row["id"]).execute()  # single use
        return True
    table("otp_codes").update({"attempts": row["attempts"] + 1}).eq("id", row["id"]).execute()
    return False


def mask_contact(contact: str) -> str:
    if "@" in contact:
        name, domain = contact.split("@", 1)
        return f"{name[:1]}{'*' * max(len(name) - 1, 2)}@{domain}"
    return f"{'*' * max(len(contact) - 3, 3)}{contact[-3:]}"


def delivery_channel(contact: str) -> str:
    if contact_kind(contact) == "email" and settings.smtp_ready:
        return "email"
    if contact_kind(contact) == "phone" and settings.twilio_ready:
        return "sms"
    return "dev"


class OtpDeliveryError(RuntimeError):
    """The code could not be delivered (bad SMTP credentials, no provider configured, network...).
    Carries a safe, human-readable reason so the API can surface it instead of the generic 500."""


def deliver_otp(contact: str, code: str, purpose: str) -> None:
    """Send the code. Blocking - run it via BackgroundTasks. Raises OtpDeliveryError on a real failure."""
    text = f"Your LokaChat verification code is {code}. It expires in {settings.OTP_TTL_MINUTES} minutes. Never share it."
    channel = delivery_channel(contact)
    try:
        if channel == "email":
            msg = EmailMessage()
            msg["Subject"], msg["From"], msg["To"] = f"LokaChat code: {code}", settings.SMTP_FROM, contact
            msg.set_content(text)
            with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=15) as s:
                s.starttls()
                s.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
                s.send_message(msg)
        elif channel == "sms":
            import httpx
            httpx.post(f"https://api.twilio.com/2010-04-01/Accounts/{settings.TWILIO_SID}/Messages.json",
                       auth=(settings.TWILIO_SID, settings.TWILIO_TOKEN),
                       data={"To": contact, "From": settings.TWILIO_FROM, "Body": text}, timeout=15).raise_for_status()
        elif settings.OTP_DEV_MODE:
            log.warning("[DEV] %s OTP for %s: %s", purpose, contact, code)
        else:
            raise OtpDeliveryError("No email/SMS provider is configured on the server, so the code could not be sent.")
    except OtpDeliveryError:
        raise
    except Exception as e:  # v8: surface the real problem instead of silently claiming the code was sent
        log.exception("OTP delivery failed")
        wake = "email" if channel == "email" else "SMS"
        raise OtpDeliveryError(f"Couldn't send the {wake} code right now. Please try again in a moment.") from e


# --------------------------------------------------------------------- TOTP
def _fernet() -> Fernet:
    if settings.TOTP_ENC_KEY:
        return Fernet(settings.TOTP_ENC_KEY.encode())
    key = hashlib.sha256(("lokachat-totp|" + settings.SUPABASE_JWT_SECRET).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_secret(secret: str) -> str:
    return _fernet().encrypt(secret.encode()).decode()


def decrypt_secret(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        raise HTTPException(500, "Stored 2FA secret cannot be decrypted (key changed?)")


def new_totp_secret() -> str:
    return pyotp.random_base32(32)


def totp_uri(secret: str, username: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name="LokaChat")


def verify_totp(secret: str, code: str, last_step: int = 0) -> Optional[int]:
    """RFC 6238 (SHA-1, 30 s, 6 digits) with +/-1 step drift. Returns the matched
    time-step, or None. Steps <= last_step are rejected to stop code replay."""
    totp, now = pyotp.TOTP(secret), time.time()
    base = int(now // 30)
    for offset in (-1, 0, 1):
        step = base + offset
        if step > (last_step or 0) and hmac.compare_digest(totp.at(now, offset), code):
            return step
    return None


# ------------------------------------------------------------- rate limiting
class RateLimiter:
    """Small in-memory sliding-window limiter (fine for a single Koyeb instance)."""

    def __init__(self) -> None:
        self._hits = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int, window: int) -> None:
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > window:
                q.popleft()
            if len(q) >= limit:
                raise HTTPException(429, "Too many attempts. Please wait a few minutes and try again.")
            q.append(now)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = RateLimiter()
