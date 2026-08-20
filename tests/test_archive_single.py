from scripts.archive_single import extract_submit_id, find_artist, saved_url_from_headers


def test_extract_submit_id_from_archive_form():
    html = '<form><input name="submitid" value="abc123"><input name="url"></form>'
    assert extract_submit_id(html) == "abc123"


def test_saved_url_prefers_refresh_header():
    headers = {"Refresh": "0;url=https://archive.md/AbCdE"}
    assert saved_url_from_headers(headers) == "https://archive.md/AbCdE"


def test_saved_url_uses_location_header():
    headers = {"Location": "/AbCdE"}
    assert saved_url_from_headers(headers) == "/AbCdE"


def test_find_artist_prefers_id():
    artists = [
        {"id": "a", "x_account": "first"},
        {"id": "b", "x_account": "second"},
    ]
    assert find_artist(artists, "b", "first")["id"] == "b"


def test_find_artist_falls_back_to_normalized_x_account():
    artists = [{"id": "a", "x_account": "Example_User"}]
    assert find_artist(artists, "missing", "@example_user")["id"] == "a"
