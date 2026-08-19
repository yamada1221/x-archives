from pathlib import Path

HTML = Path("index.html").read_text(encoding="utf-8")


def test_default_tracking_mode_is_monitor_only():
    assert "if (!artist.tracking_mode) artist.tracking_mode = 'monitor_only';" in HTML
    assert "document.getElementById('fMode').value = 'monitor_only';" in HTML


def test_mode_selector_has_monitor_and_record_options():
    assert '<option value="monitor_only">監視のみ</option>' in HTML
    assert '<option value="record">記録対象（archive.md + はてブ）</option>' in HTML


def test_record_target_requires_record_mode_and_x_account():
    assert "const recordTarget = artist.tracking_mode === 'record' && artist.x_account;" in HTML


def test_archive_hatena_ui_is_guarded_by_record_target():
    assert "${recordTarget ? `" in HTML
    assert "アーカイブ・はてブ" in HTML


def test_archive_helper_receives_x_account():
    assert "function archiveHelperUrl(artist)" in HTML
    assert "archive_helper.html?x=${encodeURIComponent(artist.x_account || '')}" in HTML


def test_record_mode_description_matches_spec():
    assert "archive.mdは通常プロフィールが既定値" in HTML
    assert "必要な場合だけリプライ欄へ切り替えられます" in HTML
    assert "はてブは通常プロフィールを対象にします" in HTML


def test_monitor_only_is_not_counted_as_record():
    assert "artists.filter(item => item.tracking_mode === 'record').length" in HTML
