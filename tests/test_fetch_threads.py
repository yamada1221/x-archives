import json
import unittest

from scripts.fetch_threads import (
    extract_posts_from_html,
    extract_profile_from_html,
    find_artist,
    normalize_username,
)


class ThreadsInputTests(unittest.TestCase):
    def test_normalizes_handle(self):
        self.assertEqual(normalize_username("@f00744"), "f00744")

    def test_normalizes_profile_url(self):
        self.assertEqual(
            normalize_username("https://www.threads.com/@f00744?igshid=abc"),
            "f00744",
        )


class ThreadsHtmlTests(unittest.TestCase):
    def test_extracts_profile_meta(self):
        raw = b"""<!doctype html><html><head>
        <meta property="og:title" content="Example Name (@f00744) on Threads">
        <meta property="og:description" content="Example biography">
        <meta property="og:image" content="https://scontent.example.fbcdn.net/avatar.jpg">
        </head></html>"""
        profile = extract_profile_from_html(raw, "f00744")
        self.assertIsNotNone(profile)
        self.assertEqual(profile["name"], "Example Name")
        self.assertEqual(profile["biography"], "Example biography")
        self.assertIn("avatar.jpg", profile["profile_picture_url"])

    def test_extracts_embedded_public_posts(self):
        payload = {
            "items": [
                {
                    "id": "1",
                    "username": "f00744",
                    "text": "first public post",
                    "timestamp": "2026-09-28T01:02:03+0000",
                    "permalink": "https://www.threads.com/@f00744/post/abc",
                    "is_reply": False,
                },
                {
                    "id": "2",
                    "username": "other",
                    "text": "not this account",
                },
                {
                    "id": "3",
                    "username": "f00744",
                    "text": "reply text",
                    "is_reply": True,
                },
            ]
        }
        raw = (
            '<html><script type="application/json">'
            + json.dumps(payload)
            + "</script></html>"
        ).encode()
        posts = extract_posts_from_html(raw, "f00744")
        self.assertEqual([post["id"] for post in posts], ["1", "3"])
        self.assertFalse(posts[0]["is_reply"])
        self.assertTrue(posts[1]["is_reply"])


class ArtistLookupTests(unittest.TestCase):
    def test_falls_back_to_threads_account(self):
        data = {"artists": [{"id": "a1", "threads_account": "f00744"}]}
        artist, matched_by = find_artist(data, "stale", "@F00744")
        self.assertEqual(artist["id"], "a1")
        self.assertEqual(matched_by, "threads_account")


if __name__ == "__main__":
    unittest.main()
