import importlib.util
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("monitor", Path("scripts/monitor_accounts.py"))
monitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitor)


class MonitorTests(unittest.TestCase):
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

    def test_archive_failure_is_retryable(self):
        artist = {"x_account": "example"}
        monitor.ensure_archive(artist, lambda _: (_ for _ in ()).throw(TimeoutError()))
        self.assertEqual(artist["archive"]["status"], "retry_pending")


if __name__ == "__main__":
    unittest.main()
