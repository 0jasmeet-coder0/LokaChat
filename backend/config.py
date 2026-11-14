"""Central settings, read from environment variables (see .env.example).

On Koyeb set these under Service -> Settings -> Environment variables.
Locally, copy .env.example to .env (loaded automatically).
"""
import os

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:  # python-dotenv is optional in production
    pass


def _bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


class Settings:
    # --- Supabase (server-side secrets: NEVER put these in the frontend) ---
    SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
    SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")   # service_role key
    SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")     # legacy JWT secret
    STORAGE_BUCKET = os.getenv("STORAGE_BUCKET", "media")

    # --- Sessions / OTP ---
    SESSION_TTL_HOURS = int(os.getenv("SESSION_TTL_HOURS", "168"))  # 7 days
    OTP_TTL_MINUTES = int(os.getenv("OTP_TTL_MINUTES", "10"))
    OTP_MAX_ATTEMPTS = int(os.getenv("OTP_MAX_ATTEMPTS", "5"))
    # DEV ONLY: returns the OTP in the API response so you can test without email/SMS.
    OTP_DEV_MODE = _bool("OTP_DEV_MODE", False)
    TOTP_ENC_KEY = os.getenv("TOTP_ENC_KEY", "")                   # optional Fernet key

    # --- CORS ---
    ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

    # --- OTP delivery: email via SMTP (e.g. Gmail app password) ---
    SMTP_HOST = os.getenv("SMTP_HOST", "")
    SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
    SMTP_USER = os.getenv("SMTP_USER", "")
    SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
    SMTP_FROM = os.getenv("SMTP_FROM", "") or os.getenv("SMTP_USER", "")

    # --- OTP delivery: SMS via Twilio (optional) ---
    TWILIO_SID = os.getenv("TWILIO_SID", "")
    TWILIO_TOKEN = os.getenv("TWILIO_TOKEN", "")
    TWILIO_FROM = os.getenv("TWILIO_FROM", "")

    @property
    def smtp_ready(self) -> bool:
        return bool(self.SMTP_HOST and self.SMTP_USER and self.SMTP_PASSWORD)

    @property
    def twilio_ready(self) -> bool:
        return bool(self.TWILIO_SID and self.TWILIO_TOKEN and self.TWILIO_FROM)


settings = Settings()
