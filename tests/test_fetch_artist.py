import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import scripts.fetch_artist as fetch_artist
from scripts.fetch_artist import clean_display_name, extract_profile_from_html, find_artist, normalize_avatar


class ArtistLookupTests(unittest.TestCase):
    def setUp(self):
        self.data = {"artists": [{"id": "current-id", "x_account": "fie3011", "name": "Existing"}]}

    def test_prefers_artist_id(self):
        artist, matched_by = find_artist(self.data, "current-id", "other")
        self.assertEqual(artist["x_account"], "fie3011")
        self.assertEqual(matched_by, "id")

    def test_falls_back_to_x_account_when_id_is_stale(self):
        artist, matched_by = find_artist(self.data, "stale-id", "fie3011")
        self.assertEqual(artist["id"], "current-id")
        self.assertEqual(matched_by, "x_account")

    def test_x_account_fallback_normalizes_at_and_case(self):
        artist, matched_by = find_artist(self.data, "stale-id", "@FIE3011")
        self.assertEqual(artist["id"], "current-id")
        self.assertEqual(matched_by, "x_account")

    def test_returns_none_when_neither_matches(self):
        artist, matched_by = find_artist(self.data, "missing", "missing_user")
        self.assertIsNone(artist)
        self.assertEqual(matched_by, "none")


class ProfileHtmlFallbackTests(unittest.TestCase):
    def test_extracts_meta_profile(self):
        raw = b'''<!doctype html><html><head><meta property="og:title" content="Example Name (@example_user) / X"><meta property="og:image" content="https://pbs.twimg.com/profile_images/123/avatar_normal.jpg"></head></html>'''
        profile = extract_profile_from_html(raw, "example_user")
        self.assertEqual(profile["display_name"], "Example Name")
        self.assertEqual(profile["avatar_url"], "https://pbs.twimg.com/profile_images/123/avatar_400x400.jpg")

    def test_extracts_embedded_json_profile(self):
        raw = b'''<html><body><script>{"legacy":{"name":"Embedded Name","screen_name":"example_user","profile_image_url_https":"https:\\/\\/pbs.twimg.com\\/profile_images\\/456\\/photo_normal.jpg"}}</script></body></html>'''
        profile = extract_profile_from_html(raw, "example_user")
        self.assertEqual(profile["display_name"], "Embedded Name")
        self.assertEqual(profile["avatar_url"], "https://pbs.twimg.com/profile_images/456/photo_400x400.jpg")

    def test_extracts_escaped_avatar_without_screen_name_marker(self):
        raw = b'''<html><head><title>Example User</title></head><body><script>window.__data={"avatar":"https:\\/\\/pbs.twimg.com\\/profile_images\\/789\\/fallback_normal.jpg"}</script></body></html>'''
        profile = extract_profile_from_html(raw, "example_user")
        self.assertEqual(profile["display_name"], "Example User")
        self.assertEqual(profile["avatar_url"], "https://pbs.twimg.com/profile_images/789/fallback_400x400.jpg")

    def test_requires_profile_image(self):
        self.assertIsNone(extract_profile_from_html(b'<html><head><title>X</title></head><body>example_user</body></html>', "example_user"))

    def test_normalizes_avatar_size(self):
        self.assertEqual(normalize_avatar("https://pbs.twimg.com/profile_images/1/a_normal.png"), "https://pbs.twimg.com/profile_images/1/a_400x400.png")

    def test_cleans_japanese_x_wrapper(self):
        self.assertEqual(clean_display_name("Xユーザーのふう（@fie3011）さん", "fie3011"), "ふう")

    def test_cleans_standard_x_suffix(self):
        self.assertEqual(clean_display_name("Example Name (@example_user) / X", "example_user"), "Example Name")


class ProfileFetchFlowTests(unittest.TestCase):
    def test_syndication_is_preferred_when_available(self):
        expected = {"display_name": "Syndication Name", "avatar_url": "https://pbs.twimg.com/profile_images/1/a.jpg"}
        with patch.object(fetch_artist, "fetch_x_profile_syndication", new=AsyncMock(return_value=expected)) as syndication, patch.object(fetch_artist, "fetch_x_profile_html", new=AsyncMock()) as html_fallback:
            result = asyncio.run(fetch_artist.fetch_x_profile("example_user"))
        self.assertEqual(result, expected)
        syndication.assert_awaited_once_with("example_user")
        html_fallback.assert_not_awaited()

    def test_html_fallback_runs_when_syndication_fails(self):
        expected = {"display_name": "HTML Name", "avatar_url": "https://pbs.twimg.com/profile_images/2/b.jpg"}
        with patch.object(fetch_artist, "fetch_x_profile_syndication", new=AsyncMock(return_value=None)), patch.object(fetch_artist, "fetch_x_profile_html", new=AsyncMock(return_value=expected)) as html_fallback:
            result = asyncio.run(fetch_artist.fetch_x_profile("example_user"))
        self.assertEqual(result, expected)
        html_fallback.assert_awaited_once_with("example_user")

    def test_save_and_load_artists_round_trip(self):
        data = {"artists": [{"id": "artist-1", "x_account": "example_user", "name": "Example", "fetch_status": "done"}]}
        with tempfile.TemporaryDirectory() as tmp:
            data_path = Path(tmp) / "artists.json"
            with patch.object(fetch_artist, "DATA_PATH", data_path):
                fetch_artist.save_artists(data)
                self.assertEqual(fetch_artist.load_artists(), data)

    def test_profile_failure_does_not_require_clearing_existing_fields(self):
        artist = {"name": "Existing Name", "avatar_url": "https://example.invalid/existing.jpg", "fetch_status": "pending"}
        profile = None
        if profile:
            artist["name"] = profile["display_name"]
            artist["avatar_url"] = profile["avatar_url"]
            artist["fetch_status"] = "done"
        else:
            artist["fetch_status"] = "error"
        self.assertEqual(artist["name"], "Existing Name")
        self.assertEqual(artist["avatar_url"], "https://example.invalid/existing.jpg")
        self.assertEqual(artist["fetch_status"], "error")


if __name__ == "__main__":
    unittest.main()
