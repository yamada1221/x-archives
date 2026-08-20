from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from archive_state import archive_target_url, mark_archive_result

DATA_PATH = Path("data/artists.json")
ARCHIVE_HOST = os.environ.get("ARCHIVE_HOST", "archive.md").strip() or "archive.md"
USER_AGENT = "x-archives/1.0 (+https://github.com/yamada1221/x-archives)"


def extract_submit_id(html: str) -> str:
    patterns = [
        r'name=["\']submitid["\'][^>]*value=["\']([^"\']+)',
        r'value=["\']([^"\']+)["\'][^>]*name=["\']submitid["\']',
    ]
    for pattern in patterns:
        match = re.search(pattern, html, flags=re.IGNORECASE)
        if match:
            return match.group(1)
    raise RuntimeError("archive.md submitid not found (captcha or page format changed)")


def saved_url_from_headers(headers) -> str | None:
    refresh = headers.get("Refresh")
    if refresh:
        match = re.search(r";\s*url=(.+)$", refresh, flags=re.IGNORECASE)
        if match:
            return match.group(1).strip()
    location = headers.get("Location")
    return location.strip() if location else None


def submit_archive(url: str) -> str:
    homepage = f"https://{ARCHIVE_HOST}/"
    submit_url = f"https://{ARCHIVE_HOST}/submit/"
    headers = {"User-Agent": USER_AGENT, "Accept": "text/html,*/*;q=0.8"}

    request = urllib.request.Request(homepage, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        html = response.read().decode("utf-8", errors="replace")
    submit_id = extract_submit_id(html)

    payload = urllib.parse.urlencode([("submitid", submit_id), ("url", url)]).encode()
    post_headers = {
        **headers,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": homepage,
    }
    post = urllib.request.Request(submit_url, data=payload, headers=post_headers, method="POST")
    try:
        with urllib.request.urlopen(post, timeout=90) as response:
            final_url = response.geturl()
            saved_url = saved_url_from_headers(response.headers)
            if saved_url:
                return urllib.parse.urljoin(submit_url, saved_url)
            if final_url and final_url.rstrip("/") != submit_url.rstrip("/"):
                return final_url
            body = response.read(4096).decode("utf-8", errors="replace").lower()
            if "captcha" in body:
                raise RuntimeError("archive.md requires captcha")
            raise RuntimeError("archive.md returned no saved URL")
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            raise RuntimeError("archive.md rate limited (HTTP 429)") from exc
        raise RuntimeError(f"archive.md HTTP {exc.code}") from exc


def find_artist(artists: list[dict], artist_id: str, x_account: str) -> dict | None:
    if artist_id:
        found = next((item for item in artists if str(item.get("id", "")) == artist_id), None)
        if found:
            return found
    normalized = x_account.strip().lstrip("@").lower()
    if normalized:
        return next(
            (
                item
                for item in artists
                if str(item.get("x_account", "")).strip().lstrip("@").lower() == normalized
            ),
            None,
        )
    return None


def main() -> None:
    artist_id = os.environ.get("ARTIST_ID", "").strip()
    x_account = os.environ.get("X_ACCOUNT", "").strip()
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    artists = data.get("artists", [])
    artist = find_artist(artists, artist_id, x_account)
    if not artist:
        raise SystemExit(f"Artist {artist_id or '-'} / @{x_account or '-'} not found")
    if artist.get("tracking_mode") != "record":
        raise SystemExit("Artist is not tracking_mode=record")

    target = archive_target_url(artist)
    print(f"Archive target: {target}")
    try:
        saved_url = submit_archive(target)
        updated = mark_archive_result(artist, success=True, archived_url=saved_url)
        print(f"Archived: {saved_url}")
    except Exception as exc:
        updated = mark_archive_result(artist, success=False, error=str(exc))
        print(f"Archive failed: {exc}")

    artist.clear()
    artist.update(updated)
    DATA_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if updated.get("archive_status") != "done":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
