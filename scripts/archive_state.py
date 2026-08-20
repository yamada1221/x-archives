from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable


def record_artists(artists: Iterable[dict]) -> list[dict]:
    """Return only artists whose tracking mode requires archival recording."""
    return [artist for artist in artists if artist.get("tracking_mode") == "record"]


def archive_target_url(artist: dict) -> str:
    """Return the X URL to archive for an artist."""
    account = str(artist.get("x_account") or "").strip().lstrip("@")
    if not account:
        raise ValueError("x_account is required")
    suffix = "/with_replies" if artist.get("archive_with_replies") is True else ""
    return f"https://x.com/{account}{suffix}"


def bookmark_target_url(artist: dict) -> str:
    """Hatena Bookmark always targets the normal X profile URL."""
    account = str(artist.get("x_account") or "").strip().lstrip("@")
    if not account:
        raise ValueError("x_account is required")
    return f"https://x.com/{account}"


def mark_archive_result(artist: dict, *, success: bool, archived_url: str | None = None,
                        error: str | None = None, now: datetime | None = None) -> dict:
    """Return a copy of artist with the latest archive attempt state recorded."""
    updated = dict(artist)
    timestamp = (now or datetime.now(timezone.utc)).isoformat()
    updated["archive_status"] = "done" if success else "error"
    updated["archive_checked_at"] = timestamp
    if success:
        updated["archive_url"] = archived_url or archive_target_url(artist)
        updated.pop("archive_error", None)
    else:
        updated["archive_error"] = error or "archive failed"
    return updated
