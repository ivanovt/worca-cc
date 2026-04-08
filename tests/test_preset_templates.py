"""Tests for the 6 built-in preset template directories."""

import json
from pathlib import Path

import pytest

TEMPLATES_DIR = Path(__file__).parent.parent / "src" / "worca" / "templates"

PRESETS = ["bugfix", "feature", "refactor", "quick-fix", "investigate", "test-only"]

# Agent overlay files expected per preset
EXPECTED_OVERLAYS = {
    "bugfix":      {"planner.md", "coordinator.md"},
    "feature":     set(),
    "refactor":    {"planner.md", "guardian.md"},
    "quick-fix":   {"planner.md", "coordinator.md"},
    "investigate": {"planner.md"},
    "test-only":   {"planner.md", "coordinator.md", "implementer.md"},
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

    def test_planner_model_sonnet(self):
        assert self._config()["agents"]["planner"]["model"] == "sonnet"

    def test_coordinator_model_sonnet(self):
        assert self._config()["agents"]["coordinator"]["model"] == "sonnet"

    def test_budget_capped(self):
        assert self._config()["budget"]["max_cost_usd"] == 30


class TestFeatureConfig:
    def _config(self):
        return json.loads((TEMPLATES_DIR / "feature" / "template.json").read_text())["config"]

    def test_plan_review_enabled(self):
        assert self._config()["stages"]["plan_review"]["enabled"] is True

    def test_learn_enabled(self):
        assert self._config()["stages"]["learn"]["enabled"] is True


class TestRefactorConfig:
    def _config(self):
        return json.loads((TEMPLATES_DIR / "refactor" / "template.json").read_text())["config"]

    def test_pr_disabled(self):
        assert self._config()["stages"]["pr"]["enabled"] is False


class TestQuickFixConfig:
    def _config(self):
        return json.loads((TEMPLATES_DIR / "quick-fix" / "template.json").read_text())["config"]

    def test_planner_model_haiku(self):
        assert self._config()["agents"]["planner"]["model"] == "haiku"

    def test_coordinator_model_haiku(self):
        assert self._config()["agents"]["coordinator"]["model"] == "haiku"

    def test_test_stage_disabled(self):
        assert self._config()["stages"]["test"]["enabled"] is False

    def test_review_stage_disabled(self):
        assert self._config()["stages"]["review"]["enabled"] is False

    def test_budget_5(self):
        assert self._config()["budget"]["max_cost_usd"] == 5


class TestInvestigateConfig:
    def _config(self):
        return json.loads((TEMPLATES_DIR / "investigate" / "template.json").read_text())["config"]

    def test_coordinate_disabled(self):
        assert self._config()["stages"]["coordinate"]["enabled"] is False

    def test_implement_disabled(self):
        assert self._config()["stages"]["implement"]["enabled"] is False

    def test_planner_opus(self):
        assert self._config()["agents"]["planner"]["model"] == "opus"

    def test_planner_200_turns(self):
        assert self._config()["agents"]["planner"]["max_turns"] == 200


class TestTestOnlyConfig:
    def _config(self):
        return json.loads((TEMPLATES_DIR / "test-only" / "template.json").read_text())["config"]

    def test_planner_model_sonnet(self):
        assert self._config()["agents"]["planner"]["model"] == "sonnet"

    def test_coordinator_model_sonnet(self):
        assert self._config()["agents"]["coordinator"]["model"] == "sonnet"

    def test_budget_25(self):
        assert self._config()["budget"]["max_cost_usd"] == 25
