from __future__ import annotations

import datetime as dt
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

DATA_PATH = Path("data/artists.json")
USER_AGENT = "Mozilla/5.0 (compatible; x-archives/1.0; +https://github.com/yamada1221/x-archives)"
PROFILE_BODY_LIMIT = 1024 * 1024


class MetaParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.meta: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "meta":
            return
        d = {k.lower(): (v or "") for k, v in attrs}
        key = (d.get("property") or d.get("name") or "").lower()
        if key and d.get("content"):
            self.meta[key] = d["content"]


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


def syndication_diag(username: str) -> dict:
    url = "https://cdn.syndication.twimg.com/widgets/followbutton/info.json?" + urllib.parse.urlencode(
        {"screen_names": username}
    )
    result: dict = {"url": url}
    try:
        with request(url, 10) as response:
            raw = response.read()
            result["http_status"] = getattr(response, "status", 200)
            result["content_type"] = response.headers.get("Content-Type", "unknown")
        result["bytes"] = len(raw)
        try:
            payload = json.loads(raw)
            result["json_ok"] = True
            result["items"] = len(payload) if isinstance(payload, list) else None
            if isinstance(payload, list) and payload:
                item = payload[0]
                result["screen_name"] = item.get("screen_name")
                result["has_name"] = bool(item.get("name"))
                result["has_avatar"] = bool(item.get("profile_image_url_https"))
        except Exception as exc:
            result["json_ok"] = False
            result["json_error"] = f"{type(exc).__name__}: {exc}"
    except urllib.error.HTTPError as exc:
        result["error"] = f"HTTPError {exc.code}"
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    return result


def html_diag(username: str) -> dict:
    url = f"https://x.com/{urllib.parse.quote(username, safe='')}"
    result: dict = {"url": url}
    try:
        with request(url, 15) as response:
            raw = response.read(PROFILE_BODY_LIMIT)
            result["http_status"] = getattr(response, "status", 200)
            result["content_type"] = response.headers.get("Content-Type", "unknown")
            result["final_url"] = response.geturl()
        text = raw.decode("utf-8", errors="replace")
        decoded = html.unescape(text).replace("\\/", "/")
        parser = MetaParser()
        try:
            parser.feed(text)
        except Exception as exc:
            result["meta_parse_error"] = f"{type(exc).__name__}: {exc}"
        result["bytes"] = len(raw)
        result["contains_username"] = username.lower() in decoded.lower()
        result["screen_name_marker"] = bool(
            re.search(r'"screen_name"\s*:\s*"' + re.escape(username) + r'"', decoded, re.I)
        )
        image_candidates = list(dict.fromkeys(
            re.findall(r"https://pbs\.twimg\.com/profile_images/[^\"'<>\\ ]+", decoded)
        ))
        result["profile_image_url_count"] = len(image_candidates)
        result["profile_image_candidates"] = image_candidates[:20]
        result["meta_keys"] = sorted(
            key for key in parser.meta if key in {"og:title", "og:image", "twitter:title", "twitter:image"}
        )
        result["og_title_present"] = bool(parser.meta.get("og:title"))
        result["og_image_present"] = bool(parser.meta.get("og:image"))
        result["twitter_title_present"] = bool(parser.meta.get("twitter:title"))
        result["twitter_image_present"] = bool(parser.meta.get("twitter:image"))
        result["og_title"] = parser.meta.get("og:title", "")
        result["og_image"] = parser.meta.get("og:image", "")
        result["twitter_title"] = parser.meta.get("twitter:title", "")
        result["twitter_image"] = parser.meta.get("twitter:image", "")
    except urllib.error.HTTPError as exc:
        result["error"] = f"HTTPError {exc.code}"
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    return result


def main() -> None:
    artist_id = os.environ.get("ARTIST_ID", "").strip()
    username = os.environ.get("X_ACCOUNT", "").strip().lstrip("@")
    if not artist_id or not username:
        raise SystemExit("ARTIST_ID and X_ACCOUNT are required")

    with DATA_PATH.open(encoding="utf-8") as f:
        data = json.load(f)
    artist = next((a for a in data.get("artists", []) if a.get("id") == artist_id), None)
    if artist is None:
        raise SystemExit(f"artist not found: {artist_id}")

    artist["profile_fetch_diagnostic"] = {
        "checked_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "x_account": username,
        "fetch_status_after_attempt": artist.get("fetch_status"),
        "syndication": syndication_diag(username),
        "html": html_diag(username),
    }

    with DATA_PATH.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(json.dumps(artist["profile_fetch_diagnostic"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
