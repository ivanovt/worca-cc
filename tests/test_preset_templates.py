"""Tests for the 7 built-in preset template directories."""

import json
from pathlib import Path

import pytest

TEMPLATES_DIR = Path(__file__).parent.parent / "src" / "worca" / "templates"

PRESETS = [
    "bugfix",
    "feature",
    "feature-fast",
    "feature-minor",
    "refactor",
    "quick-fix",
    "investigate",
    "test-only",
]

# Agent overlay files expected per preset
EXPECTED_OVERLAYS = {
    "bugfix":        {"planner.md", "coordinator.md"},
    "feature":       set(),
    "feature-fast":  set(),
    "feature-minor": set(),
    "refactor":      {"planner.md", "reviewer.md"},
    "quick-fix":     {"planner.md", "coordinator.md"},
    "investigate":   {"planner.md", "guardian.md", "pr.block.md"},
    "test-only":     {"planner.md", "coordinator.md", "implementer.md"},
}


@pytest.mark.parametrize("preset", PRESETS)
def test_template_json_exists(preset):
    assert (TEMPLATES_DIR / preset / "template.json").is_file(), (
        f"{preset}/template.json missing"
    )


@pytest.mark.parametrize("preset", PRESETS)
def test_template_json_is_valid(preset):
    path = TEMPLATES_DIR / preset / "template.json"
    data = json.loads(path.read_text())
    assert isinstance(data, dict)


@pytest.mark.parametrize("preset", PRESETS)
def test_template_json_required_fields(preset):
    data = json.loads((TEMPLATES_DIR / preset / "template.json").read_text())
    for field in ("id", "name", "description", "builtin", "created_at", "config"):
        assert field in data, f"{preset}/template.json missing field '{field}'"


@pytest.mark.parametrize("preset", PRESETS)
def test_template_id_matches_directory(preset):
    data = json.loads((TEMPLATES_DIR / preset / "template.json").read_text())
    assert data["id"] == preset


@pytest.mark.parametrize("preset", PRESETS)
def test_template_builtin_is_true(preset):
    data = json.loads((TEMPLATES_DIR / preset / "template.json").read_text())
    assert data["builtin"] is True


@pytest.mark.parametrize("preset", PRESETS)
def test_template_config_is_dict(preset):
    data = json.loads((TEMPLATES_DIR / preset / "template.json").read_text())
    assert isinstance(data["config"], dict)


@pytest.mark.parametrize("preset", PRESETS)
def test_template_tags_is_list(preset):
    data = json.loads((TEMPLATES_DIR / preset / "template.json").read_text())
    assert isinstance(data.get("tags", []), list)


@pytest.mark.parametrize("preset,expected", EXPECTED_OVERLAYS.items())
def test_agent_overlays_exist(preset, expected):
    agents_dir = TEMPLATES_DIR / preset / "agents"
    if not expected:
        # feature has no overlays — agents/ dir should not exist or be empty
        if agents_dir.exists():
            found = {f.name for f in agents_dir.iterdir()}
            assert found == set(), f"{preset}/agents/ should be empty, found {found}"
        return
    assert agents_dir.is_dir(), f"{preset}/agents/ directory missing"
    found = {f.name for f in agents_dir.iterdir() if f.is_file()}
    assert found == expected, f"{preset}/agents/ expected {expected}, found {found}"


@pytest.mark.parametrize("preset,expected", EXPECTED_OVERLAYS.items())
def test_overlay_files_are_nonempty(preset, expected):
    for filename in expected:
        path = TEMPLATES_DIR / preset / "agents" / filename
        content = path.read_text().strip()
        assert content, f"{preset}/agents/{filename} is empty"


class TestBugfixConfig:
    def _config(self):
        return json.loads((TEMPLATES_DIR / "bugfix" / "template.json").read_text())["config"]

    def test_planner_model_opus(self):
        assert self._config()["agents"]["planner"]["model"] == "opus"

    def test_coordinator_model_opus(self):
        assert self._config()["agents"]["coordinator"]["model"] == "opus"

    def test_effort_auto_cap_high(self):
        assert self._config()["effort"]["auto_cap"] == "high"


class TestFeatureConfig:
    def _config(self):
        return json.loads((TEMPLATES_DIR / "feature" / "template.json").read_text())["config"]

    def test_plan_review_enabled(self):
        assert self._config()["stages"]["plan_review"]["enabled"] is True

    def test_learn_enabled(self):
        assert self._config()["stages"]["learn"]["enabled"] is True

    def test_effort_matches_shipped_defaults(self):
        # Post-Phase-1: built-ins enumerate effort explicitly. `feature` doesn't
        # override either knob — values must match the shipped settings.json
        # defaults so picking this template is behaviorally a no-op for effort.
        assert self._config()["effort"] == {"auto_mode": "adaptive", "auto_cap": "xhigh"}


class TestFeatureFastConfig:
    def _config(self):
        return json.loads((TEMPLATES_DIR / "feature-fast" / "template.json").read_text())["config"]

    def test_plan_review_enabled(self):
        assert self._config()["stages"]["plan_review"]["enabled"] is True

    def test_plan_review_mode(self):
        assert self._config()["stages"]["plan_review"]["mode"] == "review_and_edit"

    def test_learn_enabled(self):
        assert self._config()["stages"]["learn"]["enabled"] is True

    def test_loop_implement_test(self):
        assert self._config()["loops"]["implement_test"] == 10

    def test_loop_pr_changes(self):
        assert self._config()["loops"]["pr_changes"] == 5

    def test_loop_restart_planning(self):
        assert self._config()["loops"]["restart_planning"] == 3

    def test_loop_plan_review(self):
        assert self._config()["loops"]["plan_review"] == 3

    def test_effort_matches_shipped_defaults(self):
        # Same as `feature`: enriched, but no actual override.
        assert self._config()["effort"] == {"auto_mode": "adaptive", "auto_cap": "xhigh"}


class TestRefactorConfig:
    def _config(self):
        return json.loads((TEMPLATES_DIR / "refactor" / "template.json").read_text())["config"]

    def test_pr_enabled_by_default(self):
        # `pr` is not overridden in the template, so it inherits the default (enabled).
        assert self._config()["stages"].get("pr", {}).get("enabled", True) is True

    def test_plan_review_enabled(self):
        assert self._config()["stages"]["plan_review"]["enabled"] is True

    def test_learn_enabled(self):
        assert self._config()["stages"]["learn"]["enabled"] is True


class TestQuickFixConfig:
    def _config(self):
        return json.loads((TEMPLATES_DIR / "quick-fix" / "template.json").read_text())["config"]

    def test_planner_model_opus(self):
        assert self._config()["agents"]["planner"]["model"] == "opus"

    def test_coordinator_model_opus(self):
        assert self._config()["agents"]["coordinator"]["model"] == "opus"

    def test_test_stage_disabled(self):
        assert self._config()["stages"]["test"]["enabled"] is False

    def test_review_stage_disabled(self):
        assert self._config()["stages"]["review"]["enabled"] is False

    def test_effort_auto_mode_disabled(self):
        assert self._config()["effort"]["auto_mode"] == "disabled"

    def test_planner_effort_medium(self):
        assert self._config()["agents"]["planner"]["effort"] == "medium"

    def test_coordinator_effort_low(self):
        assert self._config()["agents"]["coordinator"]["effort"] == "low"

    def test_implementer_effort_low(self):
        assert self._config()["agents"]["implementer"]["effort"] == "low"


class TestInvestigateConfig:
    def _config(self):
        return json.loads((TEMPLATES_DIR / "investigate" / "template.json").read_text())["config"]

    def test_coordinate_disabled(self):
        assert self._config()["stages"]["coordinate"]["enabled"] is False

    def test_implement_disabled(self):
        assert self._config()["stages"]["implement"]["enabled"] is False

    def test_plan_review_enabled(self):
        assert self._config()["stages"]["plan_review"]["enabled"] is True

    def test_planner_opus(self):
        assert self._config()["agents"]["planner"]["model"] == "opus"

    def test_planner_200_turns(self):
        assert self._config()["agents"]["planner"]["max_turns"] == 200


class TestTestOnlyConfig:
    def _config(self):
        return json.loads((TEMPLATES_DIR / "test-only" / "template.json").read_text())["config"]

    def test_planner_model_opus(self):
        assert self._config()["agents"]["planner"]["model"] == "opus"

    def test_coordinator_model_opus(self):
        assert self._config()["agents"]["coordinator"]["model"] == "opus"

