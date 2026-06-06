"""Tests for file access aggregation at complete_iteration."""

import json
import subprocess
from unittest import mock

import pytest

from worca.orchestrator.file_access_aggregation import aggregate_file_access


class TestAggregateFileAccess:
    """Test the aggregation of file access records at iteration completion."""

    def test_aggregates_empty_jsonl(self, tmp_path):
        """Empty JSONL file should produce empty aggregates."""
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        (repo_root / ".git").mkdir()

        access_dir = tmp_path / "access"
        access_dir.mkdir()
        jsonl_file = access_dir / "implement-1.jsonl"
        jsonl_file.write_text("")

        result = aggregate_file_access(str(jsonl_file), str(repo_root))

        assert result["reads"] == {}
        assert result["writes"] == {}
        assert result["searches"] == []
        assert result["totals"]["distinct_read"] == 0
        assert result["totals"]["distinct_write"] == 0

    def test_aggregates_read_records(self, tmp_path):
        """Read operations should be aggregated with counts."""
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        (repo_root / ".git").mkdir()
        (repo_root / "src").mkdir()
        (repo_root / "src" / "main.py").write_text("code")

        access_dir = tmp_path / "access"
        access_dir.mkdir()
        jsonl_file = access_dir / "implement-1.jsonl"

        # Write two read records for the same file
        records = [
            {"op": "read", "tool": "Read", "path": "src/main.py", "ts": "2026-01-01T00:00:00Z"},
            {"op": "read", "tool": "Read", "path": "src/main.py", "ts": "2026-01-01T00:00:01Z"},
        ]
        jsonl_file.write_text("\n".join(json.dumps(r) for r in records))

        result = aggregate_file_access(str(jsonl_file), str(repo_root))

        assert "src/main.py" in result["reads"]
        assert result["reads"]["src/main.py"] == 2
        assert result["totals"]["distinct_read"] == 1
        assert result["totals"]["total_read"] == 2

    def test_aggregates_write_records(self, tmp_path):
        """Write operations should be aggregated with counts."""
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        (repo_root / ".git").mkdir()
        (repo_root / "src").mkdir()
        (repo_root / "src" / "main.py").write_text("code")

        access_dir = tmp_path / "access"
        access_dir.mkdir()
        jsonl_file = access_dir / "implement-1.jsonl"

        # Write records for multiple files
        records = [
            {"op": "write", "tool": "Write", "path": "src/main.py", "ts": "2026-01-01T00:00:00Z"},
            {"op": "write", "tool": "Edit", "path": "src/main.py", "ts": "2026-01-01T00:00:01Z"},
            {"op": "write", "tool": "Write", "path": "src/utils.py", "ts": "2026-01-01T00:00:02Z"},
        ]
        jsonl_file.write_text("\n".join(json.dumps(r) for r in records))

        result = aggregate_file_access(str(jsonl_file), str(repo_root))

        assert result["writes"]["src/main.py"] == 2
        assert result["writes"]["src/utils.py"] == 1
        assert result["totals"]["distinct_write"] == 2
        assert result["totals"]["total_write"] == 3

    def test_aggregates_search_records(self, tmp_path):
        """Search operations should be preserved with metadata."""
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        (repo_root / ".git").mkdir()

        access_dir = tmp_path / "access"
        access_dir.mkdir()
        jsonl_file = access_dir / "implement-1.jsonl"

        records = [
            {
                "op": "search",
                "tool": "Grep",
                "pattern": "def main",
                "scope": "src",
                "result_count": 3,
                "ts": "2026-01-01T00:00:00Z",
            },
            {
                "op": "search",
                "tool": "Glob",
                "pattern": "**/*.py",
                "scope": ".",
                "result_count": 10,
                "ts": "2026-01-01T00:00:01Z",
            },
        ]
        jsonl_file.write_text("\n".join(json.dumps(r) for r in records))

        result = aggregate_file_access(str(jsonl_file), str(repo_root))

        assert len(result["searches"]) == 2
        assert result["searches"][0]["tool"] == "Grep"
        assert result["searches"][0]["pattern"] == "def main"
        assert result["searches"][0]["result_count"] == 3
        assert result["totals"]["grep"] == 1
        assert result["totals"]["glob"] == 1

    def test_aggregates_graph_query_records(self, tmp_path):
        """graph_query records (graphify / CRG) should fold into graph_queries."""
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        (repo_root / ".git").mkdir()

        access_dir = tmp_path / "access"
        access_dir.mkdir()
        jsonl_file = access_dir / "plan-1.jsonl"

        records = [
            {
                "op": "graph_query",
                "engine": "graphify",
                "graph_op": "query",
                "query": "what depends on TaskService?",
                "ts": "2026-01-01T00:00:00Z",
            },
            {
                "op": "graph_query",
                "engine": "crg",
                "graph_op": "get_impact_radius",
                "query": '{"symbol":"TaskService.create"}',
                "ts": "2026-01-01T00:00:01Z",
            },
            # Unknown engine is dropped.
            {
                "op": "graph_query",
                "engine": "bogus",
                "graph_op": "x",
                "query": "y",
                "ts": "2026-01-01T00:00:02Z",
            },
        ]
        jsonl_file.write_text("\n".join(json.dumps(r) for r in records))

        result = aggregate_file_access(str(jsonl_file), str(repo_root))

        assert len(result["graph_queries"]) == 2
        assert result["graph_queries"][0] == {
            "engine": "graphify",
            "op": "query",
            "query": "what depends on TaskService?",
        }
        assert result["graph_queries"][1]["engine"] == "crg"
        assert result["graph_queries"][1]["op"] == "get_impact_radius"

    def test_graph_queries_empty_by_default(self, tmp_path):
        """Runs with no graph queries still expose an empty graph_queries list."""
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        (repo_root / ".git").mkdir()
        result = aggregate_file_access(str(tmp_path / "missing.jsonl"), str(repo_root))
        assert result["graph_queries"] == []

    def test_handles_missing_jsonl_file(self, tmp_path):
        """Missing JSONL file should return empty aggregates without error."""
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        (repo_root / ".git").mkdir()

        nonexistent_file = tmp_path / "nonexistent.jsonl"

        result = aggregate_file_access(str(nonexistent_file), str(repo_root))

        assert result["reads"] == {}
        assert result["writes"] == {}
        assert result["searches"] == []
        assert result["capture"]["oracle"] == "degraded"

    def test_handles_malformed_jsonl_gracefully(self, tmp_path):
        """Malformed JSON lines should be skipped."""
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        (repo_root / ".git").mkdir()

        access_dir = tmp_path / "access"
        access_dir.mkdir()
        jsonl_file = access_dir / "implement-1.jsonl"

        # Write some valid and invalid lines
        content = """{"op": "read", "tool": "Read", "path": "src/main.py"}
invalid json line
{"op": "write", "tool": "Write", "path": "src/utils.py"}
"""
        jsonl_file.write_text(content)

        result = aggregate_file_access(str(jsonl_file), str(repo_root))

        # Should only have the valid records
        assert "src/main.py" in result["reads"]
        assert "src/utils.py" in result["writes"]
        assert result["totals"]["distinct_read"] == 1
        assert result["totals"]["distinct_write"] == 1

    def test_canonicalizes_paths(self, tmp_path):
        """Paths should be canonicalized to repo-relative form."""
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        (repo_root / ".git").mkdir()
        (repo_root / "src").mkdir()
        (repo_root / "src" / "main.py").write_text("code")

        access_dir = tmp_path / "access"
        access_dir.mkdir()
        jsonl_file = access_dir / "implement-1.jsonl"

        # Raw paths that need canonicalization
        records = [
            {"op": "read", "tool": "Read", "path": str(repo_root / "src" / "main.py"), "ts": "2026-01-01T00:00:00Z"},
            {"op": "read", "tool": "Read", "path": "src/main.py", "ts": "2026-01-01T00:00:01Z"},
        ]
        jsonl_file.write_text("\n".join(json.dumps(r) for r in records))

        result = aggregate_file_access(str(jsonl_file), str(repo_root))

        # Both should map to the same canonical path
        assert len(result["reads"]) == 1
        assert "src/main.py" in result["reads"]
        assert result["reads"]["src/main.py"] == 2

    def test_filters_gitignored_writes(self, tmp_path):
        """Gitignored files should be filtered from writes."""
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        (repo_root / ".git").mkdir()
        (repo_root / ".gitignore").write_text("*.pyc\nnode_modules/")

        access_dir = tmp_path / "access"
        access_dir.mkdir()
        jsonl_file = access_dir / "implement-1.jsonl"

        records = [
            {"op": "write", "tool": "Write", "path": "main.pyc", "ts": "2026-01-01T00:00:00Z"},
            {"op": "write", "tool": "Write", "path": "src/main.py", "ts": "2026-01-01T00:00:01Z"},
        ]
        jsonl_file.write_text("\n".join(json.dumps(r) for r in records))

        # Mock git check-ignore to simulate gitignore
        with mock.patch("subprocess.run") as mock_run:
            def check_ignore_side_effect(cmd, **kwargs):
                # Return 0 (ignored) for .pyc files
                if "check-ignore" in cmd:
                    path = cmd[-1]
                    result = mock.Mock()
                    result.returncode = 0 if path.endswith(".pyc") else 1
                    return result
                # Return valid ls-files and status outputs
                result = mock.Mock()
                result.returncode = 0
                result.stdout = ""
                return result

            mock_run.side_effect = check_ignore_side_effect

            result = aggregate_file_access(str(jsonl_file), str(repo_root))

        # Gitignored file should be in capture but not in writes
        assert "src/main.py" in result["writes"]
        assert result["totals"]["distinct_write"] == 1

    def test_computes_root_scoped_searches(self, tmp_path):
        """Root-scoped searches should be counted separately."""
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        (repo_root / ".git").mkdir()

        access_dir = tmp_path / "access"
        access_dir.mkdir()
        jsonl_file = access_dir / "implement-1.jsonl"

        records = [
            {
                "op": "search",
                "tool": "Grep",
                "pattern": "TODO",
                "scope": ".",
                "result_count": 5,
                "ts": "2026-01-01T00:00:00Z",
            },
            {
                "op": "search",
                "tool": "Grep",
                "pattern": "FIXME",
                "scope": "src/api",
                "result_count": 2,
                "ts": "2026-01-01T00:00:01Z",
            },
        ]
        jsonl_file.write_text("\n".join(json.dumps(r) for r in records))

        result = aggregate_file_access(str(jsonl_file), str(repo_root))

        # Root-scoped search should be counted
        assert result["totals"]["root_scoped"] == 1
        assert result["totals"]["grep"] == 2

    def test_returns_degraded_oracle_on_git_failure(self, tmp_path):
        """Git failures should degrade to degraded oracle status."""
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        # No .git directory

        access_dir = tmp_path / "access"
        access_dir.mkdir()
        jsonl_file = access_dir / "implement-1.jsonl"

        records = [
            {"op": "read", "tool": "Read", "path": "src/main.py", "ts": "2026-01-01T00:00:00Z"},
        ]
        jsonl_file.write_text("\n".join(json.dumps(r) for r in records))

        result = aggregate_file_access(str(jsonl_file), str(repo_root))

        # Should have degraded oracle but still return data
        assert result["capture"]["oracle"] == "degraded"
        assert result["reads"]["src/main.py"] == 1  # Fall back to Layer 1 form

    def test_includes_all_required_totals(self, tmp_path):
        """Result should include all required total fields."""
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        (repo_root / ".git").mkdir()

        access_dir = tmp_path / "access"
        access_dir.mkdir()
        jsonl_file = access_dir / "implement-1.jsonl"

        records = [
            {"op": "read", "tool": "Read", "path": "src/main.py", "ts": "2026-01-01T00:00:00Z"},
            {"op": "write", "tool": "Write", "path": "src/utils.py", "ts": "2026-01-01T00:00:01Z"},
            {
                "op": "search",
                "tool": "Grep",
                "pattern": "def",
                "scope": ".",
                "result_count": 0,
                "ts": "2026-01-01T00:00:02Z",
            },
        ]
        jsonl_file.write_text("\n".join(json.dumps(r) for r in records))

        result = aggregate_file_access(str(jsonl_file), str(repo_root))

        # Check all required total fields
        required_totals = [
            "distinct_read", "total_read", "distinct_write", "total_write",
            "grep", "glob", "zero_result", "root_scoped"
        ]
        for field in required_totals:
            assert field in result["totals"], f"Missing total field: {field}"

    def test_captures_hook_and_git_writes(self, tmp_path):
        """Capture dict should track hook writes vs git writes."""
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        (repo_root / ".git").mkdir()
        (repo_root / "src").mkdir()
        (repo_root / "src" / "main.py").write_text("code")

        access_dir = tmp_path / "access"
        access_dir.mkdir()
        jsonl_file = access_dir / "implement-1.jsonl"

        records = [
            {"op": "write", "tool": "Write", "path": "src/main.py", "ts": "2026-01-01T00:00:00Z"},
        ]
        jsonl_file.write_text("\n".join(json.dumps(r) for r in records))

        result = aggregate_file_access(str(jsonl_file), str(repo_root))

        # Capture should track writes
        assert "hook_writes" in result["capture"]
        assert "git_writes" in result["capture"]
        assert isinstance(result["capture"]["hook_writes"], (int, dict))

    def test_handles_search_result_count_edge_cases(self, tmp_path):
        """Zero-result searches should be counted separately."""
        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        (repo_root / ".git").mkdir()

        access_dir = tmp_path / "access"
        access_dir.mkdir()
        jsonl_file = access_dir / "implement-1.jsonl"

        records = [
            {
                "op": "search",
                "tool": "Grep",
                "pattern": "nonexistent",
                "scope": "src",
                "result_count": 0,
                "ts": "2026-01-01T00:00:00Z",
            },
            {
                "op": "search",
                "tool": "Grep",
                "pattern": "found",
                "scope": "src",
                "result_count": 5,
                "ts": "2026-01-01T00:00:01Z",
            },
        ]
        jsonl_file.write_text("\n".join(json.dumps(r) for r in records))

        result = aggregate_file_access(str(jsonl_file), str(repo_root))

        assert result["totals"]["zero_result"] == 1
        assert result["totals"]["grep"] == 2


class TestAggregateIterationFileAccess:
    """Test the convenience wrapper function."""

    def test_convenience_wrapper_computes_path(self, tmp_path):
        """The convenience wrapper should compute the JSONL path and aggregate."""
        from worca.orchestrator.file_access_aggregation import aggregate_iteration_file_access

        repo_root = tmp_path / "repo"
        repo_root.mkdir()
        (repo_root / ".git").mkdir()
        (repo_root / "src").mkdir()
        (repo_root / "src" / "main.py").write_text("code")

        # Create access directory and JSONL file
        access_dir = tmp_path / "repo" / ".worca" / "runs" / "test-run-123" / "access"
        access_dir.mkdir(parents=True)
        jsonl_file = access_dir / "implement-1.jsonl"

        records = [
            {"op": "read", "tool": "Read", "path": "src/main.py", "ts": "2026-01-01T00:00:00Z"},
        ]
        jsonl_file.write_text("\n".join(json.dumps(r) for r in records))

        # Change to repo root so relative paths work
        import os as os_module
        old_cwd = os_module.getcwd()
        try:
            os_module.chdir(str(repo_root))
            result = aggregate_iteration_file_access(
                run_id="test-run-123",
                stage="implement",
                iteration=1,
                repo_root=str(repo_root),
            )
            assert "src/main.py" in result["reads"]
            assert result["reads"]["src/main.py"] == 1
        finally:
            os_module.chdir(old_cwd)

    def test_convenience_wrapper_with_bead_id(self, tmp_path):
        """The convenience wrapper should include bead ID in filename."""
        from worca.orchestrator.file_access_aggregation import get_iteration_jsonl_path

        run_id = "test-run-123"
        stage = "implement"
        iteration = 1
        bead_id = "beads-456"

        path_with_bead = get_iteration_jsonl_path(run_id, stage, iteration, bead_id, ".")
        assert "implement-1-beads-456.jsonl" in path_with_bead

        path_without_bead = get_iteration_jsonl_path(run_id, stage, iteration, None, ".")
        assert "implement-1.jsonl" in path_without_bead
        assert "beads" not in path_without_bead


def _git(root, *args):
    subprocess.run(["git", *args], cwd=str(root), check=True,
                   capture_output=True, timeout=10)


def _init_git_repo(root):
    """Initialize a real git repo at ``root`` (skips the test if git is absent)."""
    try:
        _git(root, "init", "-q")
    except (FileNotFoundError, subprocess.SubprocessError):
        pytest.skip("git not available")
    _git(root, "config", "user.email", "t@t.dev")
    _git(root, "config", "user.name", "t")


class TestLeakageIsCumulative:
    """Leakage must compare git's cumulative uncommitted set against the run's
    *cumulative* hook-write union, not a single stage's writes.

    Regression: worca commits only once (guardian, at run end), so git status
    accumulates writes across every stage. Comparing one stage's hook log against
    that growing tree made leakage climb mechanically toward 100% — e.g. a review
    stage that writes nothing scored 100% against the implementers' uncommitted
    files. The hook side is now unioned across all access fragments on disk.

    The setup commits files then modifies them so git status lists each path
    individually (`` M src/a.py``) — mirroring real runs, where the implementers
    edit existing tracked files. (`git status --porcelain` collapses an
    *entirely* untracked directory to ``src/``, which is a different case.) The
    access fragments live outside the repo so the run-state dir never pollutes
    git status.
    """

    def _write_fragment(self, access_dir, name, write_paths):
        records = [
            {"op": "write", "tool": "Edit", "path": p, "ts": "2026-01-01T00:00:00Z"}
            for p in write_paths
        ]
        (access_dir / name).write_text("\n".join(json.dumps(r) for r in records))

    def _repo_with_committed_files(self, tmp_path, names):
        repo_root = tmp_path / "repo"
        (repo_root / "src").mkdir(parents=True)
        _init_git_repo(repo_root)
        for n in names:
            (repo_root / "src" / n).write_text("orig")
        _git(repo_root, "add", "-A")
        _git(repo_root, "commit", "-qm", "init")
        # Modify each so it appears as a tracked change in git status.
        for n in names:
            (repo_root / "src" / n).write_text("changed")
        return repo_root

    def test_review_stage_does_not_score_100pct_against_prior_writes(self, tmp_path):
        repo_root = self._repo_with_committed_files(tmp_path, ["a.py", "b.py"])
        access_dir = tmp_path / "access"
        access_dir.mkdir()
        # Implement stage recorded both writes; review stage wrote nothing.
        self._write_fragment(access_dir, "implement-1.jsonl", ["src/a.py", "src/b.py"])
        self._write_fragment(access_dir, "review-1.jsonl", [])

        result = aggregate_file_access(str(access_dir / "review-1.jsonl"), str(repo_root))
        capture = result["capture"]

        assert capture["oracle"] == "ok"
        # Cumulative hook union covers both files git reports → no leak.
        assert capture["leakage_pct"] == 0.0
        assert capture["hook_writes"] == 2
        assert capture["git_writes"] == 2

    def test_genuine_untracked_write_still_counts_as_leak(self, tmp_path):
        repo_root = self._repo_with_committed_files(tmp_path, ["a.py", "b.py", "c.py"])
        access_dir = tmp_path / "access"
        access_dir.mkdir()
        # c.py changed on disk but no hook recorded it.
        self._write_fragment(access_dir, "implement-1.jsonl", ["src/a.py", "src/b.py"])

        result = aggregate_file_access(str(access_dir / "implement-1.jsonl"), str(repo_root))
        capture = result["capture"]

        assert capture["oracle"] == "ok"
        # c.py landed in the tree but no hook recorded it → 1 of 3 leaks.
        assert capture["leakage_pct"] == pytest.approx(33.33, abs=0.01)

    def test_hook_union_canonicalizes_absolute_paths_across_fragments(self, tmp_path):
        """Absolute paths (as the recorder emits) canonicalize and union correctly."""
        repo_root = self._repo_with_committed_files(tmp_path, ["a.py"])
        access_dir = tmp_path / "access"
        access_dir.mkdir()
        abs_path = str(repo_root / "src" / "a.py")
        self._write_fragment(access_dir, "implement-1.jsonl", [abs_path])
        self._write_fragment(access_dir, "review-1.jsonl", [])

        result = aggregate_file_access(str(access_dir / "review-1.jsonl"), str(repo_root))
        capture = result["capture"]

        assert capture["oracle"] == "ok"
        assert capture["leakage_pct"] == 0.0
        assert capture["hook_writes"] == 1
