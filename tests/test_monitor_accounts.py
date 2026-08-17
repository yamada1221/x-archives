import importlib.util
import io
import unittest
import urllib.error
from email.message import Message
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("monitor", Path("scripts/monitor_accounts.py"))
monitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitor)


class MonitorTests(unittest.TestCase):
    def test_legacy_migration_is_idempotent_and_preserves_source(self):
        current = {"artists": [{"id": "new", "x_account": "already_here"}]}
        legacy = {
            "artists": [
                {"id": "old-duplicate", "x_account": "@ALREADY_HERE"},
                {"id": "legacy", "x_account": "legacy_account", "works": []},
            ]
        }
        original_legacy = repr(legacy)
        self.assertEqual(monitor.merge_legacy_artists(current, legacy), 1)
        self.assertEqual(monitor.merge_legacy_artists(current, legacy), 0)
        self.assertEqual([a["x_account"] for a in current["artists"]], ["already_here", "legacy_account"])
        self.assertEqual(repr(legacy), original_legacy)

    def test_temporary_failure_does_not_mark_unavailable(self):
        artist = {"monitoring": {"status": "active", "consecutive_unavailable": 1}}
        monitor.record_check(artist, "unknown", "timeout", "2026-01-01T00:00:00+00:00")
        self.assertEqual(artist["monitoring"]["status"], "active")
        self.assertEqual(artist["monitoring"]["consecutive_unavailable"], 1)

    def test_requires_three_explicit_unavailable_results(self):
        artist = {}
        for day in range(1, 4):
            monitor.record_check(artist, "unavailable", "HTTP 404", f"2026-01-0{day}")
        self.assertEqual(artist["monitoring"]["status"], "unavailable")
        self.assertEqual(len(artist["status_history"]), 1)

    def test_active_resets_failure_count_and_records_change(self):
        artist = {"monitoring": {"status": "unavailable", "consecutive_unavailable": 3}}
        monitor.record_check(artist, "active", "profile", "2026-01-04")
        self.assertEqual(artist["monitoring"]["consecutive_unavailable"], 0)
        self.assertEqual(artist["status_history"][0]["to"], "active")

    def test_archive_metadata_includes_hatena_registration_link(self):
        artist = {"x_account": "example"}
        monitor.ensure_archive(artist, lambda _: "https://archive.md/abc12")
        self.assertEqual(artist["archive"]["status"], "saved")
        self.assertIn("b.hatena.ne.jp/add", artist["archive"]["hatena_add_url"])

    def test_archive_failure_is_retryable_and_keeps_detail(self):
        artist = {"x_account": "example"}
        monitor.ensure_archive(artist, lambda _: (_ for _ in ()).throw(ValueError("HTTP 429 blocked")))
        self.assertEqual(artist["archive"]["status"], "retry_pending")
        self.assertEqual(artist["archive"]["last_error"], "ValueError")
        self.assertIn("HTTP 429", artist["archive"]["last_error_detail"])

    def test_non_json_probe_returns_unknown_with_safe_diagnostics(self):
        class Response:
            status = 200
            headers = {"Content-Type": "text/html; charset=utf-8"}

            def __enter__(self): return self
            def __exit__(self, *args): return None
            def read(self): return b"<html>challenge page</html>"

        with patch.object(monitor, "request", return_value=Response()):
            result, detail = monitor.probe_account("example")
        self.assertEqual(result, "unknown")
        self.assertIn("text/html", detail)
        self.assertIn("challenge page", detail)

    def test_http_error_detail_captures_status_content_type_and_body(self):
        headers = Message()
        headers["Content-Type"] = "text/html"
        exc = urllib.error.HTTPError(
            "https://example.invalid",
            403,
            "Forbidden",
            headers,
            io.BytesIO(b"Access denied"),
        )
        detail = monitor.http_error_detail("probe", exc)
        self.assertIn("HTTP 403", detail)
        self.assertIn("text/html", detail)
        self.assertIn("Access denied", detail)

    def test_archive_captcha_is_rejected_and_retryable(self):
        class Response:
            status = 200
            headers = {"Content-Type": "text/html"}

            def __enter__(self): return self
            def __exit__(self, *args): return None
            def geturl(self): return "https://archive.md/abc12"
            def read(self, _limit): return b'<div class="g-recaptcha">verify</div>'

        artist = {"x_account": "example"}
        with patch.object(monitor, "request", return_value=Response()):
            monitor.ensure_archive(artist)
        self.assertEqual(artist["archive"]["status"], "retry_pending")
        self.assertNotIn("url", artist["archive"])
        self.assertIn("CAPTCHA", artist["archive"]["last_error_detail"])

    def test_archive_submit_html_without_snapshot_redirect_is_rejected(self):
        class Response:
            status = 200
            headers = {"Content-Type": "text/html"}

            def __enter__(self): return self
            def __exit__(self, *args): return None
            def geturl(self): return "https://archive.md/submit/"
            def read(self, _limit): return b"<html>please wait</html>"

        with patch.object(monitor, "request", return_value=Response()):
            with self.assertRaisesRegex(ValueError, "did not redirect"):
                monitor.submit_archive("example")


if __name__ == "__main__":
    unittest.main()
