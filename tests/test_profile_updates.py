"""Exercise both entry points against saved data, without external requests."""

import contextlib
import copy
import datetime as dt
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from scripts import fetch_all_profiles, fetch_artist


class SavedProfileTests(unittest.TestCase):
    def setUp(self):
        self.artist = {
            "id": "artist-1",
            "x_account": "example_user",
            "name": "保存した表示名",
            "avatar_url": "https://example.invalid/previous.jpg",
            "profile_source": "x_html",
            "profile_fetched_at": "2026-01-01",
            "fetch_status": "done",
            "works": [{"url": "https://example.invalid/archive", "memo": "保存済み"}],
            "note": "手入力のメモ",
            "monitoring": {"status": "active"},
            "threads_posts": [{"id": "post-1", "text": "Threadsの記録"}],
        }

    def run_update(self, module, profile, *, error=None, mode="all"):
        data = {"artists": [copy.deepcopy(self.artist)], "other_metadata": {"keep": True}}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "artists.json"
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            with patch.object(module, "DATA_PATH", path), patch.object(
                module, "fetch_x_profile", new=AsyncMock(return_value=profile, side_effect=error)
            ) as fetch, patch.dict(os.environ, {
                "ARTIST_ID": "artist-1", "X_ACCOUNT": "example_user",
                "FETCH_MODE": mode, "FETCH_DELAY_SECONDS": "0",
            }), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                module.main()
            saved = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(saved["other_metadata"], data["other_metadata"])
        artist = saved["artists"][0]
        for field in ("id", "x_account", "works", "note", "monitoring", "threads_posts"):
            self.assertEqual(artist[field], self.artist[field], field)
        return artist, fetch

    def test_avatar_only_result_preserves_saved_name_and_records_source(self):
        profile = {"display_name": None, "avatar_url": "https://unavatar.io/x/example_user?fallback=false", "source": "unavatar"}
        for module in (fetch_artist, fetch_all_profiles):
            with self.subTest(entry_point=module.__name__):
                artist, fetch = self.run_update(module, profile)
                self.assertEqual(artist["name"], self.artist["name"])
                self.assertEqual(artist["avatar_url"], profile["avatar_url"])
                self.assertEqual(artist["profile_source"], "unavatar")
                self.assertEqual(artist["profile_fetched_at"], dt.date.today().isoformat())
                self.assertEqual(artist["fetch_status"], "done")
                fetch.assert_awaited_once_with("example_user")

    def test_name_only_result_preserves_saved_avatar(self):
        profile = {"display_name": "新しい表示名", "avatar_url": "", "source": "syndication"}
        for module in (fetch_artist, fetch_all_profiles):
            with self.subTest(entry_point=module.__name__):
                artist, _ = self.run_update(module, profile)
                self.assertEqual(artist["name"], profile["display_name"])
                self.assertEqual(artist["avatar_url"], self.artist["avatar_url"])
                self.assertEqual(artist["profile_source"], "syndication")
                self.assertEqual(artist["fetch_status"], "done")

    def test_unavailable_or_empty_profile_preserves_last_success(self):
        for profile in (None, {"display_name": None, "avatar_url": "", "source": "syndication"}):
            for module in (fetch_artist, fetch_all_profiles):
                with self.subTest(profile=profile, entry_point=module.__name__):
                    artist, _ = self.run_update(module, profile)
                    expected = {**self.artist, "fetch_status": "error"}
                    self.assertEqual(artist, expected)

    def test_full_profile_refresh_updates_both_fields(self):
        profile = {"display_name": "新しい表示名", "avatar_url": "https://example.invalid/new.jpg", "source": "x_html"}
        for module in (fetch_artist, fetch_all_profiles):
            with self.subTest(entry_point=module.__name__):
                artist, _ = self.run_update(module, profile)
                self.assertEqual(artist["name"], profile["display_name"])
                self.assertEqual(artist["avatar_url"], profile["avatar_url"])
                self.assertEqual(artist["fetch_status"], "done")

    def test_bulk_exception_preserves_last_success(self):
        artist, _ = self.run_update(fetch_all_profiles, None, error=TimeoutError("temporary outage"))
        self.assertEqual(artist, {**self.artist, "fetch_status": "error"})

    def test_missing_only_skips_existing_complete_profile(self):
        artist, fetch = self.run_update(fetch_all_profiles, None, mode="missing_only")
        self.assertEqual(artist, self.artist)
        fetch.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
