"""Queued requests must not overwrite accounts edited after dispatch."""

import contextlib
import copy
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from scripts import fetch_artist, fetch_threads, profile_fetch_diagnostics


class StaleDispatchTests(unittest.TestCase):
    modules = (fetch_artist, fetch_threads, profile_fetch_diagnostics)

    def setUp(self):
        self.artist = {
            "id": "current-id", "x_account": "current_user", "threads_account": "current_user",
            "name": "保存した名前", "avatar_url": "https://example.invalid/saved.jpg",
            "threads_name": "保存したThreads名", "threads_posts": [{"id": "saved", "text": "保存済み"}],
            "fetch_status": "pending", "threads_fetch_status": "pending",
            "note": "手入力のメモ", "works": [{"url": "https://example.invalid/archive"}],
            "monitoring": {"status": "active"},
        }

    def run_request(self, module, artists, artist_id="current-id", account="old_user"):
        data = {"artists": copy.deepcopy(artists), "metadata": {"keep": True}}
        before = json.dumps(data, ensure_ascii=False, indent=1) + "\n"
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            path = Path(tmp) / "artists.json"
            path.write_text(before, encoding="utf-8")
            stack.enter_context(patch.object(module, "DATA_PATH", path))
            stack.enter_context(patch.dict(os.environ, {
                "ARTIST_ID": artist_id, "X_ACCOUNT": account,
                "THREADS_ACCOUNT": account, "THREADS_ACCESS_TOKEN": "",
            }))
            mocks = []
            if module is fetch_artist:
                mocks.append(stack.enter_context(patch.object(module, "fetch_x_profile", new=AsyncMock(return_value={
                    "display_name": "Fetched X", "avatar_url": "https://example.invalid/new.jpg", "source": "fixture",
                }))))
            elif module is fetch_threads:
                mocks.append(stack.enter_context(patch.object(module, "fetch_threads", new=Mock(return_value=(
                    {"name": "Fetched Threads"}, [{"id": "new", "text": "新しい投稿"}], "fixture",
                )))))
            else:
                for method in ("syndication_diag", "html_diag"):
                    mocks.append(stack.enter_context(patch.object(module, method, return_value={"fixture": True})))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            module.main()
            after = path.read_text(encoding="utf-8")
        return before, after, mocks

    def assert_skipped(self, module, artists, artist_id="current-id"):
        before, after, mocks = self.run_request(module, artists, artist_id)
        self.assertEqual(after, before, "Stale dispatch must leave the file byte-for-byte unchanged")
        for fetch in mocks:
            fetch.assert_not_called()

    def test_edited_account_skips_old_request_without_network_or_writes(self):
        for module in self.modules:
            with self.subTest(module=module.__name__):
                self.assert_skipped(module, [self.artist])

    def test_removed_account_skips_old_request(self):
        artist = {**self.artist, "x_account": "", "threads_account": ""}
        for module in self.modules:
            with self.subTest(module=module.__name__):
                self.assert_skipped(module, [artist])

    def test_id_mismatch_does_not_fall_back_to_another_record(self):
        other = {**self.artist, "id": "other-id", "x_account": "old_user", "threads_account": "old_user"}
        for module in self.modules:
            with self.subTest(module=module.__name__):
                self.assert_skipped(module, [self.artist, other])

    def test_deleted_record_skips_without_network_or_writes(self):
        for module in self.modules:
            with self.subTest(module=module.__name__):
                self.assert_skipped(module, [], artist_id="deleted-id")

    def test_current_account_and_stale_id_recovery_still_update(self):
        for module in self.modules:
            for artist_id in ("current-id", "stale-id"):
                with self.subTest(module=module.__name__, artist_id=artist_id):
                    _, after, mocks = self.run_request(module, [self.artist], artist_id, "@CURRENT_USER")
                    saved = json.loads(after)
                    artist = saved["artists"][0]
                    self.assertEqual(saved["metadata"], {"keep": True})
                    for field in ("id", "note", "works", "monitoring"):
                        self.assertEqual(artist[field], self.artist[field])
                    for fetch in mocks:
                        self.assertEqual(fetch.call_count, 1)
                        self.assertEqual(fetch.call_args.args[0], "CURRENT_USER")
                    if module is fetch_artist:
                        self.assertEqual(artist["name"], "Fetched X")
                    elif module is fetch_threads:
                        self.assertEqual(artist["threads_name"], "Fetched Threads")
                        self.assertEqual([p["id"] for p in artist["threads_posts"]], ["new", "saved"])
                    else:
                        self.assertEqual(artist["profile_fetch_diagnostic"]["x_account"], "CURRENT_USER")

    def test_missing_request_arguments_still_fail(self):
        for module in self.modules:
            with self.subTest(module=module.__name__), self.assertRaises(SystemExit):
                self.run_request(module, [self.artist], account="")


if __name__ == "__main__":
    unittest.main()
