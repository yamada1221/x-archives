import json
from pathlib import Path


DATA = json.loads(Path("data/artists.json").read_text(encoding="utf-8"))


def test_f00744_is_not_linked_to_the_standalone_share():
    f00744 = next(
        artist for artist in DATA["artists"]
        if str(artist.get("threads_account", "")).lower() == "f00744"
    )
    share = next(
        artist for artist in DATA["artists"]
        if artist.get("threads_share_url") == "https://www.threads.com/share/BAeGfI7t6P/"
    )

    assert not f00744.get("threads_share_url")
    assert not share.get("threads_account")
    assert f00744["id"] != share["id"]
