import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

from scripts import fxtwitter as fx
from scripts import monitor_accounts as monitor


def profile(handle="example", user_id="123", protected=False):
    return {"code": 200, "message": "OK", "user": {"id": user_id, "screen_name": handle, "protected": protected}}


class FxTwitterTests(unittest.TestCase):
    def test_active_requires_matching_identity_and_preserves_numeric_id_as_text(self):
        evidence = fx.classify(profile("EXAMPLE", "1234567890123456789"), 200, "example")
        self.assertEqual(evidence["status"], "active")
        self.assertEqual(evidence["user_id"], "1234567890123456789")
        self.assertEqual(fx.classify(profile("other"), 200, "example")["status"], "unknown")

    def test_id_lookup_detects_renames_without_following_reassigned_handle(self):
        evidence = fx.classify(profile("new_name"), 200, "old_name", "123")
        self.assertEqual(evidence["status"], "active")
        self.assertEqual(evidence["username"], "new_name")
        self.assertEqual(fx.classify(profile("old_name", "456"), 200, "old_name", "123")["status"], "unknown")

    def test_protected_profile_is_still_active(self):
        evidence = fx.classify(profile(protected=True), 200, "example")
        self.assertEqual(evidence["status"], "active")
        self.assertTrue(evidence["protected"])

    def test_explicit_suspension_is_distinct_from_not_found(self):
        for http in (200, 404):
            with self.subTest(http=http):
                result = fx.classify({"code": 404, "message": "User is suspended", "reason": "suspended"}, http, "example")
                self.assertEqual((result["status"], result["reason"]), ("unavailable", "suspended"))
                result = fx.classify({"code": 404, "message": "User not found"}, http, "example")
                self.assertEqual((result["status"], result["reason"]), ("unavailable", "not_found"))

    def test_generic_errors_and_other_unavailability_never_become_account_loss(self):
        cases = [
            (500, {"code": 404, "message": "User not found"}),
            (429, {"code": 404, "reason": "suspended"}),
            (403, profile()), (404, profile()),
            (404, {"code": 404, "message": "Route not found"}),
            (404, {"code": 404, "message": "User not found", "reason": "upstream_error"}),
            (200, {"code": 200, "user": {}}), (200, []),
            (200, profile(user_id=123)), (200, profile(user_id="not-an-id")),
            (200, {"code": 200, "user": "invalid"}),
        ]
        for http, payload in cases:
            with self.subTest(http=http, payload=payload):
                self.assertEqual(fx.classify(payload, http, "example")["status"], "unknown")

    def test_http_error_body_is_parsed_and_id_endpoint_is_used(self):
        error = urllib.error.HTTPError("https://api.fxtwitter.com/2/profile/id:123", 404, "not found", {}, io.BytesIO(json.dumps({"code": 404, "message": "User is suspended", "reason": "suspended"}).encode()))
        with patch.object(fx.urllib.request, "urlopen", side_effect=error) as opened:
            result = fx.probe_profile("example", "123")
        self.assertEqual(result["reason"], "suspended")
        self.assertTrue(opened.call_args.args[0].full_url.endswith("/id:123"))

    def test_transport_failure_and_html_error_are_unknown(self):
        errors = [TimeoutError(), urllib.error.HTTPError("https://example.invalid", 404, "not found", {}, io.BytesIO(b"<html>challenge</html>"))]
        for error in errors:
            with self.subTest(error=type(error).__name__), patch.object(fx.urllib.request, "urlopen", side_effect=error):
                self.assertEqual(fx.probe_profile("example")["status"], "unknown")

    def test_invalid_target_does_not_request_anything(self):
        with patch.object(fx.urllib.request, "urlopen") as opened:
            self.assertEqual(fx.probe_profile("example", "bad/id")["status"], "unknown")
            self.assertEqual(fx.probe_profile("too_long_for_x_username")["status"], "unknown")
        opened.assert_not_called()


class MonitorIntegrationTests(unittest.TestCase):
    def test_saved_all_unknown_run_fails_health_check_without_altering_data(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "artists.json"
            for summary, should_fail in [
                ({"checked": 2, "unknown": 2}, True),
                ({"checked": 2, "unknown": 1}, False),
                ({"checked": 0, "unknown": 0}, False),
            ]:
                original = json.dumps({"monitoring_summary": summary})
                path.write_text(original)
                with patch.object(monitor, "DATA_PATH", path), patch("sys.argv", ["monitor", "--check-health"]):
                    if should_fail:
                        with self.assertRaises(SystemExit):
                            monitor.main()
                    else:
                        monitor.main()
                self.assertEqual(path.read_text(), original)

    def test_dry_run_does_not_write_account_data(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "artists.json"
            original = '{"artists": []}'
            path.write_text(original)
            with patch.object(monitor, "DATA_PATH", path), patch.object(monitor, "LEGACY_DATA_PATH", Path(directory) / "absent.json"), patch.object(monitor, "process") as process, patch("sys.argv", ["monitor", "--dry-run"]):
                monitor.main()
                process.assert_called_once()
            self.assertEqual(path.read_text(), original)

    def test_fx_evidence_takes_priority_over_legacy_lookup(self):
        suspended = fx.classify({"code": 404, "reason": "suspended"}, 404, "example")
        with patch.object(monitor, "probe_fxtwitter", return_value=suspended), patch.object(monitor, "probe_account") as legacy:
            self.assertEqual(monitor.probe_artist({"x_account": "example"})["reason"], "suspended")
        legacy.assert_not_called()

    def test_only_unknown_accounts_without_id_use_legacy_fallback(self):
        with patch.object(monitor, "probe_fxtwitter", return_value=fx.unknown("timeout")), patch.object(monitor, "probe_account", return_value=("active", "legacy ok")) as legacy:
            self.assertEqual(monitor.probe_artist({"x_account": "example"})["source"], "x_public")
            legacy.assert_called_once_with("example")
            legacy.reset_mock()
            self.assertEqual(monitor.probe_artist({"x_account": "example", "x_user_id": "123"})["status"], "unknown")
            legacy.assert_not_called()

    def test_provider_control_failure_cannot_mark_every_account_missing(self):
        missing = fx.classify({"code": 404, "message": "User not found"}, 404, "example")
        data = {"artists": [{"x_account": "example", "x_user_id": "123", "monitoring": {"status": "active", "consecutive_unavailable": 2}}]}
        with patch.object(monitor, "probe_fxtwitter", return_value=missing) as probe:
            monitor.process(data)
        probe.assert_called_once_with("X", "783214")
        self.assertEqual(data["artists"][0]["monitoring"]["status"], "active")
        self.assertEqual(data["artists"][0]["monitoring"]["last_result"], "unknown")
        self.assertEqual(data["monitoring_summary"]["unknown"], 1)
        self.assertFalse(data["monitoring_summary"]["fxtwitter_healthy"])

    def test_confirmed_suspension_recovery_and_timestamps(self):
        artist = {"x_account": "example"}
        active = fx.classify(profile(), 200, "example")
        suspended = fx.classify({"code": 404, "message": "User is suspended", "reason": "suspended"}, 404, "example")
        monitor.record_check(artist, "active", active["detail"], "day0", active)
        self.assertEqual(artist["x_user_id"], "123")
        for day in range(1, 4):
            monitor.record_check(artist, "unavailable", suspended["detail"], f"day{day}", suspended)
            self.assertEqual(artist["monitoring"]["status"], "active" if day < 3 else "unavailable")
            self.assertEqual(artist["monitoring"]["last_confirmed_at"], "day0" if day < 3 else "day3")
        self.assertEqual(artist["monitoring"]["confirmed_reason"], "suspended")
        monitor.record_check(artist, "unknown", "timeout", "day4", fx.unknown("timeout"))
        self.assertEqual(artist["monitoring"]["confirmed_reason"], "suspended")
        self.assertEqual(artist["monitoring"]["last_confirmed_at"], "day3")
        monitor.record_check(artist, "active", active["detail"], "day5", active)
        self.assertEqual(artist["monitoring"]["confirmed_reason"], "")
        self.assertEqual([x["to"] for x in artist["status_history"]], ["active", "unavailable", "active"])

    def test_unrelated_negative_reasons_do_not_accumulate(self):
        artist = {"monitoring": {"status": "active", "consecutive_unavailable": 2, "consecutive_reason": "not_found"}}
        evidence = {"source": "fxtwitter", "reason": "suspended"}
        monitor.record_check(artist, "unavailable", "suspended", "today", evidence)
        self.assertEqual(artist["monitoring"]["status"], "active")
        self.assertEqual(artist["monitoring"]["consecutive_unavailable"], 1)


if __name__ == "__main__":
    unittest.main()
