"""Tests for TemplateResolver.validate() method."""

import json
from pathlib import Path

import pytest

from worca.orchestrator.templates import (
    TemplateError,
    TemplateResolver,
)


def _write_template(directory: Path, data: dict):
    """Helper: create template dir with template.json."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "template.json").write_text(json.dumps(data))


def _minimal(id: str = "test-tmpl") -> dict:
    return {
        "id": id,
        "name": id.capitalize(),
        "description": f"{id} description",
        "builtin": True,
        "created_at": "2026-01-01T00:00:00Z",
        "tags": [],
        "config": {},
        "params": {},
    }


def _make_resolver(tmp_path, config=None, params_def=None):
    """Helper to create a resolver with a test template."""
    builtin_dir = tmp_path / "builtin"
    data = _minimal()
    if config is not None:
        data["config"] = config
    if params_def is not None:
        data["params"] = params_def
    _write_template(builtin_dir / "test-tmpl", data)
    return TemplateResolver(builtin_dir, None, None)


class TestTemplateResolverValidate:
    def test_validate_empty_config_returns_empty_issues(self, tmp_path):
        """Empty config on empty base should be valid."""
        resolver = _make_resolver(tmp_path, config={})
        issues = resolver.validate("test-tmpl", {})
        assert issues == []

    def test_validate_with_base_settings_ok(self, tmp_path):
        """Valid config merged onto base settings should return no issues."""
        resolver = _make_resolver(
            tmp_path,
            config={
                "agents": {"planner": {"model": "opus"}},
                "effort": {"auto_cap": "high"},
            },
        )
        base = {"governance": {"strict": True}}
        issues = resolver.validate("test-tmpl", base)
        assert issues == []

    def test_validate_flags_unknown_agent(self, tmp_path):
        """An agent not in ALL_AGENTS should be flagged as an error."""
        resolver = _make_resolver(
            tmp_path,
            config={"agents": {"ghost_agent": {"model": "sonnet"}}},
        )
        issues = resolver.validate("test-tmpl", {})
        assert len(issues) == 1
        assert issues[0]["field"] == "agents.ghost_agent"
        assert issues[0]["severity"] == "error"
        assert "unknown agent" in issues[0]["message"].lower()

    def test_validate_warns_missing_model_alias(self, tmp_path):
        """A model alias not in worca.models should be a warning (silent fallback)."""
        resolver = _make_resolver(
            tmp_path,
            config={"agents": {"planner": {"model": "ghost"}}},
        )
        base = {"models": {"opus": "claude-opus-4-6", "sonnet": "claude-sonnet-4-6"}}
        issues = resolver.validate("test-tmpl", base)
        assert len(issues) == 1
        assert issues[0]["field"] == "agents.planner.model"
        assert issues[0]["severity"] == "warning"
        assert "ghost" in issues[0]["message"].lower()

    def test_validate_flags_invalid_effort(self, tmp_path):
        """Invalid effort level should be an error."""
        resolver = _make_resolver(
            tmp_path,
            config={"effort": {"auto_cap": "nuclear"}},
        )
        issues = resolver.validate("test-tmpl", {})
        assert len(issues) == 1
        assert issues[0]["field"] == "effort.auto_cap"
        assert issues[0]["severity"] == "error"
        assert "invalid effort" in issues[0]["message"].lower()

    def test_validate_ok_for_valid_effort_levels(self, tmp_path):
        """All valid effort levels should pass."""
        resolver = _make_resolver(tmp_path, config={"effort": {"auto_cap": "xhigh"}})
        for level in ["low", "medium", "high", "xhigh", "max"]:
            resolver = _make_resolver(tmp_path, config={"effort": {"auto_cap": level}})
            issues = resolver.validate("test-tmpl", {})
            assert issues == []

    def test_validate_returns_no_issues_for_known_agents(self, tmp_path):
        """All known agents should be valid."""
        resolver = _make_resolver(
            tmp_path,
            config={
                "agents": {
                    "planner": {"model": "opus"},
                    "coordinator": {"model": "sonnet"},
                    "implementer": {"model": "sonnet"},
                    "tester": {"model": "haiku"},
                    "reviewer": {"model": "opus"},
                    "guardian": {"model": "opus"},
                    "learner": {"model": "haiku"},
                    "plan_reviewer": {"model": "sonnet"},
                    "workspace_planner": {"model": "opus"},
                },
            },
        )
        issues = resolver.validate("test-tmpl", {})
        assert issues == []

    def test_validate_multiple_issues(self, tmp_path):
        """Multiple validation issues should all be reported."""
        resolver = _make_resolver(
            tmp_path,
            config={
                "agents": {
                    "ghost": {"model": "nuclear"},
                    "planner": {"effort": "invalid"},
                },
                "effort": {"auto_cap": "boom"},
            },
        )
        issues = resolver.validate("test-tmpl", {})
        assert len(issues) == 3

        field_messages = {issue["field"]: issue["message"] for issue in issues}
        assert "agents.ghost" in field_messages
        assert "effort.auto_cap" in field_messages
        assert "invalid" in field_messages["effort.auto_cap"].lower()

    def test_validate_with_params_renders_before_merge(self, tmp_path):
        """Params should be rendered before validation."""
        resolver = _make_resolver(
            tmp_path,
            config={"agents": {"planner": {"model": "{{model_param}}"}}},
            params_def={"model_param": {"default": "sonnet"}},
        )
        base = {"models": {"sonnet": "claude-sonnet-4-6"}}
        issues = resolver.validate("test-tmpl", base, params={"model_param": "sonnet"})
        # With param rendered, the model is valid
        assert issues == []

    def test_validate_merges_config_with_base_settings(self, tmp_path):
        """Validation must use deep-merged config deep-renders properly."""
        resolver = _make_resolver(
            tmp_path,
            config={"agents": {"planner": {"model": "sonnet"}}},
        )
        base = {"agents": {"coordinator": {"model": "opus"}}, "models": {}}
        issues = resolver.validate("test-tmpl", base)
        # Should not flag either agent as invalid (they're in the merged config)
        assert issues == []

    def test_validate_raises_not_found_for_unknown_template(self, tmp_path):
        resolver = _make_resolver(tmp_path, config={})
        with pytest.raises(TemplateError) as exc_info:
            resolver.validate("nonexistent", {})
        assert exc_info.value.code == "not_found"

    def test_validate_latency_sub_100ms(self, tmp_path):
        """validate() should complete in <100ms with realistic config."""
        resolver = _make_resolver(
            tmp_path,
            config={
                "agents": {
                    "planner": {"model": "opus", "effort": "high", "max_turns": 30},
                    "coordinator": {"model": "haiku", "max_turns": 5},
                    "implementer": {"model": "sonnet", "effort": "medium"},
                    "tester": {"model": "haiku", "max_turns": 5},
                    "reviewer": {"model": "opus", "effort": "high", "max_turns": 10},
                    "guardian": {"model": "opus"},
                },
                "stages": {
                    "preflight": {"enabled": True},
                    "plan": {"enabled": True},
                    "coordinate": {"enabled": True},
                    "implement": {"enabled": True},
                    "test": {"enabled": True},
                    "review": {"enabled": True},
                    "pr": {"enabled": True},
                },
                "loops": {
                    "implement_test": 3,
                    "review": 1,
                },
                "circuit_breaker": {
                    "enabled": True,
                    "max_consecutive_failures": 5,
                },
                "effort": {
                    "auto_mode": "adaptive",
                    "auto_cap": "xhigh",
                },
            },
        )
        base = {
            "models": {
                "opus": "claude-opus-4-6",
                "sonnet": "claude-sonnet-4-6",
                "haiku": "claude-haiku-4-5-20251001",
            },
        }

        import time
        start = time.perf_counter()
        issues = resolver.validate("test-tmpl", base)
        elapsed_ms = (time.perf_counter() - start) * 1000

        assert issues == []
        assert elapsed_ms < 100, f"validate() took {elapsed_ms:.2f}ms, expected <100ms"

    def test_validate_field_paths_use_dot_notation(self, tmp_path):
        """All field paths should use dot notation (e.g., agents.planner.model)."""
        resolver = _make_resolver(
            tmp_path,
            config={
                "agents": {"ghost": {"model": "x"}},
                "effort": {"auto_cap": "y"},
            },
        )
        issues = resolver.validate("test-tmpl", {})
        fields = {issue["field"] for issue in issues}
        assert "agents.ghost" in fields
        assert "effort.auto_cap" in fields
        # No underscores or other separators
        for field in fields:
            assert "." in field or field in ["root"], f"Expected dot notation, got {field}"
