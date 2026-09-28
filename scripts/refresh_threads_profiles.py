from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import time

try:
    from fetch_threads import fetch_threads, normalize_username, update_artist_from_threads
except ModuleNotFoundError:
    from scripts.fetch_threads import fetch_threads, normalize_username, update_artist_from_threads

DATA_PATH = Path("data/artists.json")


def load_data() -> dict:
    if DATA_PATH.exists():
        return json.loads(DATA_PATH.read_text(encoding="utf-8"))
    return {"artists": []}


def save_data(data: dict) -> None:
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    DATA_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def process(data: dict, token: str = "", delay_seconds: float = 3.0, save_each=None) -> dict:
    artists = [
        artist for artist in data.get("artists", [])
        if normalize_username(str(artist.get("threads_account", "")))
    ]
    success = 0
    failed = 0

    for index, artist in enumerate(artists, start=1):
        username = normalize_username(str(artist.get("threads_account", "")))
        print(f"[{index}/{len(artists)}] Threads @{username}")
        try:
            profile, posts, source = fetch_threads(username, token)
            update_artist_from_threads(artist, username, profile, posts, source)
        except Exception as exc:
            artist["threads_fetch_status"] = "error"
            artist["threads_last_error"] = f"{type(exc).__name__}: {exc}"
            failed += 1
            print(f"  error: {artist['threads_last_error']}")
        else:
            artist.pop("threads_last_error", None)
            if artist.get("threads_fetch_status") == "done":
                success += 1
                replies = sum(1 for post in artist.get("threads_posts", []) if post.get("is_reply"))
                print(
                    f"  done: fetched={artist.get('threads_posts_last_fetch_count', 0)}; "
                    f"stored={len(artist.get('threads_posts', []))}; replies={replies}"
                )
            else:
                failed += 1
                print("  failed: public profile/posts were not available")

        if save_each:
            save_each(data)
        if index < len(artists) and delay_seconds > 0:
            time.sleep(delay_seconds)

    data["threads_refresh_summary"] = {
        "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "checked": len(artists),
        "success": success,
        "failed": failed,
    }
    return data


def check_health(data: dict) -> None:
    summary = data.get("threads_refresh_summary", {})
    checked = int(summary.get("checked", 0))
    success = int(summary.get("success", 0))
    if checked > 0 and success == 0:
        raise SystemExit("All Threads profile refreshes failed.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-health", action="store_true")
    args = parser.parse_args()

    data = load_data()
    if args.check_health:
        check_health(data)
        return

    token = os.environ.get("THREADS_ACCESS_TOKEN", "").strip()
    delay_seconds = max(0.0, float(os.environ.get("THREADS_FETCH_DELAY_SECONDS", "3")))
    process(data, token=token, delay_seconds=delay_seconds, save_each=save_data)
    save_data(data)
    summary = data["threads_refresh_summary"]
    print(
        f"Threads refresh summary: checked={summary['checked']}; "
        f"success={summary['success']}; failed={summary['failed']}"
    )


if __name__ == "__main__":
    main()
