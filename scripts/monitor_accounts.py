"""Archive and conservatively monitor the X accounts in ``data/artists.json``.

The job deliberately uses public, logged-out endpoints.  An account is never
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
from typing import Callable

DATA_PATH = Path(os.environ.get("ARTISTS_PATH", "data/artists.json"))
ARCHIVE_SUBMIT_URL = "https://archive.md/submit/"
SYNDICATION_URL = "https://cdn.syndication.twimg.com/widgets/followbutton/info.json"
UNAVAILABLE_THRESHOLD = 3
USER_AGENT = "x-archives/1.0 (+https://github.com/yamada1221/x-archives)"


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def request(url: str, *, data: bytes | None = None, timeout: int = 20):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    return urllib.request.urlopen(req, timeout=timeout)


def probe_account(username: str) -> tuple[str, str]:
    """Return (result, detail), where result is active/unavailable/unknown."""
    url = SYNDICATION_URL + "?" + urllib.parse.urlencode({"screen_names": username})
    try:
        with request(url) as response:
            payload = json.loads(response.read())
        if payload and payload[0].get("screen_name", "").lower() == username.lower():
            return "active", "public profile returned"
        # A successful, account-specific lookup with no match is evidence, but
        # record_check requires this result on three separate runs before the
        # externally visible state changes.
        return "unavailable", "public endpoint returned no matching profile"
    except urllib.error.HTTPError as exc:
        if exc.code in (404, 410):
            return "unavailable", f"public endpoint returned HTTP {exc.code}"
        return "unknown", f"public endpoint returned HTTP {exc.code}"
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return "unknown", f"temporary probe failure: {type(exc).__name__}"


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
        # Unknown checks neither change the state nor advance/reset evidence.
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


def submit_archive(username: str) -> str:
    target = f"https://x.com/{username}"
    body = urllib.parse.urlencode({"url": target}).encode()
    with request(ARCHIVE_SUBMIT_URL, data=body, timeout=90) as response:
        final_url = response.geturl()
    if not final_url.startswith(("https://archive.md/", "http://archive.md/")):
        raise ValueError("archive.md returned an unexpected URL")
    return final_url


def ensure_archive(artist: dict, submitter: Callable[[str], str] = submit_archive) -> None:
    if artist.get("archive", {}).get("url") or not artist.get("x_account"):
        return
    archive = artist.setdefault("archive", {})
    try:
        archive_url = submitter(artist["x_account"])
        archive.update(
            status="saved",
            url=archive_url,
            saved_at=now(),
            hatena_add_url="https://b.hatena.ne.jp/add?" + urllib.parse.urlencode(
                {"mode": "confirm", "url": archive_url}
            ),
        )
        archive.pop("last_error", None)
    except Exception as exc:  # a failed archive request must not abort monitoring
        archive.update(status="retry_pending", last_attempt_at=now(), last_error=type(exc).__name__)


def process(data: dict, *, archive: bool = True) -> dict:
    checked_at = now()
    for artist in data.get("artists", []):
        username = str(artist.get("x_account", "")).strip().lstrip("@")
        if not username:
            continue
        artist["x_account"] = username
        result, detail = probe_account(username)
        record_check(artist, result, detail, checked_at)
        if archive:
            ensure_archive(artist)
    return data


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-archive", action="store_true", help="only check account state")
    args = parser.parse_args()
    data = json.loads(DATA_PATH.read_text(encoding="utf-8")) if DATA_PATH.exists() else {"artists": []}
    process(data, archive=not args.no_archive)
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    DATA_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
