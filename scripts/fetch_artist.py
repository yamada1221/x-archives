"""
fetch_artist.py
- 環境変数 ARTIST_ID, X_ACCOUNT を受け取る
- twscrape でXプロフィール（表示名・アイコンURL）を取得
- data/artists.json の該当作者を更新する
"""

import asyncio
import json
import os
import sys
from pathlib import Path

DATA_PATH = Path("data/artists.json")


def load_artists() -> dict:
    if DATA_PATH.exists():
        with open(DATA_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {"artists": []}


def save_artists(data: dict):
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


async def fetch_x_profile(username: str) -> dict | None:
    """twscrape のゲストセッションでプロフィールを取得する"""
    try:
        from twscrape import API
        api = API()
        # ゲストセッション（アカウント不要）
        await api.pool.add_account("guest", "guest", "guest@guest.com", "guest")
        await api.pool.login_all()
        user = await api.user_by_login(username)
        if user:
            return {
                "display_name": user.displayname,
                "avatar_url": user.profileImageUrl.replace("_normal", "_400x400"),
            }
    except Exception as e:
        print(f"[twscrape] error: {e}", file=sys.stderr)

    # フォールバック: nitter 風の公開エンドポイント
    return await fetch_x_profile_fallback(username)


async def fetch_x_profile_fallback(username: str) -> dict | None:
    """twscrape が失敗した場合の代替取得"""
    import urllib.request, urllib.error

    # syndication API（非公式・ゲスト向け）
    url = f"https://cdn.syndication.twimg.com/widgets/followbutton/info.json?screen_names={username}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
            if data:
                user = data[0]
                return {
                    "display_name": user.get("name", username),
                    "avatar_url": user.get("profile_image_url_https", "").replace("_normal", "_400x400"),
                }
    except Exception as e:
        print(f"[fallback] error: {e}", file=sys.stderr)

    return None


def main():
    artist_id = os.environ.get("ARTIST_ID", "").strip()
    x_account = os.environ.get("X_ACCOUNT", "").strip().lstrip("@")

    if not artist_id or not x_account:
        print("ERROR: ARTIST_ID and X_ACCOUNT are required", file=sys.stderr)
        sys.exit(1)

    print(f"Fetching profile for @{x_account} (id={artist_id})")

    profile = asyncio.run(fetch_x_profile(x_account))

    data = load_artists()
    artist = next((a for a in data["artists"] if a["id"] == artist_id), None)

    if artist is None:
        print(f"Artist {artist_id} not found in artists.json", file=sys.stderr)
        sys.exit(1)

    if profile:
        artist["name"] = profile["display_name"]
        artist["avatar_url"] = profile["avatar_url"]
        artist["profile_fetched_at"] = __import__("datetime").date.today().isoformat()
        print(f"Updated: {artist['name']} / {artist['avatar_url']}")
    else:
        print("Could not fetch profile, keeping existing data", file=sys.stderr)

    save_artists(data)
    print("artists.json saved.")


if __name__ == "__main__":
    main()
