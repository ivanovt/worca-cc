"""Tests for template data types and utility functions."""

import pytest

from worca.orchestrator.templates import (
    Template,
    TemplateError,
    TemplateSummary,
    deep_merge_config,
    render_params,
)


class TestTemplateSummary:
    def test_instantiation_with_all_fields(self):
        ts = TemplateSummary(
            id="bugfix",
            name="Bugfix",
            description="Fast bug fix pipeline.",
            builtin=True,
            tags=["fast", "focused"],
            created_at="2026-03-10T00:00:00Z",
            tier="builtin",
        )
        assert ts.id == "bugfix"
        assert ts.name == "Bugfix"
        assert ts.description == "Fast bug fix pipeline."
        assert ts.builtin is True
        assert ts.tags == ["fast", "focused"]
        assert ts.created_at == "2026-03-10T00:00:00Z"
        assert ts.tier == "builtin"

    def test_tier_project(self):
        ts = TemplateSummary(
            id="my-template",
            name="My Template",
            description="Custom template.",
            builtin=False,
            tags=[],
            created_at="2026-04-01T00:00:00Z",
            tier="project",
        )
        assert ts.tier == "project"
        assert ts.builtin is False

    def test_tier_user(self):
        ts = TemplateSummary(
            id="user-tmpl",
            name="User Template",
            description="User-level template.",
            builtin=False,
            tags=["custom"],
            created_at="2026-04-01T00:00:00Z",
            tier="user",
        )
        assert ts.tier == "user"

    def test_empty_tags(self):
        ts = TemplateSummary(
            id="feature",
            name="Feature Development",
            description="Full pipeline.",
            builtin=True,
            tags=[],
            created_at="2026-03-10T00:00:00Z",
            tier="builtin",
        )
        assert ts.tags == []


class TestTemplate:
    def _make_template(self, **overrides):
        defaults = dict(
            id="bugfix",
            name="Bugfix",
            description="Fast bug fix pipeline.",
            builtin=True,
            created_at="2026-03-10T00:00:00Z",
            tags=["fast"],
            params={},
            config={"agents": {"planner": {"model": "sonnet"}}},
            agents_dir="/path/to/bugfix/agents",
            source_dir="/path/to/bugfix",
            tier="builtin",
        )
        defaults.update(overrides)
        return Template(**defaults)

    def test_instantiation_with_all_fields(self):
        t = self._make_template()
        assert t.id == "bugfix"
        assert t.name == "Bugfix"
        assert t.description == "Fast bug fix pipeline."
        assert t.builtin is True
        assert t.created_at == "2026-03-10T00:00:00Z"
        assert t.tags == ["fast"]
        assert t.params == {}
        assert t.config == {"agents": {"planner": {"model": "sonnet"}}}
        assert t.agents_dir == "/path/to/bugfix/agents"
        assert t.source_dir == "/path/to/bugfix"
        assert t.tier == "builtin"

    def test_agents_dir_can_be_none(self):
        t = self._make_template(agents_dir=None)
        assert t.agents_dir is None

    def test_params_with_definitions(self):
        params = {
            "severity": {
                "description": "Severity threshold",
                "default": "medium",
                "enum": ["low", "medium", "high"],
            }
        }
        t = self._make_template(params=params)
        assert t.params["severity"]["default"] == "medium"

    def test_tier_project(self):
        t = self._make_template(tier="project", builtin=False)
        assert t.tier == "project"

    def test_tier_user(self):
        t = self._make_template(tier="user", builtin=False)
        assert t.tier == "user"

    def test_config_can_be_empty(self):
        t = self._make_template(config={})
        assert t.config == {}


class TestTemplateError:
    def test_basic_instantiation(self):
        err = TemplateError("Template not found", code="not_found")
        assert str(err) == "Template not found"
        assert err.code == "not_found"
        assert err.details is None

    def test_with_details(self):
        err = TemplateError("Validation failed", code="validation_error", details={"field": "id"})
        assert err.code == "validation_error"
        assert err.details == {"field": "id"}

    def test_is_exception(self):
        with pytest.raises(TemplateError) as exc_info:
            raise TemplateError("Cannot delete built-in", code="builtin")
        assert exc_info.value.code == "builtin"

    def test_all_valid_codes(self):
        valid_codes = ["not_found", "builtin", "builtin_conflict", "validation_error", "parse_error"]
        for code in valid_codes:
            err = TemplateError("msg", code=code)
            assert err.code == code


class TestDeepMergeConfig:
    def test_scalar_override(self):
        base = {"a": 1, "b": 2}
        overlay = {"b": 99}
        result = deep_merge_config(base, overlay)
        assert result == {"a": 1, "b": 99}

    def test_new_key_added(self):
        base = {"a": 1}
        overlay = {"b": 2}
        result = deep_merge_config(base, overlay)
        assert result == {"a": 1, "b": 2}

    def test_recursive_dict_merge(self):
        base = {"agents": {"planner": {"model": "opus", "max_turns": 50}, "coordinator": {"model": "sonnet"}}}
        overlay = {"agents": {"planner": {"max_turns": 30}}}
        result = deep_merge_config(base, overlay)
        assert result == {
            "agents": {
                "planner": {"model": "opus", "max_turns": 30},
                "coordinator": {"model": "sonnet"},
            }
        }

    def test_does_not_mutate_base(self):
        base = {"a": {"x": 1}}
        overlay = {"a": {"x": 2}}
        original_base = {"a": {"x": 1}}
        deep_merge_config(base, overlay)
        assert base == original_base

    def test_does_not_mutate_overlay(self):
        base = {"a": 1}
        overlay = {"b": 2}
        original_overlay = {"b": 2}
        deep_merge_config(base, overlay)
        assert overlay == original_overlay

    def test_replace_sentinel_replaces_whole_dict(self):
        base = {"agents": {"planner": {"model": "opus"}, "coordinator": {"model": "sonnet"}}}
        overlay = {"agents": {"__replace__": True, "implementer": {"model": "opus"}}}
        result = deep_merge_config(base, overlay)
        assert result == {"agents": {"implementer": {"model": "opus"}}}

    def test_replace_sentinel_stripped_from_result(self):
        base = {}
        overlay = {"agents": {"__replace__": True, "planner": {"model": "haiku"}}}
        result = deep_merge_config(base, overlay)
        assert "__replace__" not in result["agents"]

    def test_replace_sentinel_on_nested_dict(self):
        base = {"loops": {"implement_test": 5, "pr_changes": 3}}
        overlay = {"loops": {"__replace__": True, "implement_test": 0}}
        result = deep_merge_config(base, overlay)
        assert result == {"loops": {"implement_test": 0}}

    def test_non_replace_nested_dict_when_base_key_is_not_dict(self):
        base = {"key": "scalar"}
        overlay = {"key": {"sub": "value"}}
        result = deep_merge_config(base, overlay)
        assert result == {"key": {"sub": "value"}}

    def test_non_replace_nested_dict_when_base_key_absent(self):
        base = {}
        overlay = {"agents": {"planner": {"model": "haiku"}}}
        result = deep_merge_config(base, overlay)
        assert result == {"agents": {"planner": {"model": "haiku"}}}

    def test_top_level_replace_sentinel_ignored_as_key(self):
        # __replace__ at the top level has no parent to replace — it's skipped
        base = {"a": 1}
        overlay = {"__replace__": True, "b": 2}
        result = deep_merge_config(base, overlay)
        assert result == {"a": 1, "b": 2}
        assert "__replace__" not in result

    def test_empty_overlay(self):
        base = {"a": 1}
        result = deep_merge_config(base, {})
        assert result == {"a": 1}

    def test_empty_base(self):
        base = {}
        overlay = {"a": 1}
        result = deep_merge_config(base, overlay)
        assert result == {"a": 1}

    def test_deeply_nested_merge(self):
        base = {"a": {"b": {"c": 1, "d": 2}}}
        overlay = {"a": {"b": {"c": 99}}}
        result = deep_merge_config(base, overlay)
        assert result == {"a": {"b": {"c": 99, "d": 2}}}

    def test_scalar_value_in_overlay_over_dict_in_base(self):
        base = {"a": {"nested": "value"}}
        overlay = {"a": "scalar"}
        result = deep_merge_config(base, overlay)
        assert result == {"a": "scalar"}


class TestRenderParams:
    def test_basic_placeholder_replaced(self):
        content = "Severity: {{severity}}"
        params = {"severity": "high"}
        param_defs = {"severity": {"description": "test", "default": "medium"}}
        result = render_params(content, params, param_defs)
        assert result == "Severity: high"

    def test_default_used_when_param_not_provided(self):
        content = "Threshold: {{threshold}}"
        params = {}
        param_defs = {"threshold": {"description": "test", "default": "medium"}}
        result = render_params(content, params, param_defs)
        assert result == "Threshold: medium"

    def test_explicit_param_overrides_default(self):
        content = "Model: {{model}}"
        params = {"model": "opus"}
        param_defs = {"model": {"description": "test", "default": "sonnet"}}
        result = render_params(content, params, param_defs)
        assert result == "Model: opus"

    def test_multiple_placeholders(self):
        content = "{{a}} and {{b}}"
        params = {"a": "foo"}
        param_defs = {
            "a": {"description": "first", "default": "default_a"},
            "b": {"description": "second", "default": "default_b"},
        }
        result = render_params(content, params, param_defs)
        assert result == "foo and default_b"

    def test_missing_required_param_raises_error(self):
        content = "Value: {{required_param}}"
        params = {}
        param_defs = {"required_param": {"description": "required"}}  # no default
        with pytest.raises(TemplateError) as exc_info:
            render_params(content, params, param_defs)
        assert exc_info.value.code == "validation_error"

    def test_no_placeholders_returns_unchanged(self):
        content = "No placeholders here"
        params = {}
        param_defs = {}
        result = render_params(content, params, param_defs)
        assert result == "No placeholders here"

    def test_placeholder_not_in_param_defs_raises_error(self):
        content = "Value: {{unknown}}"
        params = {}
        param_defs = {}
        with pytest.raises(TemplateError) as exc_info:
            render_params(content, params, param_defs)
        assert exc_info.value.code == "validation_error"

    def test_same_placeholder_replaced_multiple_times(self):
        content = "{{x}} and {{x}} again"
        params = {"x": "hello"}
        param_defs = {"x": {"description": "test", "default": "world"}}
        result = render_params(content, params, param_defs)
        assert result == "hello and hello again"

    def test_non_string_default_converted(self):
        content = "Max: {{max_turns}}"
        params = {}
        param_defs = {"max_turns": {"description": "test", "default": 50}}
        result = render_params(content, params, param_defs)
        assert result == "Max: 50"

    def test_non_string_param_value_converted(self):
        content = "Max: {{max_turns}}"
        params = {"max_turns": 100}
        param_defs = {"max_turns": {"description": "test", "default": 50}}
        result = render_params(content, params, param_defs)
        assert result == "Max: 100"
