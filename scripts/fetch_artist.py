"""
fetch_artist.py
- 環境変数 ARTIST_ID, X_ACCOUNT を受け取る
- 公開エンドポイントを使ってXプロフィール（表示名・アイコンURL）を取得
- syndication API → XプロフィールHTML → Unavatar の順にフォールバックする
- data/artists.json の該当アカウントを更新する
"""

from __future__ import annotations

import asyncio
import datetime as dt
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

DATA_PATH = Path("data/artists.json")
PROFILE_BODY_LIMIT = 1024 * 1024
USER_AGENT = "Mozilla/5.0 (compatible; x-archives/1.0; +https://github.com/yamada1221/x-archives)"


class ProfileMetaParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.meta: dict[str, str] = {}
        self.in_title = False
        self.title_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = {k.lower(): (v or "") for k, v in attrs}
        if tag.lower() == "meta":
            key = (attrs_dict.get("property") or attrs_dict.get("name") or "").lower()
            content = attrs_dict.get("content", "")
            if key and content:
                self.meta[key] = content
        elif tag.lower() == "title":
            self.in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)

    @property
    def title(self) -> str:
        return "".join(self.title_parts).strip()


def load_artists() -> dict:
    if DATA_PATH.exists():
        with open(DATA_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {"artists": []}


def save_artists(data: dict) -> None:
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def find_artist(data: dict, artist_id: str, x_account: str) -> tuple[dict | None, str]:
    """Find by stable UI id first, then recover from stale ids using X account."""
    artists = data.get("artists", [])
    artist = next((a for a in artists if str(a.get("id", "")) == artist_id), None)
    if artist is not None:
        return artist, "id"

    normalized = x_account.strip().lstrip("@").lower()
    artist = next(
        (
            a
            for a in artists
            if str(a.get("x_account", "")).strip().lstrip("@").lower() == normalized
        ),
        None,
    )
    return (artist, "x_account") if artist is not None else (None, "none")


def request(url: str, timeout: int = 15):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
            "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
        },
    )
    return urllib.request.urlopen(req, timeout=timeout)


def normalize_avatar(url: str) -> str:
    return url.replace("_normal.", "_400x400.").replace("_normal", "_400x400").replace("\\/", "/")


def clean_display_name(value: str, username: str) -> str:
    value = html.unescape(value).strip()
    localized_patterns = [
        rf"^Xユーザーの(?P<name>.+?)（@{re.escape(username)}）さん$",
        rf"^Xユーザーの(?P<name>.+?)\s*\(@{re.escape(username)}\)さん$",
    ]
    for pattern in localized_patterns:
        match = re.match(pattern, value, flags=re.I)
        if match:
            cleaned = match.group("name").strip()
            return cleaned or username
    for suffix in [f" (@{username}) / X", f" (@{username}) on X", f" (@{username}) / Twitter"]:
        if value.lower().endswith(suffix.lower()):
            value = value[: -len(suffix)].strip()
            break
    return value or username


def is_profile_avatar(url: str, verified_title: bool) -> bool:
    normalized = normalize_avatar(url)
    if "pbs.twimg.com/profile_images/" in normalized:
        return True
    if verified_title and "abs.twimg.com/sticky/default_profile_images/" in normalized:
        return True
    return False


def extract_profile_from_html(raw: bytes, username: str) -> dict | None:
    text = raw.decode("utf-8", errors="replace")
    decoded = html.unescape(text).replace("\\/", "/")
    parser = ProfileMetaParser()
    try:
        parser.feed(text)
    except Exception:
        pass
    name_candidates = [parser.meta.get("og:title", ""), parser.meta.get("twitter:title", ""), parser.title]
    image_candidates = [parser.meta.get("og:image", ""), parser.meta.get("twitter:image", "")]
    marker_patterns = [
        re.compile(r'"screen_name"\s*:\s*"' + re.escape(username) + r'"', re.I),
        re.compile(r'\\"screen_name\\"\s*:\s*\\"' + re.escape(username) + r'\\"', re.I),
    ]
    for source in (text, decoded):
        for marker_pattern in marker_patterns:
            match = marker_pattern.search(source)
            if not match:
                continue
            window = source[max(0, match.start() - 10000):min(len(source), match.end() + 10000)].replace("\\/", "/")
            name_match = re.search(r'"name"\s*:\s*"((?:\\.|[^"\\])*)"', window)
            if name_match:
                try:
                    name_candidates.append(json.loads('"' + name_match.group(1) + '"'))
                except Exception:
                    name_candidates.append(name_match.group(1))
            image_match = re.search(r'"profile_image_url_https"\s*:\s*"((?:\\.|[^"\\])*)"', window)
            if image_match:
                try:
                    image_candidates.append(json.loads('"' + image_match.group(1) + '"'))
                except Exception:
                    image_candidates.append(image_match.group(1))
            break
    if not any(image_candidates):
        image_match = re.search(r'https://pbs\.twimg\.com/profile_images/[^"\'<>\\ ]+', decoded)
        if image_match:
            image_candidates.append(image_match.group(0))
    verified_name = next((c for c in name_candidates if c and username.lower() in c.lower()), "")
    display_name = clean_display_name(verified_name, username) if verified_name else ""
    if not display_name:
        display_name = next((clean_display_name(c, username) for c in name_candidates if c), username)
    avatar_url = next((normalize_avatar(c) for c in image_candidates if c and is_profile_avatar(c, bool(verified_name))), "")
    if avatar_url:
        return {"display_name": display_name, "avatar_url": avatar_url, "source": "x_html"}
    return None


async def fetch_x_profile(username: str) -> dict | None:
    profile = await fetch_x_profile_syndication(username)
    if profile:
        return profile
    profile = await fetch_x_profile_html(username)
    if profile:
        return profile
    return await fetch_x_profile_unavatar(username)


async def fetch_x_profile_syndication(username: str) -> dict | None:
    url = "https://cdn.syndication.twimg.com/widgets/followbutton/info.json?" + urllib.parse.urlencode({"screen_names": username})
    try:
        with request(url, timeout=10) as response:
            raw = response.read()
        data = json.loads(raw)
        if data:
            user = data[0]
            return {
                "display_name": user.get("name", username),
                "avatar_url": normalize_avatar(user.get("profile_image_url_https", "")),
                "source": "syndication",
            }
    except Exception as exc:
        print(f"[syndication] error: {type(exc).__name__}: {exc}", file=sys.stderr)
    return None


async def fetch_x_profile_html(username: str) -> dict | None:
    url = f"https://x.com/{urllib.parse.quote(username, safe='')}"
    try:
        with request(url, timeout=15) as response:
            status = getattr(response, "status", 200)
            raw = response.read(PROFILE_BODY_LIMIT)
        print(f"[html] HTTP {status}; bytes={len(raw)}", file=sys.stderr)
        if status == 200:
            profile = extract_profile_from_html(raw, username)
            if profile:
                print(f"[html] extracted display_name={profile['display_name']!r}; avatar={'yes' if profile['avatar_url'] else 'no'}", file=sys.stderr)
                return profile
    except urllib.error.HTTPError as exc:
        print(f"[html] HTTPError {exc.code}", file=sys.stderr)
    except Exception as exc:
        print(f"[html] error: {type(exc).__name__}: {exc}", file=sys.stderr)
    return None


async def fetch_x_profile_unavatar(username: str) -> dict | None:
    """Resolve an X avatar through Unavatar without accepting its generic fallback image."""
    encoded_username = urllib.parse.quote(username, safe="")
    url = f"https://unavatar.io/x/{encoded_username}?fallback=false"
    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "image/*,*/*;q=0.8",
            },
        )
        with urllib.request.urlopen(req, timeout=15) as response:
            status = getattr(response, "status", 200)
            content_type = (response.headers.get("Content-Type") or "").lower()
            if status == 200 and content_type.startswith("image/"):
                print(f"[unavatar] resolved avatar for @{username}; content-type={content_type}", file=sys.stderr)
                return {"display_name": None, "avatar_url": url, "source": "unavatar"}
            print(f"[unavatar] unexpected response: HTTP {status}; content-type={content_type}", file=sys.stderr)
    except urllib.error.HTTPError as exc:
        print(f"[unavatar] HTTPError {exc.code}", file=sys.stderr)
    except Exception as exc:
        print(f"[unavatar] error: {type(exc).__name__}: {exc}", file=sys.stderr)
    return None


def main() -> None:
    artist_id = os.environ.get("ARTIST_ID", "").strip()
    x_account = os.environ.get("X_ACCOUNT", "").strip().lstrip("@")
    if not artist_id or not x_account:
        print("ERROR: ARTIST_ID and X_ACCOUNT are required", file=sys.stderr)
        sys.exit(1)
    print(f"Fetching profile for @{x_account} (id={artist_id})")
    profile = asyncio.run(fetch_x_profile(x_account))
    data = load_artists()
    artist, matched_by = find_artist(data, artist_id, x_account)
    if artist is None:
        print(f"Artist {artist_id} / @{x_account} not found in artists.json", file=sys.stderr)
        sys.exit(1)
    if matched_by == "x_account":
        print(f"Artist id {artist_id} was stale; matched @{x_account} by x_account", file=sys.stderr)
    if profile:
        if profile.get("display_name"):
            artist["name"] = profile["display_name"]
        artist["avatar_url"] = profile["avatar_url"]
        artist["profile_fetched_at"] = dt.date.today().isoformat()
        artist["fetch_status"] = "done"
        artist["profile_source"] = profile.get("source", "unknown")
        print(f"Updated: {artist['name']} / {artist['avatar_url']} ({artist['profile_source']})")
    else:
        artist["fetch_status"] = "error"
        print("Could not fetch profile, keeping existing data", file=sys.stderr)
    save_artists(data)
    print("artists.json saved.")


if __name__ == "__main__":
    main()
