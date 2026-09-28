import json
import unittest

from scripts.fetch_threads import (
    extract_posts_from_html,
    extract_profile_from_html,
    find_artist,
    merge_posts,
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

    def test_extracts_threads_ssr_thread_items_shape(self):
        payload = {
            "data": {
                "threads": [
                    {
                        "thread_items": [
                            {
                                "post": {
                                    "pk": "111",
                                    "code": "ABC111",
                                    "caption": {"text": "SSR post text"},
                                    "taken_at": 1790550000,
                                    "like_count": 12,
                                    "user": {"username": "f00744", "pk": "u1"},
                                    "text_post_app_info": {
                                        "direct_reply_count": 3,
                                        "repost_count": 2,
                                        "quote_count": 1,
                                        "reply_to_author": None,
                                    },
                                }
                            }
                        ]
                    }
                ]
            }
        }
        raw = (
            '<html><script type="application/json" data-sjs>'
            + json.dumps(payload)
            + "</script></html>"
        ).encode()
        posts = extract_posts_from_html(raw, "f00744")
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["id"], "111")
        self.assertEqual(posts[0]["text"], "SSR post text")
        self.assertEqual(posts[0]["permalink"], "https://www.threads.com/@f00744/post/ABC111")
        self.assertEqual(posts[0]["like_count"], 12)
        self.assertEqual(posts[0]["reply_count"], 3)
        self.assertFalse(posts[0]["is_reply"])

    def test_replies_surface_can_force_reply_flag(self):
        payload = {
            "thread_items": [
                {
                    "post": {
                        "pk": "222",
                        "code": "REPLY222",
                        "caption": {"text": "reply from profile replies tab"},
                        "user": {"username": "f00744"},
                        "text_post_app_info": {},
                    }
                }
            ]
        }
        raw = (
            '<html><script type="application/json" data-sjs>'
            + json.dumps(payload)
            + "</script></html>"
        ).encode()
        posts = extract_posts_from_html(raw, "f00744", force_reply=True)
        self.assertEqual(len(posts), 1)
        self.assertTrue(posts[0]["is_reply"])

    def test_merge_posts_deduplicates_profile_and_replies(self):
        first = [{"id": "1", "text": "a"}, {"id": "2", "text": "b"}]
        second = [{"id": "2", "text": "b"}, {"id": "3", "text": "c", "is_reply": True}]
        merged = merge_posts(first, second)
        self.assertEqual([post["id"] for post in merged], ["1", "2", "3"])


class ArtistLookupTests(unittest.TestCase):
    def test_falls_back_to_threads_account(self):
        data = {"artists": [{"id": "a1", "threads_account": "f00744"}]}
        artist, matched_by = find_artist(data, "stale", "@F00744")
        self.assertEqual(artist["id"], "a1")
        self.assertEqual(matched_by, "threads_account")


if __name__ == "__main__":
    unittest.main()
