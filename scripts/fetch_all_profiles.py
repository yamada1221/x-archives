from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import time
from pathlib import Path

from fetch_artist import fetch_x_profile

DATA_PATH = Path("data/artists.json")


def load_data() -> dict:
    with DATA_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def save_data(data: dict) -> None:
    with DATA_PATH.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def normalize_x_account(value: object) -> str:
    return str(value or "").strip().lstrip("@").lower()


def merge_duplicate_artist(target: dict, duplicate: dict) -> None:
    if target.get("tracking_mode") != "record" and duplicate.get("tracking_mode") == "record":
        target["tracking_mode"] = "record"

    existing_works = target.setdefault("works", [])
    seen = {(item.get("url"), item.get("saved_at"), item.get("memo")) for item in existing_works if isinstance(item, dict)}
    for work in duplicate.get("works", []) or []:
        if not isinstance(work, dict):
            continue
        key = (work.get("url"), work.get("saved_at"), work.get("memo"))
        if key not in seen:
            existing_works.append(work)
            seen.add(key)

    for field in ("note", "pixiv_user", "avatar_url", "profile_fetched_at"):
        if not target.get(field) and duplicate.get(field):
            target[field] = duplicate[field]

    if target.get("fetch_status") != "done" and duplicate.get("fetch_status") == "done":
        target["fetch_status"] = "done"
        if duplicate.get("name"):
            target["name"] = duplicate["name"]


def deduplicate_artists(artists: list[dict]) -> tuple[list[dict], int]:
    result: list[dict] = []
    by_x: dict[str, dict] = {}
    removed = 0

    for artist in artists:
        username = normalize_x_account(artist.get("x_account"))
        if not username:
            result.append(artist)
            continue

        existing = by_x.get(username)
        if existing is None:
            by_x[username] = artist
            result.append(artist)
            continue

        merge_duplicate_artist(existing, artist)
        removed += 1
        print(f"dedupe: merged duplicate @{username} (kept id={existing.get('id')})")

    return result, removed


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

    artists, duplicates_removed = deduplicate_artists(data.get("artists", []))
    data["artists"] = artists
    if duplicates_removed:
        save_data(data)

    print(f"Bulk profile fetch: mode={mode}; artists={len(artists)}; duplicates_removed={duplicates_removed}")

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
            artist["fetch_status"] = "error"
            failed += 1
            print("  failed: keeping existing profile data")

        save_data(data)

        if index < len(artists) and delay_seconds > 0:
            time.sleep(delay_seconds)

    print(
        f"Summary: success={success}; failed={failed}; skipped={skipped}; "
        f"duplicates_removed={duplicates_removed}"
    )
    save_data(data)


if __name__ == "__main__":
    main()
