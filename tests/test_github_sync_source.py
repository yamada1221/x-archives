from pathlib import Path

HTML = Path('index.html').read_text(encoding='utf-8')


def test_sync_requires_config():
    assert "if (!cfg.token || !cfg.owner || !cfg.repo)" in HTML
    assert "まずGitHub設定を入力してください" in HTML


def test_sync_fetches_existing_sha_before_put():
    assert "const sha = await getFileSha(apiUrl, cfg.token);" in HTML
    assert "if (sha) body.sha = sha;" in HTML


def test_sync_puts_to_contents_api_with_auth():
    assert "method: 'PUT'" in HTML
    assert "Authorization: `token ${cfg.token}`" in HTML
    assert "Accept: 'application/vnd.github.v3+json'" in HTML


def test_sync_serializes_artists_json():
    assert "JSON.stringify({ artists }, null, 2)" in HTML
    assert "chore: update artists.json" in HTML


def test_load_reads_same_configured_path():
    assert "contents/${cfg.path}" in HTML
    assert "if (json.artists)" in HTML
    assert "json.artists.map(normalizeArtist)" in HTML


def test_profile_fetch_uses_repository_dispatch():
    assert "repos/${cfg.owner}/${cfg.repo}/dispatches" in HTML
    assert "event_type: 'fetch_artist'" in HTML
    assert "client_payload: { artist_id: artistId, x_account: xAccount }" in HTML


def test_sync_reports_http_status_on_failure():
    assert "`エラー: ${response.status}`" in HTML


def test_save_artist_syncs_before_triggering_profile_fetch():
    sync_pos = HTML.index("const synced = await syncToGitHub();")
    trigger_pos = HTML.index("const ok = await triggerFetch(artist.id, xAccount);")
    assert sync_pos < trigger_pos
