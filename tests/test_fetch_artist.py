import unittest

from scripts.fetch_artist import clean_display_name, extract_profile_from_html, normalize_avatar


class ProfileHtmlFallbackTests(unittest.TestCase):
    def test_extracts_meta_profile(self):
        raw = b'''<!doctype html><html><head>
        <meta property="og:title" content="Example Name (@example_user) / X">
        <meta property="og:image" content="https://pbs.twimg.com/profile_images/123/avatar_normal.jpg">
        </head></html>'''
        profile = extract_profile_from_html(raw, "example_user")
        self.assertEqual(profile["display_name"], "Example Name")
        self.assertEqual(
            profile["avatar_url"],
            "https://pbs.twimg.com/profile_images/123/avatar_400x400.jpg",
        )

    def test_extracts_embedded_json_profile(self):
        raw = b'''<html><body><script>{"legacy":{"name":"Embedded Name","screen_name":"example_user","profile_image_url_https":"https:\\/\\/pbs.twimg.com\\/profile_images\\/456\\/photo_normal.jpg"}}</script></body></html>'''
        profile = extract_profile_from_html(raw, "example_user")
        self.assertEqual(profile["display_name"], "Embedded Name")
        self.assertEqual(
            profile["avatar_url"],
            "https://pbs.twimg.com/profile_images/456/photo_400x400.jpg",
        )

    def test_requires_profile_image(self):
        raw = b'<html><head><title>X</title></head><body>example_user</body></html>'
        self.assertIsNone(extract_profile_from_html(raw, "example_user"))

    def test_normalizes_avatar_size(self):
        self.assertEqual(
            normalize_avatar("https://pbs.twimg.com/profile_images/1/a_normal.png"),
            "https://pbs.twimg.com/profile_images/1/a_400x400.png",
        )

    def test_cleans_japanese_x_wrapper(self):
        self.assertEqual(
            clean_display_name("Xユーザーのふう（@fie3011）さん", "fie3011"),
            "ふう",
        )


if __name__ == "__main__":
    unittest.main()
