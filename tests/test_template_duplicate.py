"""Tests for TemplateResolver.duplicate() method."""

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


def _make_resolver_with_tiers(tmp_path) -> TemplateResolver:
    """Helper: create resolver with builtin, project, and user dirs."""
    builtin_dir = tmp_path / "builtin"
    project_dir = tmp_path / "project"
    user_dir = tmp_path / "user"
    return TemplateResolver(builtin_dir, project_dir, user_dir)


class TestTemplateResolverDuplicate:
    def test_duplicate_creates_in_project_scope(self, tmp_path):
        """Duplicate should create copy in project scope."""
        resolver = _make_resolver_with_tiers(tmp_path)

        # Create source template in builtin
        _write_template(
            tmp_path / "builtin" / "source-tmpl",
            _minimal("source-tmpl") | {
                "name": "Source Template",
                "description": "A source template",
                "tags": ["tag1", "tag2"],
                "config": {"agents": {"planner": {"model": "opus"}}},
                "params": {"param1": {"default": "value1"}},
            },
        )

        result = resolver.duplicate("source-tmpl", "copy-tmpl", "project")

        # Verify result is a Template
        assert result.id == "copy-tmpl"
        assert result.name == "Source Template"
        assert result.description == "A source template"
        assert result.tags == ["tag1", "tag2"]
        assert result.config == {"agents": {"planner": {"model": "opus"}}}
        assert result.params == {"param1": {"default": "value1"}}
        assert result.builtin is False
        assert result.tier == "project"

        # Verify it was written to project dir
        project_template = tmp_path / "project" / "copy-tmpl" / "template.json"
        assert project_template.exists()
        data = json.loads(project_template.read_text())
        assert data["id"] == "copy-tmpl"
        assert data["builtin"] is False
        assert data["created_at"] != "2026-01-01T00:00:00Z"  # Should have new timestamp

    def test_duplicate_creates_in_user_scope(self, tmp_path):
        """Duplicate should create copy in user scope."""
        resolver = _make_resolver_with_tiers(tmp_path)

        # Create source in project tier
        _write_template(
            tmp_path / "project" / "proj-tmpl",
            _minimal("proj-tmpl") | {
                "name": "Project Template",
                "config": {"effort": {"auto_cap": "high"}},
            },
        )

        result = resolver.duplicate("proj-tmpl", "user-copy", "user")

        assert result.id == "user-copy"
        assert result.tier == "user"
        assert result.builtin is False

        # Verify it was written to user dir
        user_template = tmp_path / "user" / "user-copy" / "template.json"
        assert user_template.exists()

    def test_duplicate_resolves_from_any_tier(self, tmp_path):
        """Duplicate should find source in priority order: project > user > builtin."""
        resolver = _make_resolver_with_tiers(tmp_path)

        # Create same ID in all tiers with different descriptions
        _write_template(
            tmp_path / "builtin" / "multi",
            _minimal("multi") | {"description": "builtin version"},
        )
        _write_template(
            tmp_path / "user" / "multi",
            _minimal("multi") | {"description": "user version"},
        )
        _write_template(
            tmp_path / "project" / "multi",
            _minimal("multi") | {"description": "project version"},
        )

        result = resolver.duplicate("multi", "copy", "project")

        # Should copy from project (highest priority)
        assert result.description == "project version"

    def test_duplicate_generates_new_timestamp(self, tmp_path):
        """Duplicate should generate a new created_at timestamp."""
        resolver = _make_resolver_with_tiers(tmp_path)

        _write_template(
            tmp_path / "builtin" / "old",
            _minimal("old") | {"created_at": "2024-01-01T00:00:00Z"},
        )

        result = resolver.duplicate("old", "new", "project")

        # New timestamp should differ
        assert result.created_at != "2024-01-01T00:00:00Z"
        # Should be recent (ISO format)
        assert result.created_at.startswith("2") and "T" in result.created_at

    def test_duplicate_respects_builtin_false(self, tmp_path):
        """Duplicate must set builtin=false even if source is builtin."""
        resolver = _make_resolver_with_tiers(tmp_path)

        _write_template(
            tmp_path / "builtin" / "builtin-tmpl",
            _minimal("builtin-tmpl") | {"builtin": True},
        )

        result = resolver.duplicate("builtin-tmpl", "copy", "project")

        assert result.builtin is False

    def test_duplicate_copies_agents_dir_if_present(self, tmp_path):
        """Duplicate should copy agents directory if present in source."""
        resolver = _make_resolver_with_tiers(tmp_path)

        source_dir = tmp_path / "builtin" / "with-agents"
        _write_template(source_dir, _minimal("with-agents"))
        (source_dir / "agents").mkdir(parents=True, exist_ok=True)
        (source_dir / "agents" / "planner.md").write_text("Planner prompt")

        result = resolver.duplicate("with-agents", "copy-agents", "project")

        # agents_dir should point to the destination
        assert result.agents_dir is not None
        assert "copy-agents" in result.agents_dir

        # Verify agents directory was copied
        dest_agents = tmp_path / "project" / "copy-agents" / "agents"
        assert dest_agents.exists()
        assert (dest_agents / "planner.md").exists()

    def test_duplicate_handles_missing_agents_dir(self, tmp_path):
        """Duplicate should handle source without agents directory."""
        resolver = _make_resolver_with_tiers(tmp_path)

        source_dir = tmp_path / "builtin" / "no-agents"
        _write_template(source_dir, _minimal("no-agents"))
        # No agents directory created

        result = resolver.duplicate("no-agents", "copy-no-agents", "project")

        # agents_dir should be None
        assert result.agents_dir is None

    def test_duplicate_builtin_to_same_id_shadows_in_project_scope(self, tmp_path):
        """Duplicating a built-in with the SAME id into project scope is the
        canonical 'clone built-in to edit it' flow. The result must land in
        the project tier and shadow (not overwrite) the built-in.
        """
        resolver = _make_resolver_with_tiers(tmp_path)

        _write_template(
            tmp_path / "builtin" / "minimal",
            _minimal("minimal") | {"name": "Built-in Minimal"},
        )

        result = resolver.duplicate("minimal", "minimal", "project")

        # The clone lives in project scope (not overwriting the built-in)
        assert result.tier == "project"
        assert (tmp_path / "project" / "minimal" / "template.json").is_file()
        # And the built-in is still intact in the builtin tier
        assert (tmp_path / "builtin" / "minimal" / "template.json").is_file()

    def test_duplicate_rejects_invalid_dst_scope(self, tmp_path):
        """`dst_scope` must be 'project' or 'user'; 'builtin' is rejected because
        the built-in tier is immutable to the CRUD API.
        """
        resolver = _make_resolver_with_tiers(tmp_path)
        _write_template(tmp_path / "builtin" / "src", _minimal("src"))

        with pytest.raises(TemplateError) as exc_info:
            resolver.duplicate("src", "dst", "builtin")

        assert exc_info.value.code == "validation_error"

    def test_duplicate_refuses_name_collision_in_project_scope(self, tmp_path):
        """Duplicate should raise name_collision if dst_id exists in target scope."""
        resolver = _make_resolver_with_tiers(tmp_path)

        # Create source
        _write_template(tmp_path / "builtin" / "source", _minimal("source"))
        # Create existing template in project scope
        _write_template(
            tmp_path / "project" / "existing",
            _minimal("existing") | {"name": "Existing Template"},
        )

        with pytest.raises(TemplateError) as exc_info:
            resolver.duplicate("source", "existing", "project")

        assert exc_info.value.code == "name_collision"
        assert "existing" in str(exc_info.value)

    def test_duplicate_refuses_name_collision_in_user_scope(self, tmp_path):
        """Duplicate should raise name_collision if dst_id exists in user scope."""
        resolver = _make_resolver_with_tiers(tmp_path)

        _write_template(tmp_path / "builtin" / "source", _minimal("source"))
        _write_template(tmp_path / "user" / "user-existing", _minimal("user-existing"))

        with pytest.raises(TemplateError) as exc_info:
            resolver.duplicate("source", "user-existing", "user")

        assert exc_info.value.code == "name_collision"

    def test_duplicate_allows_dst_id_in_other_scope(self, tmp_path):
        """Duplicate should allow dst_id that exists only in project/user scopes (not builtin)."""
        resolver = _make_resolver_with_tiers(tmp_path)

        _write_template(tmp_path / "builtin" / "source", _minimal("source"))
        # Same ID exists in project scope - should be ok for user copy
        _write_template(tmp_path / "project" / "id-in-project", _minimal("id-in-project"))

        # No error - conflict only within same scope
        result = resolver.duplicate("source", "id-in-project", "user")
        assert result.id == "id-in-project"

    def test_duplicate_raises_not_found_for_unknown_src_id(self, tmp_path):
        """Duplicate should raise not_found if source template doesn't exist."""
        resolver = _make_resolver_with_tiers(tmp_path)

        with pytest.raises(TemplateError) as exc_info:
            resolver.duplicate("nonexistent", "copy", "project")

        assert exc_info.value.code == "not_found"
        assert "nonexistent" in str(exc_info.value)

    def test_duplicate_refuses_builtin_as_dst_scope(self, tmp_path):
        """Duplicate should refuse 'builtin' as destination scope."""
        resolver = _make_resolver_with_tiers(tmp_path)

        _write_template(tmp_path / "builtin" / "source", _minimal("source"))

        with pytest.raises(TemplateError) as exc_info:
            resolver.duplicate("source", "copy", "builtin")

        assert exc_info.value.code == "validation_error"

    def test_duplicate_preserves_all_fields(self, tmp_path):
        """Duplicate should preserve id, name, description, tags, params, config."""
        resolver = _make_resolver_with_tiers(tmp_path)

        source_data = _minimal("full")
        source_data.update(
            {
                "name": "Full Template",
                "description": "A complete template",
                "tags": ["fast", "simple"],
                "params": {
                    "timeout": {"default": "30", "type": "number"},
                    "debug": {"default": "false", "type": "boolean"},
                },
                "config": {
                    "agents": {
                        "planner": {"model": "opus", "max_turns": 30},
                        "implementer": {"model": "sonnet"},
                    },
                    "loops": {"implement_test": 3},
                    "stages": {"test": {"enabled": True}},
                },
            }
        )
        _write_template(tmp_path / "project" / "full", source_data)

        result = resolver.duplicate("full", "full-copy", "project")

        assert result.name == "Full Template"
        assert result.description == "A complete template"
        assert result.tags == ["fast", "simple"]
        assert result.params == source_data["params"]
        assert result.config == source_data["config"]

    def test_duplicate_without_agents_only_confirms_json_content(self, tmp_path):
        """When source has no agents dir, duplicate should just copy the manifest."""
        resolver = _make_resolver_with_tiers(tmp_path)

        _write_template(
            tmp_path / "user" / "minimal",
            _minimal("minimal") | {
                "run": "prompt-only",
                "config": {"empty": True},
            },
        )

        resolver.duplicate("minimal", "minimal-copy", "user")

        # Check the written JSON was correct
        dest_json = tmp_path / "user" / "minimal-copy" / "template.json"
        written = json.loads(dest_json.read_text())
        assert written["id"] == "minimal-copy"
        assert written["run"] == "prompt-only"
        assert written["config"]["empty"] is True
