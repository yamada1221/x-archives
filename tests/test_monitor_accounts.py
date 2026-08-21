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

    def test_one_or_two_unavailable_results_do_not_flip_active_status(self):
        artist = {"monitoring": {"status": "active", "consecutive_unavailable": 0}}
        monitor.record_check(artist, "unavailable", "miss 1", "2026-01-01")
        self.assertEqual(artist["monitoring"]["status"], "active")
        self.assertEqual(artist["monitoring"]["consecutive_unavailable"], 1)
        self.assertNotIn("status_history", artist)
        monitor.record_check(artist, "unavailable", "miss 2", "2026-01-02")
        self.assertEqual(artist["monitoring"]["status"], "active")
        self.assertEqual(artist["monitoring"]["consecutive_unavailable"], 2)
        self.assertNotIn("status_history", artist)

    def test_active_resets_failure_count_and_records_change(self):
        artist = {"monitoring": {"status": "unavailable", "consecutive_unavailable": 3}}
        monitor.record_check(artist, "active", "profile", "2026-01-04")
        self.assertEqual(artist["monitoring"]["consecutive_unavailable"], 0)
        self.assertEqual(artist["status_history"][0]["to"], "active")

    def test_active_after_two_misses_breaks_consecutive_sequence(self):
        artist = {"monitoring": {"status": "active", "consecutive_unavailable": 0}}
        monitor.record_check(artist, "unavailable", "miss 1", "2026-01-01")
        monitor.record_check(artist, "unavailable", "miss 2", "2026-01-02")
        monitor.record_check(artist, "active", "found", "2026-01-03")
        self.assertEqual(artist["monitoring"]["status"], "active")
        self.assertEqual(artist["monitoring"]["consecutive_unavailable"], 0)

    def test_unknown_preserves_status_and_failure_count(self):
        artist = {"monitoring": {"status": "active", "consecutive_unavailable": 2}}
        monitor.record_check(artist, "unknown", "rate limit", "2026-01-03")
        self.assertEqual(artist["monitoring"]["status"], "active")
        self.assertEqual(artist["monitoring"]["consecutive_unavailable"], 2)
        self.assertEqual(artist["monitoring"]["last_result"], "unknown")
        self.assertNotIn("status_history", artist)

    def test_non_json_probe_returns_unknown_with_safe_diagnostics(self):
        class Response:
            status = 200
            headers = {"Content-Type": "text/html; charset=utf-8"}

            def __enter__(self): return self
            def __exit__(self, *args): return None
            def geturl(self): return "https://x.com/example"
            def read(self, _limit=None): return b"<html>challenge page</html>"

        with patch.object(monitor, "request", return_value=Response()):
            result, detail = monitor.probe_account("example")
        self.assertEqual(result, "unknown")
        self.assertIn("text/html", detail)
        self.assertIn("challenge page", detail)
        self.assertIn("profile page HTTP 200", detail)

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

    def test_process_checks_both_tracking_modes(self):
        data = {
            "artists": [
                {"id": "m", "x_account": "monitor_user", "tracking_mode": "monitor_only"},
                {"id": "r", "x_account": "record_user", "tracking_mode": "record"},
            ]
        }
        probed = []

        def fake_probe(username):
            probed.append(username)
            return "active", "ok"

        with patch.object(monitor, "probe_account", side_effect=fake_probe):
            monitor.process(data)

        self.assertEqual(probed, ["monitor_user", "record_user"])
        self.assertTrue(all(a["monitoring"]["status"] == "active" for a in data["artists"]))

    def test_scheduled_workflow_runs_monitor_without_archive_flags(self):
        workflow = Path(".github/workflows/monitor_accounts.yml").read_text(encoding="utf-8")
        self.assertIn("python scripts/monitor_accounts.py", workflow)
        self.assertNotIn("--no-archive", workflow)
        self.assertNotIn("--verify-archive", workflow)


if __name__ == "__main__":
    unittest.main()
