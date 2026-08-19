import importlib.util
from pathlib import Path

MODULE_PATH = Path("scripts/fetch_all_profiles.py")
spec = importlib.util.spec_from_file_location("fetch_all_profiles", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)


def test_normalize_x_account_ignores_at_and_case():
    assert module.normalize_x_account(" @Fie3011 ") == "fie3011"


def test_deduplicate_artists_keeps_first_id_and_merges_record_mode_and_works():
    artists = [
        {
            "id": "first",
            "x_account": "fie3011",
            "tracking_mode": "monitor_only",
            "works": [{"url": "https://example.com/1", "saved_at": "2026-08-19", "memo": ""}],
            "fetch_status": "pending",
        },
        {
            "id": "second",
            "x_account": "@FIE3011",
            "tracking_mode": "record",
            "works": [{"url": "https://example.com/2", "saved_at": "2026-08-19", "memo": ""}],
            "fetch_status": "done",
            "name": "ふう",
            "avatar_url": "https://example.com/avatar.jpg",
            "profile_fetched_at": "2026-08-19",
        },
    ]

    result, removed = module.deduplicate_artists(artists)

    assert removed == 1
    assert len(result) == 1
    kept = result[0]
    assert kept["id"] == "first"
    assert kept["tracking_mode"] == "record"
    assert kept["fetch_status"] == "done"
    assert kept["name"] == "ふう"
    assert kept["avatar_url"] == "https://example.com/avatar.jpg"
    assert [work["url"] for work in kept["works"]] == ["https://example.com/1", "https://example.com/2"]


def test_accounts_without_x_are_not_deduplicated():
    artists = [{"id": "a", "x_account": ""}, {"id": "b", "x_account": ""}]
    result, removed = module.deduplicate_artists(artists)
    assert removed == 0
    assert [item["id"] for item in result] == ["a", "b"]
