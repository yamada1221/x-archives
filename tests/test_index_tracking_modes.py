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


def test_duplicate_x_account_is_rejected_in_ui():
    assert "const normalizedX = xAccount.toLowerCase();" in HTML
    assert "item.id !== editingId" in HTML
    assert "String(item.x_account || '').trim().replace(/^@/, '').toLowerCase() === normalizedX" in HTML
    assert "@${xAccount} はすでに登録されています" in HTML


def test_record_archive_status_badges_are_rendered():
    assert "function archiveBadge(artist)" in HTML
    assert "保存済み" in HTML
    assert "処理中" in HTML
    assert "未保存" in HTML
    assert "${archiveBadge(artist)}" in HTML


def test_saved_archive_link_uses_current_archive_fields():
    assert "artist.archive_status === 'done' && artist.archive_url" in HTML
    assert "href=\"${esc(artist.archive_url)}\"" in HTML
    assert "artist.archive && artist.archive.url" not in HTML


def test_startup_loads_github_when_saved_config_is_complete():
    assert "const startupConfig = getConfig();" in HTML
    assert "startupConfig.token && startupConfig.owner && startupConfig.repo" in HTML
    assert "loadFromGitHub();" in HTML


def test_latest_monitor_result_prefers_last_result():
    assert "function latestMonitorResult(artist)" in HTML
    assert "monitoring.last_result" in HTML
    assert "return monitoring.last_result;" in HTML


def test_monitor_badge_shows_latest_unknown_result():
    assert "const result = latestMonitorResult(artist);" in HTML
    assert "X 判定不能" in HTML
    assert 'status-tag unknown' in HTML


def test_stats_split_latest_monitor_results():
    assert 'id="statActive"' in HTML
    assert 'id="statUnknown"' in HTML
    assert 'id="statUnavailable"' in HTML
    assert "latestMonitorResult(item) === 'active'" in HTML
    assert "latestMonitorResult(item) === 'unknown'" in HTML
    assert "latestMonitorResult(item) === 'unavailable'" in HTML
