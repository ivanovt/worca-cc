"""Tests for Workspace dataclass + manifest loader (W-047-02)."""
import json

import pytest

# ---- helpers ----------------------------------------------------------------

def _write_workspace_json(tmp_path, doc):
    p = tmp_path / "workspace.json"
    p.write_text(json.dumps(doc))
    return str(tmp_path)


def _minimal():
    return {
        "name": "my-platform",
        "projects": [
            {"name": "lib", "path": "lib", "depends_on": []},
        ],
    }


def _linear_chain():
    """lib -> backend -> frontend (3 tiers)."""
    return {
        "name": "my-platform",
        "projects": [
            {"name": "lib", "path": "lib", "depends_on": []},
            {"name": "backend", "path": "backend", "depends_on": ["lib"]},
            {"name": "frontend", "path": "frontend", "depends_on": ["backend"]},
        ],
    }


def _diamond():
    """Diamond: lib -> (backend, worker) -> frontend."""
    return {
        "name": "diamond",
        "projects": [
            {"name": "lib", "path": "lib", "depends_on": []},
            {"name": "backend", "path": "backend", "depends_on": ["lib"]},
            {"name": "worker", "path": "worker", "depends_on": ["lib"]},
            {"name": "frontend", "path": "frontend", "depends_on": ["backend", "worker"]},
        ],
    }


def _cycle():
    """A -> B -> C -> A."""
    return {
        "name": "cycle",
        "projects": [
            {"name": "a", "path": "a", "depends_on": ["c"]},
            {"name": "b", "path": "b", "depends_on": ["a"]},
            {"name": "c", "path": "c", "depends_on": ["b"]},
        ],
    }


def _self_cycle():
    """Repo depends on itself."""
    return {
        "name": "self-cycle",
        "projects": [
            {"name": "a", "path": "a", "depends_on": ["a"]},
        ],
    }


def _missing_dep():
    """Repo references a dependency that doesn't exist."""
    return {
        "name": "missing",
        "projects": [
            {"name": "a", "path": "a", "depends_on": ["nonexistent"]},
        ],
    }


# ---- tests ------------------------------------------------------------------

class TestLoadValid:
    def test_load_minimal(self, tmp_path):
        from worca.workspace.manifest import Workspace

        root = _write_workspace_json(tmp_path, _minimal())
        ws = Workspace.load(root)

        assert ws.name == "my-platform"
        assert len(ws.projects) == 1
        assert ws.projects[0].name == "lib"
        assert ws.projects[0].path == "lib"
        assert ws.projects[0].depends_on == []
        assert not hasattr(ws.projects[0], "role")
        assert ws.integration_test is None
        assert ws.umbrella_repo is None

    def test_load_full(self, tmp_path):
        from worca.workspace.manifest import Workspace

        doc = _linear_chain()
        doc["integration_test"] = {"command": "make test", "working_dir": "."}
        doc["umbrella_repo"] = "org/meta"
        root = _write_workspace_json(tmp_path, doc)
        ws = Workspace.load(root)

        assert ws.name == "my-platform"
        assert len(ws.projects) == 3
        assert ws.integration_test is not None
        assert ws.integration_test.command == "make test"
        assert ws.integration_test.working_dir == "."
        assert ws.umbrella_repo == "org/meta"

    def test_load_file_not_found(self, tmp_path):
        from worca.workspace.manifest import Workspace

        with pytest.raises(FileNotFoundError):
            Workspace.load(str(tmp_path))

    def test_load_invalid_json(self, tmp_path):
        from worca.workspace.manifest import Workspace

        (tmp_path / "workspace.json").write_text("{bad json")
        with pytest.raises(json.JSONDecodeError):
            Workspace.load(str(tmp_path))

    def test_load_schema_violation(self, tmp_path):
        from worca.workspace.manifest import Workspace
        import jsonschema

        doc = {"name": "x"}  # missing repos
        _write_workspace_json(tmp_path, doc)
        with pytest.raises(jsonschema.ValidationError):
            Workspace.load(str(tmp_path))

    def test_projects_accessible_by_name(self, tmp_path):
        from worca.workspace.manifest import Workspace

        root = _write_workspace_json(tmp_path, _linear_chain())
        ws = Workspace.load(root)
        names = [r.name for r in ws.projects]
        assert names == ["lib", "backend", "frontend"]


class TestCycleDetection:
    def test_cycle_raises(self, tmp_path):
        from worca.workspace.manifest import Workspace, WorkspaceCycleError

        root = _write_workspace_json(tmp_path, _cycle())
        with pytest.raises(WorkspaceCycleError) as exc_info:
            Workspace.load(root)
        assert "cycle" in str(exc_info.value).lower()

    def test_self_cycle_raises(self, tmp_path):
        from worca.workspace.manifest import Workspace, WorkspaceCycleError

        root = _write_workspace_json(tmp_path, _self_cycle())
        with pytest.raises(WorkspaceCycleError):
            Workspace.load(root)

    def test_no_cycle_in_linear_chain(self, tmp_path):
        from worca.workspace.manifest import Workspace

        root = _write_workspace_json(tmp_path, _linear_chain())
        ws = Workspace.load(root)
        assert ws is not None

    def test_no_cycle_in_diamond(self, tmp_path):
        from worca.workspace.manifest import Workspace

        root = _write_workspace_json(tmp_path, _diamond())
        ws = Workspace.load(root)
        assert ws is not None


class TestMissingDepName:
    def test_missing_dependency_raises(self, tmp_path):
        from worca.workspace.manifest import Workspace, WorkspaceDependencyError

        root = _write_workspace_json(tmp_path, _missing_dep())
        with pytest.raises(WorkspaceDependencyError, match="nonexistent"):
            Workspace.load(root)

    def test_missing_one_of_multiple_deps(self, tmp_path):
        from worca.workspace.manifest import Workspace, WorkspaceDependencyError

        doc = {
            "name": "test",
            "projects": [
                {"name": "a", "path": "a", "depends_on": []},
                {"name": "b", "path": "b", "depends_on": ["a", "ghost"]},
            ],
        }
        root = _write_workspace_json(tmp_path, doc)
        with pytest.raises(WorkspaceDependencyError, match="ghost"):
            Workspace.load(root)

    def test_duplicate_project_names_raises(self, tmp_path):
        from worca.workspace.manifest import Workspace, WorkspaceDependencyError

        doc = {
            "name": "dupes",
            "projects": [
                {"name": "a", "path": "a1", "depends_on": []},
                {"name": "a", "path": "a2", "depends_on": []},
            ],
        }
        root = _write_workspace_json(tmp_path, doc)
        with pytest.raises(WorkspaceDependencyError, match="duplicate.*a"):
            Workspace.load(root)


class TestTierComputation:
    def test_single_repo_tier_zero(self, tmp_path):
        from worca.workspace.manifest import Workspace

        root = _write_workspace_json(tmp_path, _minimal())
        ws = Workspace.load(root)
        assert ws.tiers == [["lib"]]

    def test_linear_chain_tiers(self, tmp_path):
        from worca.workspace.manifest import Workspace

        root = _write_workspace_json(tmp_path, _linear_chain())
        ws = Workspace.load(root)
        assert len(ws.tiers) == 3
        assert ws.tiers[0] == ["lib"]
        assert ws.tiers[1] == ["backend"]
        assert ws.tiers[2] == ["frontend"]

    def test_diamond_tiers(self, tmp_path):
        from worca.workspace.manifest import Workspace

        root = _write_workspace_json(tmp_path, _diamond())
        ws = Workspace.load(root)
        assert len(ws.tiers) == 3
        assert ws.tiers[0] == ["lib"]
        assert sorted(ws.tiers[1]) == ["backend", "worker"]
        assert ws.tiers[2] == ["frontend"]

    def test_all_independent(self, tmp_path):
        from worca.workspace.manifest import Workspace

        doc = {
            "name": "flat",
            "projects": [
                {"name": "a", "path": "a", "depends_on": []},
                {"name": "b", "path": "b", "depends_on": []},
                {"name": "c", "path": "c", "depends_on": []},
            ],
        }
        root = _write_workspace_json(tmp_path, doc)
        ws = Workspace.load(root)
        assert len(ws.tiers) == 1
        assert sorted(ws.tiers[0]) == ["a", "b", "c"]

    def test_two_tier_partial_deps(self, tmp_path):
        from worca.workspace.manifest import Workspace

        doc = {
            "name": "partial",
            "projects": [
                {"name": "a", "path": "a", "depends_on": []},
                {"name": "b", "path": "b", "depends_on": []},
                {"name": "c", "path": "c", "depends_on": ["a"]},
            ],
        }
        root = _write_workspace_json(tmp_path, doc)
        ws = Workspace.load(root)
        assert len(ws.tiers) == 2
        assert sorted(ws.tiers[0]) == ["a", "b"]
        assert ws.tiers[1] == ["c"]

    def test_tier_order_stable_within_tier(self, tmp_path):
        """Repos within a tier are sorted alphabetically for determinism."""
        from worca.workspace.manifest import Workspace

        doc = {
            "name": "order",
            "projects": [
                {"name": "zebra", "path": "z", "depends_on": []},
                {"name": "apple", "path": "a", "depends_on": []},
                {"name": "mango", "path": "m", "depends_on": []},
            ],
        }
        root = _write_workspace_json(tmp_path, doc)
        ws = Workspace.load(root)
        assert ws.tiers[0] == ["apple", "mango", "zebra"]
