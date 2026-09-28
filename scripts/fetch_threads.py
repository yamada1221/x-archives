"""
fetch_threads.py
- ARTIST_ID / THREADS_ACCOUNT を受け取る
- Threads公式API（THREADS_ACCESS_TOKEN + threads_profile_discovery）が使える場合は
  公開プロフィールと投稿を取得する
- 公式APIが使えない場合は公開プロフィールHTMLから表示名・説明・アイコンと
  HTML内に埋め込まれた公開投稿を保守的に抽出する
- data/artists.json の該当アカウントを更新する
"""

from __future__ import annotations

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
THREADS_WEB = "https://www.threads.com/@{username}"
THREADS_GRAPH = "https://graph.threads.net/v1.0"
BODY_LIMIT = 2 * 1024 * 1024
USER_AGENT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
MAX_POSTS = 50


class ThreadsPageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.meta: dict[str, str] = {}
        self.title_parts: list[str] = []
        self.in_title = False
        self.in_json_script = False
        self.script_parts: list[str] = []
        self.json_scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = {k.lower(): (v or "") for k, v in attrs}
        lower_tag = tag.lower()
        if lower_tag == "meta":
            key = (attrs_dict.get("property") or attrs_dict.get("name") or "").lower()
            content = attrs_dict.get("content", "")
            if key and content:
                self.meta[key] = content
        elif lower_tag == "title":
            self.in_title = True
        elif lower_tag == "script":
            script_type = attrs_dict.get("type", "").lower()
            self.in_json_script = script_type in {"application/json", "application/ld+json"}
            self.script_parts = []

    def handle_endtag(self, tag: str) -> None:
        lower_tag = tag.lower()
        if lower_tag == "title":
            self.in_title = False
        elif lower_tag == "script" and self.in_json_script:
            body = "".join(self.script_parts).strip()
            if body:
                self.json_scripts.append(body)
            self.in_json_script = False
            self.script_parts = []

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)
        if self.in_json_script:
            self.script_parts.append(data)

    @property
    def title(self) -> str:
        return "".join(self.title_parts).strip()


def request(url: str, timeout: int = 20):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
            "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
        },
    )
    return urllib.request.urlopen(req, timeout=timeout)


def normalize_username(value: str) -> str:
    raw = (value or "").strip()
    match = re.search(r"threads\.(?:com|net)/@([^/?#]+)", raw, flags=re.I)
    if match:
        raw = urllib.parse.unquote(match.group(1))
    return raw.lstrip("@").strip()


def load_artists() -> dict:
    if DATA_PATH.exists():
        return json.loads(DATA_PATH.read_text(encoding="utf-8"))
    return {"artists": []}


def save_artists(data: dict) -> None:
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    DATA_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def find_artist(data: dict, artist_id: str, threads_account: str) -> tuple[dict | None, str]:
    artist = next((a for a in data.get("artists", []) if str(a.get("id", "")) == artist_id), None)
    if artist is not None:
        return artist, "id"
    normalized = normalize_username(threads_account).lower()
    artist = next(
        (
            a for a in data.get("artists", [])
            if normalize_username(str(a.get("threads_account", ""))).lower() == normalized
        ),
        None,
    )
    return (artist, "threads_account") if artist is not None else (None, "none")


def parse_page(raw: bytes) -> ThreadsPageParser:
    parser = ThreadsPageParser()
    try:
        parser.feed(raw.decode("utf-8", errors="replace"))
    except Exception:
        pass
    return parser


def clean_threads_title(value: str, username: str) -> str:
    value = html.unescape(value or "").strip()
    patterns = [
        rf"^(?P<name>.+?)\s*\(@{re.escape(username)}\)\s*(?:on Threads|・ Threads|\| Threads)?$",
        rf"^(?P<name>.+?)\s*\(@{re.escape(username)}\).*$",
    ]
    for pattern in patterns:
        match = re.match(pattern, value, flags=re.I)
        if match:
            return match.group("name").strip() or username
    if value.lower() in {"threads", "threads.net", "threads.com"}:
        return username
    return value or username


def is_threads_avatar(url: str) -> bool:
    lower = (url or "").lower()
    return any(marker in lower for marker in ("cdninstagram.com", "fbcdn.net", "scontent."))


def extract_profile_from_html(raw: bytes, username: str) -> dict | None:
    parser = parse_page(raw)
    title = parser.meta.get("og:title") or parser.meta.get("twitter:title") or parser.title
    description = parser.meta.get("og:description") or parser.meta.get("twitter:description") or ""
    avatar = parser.meta.get("og:image") or parser.meta.get("twitter:image") or ""
    joined = " ".join((title, description)).lower()
    if username.lower() not in joined and f"@{username.lower()}" not in joined:
        return None
    profile = {
        "username": username,
        "name": clean_threads_title(title, username),
        "biography": html.unescape(description).strip(),
        "profile_picture_url": html.unescape(avatar).strip() if is_threads_avatar(avatar) else "",
        "source": "threads_html",
    }
    return profile


def _timestamp_to_iso(value) -> str:
    if value in (None, ""):
        return ""
    if isinstance(value, (int, float)):
        try:
            return dt.datetime.fromtimestamp(float(value), tz=dt.timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return str(value)
    raw = str(value).strip()
    if raw.isdigit():
        try:
            return dt.datetime.fromtimestamp(int(raw), tz=dt.timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            pass
    return raw


def _post_from_threads_object(post: dict, expected_username: str, force_reply: bool = False) -> dict | None:
    if not any(post.get(key) for key in ("pk", "id", "code", "permalink", "url")):
        return None

    user = post.get("user") if isinstance(post.get("user"), dict) else {}
    raw_username = str(user.get("username") or post.get("username") or "").lstrip("@")
    if raw_username and raw_username.lower() != expected_username.lower():
        return None

    caption = post.get("caption") if isinstance(post.get("caption"), dict) else {}
    text = caption.get("text") if isinstance(caption.get("text"), str) else post.get("text")
    if not isinstance(text, str) or not text.strip():
        return None

    post_id = str(post.get("pk") or post.get("id") or "")
    shortcode = str(post.get("code") or post.get("shortcode") or "")
    permalink = str(post.get("permalink") or post.get("url") or "")
    if not permalink and shortcode and raw_username:
        permalink = f"https://www.threads.com/@{raw_username}/post/{shortcode}"

    app_info = post.get("text_post_app_info") if isinstance(post.get("text_post_app_info"), dict) else {}
    reply_to_author = app_info.get("reply_to_author")
    is_reply = force_reply or bool(post.get("is_reply")) or reply_to_author is not None

    return {
        "id": post_id,
        "text": html.unescape(text).strip(),
        "timestamp": _timestamp_to_iso(post.get("timestamp") or post.get("taken_at")),
        "permalink": permalink,
        "is_reply": is_reply,
        "like_count": int(post.get("like_count") or 0),
        "reply_count": int(app_info.get("direct_reply_count") or post.get("reply_count") or 0),
        "repost_count": int(app_info.get("repost_count") or post.get("repost_count") or 0),
        "quote_count": int(app_info.get("quote_count") or post.get("quote_count") or 0),
    }


def _walk_json_for_posts(
    value,
    username: str,
    output: list[dict],
    seen: set[str],
    force_reply: bool = False,
    depth: int = 0,
) -> None:
    if len(output) >= MAX_POSTS or depth > 30:
        return

    if isinstance(value, dict):
        thread_items = value.get("thread_items")
        if isinstance(thread_items, list):
            for item in thread_items:
                if not isinstance(item, dict) or not isinstance(item.get("post"), dict):
                    continue
                parsed = _post_from_threads_object(item["post"], username, force_reply=force_reply)
                if not parsed:
                    continue
                dedupe_key = parsed["id"] or parsed["permalink"] or parsed["text"]
                if dedupe_key in seen:
                    continue
                seen.add(dedupe_key)
                output.append(parsed)
                if len(output) >= MAX_POSTS:
                    return

        parsed_direct = _post_from_threads_object(value, username, force_reply=force_reply)
        if parsed_direct:
            dedupe_key = parsed_direct["id"] or parsed_direct["permalink"] or parsed_direct["text"]
            if dedupe_key not in seen:
                seen.add(dedupe_key)
                output.append(parsed_direct)
                if len(output) >= MAX_POSTS:
                    return

        for child in value.values():
            _walk_json_for_posts(child, username, output, seen, force_reply, depth + 1)
    elif isinstance(value, list):
        for child in value:
            _walk_json_for_posts(child, username, output, seen, force_reply, depth + 1)


def extract_posts_from_html(raw: bytes, username: str, force_reply: bool = False) -> list[dict]:
    parser = parse_page(raw)
    posts: list[dict] = []
    seen: set[str] = set()
    for script in parser.json_scripts:
        try:
            payload = json.loads(html.unescape(script))
        except json.JSONDecodeError:
            continue
        _walk_json_for_posts(payload, username, posts, seen, force_reply=force_reply)
        if len(posts) >= MAX_POSTS:
            break
    return posts


def graph_get(path: str, token: str, params: dict[str, str]) -> dict:
    query = dict(params)
    query["access_token"] = token
    url = THREADS_GRAPH + path + "?" + urllib.parse.urlencode(query)
    with request(url, timeout=20) as response:
        return json.loads(response.read(BODY_LIMIT))


def fetch_from_api(username: str, token: str) -> tuple[dict | None, list[dict]]:
    if not token:
        return None, []
    try:
        profile = graph_get("/profile_lookup", token, {"username": username})
        posts_payload = graph_get(
            "/profile_posts",
            token,
            {
                "username": username,
                "fields": "id,text,timestamp,permalink,username,is_reply,replied_to",
                "limit": str(MAX_POSTS),
            },
        )
        posts = []
        for item in posts_payload.get("data", []) if isinstance(posts_payload, dict) else []:
            if not isinstance(item, dict):
                continue
            posts.append(
                {
                    "id": str(item.get("id", "")),
                    "text": str(item.get("text", "")).strip(),
                    "timestamp": str(item.get("timestamp", "")),
                    "permalink": str(item.get("permalink", "")),
                    "is_reply": bool(item.get("is_reply")),
                }
            )
        if isinstance(profile, dict):
            profile["source"] = "threads_api"
        return profile if isinstance(profile, dict) else None, posts
    except urllib.error.HTTPError as exc:
        print(f"[threads_api] HTTPError {exc.code}; falling back to public HTML", file=sys.stderr)
    except Exception as exc:
        print(f"[threads_api] error: {type(exc).__name__}: {exc}; falling back to public HTML", file=sys.stderr)
    return None, []


def fetch_threads_html_page(url: str, label: str) -> bytes | None:
    try:
        with request(url, timeout=20) as response:
            status = getattr(response, "status", 200)
            raw = response.read(BODY_LIMIT)
        print(f"[{label}] HTTP {status}; bytes={len(raw)}", file=sys.stderr)
        return raw if status == 200 else None
    except urllib.error.HTTPError as exc:
        print(f"[{label}] HTTPError {exc.code}", file=sys.stderr)
    except Exception as exc:
        print(f"[{label}] error: {type(exc).__name__}: {exc}", file=sys.stderr)
    return None


def merge_posts(*groups: list[dict]) -> list[dict]:
    merged: list[dict] = []
    seen: set[str] = set()
    for group in groups:
        for post in group:
            key = str(post.get("id") or post.get("permalink") or post.get("text") or "")
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(post)
            if len(merged) >= MAX_POSTS:
                return merged
    return merged


def fetch_from_html(username: str) -> tuple[dict | None, list[dict]]:
    encoded = urllib.parse.quote(username, safe="")
    profile_url = THREADS_WEB.format(username=encoded)
    profile_raw = fetch_threads_html_page(profile_url, "threads_html")
    replies_raw = fetch_threads_html_page(profile_url + "/replies", "threads_replies_html")

    profile = extract_profile_from_html(profile_raw, username) if profile_raw else None
    posts = extract_posts_from_html(profile_raw, username) if profile_raw else []
    replies = extract_posts_from_html(replies_raw, username, force_reply=True) if replies_raw else []
    return profile, merge_posts(posts, replies)


def fetch_threads(username: str, token: str) -> tuple[dict | None, list[dict], str]:
    api_profile, api_posts = fetch_from_api(username, token)
    if api_profile or api_posts:
        if api_profile and api_posts:
            return api_profile, api_posts, "threads_api"
        html_profile, html_posts = fetch_from_html(username)
        return api_profile or html_profile, api_posts or html_posts, "threads_api+html"
    html_profile, html_posts = fetch_from_html(username)
    return html_profile, html_posts, "threads_html"


def main() -> None:
    artist_id = os.environ.get("ARTIST_ID", "").strip()
    threads_account = normalize_username(os.environ.get("THREADS_ACCOUNT", ""))
    token = os.environ.get("THREADS_ACCESS_TOKEN", "").strip()
    if not artist_id or not threads_account:
        print("ERROR: ARTIST_ID and THREADS_ACCOUNT are required", file=sys.stderr)
        raise SystemExit(1)

    data = load_artists()
    artist, matched_by = find_artist(data, artist_id, threads_account)
    if artist is None:
        print(f"Artist {artist_id} / Threads @{threads_account} not found", file=sys.stderr)
        raise SystemExit(1)
    if matched_by == "threads_account":
        print(f"Artist id {artist_id} was stale; matched Threads @{threads_account}", file=sys.stderr)

    profile, posts, source = fetch_threads(threads_account, token)
    artist["threads_account"] = threads_account
    artist["threads_profile_url"] = THREADS_WEB.format(username=threads_account)
    artist["threads_profile_fetched_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    artist["threads_profile_source"] = source

    if profile:
        artist["threads_name"] = (
            profile.get("name")
            or profile.get("display_name")
            or profile.get("username")
            or threads_account
        )
        artist["threads_bio"] = (
            profile.get("biography")
            or profile.get("threads_biography")
            or ""
        )
        artist["threads_avatar_url"] = (
            profile.get("profile_picture_url")
            or profile.get("threads_profile_picture_url")
            or ""
        )
        if profile.get("follower_count") is not None:
            artist["threads_follower_count"] = profile.get("follower_count")
        if profile.get("is_verified") is not None:
            artist["threads_is_verified"] = bool(profile.get("is_verified"))

    if posts:
        artist["threads_posts"] = posts[:MAX_POSTS]

    if profile or posts:
        artist["threads_fetch_status"] = "done"
        if not artist.get("x_account"):
            if profile and artist.get("threads_name"):
                artist["name"] = artist["threads_name"]
            if not artist.get("avatar_url") and artist.get("threads_avatar_url"):
                artist["avatar_url"] = artist["threads_avatar_url"]
    else:
        artist["threads_fetch_status"] = "error"

    save_artists(data)
    print(
        f"Threads @{threads_account}: profile={'yes' if profile else 'no'}, "
        f"posts={len(posts)}, source={source}"
    )


if __name__ == "__main__":
    main()
