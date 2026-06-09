"""Tests for load_settings_with_global_fallback."""

import json

from worca.utils.settings import load_settings_with_global_fallback


class TestLoadSettingsWithGlobalFallback:
    """Deep-merges ~/.worca/settings.json under project blob, project wins."""

    def test_merge_project_wins(self, tmp_path):
        """Project values override global values on overlap."""
        global_file = tmp_path / "global" / "settings.json"
        global_file.parent.mkdir()
        global_file.write_text(json.dumps({
            "worca": {
                "circuit_breaker": {"classifier_model": "sonnet"},
                "parallel": {"cleanup_policy": "always"},
            }
        }))

        project_file = tmp_path / "project" / "settings.json"
        project_file.parent.mkdir()
        project_file.write_text(json.dumps({
            "worca": {
                "circuit_breaker": {"max_consecutive_failures": 5},
            }
        }))

        result = load_settings_with_global_fallback(
            str(project_file), global_path=str(global_file)
        )

        assert result["worca"]["circuit_breaker"]["max_consecutive_failures"] == 5
        assert result["worca"]["circuit_breaker"]["classifier_model"] == "sonnet"
        assert result["worca"]["parallel"]["cleanup_policy"] == "always"

    def test_missing_global_file(self, tmp_path):
        """Missing global file returns project settings unchanged."""
        project_file = tmp_path / "settings.json"
        project_file.write_text(json.dumps({
            "worca": {"stages": {"plan": {"enabled": True}}}
        }))

        result = load_settings_with_global_fallback(
            str(project_file),
            global_path=str(tmp_path / "nonexistent" / "settings.json"),
        )

        assert result["worca"] == {"stages": {"plan": {"enabled": True}}}

    def test_malformed_global_json(self, tmp_path, capsys):
        """Malformed global JSON logs a warning and returns project settings."""
        global_file = tmp_path / "global_settings.json"
        global_file.write_text("{bad json!!!")

        project_file = tmp_path / "settings.json"
        project_file.write_text(json.dumps({"worca": {"key": "val"}}))

        result = load_settings_with_global_fallback(
            str(project_file), global_path=str(global_file)
        )

        assert result["worca"] == {"key": "val"}
        captured = capsys.readouterr()
        assert "invalid JSON" in captured.err

    def test_both_missing(self, tmp_path):
        """Both files missing returns empty dict."""
        result = load_settings_with_global_fallback(
            str(tmp_path / "no_project.json"),
            global_path=str(tmp_path / "no_global.json"),
        )
        assert result.get("worca") is None

    def test_global_only_no_project(self, tmp_path):
        """Only global file exists — its values appear in result."""
        global_file = tmp_path / "global.json"
        global_file.write_text(json.dumps({
            "worca": {"parallel": {"max_concurrent_pipelines": 7}}
        }))

        result = load_settings_with_global_fallback(
            str(tmp_path / "missing_project.json"),
            global_path=str(global_file),
        )

        assert result["worca"] == {"parallel": {"max_concurrent_pipelines": 7}}

    def test_deep_nested_merge(self, tmp_path):
        """Deep merge works across multiple nesting levels."""
        global_file = tmp_path / "global.json"
        global_file.write_text(json.dumps({
            "worca": {
                "parallel": {"cleanup_policy": "always", "max_concurrent_pipelines": 5},
                "ui": {"worktree_disk_warning_bytes": 1000000},
            }
        }))

        project_file = tmp_path / "project.json"
        project_file.write_text(json.dumps({
            "worca": {
                "parallel": {"default_base_branch": "develop"},
                "stages": {"plan": {"enabled": True}},
            }
        }))

        result = load_settings_with_global_fallback(
            str(project_file), global_path=str(global_file)
        )

        assert result["worca"]["parallel"]["cleanup_policy"] == "always"
        assert result["worca"]["parallel"]["max_concurrent_pipelines"] == 5
        assert result["worca"]["parallel"]["default_base_branch"] == "develop"
        assert result["worca"]["ui"]["worktree_disk_warning_bytes"] == 1000000
        assert result["worca"]["stages"]["plan"]["enabled"] is True

    def test_tier_views_populated(self, tmp_path):
        """_worca_tier_views stash has user, project, and builtin tiers."""
        from worca.utils.settings import _DEFAULT_MODEL_MAP
        global_file = tmp_path / "global.json"
        global_file.write_text(json.dumps({
            "worca": {"models": {"fast": "claude-user-fast"}}
        }))
        project_file = tmp_path / "project.json"
        project_file.write_text(json.dumps({
            "worca": {"models": {"fast": "claude-project-fast"}}
        }))

        result = load_settings_with_global_fallback(
            str(project_file), global_path=str(global_file)
        )

        views = result["_worca_tier_views"]
        assert views["user"] == {"fast": "claude-user-fast"}
        assert views["project"] == {"fast": "claude-project-fast"}
        assert "opus" in views["builtin"]
        assert views["builtin"]["opus"] == _DEFAULT_MODEL_MAP["opus"]

    def test_tier_views_builtin_always_present(self, tmp_path):
        """builtin tier is always populated even when no models config exists."""
        global_file = tmp_path / "global.json"
        global_file.write_text(json.dumps({"worca": {}}))
        project_file = tmp_path / "project.json"
        project_file.write_text(json.dumps({"worca": {}}))

        result = load_settings_with_global_fallback(
            str(project_file), global_path=str(global_file)
        )

        views = result["_worca_tier_views"]
        assert views["builtin"] != {}
        assert "sonnet" in views["builtin"]

    def test_tier_views_stash_regression_dropped(self, tmp_path):
        """Pre-existing _worca_tier_views in input is dropped and rebuilt."""
        global_file = tmp_path / "global.json"
        global_file.write_text(json.dumps({
            "_worca_tier_views": {"user": {"stale": "old"}, "project": {}, "builtin": {}},
            "worca": {"models": {"mymodel": "fresh-id"}}
        }))
        project_file = tmp_path / "project.json"
        project_file.write_text(json.dumps({"worca": {}}))

        result = load_settings_with_global_fallback(
            str(project_file), global_path=str(global_file)
        )

        # Rebuilt stash — should reflect fresh global models, not the stale stash
        views = result["_worca_tier_views"]
        assert views["user"] == {"mymodel": "fresh-id"}

    def test_tier_views_worktree_case(self, tmp_path):
        """Worktree-local project settings + separate user-global resolves correctly."""
        global_file = tmp_path / "global.json"
        global_file.write_text(json.dumps({
            "worca": {"models": {"fast": "claude-user-fast", "slow": "claude-user-slow"}}
        }))
        project_file = tmp_path / "worktree" / "settings.json"
        project_file.parent.mkdir()
        project_file.write_text(json.dumps({
            "worca": {"models": {"fast": "claude-worktree-fast"}}
        }))

        result = load_settings_with_global_fallback(
            str(project_file), global_path=str(global_file)
        )

        views = result["_worca_tier_views"]
        assert views["user"]["fast"] == "claude-user-fast"
        assert views["user"]["slow"] == "claude-user-slow"
        assert views["project"]["fast"] == "claude-worktree-fast"
        assert "fast" not in views["project"] or views["project"]["fast"] == "claude-worktree-fast"

    def test_default_global_path(self, tmp_path, monkeypatch):
        """Without explicit global_path, uses $WORCA_HOME/settings.json."""
        fake_home = tmp_path / "home"
        fake_home.mkdir()
        worca_dir = fake_home / ".worca"
        worca_dir.mkdir()
        global_file = worca_dir / "settings.json"
        global_file.write_text(json.dumps({
            "worca": {"circuit_breaker": {"classifier_model": "opus"}}
        }))

        monkeypatch.setenv("WORCA_HOME", str(worca_dir))

        project_file = tmp_path / "settings.json"
        project_file.write_text(json.dumps({
            "worca": {"circuit_breaker": {"max_consecutive_failures": 2}}
        }))

        result = load_settings_with_global_fallback(str(project_file))

        assert result["worca"]["circuit_breaker"]["classifier_model"] == "opus"
        assert result["worca"]["circuit_breaker"]["max_consecutive_failures"] == 2
