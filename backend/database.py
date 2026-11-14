"""Supabase (PostgreSQL) access. The server uses the service_role key, which
bypasses Row Level Security - so every endpoint in main.py must enforce its own
permission checks."""
from typing import Any, Optional

from config import settings

_client: Any = None


def get_db():
    """Lazily create the Supabase client (so imports work without credentials)."""
    global _client
    if _client is None:
        if not settings.SUPABASE_URL or not settings.SUPABASE_SERVICE_KEY:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        from supabase import create_client
        _client = create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_KEY)
    return _client


def set_db(client: Any) -> None:
    """Swap the client (used by the test-suite)."""
    global _client
    _client = client


def table(name: str):
    return get_db().table(name)


def rows(query) -> list:
    """Execute a query builder and return its rows."""
    return query.execute().data or []


def first(query) -> Optional[dict]:
    """Execute a SELECT query builder and return the first row (or None)."""
    data = query.limit(1).execute().data or []
    return data[0] if data else None


def public_url(path: Optional[str]) -> Optional[str]:
    """Public CDN URL of an object in the (public) media bucket."""
    if not path:
        return None
    return f"{settings.SUPABASE_URL}/storage/v1/object/public/{settings.STORAGE_BUCKET}/{path}"


def remove_files(paths: list) -> None:
    paths = [p for p in paths if p]
    if not paths:
        return
    try:
        get_db().storage.from_(settings.STORAGE_BUCKET).remove(paths)
    except Exception:  # storage cleanup is best-effort
        pass
