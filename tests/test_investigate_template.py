"""Tests for the investigate template — template loading and agent overlays."""

import json
from pathlib import Path

TEMPLATES_DIR = Path(__file__).parent.parent / "src" / "worca" / "templates"
INVESTIGATE_DIR = TEMPLATES_DIR / "investigate"


def _template():
    return json.loads((INVESTIGATE_DIR / "template.json").read_text())


def _config():
    return _template()["config"]


# --- Template loading tests ---


class TestTemplateLoading:
    def test_enabled_stages(self):
        stages = _config()["stages"]
        enabled = {name for name, cfg in stages.items() if cfg.get("enabled", True)}
        assert enabled == {"pr"}

    def test_disabled_stages(self):
        stages = _config()["stages"]
        disabled = {name for name, cfg in stages.items() if not cfg.get("enabled", True)}
        assert disabled == {"coordinate", "implement", "test", "review"}

    def test_preflight_not_disabled(self):
        stages = _config()["stages"]
        assert "preflight" not in stages or stages["preflight"].get("enabled", True)

    def test_plan_not_disabled(self):
        stages = _config()["stages"]
        assert "plan" not in stages or stages["plan"].get("enabled", True)

    def test_pr_enabled(self):
        assert _config()["stages"]["pr"]["enabled"] is True

    def test_milestones_all_disabled(self):
        milestones = _config()["milestones"]
        assert milestones["plan_approval"] is False
        assert milestones["pr_approval"] is False
        assert milestones["deploy_approval"] is False

    def test_planner_model_opus(self):
        assert _config()["agents"]["planner"]["model"] == "opus"

    def test_planner_max_turns(self):
        assert _config()["agents"]["planner"]["max_turns"] == 200

    def test_tags_include_plan_pr(self):
        assert "plan-pr" in _template()["tags"]

    def test_tags_include_analysis(self):
        assert "analysis" in _template()["tags"]

    def test_tags_include_no_code(self):
        assert "no-code" in _template()["tags"]


# --- Agent overlay tests ---


class TestAgentOverlays:
    def test_guardian_overlay_exists(self):
        assert (INVESTIGATE_DIR / "agents" / "guardian.md").is_file()

    def test_pr_block_overlay_exists(self):
        assert (INVESTIGATE_DIR / "agents" / "pr.block.md").is_file()

    def test_guardian_is_replace_mode(self):
        guardian = (INVESTIGATE_DIR / "agents" / "guardian.md").read_text()
        assert "Guardian Agent — Investigate Mode" in guardian

    def test_base_guardian_unaffected(self):
        base = Path(__file__).parent.parent / "src" / "worca" / "agents" / "core" / "guardian.md"
        content = base.read_text()
        assert "proof" in content.lower()
        assert "proof status" in content.lower()

    def test_investigate_guardian_no_proof_check(self):
        guardian = (INVESTIGATE_DIR / "agents" / "guardian.md").read_text()
        assert "proof_check" not in guardian.lower()
        assert "proof status" not in guardian.lower()

    def test_guardian_has_plan_copy_steps(self):
        guardian = (INVESTIGATE_DIR / "agents" / "guardian.md").read_text()
        assert "cp" in guardian
        assert "docs/plans/" in guardian

    def test_guardian_references_pr_json_schema(self):
        guardian = (INVESTIGATE_DIR / "agents" / "guardian.md").read_text()
        assert "pr.json" in guardian or "pr_number" in guardian

    def test_pr_block_has_work_request_placeholder(self):
        pr_block = (INVESTIGATE_DIR / "agents" / "pr.block.md").read_text()
        assert "{{work_request}}" in pr_block

    def test_guardian_has_commit_step(self):
        guardian = (INVESTIGATE_DIR / "agents" / "guardian.md").read_text()
        assert "git commit" in guardian

    def test_guardian_has_push_step(self):
        guardian = (INVESTIGATE_DIR / "agents" / "guardian.md").read_text()
        assert "git push" in guardian

    def test_guardian_has_pr_create_step(self):
        guardian = (INVESTIGATE_DIR / "agents" / "guardian.md").read_text()
        assert "gh pr create" in guardian
