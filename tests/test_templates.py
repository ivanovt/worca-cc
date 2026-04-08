"""Tests for TemplateResolver.__init__, list(), and get()."""

import json
from pathlib import Path

import pytest

from worca.orchestrator.templates import (
    Template,
    TemplateSummary,
    TemplateError,
    TemplateResolver,
    deep_merge_config,
    render_params,
)


def _write_template(directory: Path, data: dict):
    """Helper: create template dir with template.json."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "template.json").write_text(json.dumps(data))


def _minimal(id: str, tier: str = "builtin", created_at: str = "2026-01-01T00:00:00Z") -> dict:
    return {
        "id": id,
        "name": id.capitalize(),
        "description": f"{id} description",
        "builtin": tier == "builtin",
        "created_at": created_at,
        "tags": [],
        "config": {},
    }


# ---------------------------------------------------------------------------
# TemplateResolver.list()
# ---------------------------------------------------------------------------


class TestTemplateResolverList:
    def test_returns_builtins_sorted_alphabetically(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        for id_ in ["zebra", "alpha", "monkey"]:
            _write_template(builtin_dir / id_, _minimal(id_))

        resolver = TemplateResolver(builtin_dir, None, None)
        results = resolver.list()

        assert [r.id for r in results] == ["alpha", "monkey", "zebra"]
        assert all(r.tier == "builtin" for r in results)

    def test_returns_project_templates_after_builtins(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        project_dir = tmp_path / "project"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix"))
        _write_template(project_dir / "custom", _minimal("custom", tier="project"))

        resolver = TemplateResolver(builtin_dir, project_dir, None)
        results = resolver.list()

        ids = [r.id for r in results]
        assert ids.index("bugfix") < ids.index("custom")
        assert results[ids.index("bugfix")].tier == "builtin"
        assert results[ids.index("custom")].tier == "project"

    def test_deduplicates_by_id_user_wins_over_project_and_builtin(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"

        # Same ID "shared" in all three tiers
        _write_template(builtin_dir / "shared", _minimal("shared", "builtin"))
        _write_template(project_dir / "shared", _minimal("shared", "project"))
        _write_template(user_dir / "shared", _minimal("shared", "user"))

        resolver = TemplateResolver(builtin_dir, project_dir, user_dir)
        results = resolver.list()

        shared = [r for r in results if r.id == "shared"]
        assert len(shared) == 1
        assert shared[0].tier == "user"

    def test_deduplicates_project_wins_over_builtin(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        project_dir = tmp_path / "project"

        _write_template(builtin_dir / "shared", _minimal("shared", "builtin"))
        _write_template(project_dir / "shared", _minimal("shared", "project"))

        resolver = TemplateResolver(builtin_dir, project_dir, None)
        results = resolver.list()

        shared = [r for r in results if r.id == "shared"]
        assert len(shared) == 1
        assert shared[0].tier == "project"

    def test_gracefully_handles_missing_tier_directories(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix"))

        # project_dir and user_dir don't exist
        resolver = TemplateResolver(builtin_dir, tmp_path / "nonexistent-project", tmp_path / "nonexistent-user")
        results = resolver.list()

        assert len(results) == 1
        assert results[0].id == "bugfix"

    def test_all_dirs_missing_returns_empty(self, tmp_path):
        resolver = TemplateResolver(tmp_path / "a", tmp_path / "b", tmp_path / "c")
        assert resolver.list() == []

    def test_none_dirs_handled_gracefully(self):
        resolver = TemplateResolver(None, None, None)
        assert resolver.list() == []

    def test_skips_unparseable_template_json(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        good = builtin_dir / "good"
        bad = builtin_dir / "bad"
        good.mkdir(parents=True)
        bad.mkdir(parents=True)
        (good / "template.json").write_text(json.dumps(_minimal("good")))
        (bad / "template.json").write_text("this is not json {{{")

        resolver = TemplateResolver(builtin_dir, None, None)
        results = resolver.list()

        assert len(results) == 1
        assert results[0].id == "good"

    def test_returns_template_summary_objects(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix"))

        resolver = TemplateResolver(builtin_dir, None, None)
        results = resolver.list()

        assert all(isinstance(r, TemplateSummary) for r in results)

    def test_user_templates_sorted_newest_first(self, tmp_path):
        user_dir = tmp_path / "user"
        _write_template(user_dir / "old", _minimal("old", "user", "2026-01-01T00:00:00Z"))
        _write_template(user_dir / "new", _minimal("new", "user", "2026-04-01T00:00:00Z"))
        _write_template(user_dir / "mid", _minimal("mid", "user", "2026-02-01T00:00:00Z"))

        resolver = TemplateResolver(None, None, user_dir)
        results = resolver.list()

        assert [r.id for r in results] == ["new", "mid", "old"]


# ---------------------------------------------------------------------------
# TemplateResolver.get()
# ---------------------------------------------------------------------------


class TestTemplateResolverGet:
    def test_returns_none_for_unknown_id(self, tmp_path):
        resolver = TemplateResolver(tmp_path / "builtin", None, None)
        assert resolver.get("nonexistent") is None

    def test_returns_template_from_highest_priority_tier(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        user_dir = tmp_path / "user"
        _write_template(builtin_dir / "shared", _minimal("shared", "builtin"))
        _write_template(user_dir / "shared", _minimal("shared", "user"))

        resolver = TemplateResolver(builtin_dir, None, user_dir)
        result = resolver.get("shared")

        assert result is not None
        assert result.tier == "user"

    def test_returns_template_object(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix"))

        resolver = TemplateResolver(builtin_dir, None, None)
        result = resolver.get("bugfix")

        assert isinstance(result, Template)

    def test_populates_source_dir(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix"))

        resolver = TemplateResolver(builtin_dir, None, None)
        result = resolver.get("bugfix")

        assert result.source_dir == str(builtin_dir / "bugfix")

    def test_agents_dir_is_none_when_no_agents_subdir(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        _write_template(builtin_dir / "feature", _minimal("feature"))

        resolver = TemplateResolver(builtin_dir, None, None)
        result = resolver.get("feature")

        assert result.agents_dir is None

    def test_agents_dir_populated_when_agents_subdir_exists(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        tmpl_dir = builtin_dir / "bugfix"
        _write_template(tmpl_dir, _minimal("bugfix"))
        agents_dir = tmpl_dir / "agents"
        agents_dir.mkdir()
        (agents_dir / "planner.md").write_text("# Planner overlay")

        resolver = TemplateResolver(builtin_dir, None, None)
        result = resolver.get("bugfix")

        assert result.agents_dir == str(agents_dir)

    def test_returns_full_template_fields(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        data = {
            "id": "bugfix",
            "name": "Bugfix",
            "description": "Fast bug fix.",
            "builtin": True,
            "created_at": "2026-03-10T00:00:00Z",
            "tags": ["fast"],
            "params": {"severity": {"default": "medium"}},
            "config": {"agents": {"planner": {"model": "sonnet"}}},
        }
        _write_template(builtin_dir / "bugfix", data)

        resolver = TemplateResolver(builtin_dir, None, None)
        result = resolver.get("bugfix")

        assert result.id == "bugfix"
        assert result.name == "Bugfix"
        assert result.description == "Fast bug fix."
        assert result.builtin is True
        assert result.tags == ["fast"]
        assert result.params == {"severity": {"default": "medium"}}
        assert result.config == {"agents": {"planner": {"model": "sonnet"}}}


# ---------------------------------------------------------------------------
# TemplateResolver.apply()
# ---------------------------------------------------------------------------


class TestTemplateResolverApply:
    def _make_resolver(self, tmp_path, config, params=None):
        builtin_dir = tmp_path / "builtin"
        data = {
            "id": "bugfix",
            "name": "Bugfix",
            "description": "Fast bug fix.",
            "builtin": True,
            "created_at": "2026-01-01T00:00:00Z",
            "tags": [],
            "params": params or {},
            "config": config,
        }
        _write_template(builtin_dir / "bugfix", data)
        return TemplateResolver(builtin_dir, None, None)

    def test_raises_not_found_for_unknown_template(self, tmp_path):
        resolver = TemplateResolver(tmp_path / "builtin", None, None)
        with pytest.raises(TemplateError) as exc_info:
            resolver.apply("nonexistent", {})
        assert exc_info.value.code == "not_found"

    def test_deep_merges_template_config_into_current_settings(self, tmp_path):
        resolver = self._make_resolver(tmp_path, config={"stages": {"test": {"enabled": False}}})
        current = {"stages": {"test": {"enabled": True}, "plan": {"enabled": True}}}
        result = resolver.apply("bugfix", current)
        assert result["stages"]["test"]["enabled"] is False
        assert result["stages"]["plan"]["enabled"] is True

    def test_preserves_unspecified_keys(self, tmp_path):
        resolver = self._make_resolver(tmp_path, config={"agents": {"planner": {"model": "sonnet"}}})
        current = {"governance": {"strict": True}, "agents": {"planner": {"model": "opus"}}}
        result = resolver.apply("bugfix", current)
        assert result["governance"]["strict"] is True
        assert result["agents"]["planner"]["model"] == "sonnet"

    def test_handles_replace_sentinel(self, tmp_path):
        resolver = self._make_resolver(
            tmp_path,
            config={"stages": {"__replace__": True, "test": {"enabled": False}}},
        )
        current = {"stages": {"plan": {"enabled": True}, "test": {"enabled": True}}}
        result = resolver.apply("bugfix", current)
        assert result["stages"] == {"test": {"enabled": False}}
        assert "plan" not in result["stages"]

    def test_renders_params_into_config_values(self, tmp_path):
        resolver = self._make_resolver(
            tmp_path,
            config={"agents": {"planner": {"model": "{{model}}"}}},
            params={"model": {"default": "opus"}},
        )
        current = {}
        result = resolver.apply("bugfix", current, params={"model": "haiku"})
        assert result["agents"]["planner"]["model"] == "haiku"

    def test_renders_param_defaults_when_not_overridden(self, tmp_path):
        resolver = self._make_resolver(
            tmp_path,
            config={"agents": {"planner": {"model": "{{model}}"}}},
            params={"model": {"default": "opus"}},
        )
        result = resolver.apply("bugfix", {})
        assert result["agents"]["planner"]["model"] == "opus"

    def test_does_not_mutate_inputs(self, tmp_path):
        resolver = self._make_resolver(tmp_path, config={"stages": {"test": {"enabled": False}}})
        current = {"stages": {"test": {"enabled": True}}}
        current_copy = {"stages": {"test": {"enabled": True}}}
        resolver.apply("bugfix", current)
        assert current == current_copy


# ---------------------------------------------------------------------------
# TemplateResolver.snapshot_to_run()
# ---------------------------------------------------------------------------


class TestTemplateResolverSnapshotToRun:
    def _make_template_dir(self, root: Path, template_id: str, with_agents: bool = False) -> Path:
        tmpl_dir = root / template_id
        tmpl_dir.mkdir(parents=True)
        (tmpl_dir / "template.json").write_text(json.dumps({
            "id": template_id,
            "name": template_id.capitalize(),
            "description": f"{template_id} description",
            "builtin": True,
            "created_at": "2026-01-01T00:00:00Z",
            "tags": [],
            "params": {},
            "config": {},
        }))
        if with_agents:
            agents_dir = tmpl_dir / "agents"
            agents_dir.mkdir()
            (agents_dir / "planner.md").write_text("# Planner overlay")
            (agents_dir / "coordinator.md").write_text("# Coordinator overlay")
        return tmpl_dir

    def test_copies_template_directory_to_run_dir(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        self._make_template_dir(builtin_dir, "bugfix")
        run_dir = tmp_path / "run"
        run_dir.mkdir()

        resolver = TemplateResolver(builtin_dir, None, None)
        resolver.snapshot_to_run("bugfix", str(run_dir))

        assert (run_dir / "template" / "template.json").is_file()

    def test_writes_resolved_params_json(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        self._make_template_dir(builtin_dir, "bugfix")
        run_dir = tmp_path / "run"
        run_dir.mkdir()

        resolver = TemplateResolver(builtin_dir, None, None)
        resolver.snapshot_to_run("bugfix", str(run_dir), params={"severity": "high"})

        resolved = json.loads((run_dir / "template" / "resolved-params.json").read_text())
        assert resolved["template_id"] == "bugfix"
        assert resolved["template_tier"] == "builtin"
        assert resolved["params"] == {"severity": "high"}
        assert "snapshot_at" in resolved

    def test_copies_agents_subdirectory_when_present(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        self._make_template_dir(builtin_dir, "bugfix", with_agents=True)
        run_dir = tmp_path / "run"
        run_dir.mkdir()

        resolver = TemplateResolver(builtin_dir, None, None)
        resolver.snapshot_to_run("bugfix", str(run_dir))

        assert (run_dir / "template" / "agents" / "planner.md").is_file()
        assert (run_dir / "template" / "agents" / "coordinator.md").is_file()

    def test_raises_not_found_for_unknown_template(self, tmp_path):
        resolver = TemplateResolver(tmp_path / "builtin", None, None)
        run_dir = tmp_path / "run"
        run_dir.mkdir()

        with pytest.raises(TemplateError) as exc_info:
            resolver.snapshot_to_run("nonexistent", str(run_dir))
        assert exc_info.value.code == "not_found"


# ---------------------------------------------------------------------------
# TemplateResolver.save()
# ---------------------------------------------------------------------------


class TestTemplateResolverSave:
    def _make_resolver(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        project_dir = tmp_path / "project"
        user_dir = tmp_path / "user"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix", "builtin"))
        return TemplateResolver(builtin_dir, project_dir, user_dir)

    def _valid_data(self, id_="my-template"):
        return {
            "id": id_,
            "name": "My Template",
            "description": "A custom template.",
            "tags": ["fast"],
            "config": {},
        }

    def test_creates_template_directory_and_json(self, tmp_path):
        resolver = self._make_resolver(tmp_path)
        resolver.save(self._valid_data(), scope="project")
        assert (tmp_path / "project" / "my-template" / "template.json").is_file()

    def test_sets_builtin_false_and_created_at(self, tmp_path):
        resolver = self._make_resolver(tmp_path)
        result = resolver.save(self._valid_data(), scope="project")
        assert result.builtin is False
        assert result.created_at
        data = json.loads((tmp_path / "project" / "my-template" / "template.json").read_text())
        assert data["builtin"] is False
        assert data["created_at"]

    def test_creates_scope_dir_if_not_exists(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        builtin_dir.mkdir()
        project_dir = tmp_path / "does-not-exist-yet"
        resolver = TemplateResolver(builtin_dir, project_dir, None)
        resolver.save(self._valid_data(), scope="project")
        assert (project_dir / "my-template" / "template.json").is_file()

    def test_raises_builtin_conflict_for_builtin_id(self, tmp_path):
        resolver = self._make_resolver(tmp_path)
        with pytest.raises(TemplateError) as exc_info:
            resolver.save(self._valid_data("bugfix"), scope="project")
        assert exc_info.value.code == "builtin_conflict"

    def test_raises_validation_error_for_invalid_fields(self, tmp_path):
        resolver = self._make_resolver(tmp_path)
        bad_data = self._valid_data()
        bad_data["id"] = "INVALID ID!"
        bad_data["name"] = ""
        with pytest.raises(TemplateError) as exc_info:
            resolver.save(bad_data, scope="project")
        assert exc_info.value.code == "validation_error"

    def test_collects_multiple_validation_errors_in_details(self, tmp_path):
        resolver = self._make_resolver(tmp_path)
        bad_data = {
            "id": "INVALID!",
            "name": "",
            "tags": ["t1", "t2", "t3", "t4", "t5", "t6"],  # too many tags
            "config": {},
        }
        with pytest.raises(TemplateError) as exc_info:
            resolver.save(bad_data, scope="project")
        assert exc_info.value.code == "validation_error"
        assert isinstance(exc_info.value.details, list)
        assert len(exc_info.value.details) >= 2


# ---------------------------------------------------------------------------
# TemplateResolver.delete()
# ---------------------------------------------------------------------------


class TestTemplateResolverDelete:
    def _make_resolver(self, tmp_path):
        builtin_dir = tmp_path / "builtin"
        project_dir = tmp_path / "project"
        _write_template(builtin_dir / "bugfix", _minimal("bugfix", "builtin"))
        _write_template(project_dir / "custom", _minimal("custom", "project"))
        return TemplateResolver(builtin_dir, project_dir, None)

    def test_removes_template_directory(self, tmp_path):
        resolver = self._make_resolver(tmp_path)
        assert (tmp_path / "project" / "custom").is_dir()
        resolver.delete("custom", scope="project")
        assert not (tmp_path / "project" / "custom").exists()

    def test_raises_not_found_for_missing_template(self, tmp_path):
        resolver = self._make_resolver(tmp_path)
        with pytest.raises(TemplateError) as exc_info:
            resolver.delete("nonexistent", scope="project")
        assert exc_info.value.code == "not_found"

    def test_raises_builtin_for_builtin_template(self, tmp_path):
        resolver = self._make_resolver(tmp_path)
        with pytest.raises(TemplateError) as exc_info:
            resolver.delete("bugfix", scope="project")
        assert exc_info.value.code == "builtin"


# ---------------------------------------------------------------------------
# deep_merge_config()
# ---------------------------------------------------------------------------


class TestDeepMergeConfig:
    def test_merges_nested_dicts_recursively(self):
        base = {"a": {"x": 1, "y": 2}, "b": 3}
        overlay = {"a": {"y": 99, "z": 4}}
        result = deep_merge_config(base, overlay)
        assert result == {"a": {"x": 1, "y": 99, "z": 4}, "b": 3}

    def test_overlay_scalars_replace_base(self):
        base = {"key": "original", "other": 10}
        overlay = {"key": "overridden"}
        result = deep_merge_config(base, overlay)
        assert result["key"] == "overridden"
        assert result["other"] == 10

    def test_replace_sentinel_triggers_wholesale_replacement(self):
        base = {"stages": {"plan": {"enabled": True}, "test": {"enabled": True}}}
        overlay = {"stages": {"__replace__": True, "test": {"enabled": False}}}
        result = deep_merge_config(base, overlay)
        assert result["stages"] == {"test": {"enabled": False}}
        assert "plan" not in result["stages"]

    def test_returns_new_dict_no_mutation(self):
        base = {"a": {"x": 1}}
        overlay = {"a": {"x": 2}}
        base_copy = {"a": {"x": 1}}
        result = deep_merge_config(base, overlay)
        assert result is not base
        assert base == base_copy


# ---------------------------------------------------------------------------
# render_params()
# ---------------------------------------------------------------------------


class TestRenderParams:
    def test_replaces_placeholders_with_provided_params(self):
        content = "Model is {{model}} with {{turns}} turns."
        result = render_params(content, {"model": "haiku", "turns": "50"}, {})
        assert result == "Model is haiku with 50 turns."

    def test_falls_back_to_defaults_from_param_defs(self):
        content = "Use {{model}} for planning."
        result = render_params(content, {}, {"model": {"default": "opus"}})
        assert result == "Use opus for planning."

    def test_raises_template_error_for_required_param_missing_value_and_default(self):
        content = "Run with {{budget}} limit."
        with pytest.raises(TemplateError) as exc_info:
            render_params(content, {}, {"budget": {}})
        assert exc_info.value.code == "validation_error"
        assert exc_info.value.details["param"] == "budget"


# ---------------------------------------------------------------------------
# TemplateResolver.apply() — config & params
# ---------------------------------------------------------------------------


class TestTemplateResolverApplyConfig:
    def _make_resolver(self, tmp_path, config: dict, params_def: dict | None = None):
        builtin_dir = tmp_path / "builtin"
        data = _minimal("tmpl")
        data["config"] = config
        if params_def is not None:
            data["params"] = params_def
        _write_template(builtin_dir / "tmpl", data)
        return TemplateResolver(builtin_dir, None, None)

    def test_deep_merges_template_stages_into_current_settings(self, tmp_path):
        resolver = self._make_resolver(
            tmp_path,
            config={"stages": {"test": {"enabled": False}}},
        )
        current = {"stages": {"plan": {"enabled": True}, "test": {"enabled": True}}}
        result = resolver.apply("tmpl", current)
        assert result["stages"]["plan"]["enabled"] is True
        assert result["stages"]["test"]["enabled"] is False

    def test_preserves_unspecified_keys(self, tmp_path):
        resolver = self._make_resolver(
            tmp_path,
            config={"stages": {"test": {"enabled": False}}},
        )
        current = {"governance": {"hooks_enabled": True}, "stages": {"test": {"enabled": True}}}
        result = resolver.apply("tmpl", current)
        assert result["governance"]["hooks_enabled"] is True

    def test_handles_replace_sentinel(self, tmp_path):
        resolver = self._make_resolver(
            tmp_path,
            config={"stages": {"__replace__": True, "test": {"enabled": False}}},
        )
        current = {"stages": {"plan": {"enabled": True}, "test": {"enabled": True}}}
        result = resolver.apply("tmpl", current)
        assert result["stages"] == {"test": {"enabled": False}}
        assert "plan" not in result["stages"]

    def test_renders_params_into_config_values(self, tmp_path):
        resolver = self._make_resolver(
            tmp_path,
            config={"agents": {"planner": {"model": "{{model}}"}}},
            params_def={"model": {"default": "opus"}},
        )
        current = {}
        result = resolver.apply("tmpl", current, params={"model": "haiku"})
        assert result["agents"]["planner"]["model"] == "haiku"

    def test_returns_new_dict_does_not_mutate_inputs(self, tmp_path):
        resolver = self._make_resolver(
            tmp_path,
            config={"stages": {"test": {"enabled": False}}},
        )
        current = {"stages": {"test": {"enabled": True}}}
        current_copy = {"stages": {"test": {"enabled": True}}}
        result = resolver.apply("tmpl", current)
        assert result is not current
        assert current == current_copy
