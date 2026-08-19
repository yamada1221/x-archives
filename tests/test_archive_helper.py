from pathlib import Path
import re
from urllib.parse import urlencode

HTML = Path("archive_helper.html").read_text(encoding="utf-8")


def clean_account(value):
    return str(value or "").strip().removeprefix("@")


def profile_urls(account):
    account = clean_account(account)
    if not account:
        return {"profile": "", "replies": ""}
    base = f"https://x.com/{account}"
    return {"profile": base, "replies": base + "/with_replies"}


def hatena_url(url):
    return "https://b.hatena.ne.jp/add?" + urlencode({"mode": "confirm", "url": url})


def test_account_normalization():
    assert clean_account(" @fie3011 ") == "fie3011"


def test_default_profile_url():
    urls = profile_urls("fie3011")
    assert urls["profile"] == "https://x.com/fie3011"


def test_replies_url_is_archive_option():
    urls = profile_urls("fie3011")
    assert urls["replies"] == "https://x.com/fie3011/with_replies"


def test_hatena_targets_normal_profile():
    profile = profile_urls("fie3011")["profile"]
    target = hatena_url(profile)
    assert "x.com%2Ffie3011" in target
    assert "with_replies" not in target
    assert "archive.md" not in target


def test_helper_source_keeps_hatena_and_archive_targets_separate():
    assert "function openHatenaProfile()" in HTML
    assert "window.open(hatenaUrl(profileUrl.value)" in HTML
    assert "function useReplies()" in HTML
    assert "archiveTarget.value=urls().replies" in HTML


def test_archive_url_bookmark_is_explicitly_optional():
    assert "archive URL自体をはてブ（任意）" in HTML
    assert "通常はarchive URL自体をはてブする必要はありません" in HTML


def test_default_archive_target_is_profile():
    assert re.search(r"if\(!archiveTarget\.dataset\.edited\)archiveTarget\.value=u\.profile", HTML)
