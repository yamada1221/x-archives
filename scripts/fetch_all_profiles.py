from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import time
from pathlib import Path

from scripts.fetch_artist import fetch_x_profile

DATA_PATH = Path("data/artists.json")


def load_data() -> dict:
    with DATA_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def save_data(data: dict) -> None:
    with DATA_PATH.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def already_fetched(artist: dict) -> bool:
    return (
        artist.get("fetch_status") == "done"
        and bool(artist.get("avatar_url"))
        and bool(artist.get("profile_fetched_at"))
    )


def main() -> None:
    mode = os.environ.get("FETCH_MODE", "missing_only").strip()
    if mode not in {"missing_only", "all"}:
        raise SystemExit(f"Unsupported FETCH_MODE: {mode}")

    delay_seconds = float(os.environ.get("FETCH_DELAY_SECONDS", "3"))
    data = load_data()

    success = 0
    failed = 0
    skipped = 0

    artists = data.get("artists", [])
    print(f"Bulk profile fetch: mode={mode}; artists={len(artists)}")

    for index, artist in enumerate(artists, start=1):
        username = str(artist.get("x_account", "")).strip().lstrip("@")
        if not username:
            print(f"[{index}/{len(artists)}] skip: no x_account")
            skipped += 1
            continue

        if mode == "missing_only" and already_fetched(artist):
            print(f"[{index}/{len(artists)}] skip @{username}: already fetched")
            skipped += 1
            continue

        print(f"[{index}/{len(artists)}] fetch @{username}")
        try:
            profile = asyncio.run(fetch_x_profile(username))
        except Exception as exc:
            profile = None
            print(f"  error: {type(exc).__name__}: {exc}")

        if profile:
            artist["name"] = profile["display_name"]
            artist["avatar_url"] = profile["avatar_url"]
            artist["profile_fetched_at"] = dt.date.today().isoformat()
            artist["fetch_status"] = "done"
            success += 1
            print(f"  done: {artist['name']}")
        else:
            # Keep the existing name/avatar when a refresh fails.
            artist["fetch_status"] = "error"
            failed += 1
            print("  failed: keeping existing profile data")

        save_data(data)

        if index < len(artists) and delay_seconds > 0:
            time.sleep(delay_seconds)

    print(f"Summary: success={success}; failed={failed}; skipped={skipped}")
    save_data(data)


if __name__ == "__main__":
    main()
