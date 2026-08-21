"""Conservatively monitor the X accounts in ``data/artists.json``.

The job deliberately uses public, logged-out endpoints. An account is never
marked unavailable because of an exception, timeout, rate limit, or a single
negative response.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DATA_PATH = Path(os.environ.get("ARTISTS_PATH", "data/artists.json"))
LEGACY_DATA_PATH = Path(os.environ.get("ARCHIVES_PATH", "data/archives.json"))
SYNDICATION_URL = "https://cdn.syndication.twimg.com/widgets/followbutton/info.json"
PROFILE_URL_TEMPLATE = "https://x.com/{username}"
UNAVAILABLE_THRESHOLD = 3
USER_AGENT = "x-archives/1.0 (+https://github.com/yamada1221/x-archives)"
DIAGNOSTIC_BODY_LIMIT = 160
PROFILE_BODY_LIMIT = 512 * 1024


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def request(url: str, *, data: bytes | None = None, timeout: int = 20):
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
        },
    )
    return urllib.request.urlopen(req, timeout=timeout)


def safe_preview(raw: bytes, limit: int = DIAGNOSTIC_BODY_LIMIT) -> str:
    """Return a short single-line body preview suitable for public CI logs/data."""
    text = raw[:limit].decode("utf-8", errors="replace")
    return " ".join(text.split())


def response_content_type(response) -> str:
    headers = getattr(response, "headers", None)
    return headers.get("Content-Type", "unknown") if headers else "unknown"


def http_error_detail(prefix: str, exc: urllib.error.HTTPError) -> str:
    content_type = exc.headers.get("Content-Type", "unknown") if exc.headers else "unknown"
    try:
        preview = safe_preview(exc.read(DIAGNOSTIC_BODY_LIMIT))
    except Exception:
        preview = "<unreadable>"
    return f"{prefix} HTTP {exc.code}; content-type={content_type}; body={preview!r}"


def probe_profile_page_status(username: str) -> tuple[str, str]:
    """Conservatively classify the public X profile page and return diagnostics."""
    url = PROFILE_URL_TEMPLATE.format(username=urllib.parse.quote(username, safe=""))
    try:
        with request(url) as response:
            status = getattr(response, "status", 200)
            content_type = response_content_type(response)
            final_url = response.geturl()
            raw = response.read(PROFILE_BODY_LIMIT)
        lower = raw.lower()
        user_marker = username.lower().encode("utf-8") in lower
        suspended_marker = b"account suspended" in lower
        missing_marker = b"this account doesn" in lower and b"exist" in lower
        detail = (
            f"profile page HTTP {status}; content-type={content_type}; final_url={final_url}; "
            f"contains_username={user_marker}; suspended_marker={suspended_marker}; "
            f"missing_marker={missing_marker}; bytes={len(raw)}; body={safe_preview(raw)!r}"
        )
        if suspended_marker or missing_marker:
            return "unavailable", detail
        if status == 200 and user_marker:
            return "active", detail
        return "unknown", detail
    except urllib.error.HTTPError as exc:
        return "unknown", http_error_detail("profile page returned", exc)
    except OSError as exc:
        return "unknown", f"profile page failure: {type(exc).__name__}: {exc}"


def probe_profile_page(username: str) -> str:
    """Return diagnostics for the public X profile page without exposing headers."""
    return probe_profile_page_status(username)[1]


def merge_legacy_artists(current: dict, legacy: dict) -> int:
    """Merge legacy entries without overwriting or duplicating artists."""
    artists = current.setdefault("artists", [])

    def keys(artist: dict) -> set[tuple[str, str]]:
        result = set()
        account = str(artist.get("x_account", "")).strip().lstrip("@").lower()
        artist_id = str(artist.get("id", "")).strip()
        if account:
            result.add(("x_account", account))
        if artist_id:
            result.add(("id", artist_id))
        if not result:
            result.add(("record", json.dumps(artist, ensure_ascii=False, sort_keys=True)))
        return result

    known = set().union(*(keys(artist) for artist in artists)) if artists else set()
    added = 0
    for legacy_artist in legacy.get("artists", []):
        legacy_keys = keys(legacy_artist)
        if legacy_keys & known:
            continue
        artists.append(json.loads(json.dumps(legacy_artist)))
        known.update(legacy_keys)
        added += 1
    return added


def probe_account(username: str) -> tuple[str, str]:
    """Return (result, detail), where result is active/unavailable/unknown."""
    url = SYNDICATION_URL + "?" + urllib.parse.urlencode({"screen_names": username})
    try:
        with request(url) as response:
            status = getattr(response, "status", 200)
            content_type = response_content_type(response)
            raw = response.read()
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            fallback_result, fallback = probe_profile_page_status(username)
            return (
                fallback_result,
                f"non-JSON public response; HTTP {status}; content-type={content_type}; "
                f"body={safe_preview(raw)!r}; {fallback}",
            )
        if payload and payload[0].get("screen_name", "").lower() == username.lower():
            return "active", "public profile returned"
        return "unavailable", "public endpoint returned no matching profile"
    except urllib.error.HTTPError as exc:
        if exc.code in (404, 410):
            return "unavailable", http_error_detail("public endpoint returned", exc)
        return "unknown", http_error_detail("public endpoint returned", exc)
    except OSError as exc:
        return "unknown", f"temporary probe failure: {type(exc).__name__}: {exc}"


def record_check(artist: dict, result: str, detail: str, checked_at: str) -> None:
    monitoring = artist.setdefault("monitoring", {})
    old_status = monitoring.get("status", "unknown")
    failures = int(monitoring.get("consecutive_unavailable", 0))

    if result == "active":
        new_status, failures = "active", 0
    elif result == "unavailable":
        failures += 1
        new_status = "unavailable" if failures >= UNAVAILABLE_THRESHOLD else old_status
    else:
        new_status = old_status

    monitoring.update(
        status=new_status,
        last_checked_at=checked_at,
        last_result=result,
        last_detail=detail,
        consecutive_unavailable=failures,
    )
    if new_status != old_status:
        artist.setdefault("status_history", []).append(
            {"from": old_status, "to": new_status, "at": checked_at, "reason": detail}
        )


def process(data: dict) -> dict:
    checked_at = now()
    for artist in data.get("artists", []):
        username = str(artist.get("x_account", "")).strip().lstrip("@")
        if not username:
            continue
        artist["x_account"] = username
        result, detail = probe_account(username)
        print(f"X probe @{username}: {result} — {detail}", flush=True)
        record_check(artist, result, detail, checked_at)
    return data


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--diagnose-profile",
        metavar="X_ACCOUNT",
        help="print public X profile-page diagnostics without changing data",
    )
    args = parser.parse_args()
    if args.diagnose_profile:
        username = args.diagnose_profile.strip().lstrip("@")
        result, detail = probe_profile_page_status(username)
        print(f"Profile diagnostic @{username}: {result} — {detail}")
        return
    data = json.loads(DATA_PATH.read_text(encoding="utf-8")) if DATA_PATH.exists() else {"artists": []}
    if LEGACY_DATA_PATH.exists():
        legacy = json.loads(LEGACY_DATA_PATH.read_text(encoding="utf-8"))
        merge_legacy_artists(data, legacy)
    process(data)
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    DATA_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
