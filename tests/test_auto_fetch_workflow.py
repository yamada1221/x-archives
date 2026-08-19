from pathlib import Path

WORKFLOW = Path('.github/workflows/fetch_all_profiles.yml').read_text(encoding='utf-8')


def test_runs_when_artists_json_is_pushed():
    assert 'push:' in WORKFLOW
    assert "- 'data/artists.json'" in WORKFLOW


def test_push_uses_missing_only_mode():
    assert "github.event_name == 'push' && 'missing_only' || inputs.mode" in WORKFLOW


def test_keeps_manual_mode_choices():
    assert 'workflow_dispatch:' in WORKFLOW
    assert '- missing_only' in WORKFLOW
    assert '- all' in WORKFLOW


def test_does_not_loop_on_bot_profile_commit():
    assert "github.actor != 'github-actions[bot]'" in WORKFLOW


def test_commits_profile_results_back_to_repository():
    assert 'git add data/artists.json' in WORKFLOW
    assert 'git push' in WORKFLOW
