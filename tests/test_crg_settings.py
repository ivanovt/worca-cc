"""Tests for CRG settings resolution (effective_crg_config)."""

import json
import os

import pytest

from worca.utils.code_review_graph import (
    EffectiveCrgConfig,
    effective_crg_config,
)
from worca.utils.settings import load_settings


class TestEffectiveCrgConfig:
    def test_global_off_kills_project(self):
        """Explicit global enabled=false is a hard kill-switch — project cannot override."""
        global_cfg = {"worca": {"code_review_graph": {"enabled": False}}}
        project_cfg = {"worca": {"code_review_graph": {"enabled": True}}}
        result = effective_crg_config(global_cfg, project_cfg)
        assert result.enabled is False
        assert result.reason == "global-off"

    def test_both_disabled_returns_disabled(self):
        global_cfg = {"worca": {"code_review_graph": {"enabled": False}}}
        project_cfg = {"worca": {"code_review_graph": {"enabled": False}}}
        result = effective_crg_config(global_cfg, project_cfg)
        assert result.enabled is False
        assert result.reason == "global-off"

    def test_global_on_project_on(self):
        global_cfg = {"worca": {"code_review_graph": {"enabled": True}}}
        project_cfg = {"worca": {"code_review_graph": {"enabled": True}}}
        result = effective_crg_config(global_cfg, project_cfg)
        assert result.enabled is True
        assert result.reason is None

    def test_global_on_project_off(self):
        global_cfg = {"worca": {"code_review_graph": {"enabled": True}}}
        project_cfg = {"worca": {"code_review_graph": {"enabled": False}}}
        result = effective_crg_config(global_cfg, project_cfg)
        assert result.enabled is False
        assert result.reason == "project-off"

    def test_global_on_project_unset_requires_opt_in(self):
        global_cfg = {"worca": {"code_review_graph": {"enabled": True}}}
        project_cfg = {"worca": {}}
        result = effective_crg_config(global_cfg, project_cfg)
        assert result.enabled is False
        assert result.reason == "project-off"

    def test_global_unset_project_on_enables(self):
        global_cfg = {"worca": {}}
        project_cfg = {"worca": {"code_review_graph": {"enabled": True}}}
        result = effective_crg_config(global_cfg, project_cfg)
        assert result.enabled is True
        assert result.reason is None

    def test_defaults_when_no_crg_block(self):
        result = effective_crg_config({"worca": {}}, {"worca": {}})
        assert result.enabled is False
        assert result.embeddings is False
        assert result.version_range == ">=2,<3"
        assert result.fastmcp_min == "3.2.4"
        assert result.min_repo_files == 100
        assert result.preflight_timeout_seconds == 300
        assert result.freshness == "clean_only"
        assert result.stage_tools is None
        assert result.reason == "project-off"

    def test_defaults_when_empty_settings(self):
        result = effective_crg_config({}, {})
        assert result.enabled is False
        assert result.reason == "project-off"

    def test_update_on_defaults(self):
        global_cfg = {"worca": {"code_review_graph": {"enabled": True}}}
        project_cfg = {"worca": {"code_review_graph": {"enabled": True}}}
        result = effective_crg_config(global_cfg, project_cfg)
        assert result.update_on_preflight is True
        assert result.update_on_post_implement is True
        assert result.update_on_guardian_post_commit is True

    def test_update_on_merge(self):
        global_cfg = {
            "worca": {
                "code_review_graph": {
                    "enabled": True,
                    "update_on": {
                        "preflight": True,
                        "post_implement": True,
                        "guardian_post_commit": True,
                    },
                }
            }
        }
        project_cfg = {
            "worca": {
                "code_review_graph": {
                    "enabled": True,
                    "update_on": {"post_implement": False},
                }
            }
        }
        result = effective_crg_config(global_cfg, project_cfg)
        assert result.update_on_preflight is True
        assert result.update_on_post_implement is False
        assert result.update_on_guardian_post_commit is True

    def test_project_overrides_version_range(self):
        global_cfg = {"worca": {"code_review_graph": {"enabled": True}}}
        project_cfg = {
            "worca": {
                "code_review_graph": {
                    "enabled": True,
                    "version_range": ">=2.1,<3",
                }
            }
        }
        result = effective_crg_config(global_cfg, project_cfg)
        assert result.version_range == ">=2.1,<3"

    def test_project_overrides_fastmcp_min(self):
        global_cfg = {"worca": {"code_review_graph": {"enabled": True}}}
        project_cfg = {
            "worca": {
                "code_review_graph": {
                    "enabled": True,
                    "fastmcp_min": "4.0.0",
                }
            }
        }
        result = effective_crg_config(global_cfg, project_cfg)
        assert result.fastmcp_min == "4.0.0"

    def test_stage_tools_override(self):
        global_cfg = {"worca": {"code_review_graph": {"enabled": True}}}
        custom_tools = {
            "planner": ["get_architecture_overview_tool"],
            "implementer": ["query_graph_tool"],
        }
        project_cfg = {
            "worca": {
                "code_review_graph": {
                    "enabled": True,
                    "stage_tools": custom_tools,
                }
            }
        }
        result = effective_crg_config(global_cfg, project_cfg)
        assert result.stage_tools == custom_tools

    def test_invalid_freshness_raises(self):
        with pytest.raises(ValueError, match="freshness"):
            effective_crg_config(
                {"worca": {"code_review_graph": {"enabled": True, "freshness": "always"}}},
                {"worca": {"code_review_graph": {"enabled": True}}},
            )

    def test_dataclass_fields(self):
        result = effective_crg_config({}, {})
        assert isinstance(result, EffectiveCrgConfig)
        for field in (
            "enabled", "embeddings", "update_on_preflight",
            "update_on_post_implement", "update_on_guardian_post_commit",
            "min_repo_files", "version_range", "fastmcp_min",
            "preflight_timeout_seconds", "freshness", "stage_tools", "reason",
        ):
            assert hasattr(result, field), f"missing field: {field}"

    def test_disabled_config_carries_defaults(self):
        result = effective_crg_config(
            {"worca": {"code_review_graph": {"enabled": False}}},
            {"worca": {"code_review_graph": {"enabled": True, "min_repo_files": 50}}},
        )
        assert result.enabled is False
        assert result.min_repo_files == 100
        assert result.version_range == ">=2,<3"

    def test_preflight_timeout_project_override(self):
        result = effective_crg_config(
            {"worca": {"code_review_graph": {"enabled": True}}},
            {"worca": {"code_review_graph": {"enabled": True, "preflight_timeout_seconds": 600}}},
        )
        assert result.preflight_timeout_seconds == 600

    def test_preflight_timeout_global_inherited(self):
        result = effective_crg_config(
            {"worca": {"code_review_graph": {"enabled": True, "preflight_timeout_seconds": 120}}},
            {"worca": {"code_review_graph": {"enabled": True}}},
        )
        assert result.preflight_timeout_seconds == 120


class TestCrgInSettingsJson:
    """Tests that src/worca/settings.json contains the code_review_graph block."""

    def test_real_settings_has_crg_section(self):
        settings_path = os.path.join(
            os.path.dirname(__file__), '..', 'src', 'worca', 'settings.json'
        )
        result = load_settings(settings_path)
        assert "code_review_graph" in result.get("worca", {}), \
            "worca.code_review_graph section missing from src/worca/settings.json"

    def test_crg_settings_defaults(self):
        settings_path = os.path.join(
            os.path.dirname(__file__), '..', 'src', 'worca', 'settings.json'
        )
        result = load_settings(settings_path)
        crg = result["worca"]["code_review_graph"]

        assert crg["enabled"] is False
        assert crg["embeddings"] is False
        assert crg["update_on"]["preflight"] is True
        assert crg["update_on"]["post_implement"] is True
        assert crg["update_on"]["guardian_post_commit"] is True
        assert crg["freshness"] == "clean_only"
        assert crg["min_repo_files"] == 100
        assert crg["version_range"] == ">=2,<3"
        assert crg["fastmcp_min"] == "3.2.4"
        assert crg["preflight_timeout_seconds"] == 300
        assert crg["stage_tools"] is None

    def test_crg_merge_preserves_siblings(self, tmp_path):
        base = {
            "worca": {
                "code_review_graph": {"enabled": False, "embeddings": False},
                "fleet": {"max_parallel": 5, "failure_threshold": 0.30},
            }
        }
        local = {
            "worca": {"code_review_graph": {"enabled": True}}
        }
        settings_file = tmp_path / "settings.json"
        settings_file.write_text(json.dumps(base))
        local_file = tmp_path / "settings.local.json"
        local_file.write_text(json.dumps(local))

        result = load_settings(str(settings_file))
        assert result["worca"]["code_review_graph"]["enabled"] is True
        assert result["worca"]["code_review_graph"]["embeddings"] is False
        assert result["worca"]["fleet"]["max_parallel"] == 5
