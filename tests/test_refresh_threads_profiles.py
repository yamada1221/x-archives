import unittest
from unittest.mock import patch

import scripts.refresh_threads_profiles as refresh


class ThreadsRefreshTests(unittest.TestCase):
    def test_refreshes_threads_accounts_and_retains_history(self):
        data = {
            "artists": [
                {
                    "id": "t1",
                    "threads_account": "example",
                    "threads_posts": [
                        {"id": "old", "text": "old post", "permalink": "https://www.threads.com/@example/post/old"}
                    ],
                },
                {"id": "x1", "x_account": "xonly"},
            ]
        }
        profile = {
            "name": "Example",
            "biography": "bio",
            "profile_picture_url": "https://scontent.example.fbcdn.net/a.jpg",
        }
        new_posts = [
            {"id": "new", "text": "new post", "permalink": "https://www.threads.com/@example/post/new", "is_reply": False}
        ]
        with patch.object(refresh, "fetch_threads", return_value=(profile, new_posts, "threads_html")) as fetch:
            refresh.process(data, delay_seconds=0)

        fetch.assert_called_once_with("example", "")
        artist = data["artists"][0]
        self.assertEqual(artist["threads_fetch_status"], "done")
        self.assertEqual([post["id"] for post in artist["threads_posts"]], ["new", "old"])
        self.assertEqual(data["threads_refresh_summary"]["checked"], 1)
        self.assertEqual(data["threads_refresh_summary"]["success"], 1)
        self.assertEqual(data["threads_refresh_summary"]["failed"], 0)

    def test_failed_refresh_keeps_existing_posts(self):
        data = {
            "artists": [
                {
                    "id": "t1",
                    "threads_account": "example",
                    "threads_posts": [{"id": "old", "text": "old"}],
                }
            ]
        }
        with patch.object(refresh, "fetch_threads", return_value=(None, [], "threads_html")):
            refresh.process(data, delay_seconds=0)

        artist = data["artists"][0]
        self.assertEqual(artist["threads_fetch_status"], "error")
        self.assertEqual([post["id"] for post in artist["threads_posts"]], ["old"])
        self.assertEqual(data["threads_refresh_summary"]["failed"], 1)

    def test_health_fails_only_when_all_checked_accounts_fail(self):
        with self.assertRaises(SystemExit):
            refresh.check_health({"threads_refresh_summary": {"checked": 2, "success": 0, "failed": 2}})
        refresh.check_health({"threads_refresh_summary": {"checked": 2, "success": 1, "failed": 1}})
        refresh.check_health({"threads_refresh_summary": {"checked": 0, "success": 0, "failed": 0}})


if __name__ == "__main__":
    unittest.main()
