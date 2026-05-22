"""Tests for graphify settings resolution (effective_graphify_config)."""

import json
import os

from worca.utils.graphify import (
    EffectiveGraphifyConfig,
    build_subprocess_env,
    build_update_cmd,
    effective_graphify_config,
)
from worca.utils.settings import load_settings


GRAPHIFY_DEFAULTS = {
    "enabled": False,
    "mode": "structural",
    "backend": None,
    "model_profile": None,
    "out_dir": "graphify-out",
    "update_on": {
        "preflight": True,
        "guardian_post_commit": True,
    },
    "min_repo_files": 100,
    "version_range": ">=4,<5",
}


class TestEffectiveGraphifyConfig:
    def test_both_disabled_returns_disabled(self):
        """When both global and project are disabled, effective is disabled."""
        global_cfg = {"worca": {"graphify": {"enabled": False}}}
        project_cfg = {"worca": {"graphify": {"enabled": False}}}
        result = effective_graphify_config(global_cfg, project_cfg)
        assert result.enabled is False
        assert result.reason == "global-off"

    def test_global_off_project_on_killswitch(self):
        """Global enabled=false is a hard kill-switch — project cannot override."""
        global_cfg = {"worca": {"graphify": {"enabled": False}}}
        project_cfg = {"worca": {"graphify": {"enabled": True, "mode": "full"}}}
        result = effective_graphify_config(global_cfg, project_cfg)
        assert result.enabled is False
        assert result.reason == "global-off"

    def test_global_on_project_on(self):
        """When both enabled, effective is enabled with merged config."""
        global_cfg = {"worca": {"graphify": {"enabled": True, "mode": "structural"}}}
        project_cfg = {"worca": {"graphify": {"enabled": True}}}
        result = effective_graphify_config(global_cfg, project_cfg)
        assert result.enabled is True
        assert result.mode == "structural"
        assert result.reason is None

    def test_global_on_project_off(self):
        """When global is on but project explicitly disables, effective is disabled."""
        global_cfg = {"worca": {"graphify": {"enabled": True}}}
        project_cfg = {"worca": {"graphify": {"enabled": False}}}
        result = effective_graphify_config(global_cfg, project_cfg)
        assert result.enabled is False
        assert result.reason == "project-off"

    def test_global_on_project_inherits(self):
        """When global is on and project has no graphify block, inherits global."""
        global_cfg = {
            "worca": {
                "graphify": {
                    "enabled": True,
                    "mode": "full",
                    "out_dir": "custom-out",
                }
            }
        }
        project_cfg = {"worca": {}}
        result = effective_graphify_config(global_cfg, project_cfg)
        assert result.enabled is True
        assert result.mode == "full"
        assert result.out_dir == "custom-out"

    def test_project_overrides_mode(self):
        """Project mode overrides global mode when both enabled."""
        global_cfg = {"worca": {"graphify": {"enabled": True, "mode": "structural"}}}
        project_cfg = {"worca": {"graphify": {"enabled": True, "mode": "full"}}}
        result = effective_graphify_config(global_cfg, project_cfg)
        assert result.enabled is True
        assert result.mode == "full"

    def test_defaults_when_no_graphify_block(self):
        """When neither global nor project has graphify, defaults apply."""
        result = effective_graphify_config({"worca": {}}, {"worca": {}})
        assert result.enabled is False
        assert result.mode == "structural"
        assert result.out_dir == "graphify-out"
        assert result.version_range == ">=4,<5"
        assert result.min_repo_files == 100
        assert result.reason == "global-off"

    def test_defaults_when_empty_settings(self):
        """When settings are completely empty dicts, defaults apply."""
        result = effective_graphify_config({}, {})
        assert result.enabled is False
        assert result.mode == "structural"
        assert result.reason == "global-off"

    def test_project_overrides_backend_and_model_profile(self):
        """Project can override backend and model_profile."""
        global_cfg = {
            "worca": {
                "graphify": {
                    "enabled": True,
                    "backend": None,
                    "model_profile": None,
                }
            }
        }
        project_cfg = {
            "worca": {
                "graphify": {
                    "enabled": True,
                    "backend": "openai",
                    "model_profile": "graphify-llm",
                }
            }
        }
        result = effective_graphify_config(global_cfg, project_cfg)
        assert result.backend == "openai"
        assert result.model_profile == "graphify-llm"

    def test_update_on_merge(self):
        """update_on sub-keys merge correctly between global and project."""
        global_cfg = {
            "worca": {
                "graphify": {
                    "enabled": True,
                    "update_on": {"preflight": True, "guardian_post_commit": True},
                }
            }
        }
        project_cfg = {
            "worca": {
                "graphify": {
                    "enabled": True,
                    "update_on": {"preflight": False},
                }
            }
        }
        result = effective_graphify_config(global_cfg, project_cfg)
        assert result.update_on_preflight is False
        assert result.update_on_guardian_post_commit is True

    def test_invalid_mode_raises(self):
        """An invalid mode value raises ValueError."""
        global_cfg = {"worca": {"graphify": {"enabled": True, "mode": "turbo"}}}
        project_cfg = {"worca": {"graphify": {"enabled": True}}}
        import pytest
        with pytest.raises(ValueError, match="mode"):
            effective_graphify_config(global_cfg, project_cfg)

    def test_dataclass_fields(self):
        """EffectiveGraphifyConfig has all expected fields."""
        result = effective_graphify_config({}, {})
        assert isinstance(result, EffectiveGraphifyConfig)
        assert hasattr(result, "enabled")
        assert hasattr(result, "mode")
        assert hasattr(result, "backend")
        assert hasattr(result, "model_profile")
        assert hasattr(result, "out_dir")
        assert hasattr(result, "update_on_preflight")
        assert hasattr(result, "update_on_guardian_post_commit")
        assert hasattr(result, "min_repo_files")
        assert hasattr(result, "version_range")
        assert hasattr(result, "reason")


class TestGraphifyInSettingsJson:
    """Tests that src/worca/settings.json contains the graphify block."""

    def test_real_settings_has_graphify_section(self):
        """The src/worca/settings.json contains the worca.graphify block."""
        settings_path = os.path.join(
            os.path.dirname(__file__), '..', 'src', 'worca', 'settings.json'
        )
        result = load_settings(settings_path)
        assert "graphify" in result.get("worca", {}), \
            "worca.graphify section missing from src/worca/settings.json"

    def test_graphify_defaults_match(self):
        """Graphify defaults in settings.json match the expected values."""
        settings_path = os.path.join(
            os.path.dirname(__file__), '..', 'src', 'worca', 'settings.json'
        )
        result = load_settings(settings_path)
        g = result["worca"]["graphify"]

        assert g["enabled"] is False
        assert g["mode"] == "structural"
        assert g["backend"] is None
        assert g["model_profile"] is None
        assert g["out_dir"] == "graphify-out"
        assert g["update_on"]["preflight"] is True
        assert g["update_on"]["guardian_post_commit"] is True
        assert g["min_repo_files"] == 100
        assert g["version_range"] == ">=4,<5"
        assert g["preflight_timeout_seconds"] == 300

    def test_graphify_merge_preserves_siblings(self, tmp_path):
        """Overriding graphify keys does not affect sibling worca sections."""
        base = {
            "worca": {
                "graphify": dict(GRAPHIFY_DEFAULTS),
                "fleet": {"max_parallel": 5, "failure_threshold": 0.30},
            }
        }
        local = {
            "worca": {"graphify": {"enabled": True, "mode": "full"}}
        }

        settings_file = tmp_path / "settings.json"
        settings_file.write_text(json.dumps(base))
        local_file = tmp_path / "settings.local.json"
        local_file.write_text(json.dumps(local))

        result = load_settings(str(settings_file))
        assert result["worca"]["graphify"]["enabled"] is True
        assert result["worca"]["graphify"]["mode"] == "full"
        assert result["worca"]["graphify"]["out_dir"] == "graphify-out"
        assert result["worca"]["fleet"]["max_parallel"] == 5

    def test_local_override_graphify_enabled(self, tmp_path):
        """Local override can change graphify.enabled."""
        base = {"worca": {"graphify": dict(GRAPHIFY_DEFAULTS)}}
        settings_file = tmp_path / "settings.json"
        settings_file.write_text(json.dumps(base))
        local_file = tmp_path / "settings.local.json"
        local_file.write_text(json.dumps({
            "worca": {"graphify": {"enabled": True}}
        }))

        result = load_settings(str(settings_file))
        assert result["worca"]["graphify"]["enabled"] is True
        assert result["worca"]["graphify"]["mode"] == "structural"


class TestPreflightTimeoutConfig:
    """F4: preflight_timeout_seconds is configurable (not hardcoded 300)."""

    def test_default_timeout(self):
        result = effective_graphify_config(
            {"worca": {"graphify": {"enabled": True}}},
            {"worca": {"graphify": {"enabled": True}}},
        )
        assert result.preflight_timeout_seconds == 300

    def test_project_override_timeout(self):
        result = effective_graphify_config(
            {"worca": {"graphify": {"enabled": True}}},
            {"worca": {"graphify": {"enabled": True, "preflight_timeout_seconds": 900}}},
        )
        assert result.preflight_timeout_seconds == 900

    def test_global_timeout_inherited(self):
        result = effective_graphify_config(
            {"worca": {"graphify": {"enabled": True, "preflight_timeout_seconds": 120}}},
            {"worca": {"graphify": {"enabled": True}}},
        )
        assert result.preflight_timeout_seconds == 120


class TestBuildUpdateCmd:
    """F1: build_update_cmd is the single source of the `graphify --update` argv."""

    def test_structural_appends_no_llm(self):
        cfg = effective_graphify_config(
            {"worca": {"graphify": {"enabled": True, "mode": "structural"}}},
            {"worca": {"graphify": {"enabled": True}}},
        )
        cmd = build_update_cmd(cfg)
        assert cmd[:2] == ["graphify", "--update"]
        assert "--no-llm" in cmd

    def test_full_omits_no_llm(self):
        cfg = effective_graphify_config(
            {"worca": {"graphify": {"enabled": True, "mode": "full"}}},
            {"worca": {"graphify": {"enabled": True}}},
        )
        assert "--no-llm" not in build_update_cmd(cfg)

    def test_backend_flag(self):
        cfg = effective_graphify_config(
            {"worca": {"graphify": {"enabled": True, "mode": "full", "backend": "ollama"}}},
            {"worca": {"graphify": {"enabled": True}}},
        )
        cmd = build_update_cmd(cfg)
        assert cmd[cmd.index("--backend") + 1] == "ollama"


class TestBuildSubprocessEnv:
    """F1: build_subprocess_env merges the model_profile env over the base."""

    def test_no_profile_returns_base_copy(self):
        cfg = effective_graphify_config(
            {"worca": {"graphify": {"enabled": True}}},
            {"worca": {"graphify": {"enabled": True}}},
        )
        env = build_subprocess_env(cfg, {"worca": {}}, base_env={"FOO": "bar"})
        assert env == {"FOO": "bar"}

    def test_merges_model_profile_env(self):
        cfg = effective_graphify_config(
            {"worca": {"graphify": {"enabled": True, "model_profile": "gp"}}},
            {"worca": {"graphify": {"enabled": True}}},
        )
        settings = {
            "worca": {"models": {"gp": {"id": "x", "env": {"OPENAI_API_KEY": "sk-1"}}}}
        }
        env = build_subprocess_env(cfg, settings, base_env={"FOO": "bar"})
        assert env["OPENAI_API_KEY"] == "sk-1"
        assert env["FOO"] == "bar"
