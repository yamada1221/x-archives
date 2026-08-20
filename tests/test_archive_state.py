from datetime import datetime, timezone

from scripts.archive_state import (
    archive_target_url,
    bookmark_target_url,
    mark_archive_result,
    record_artists,
)


def test_only_record_mode_is_archived():
    artists = [
        {"id": "1", "tracking_mode": "record"},
        {"id": "2", "tracking_mode": "monitor_only"},
    ]
    assert [a["id"] for a in record_artists(artists)] == ["1"]


def test_archive_uses_normal_profile_by_default():
    assert archive_target_url({"x_account": "@example"}) == "https://x.com/example"


def test_archive_can_include_replies_when_explicitly_enabled():
    artist = {"x_account": "example", "archive_with_replies": True}
    assert archive_target_url(artist) == "https://x.com/example/with_replies"


def test_bookmark_always_uses_normal_profile():
    artist = {"x_account": "example", "archive_with_replies": True}
    assert bookmark_target_url(artist) == "https://x.com/example"


def test_success_state_is_recorded():
    now = datetime(2026, 8, 20, 0, 0, tzinfo=timezone.utc)
    result = mark_archive_result({"x_account": "example"}, success=True, now=now)
    assert result["archive_status"] == "done"
    assert result["archive_checked_at"] == "2026-08-20T00:00:00+00:00"
    assert result["archive_url"] == "https://x.com/example"


def test_failure_state_keeps_error():
    result = mark_archive_result({"x_account": "example"}, success=False, error="429")
    assert result["archive_status"] == "error"
    assert result["archive_error"] == "429"
