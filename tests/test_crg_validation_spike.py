"""CRG validation spike — blocking gates for Phase 3 (W-057 §5 + Known unknowns 1-3).

Three gates:
1. Read tools emit no DML (INSERT/UPDATE/DELETE/DROP/CREATE/ALTER)
2. ``serve`` honors CRG_DATA_DIR / CRG_REPO_ROOT for reads
3. Per-agent ``serve`` startup latency measurement

Unit tests (is_dml, tool lists, result structure) run unconditionally.
Integration tests that need a real ``code-review-graph`` installation
are gated by ``requires_crg``.
"""

import shutil

import pytest

import worca.scripts.crg_validation_spike as crg_spike
from worca.scripts.crg_validation_spike import (
    MUTATING_TOOLS,
    READ_TOOLS,
    ValidationResult,
    is_dml,
    validate_env_var_honor,
    validate_read_tools_no_dml,
    measure_serve_startup_latency,
    run_all_gates,
)

requires_crg = pytest.mark.skipif(
    shutil.which("code-review-graph") is None,
    reason="code-review-graph not installed",
)


@pytest.fixture
def crg_not_installed(monkeypatch):
    """Force the skip path regardless of whether CRG is locally installed.

    Without this, the "skip" tests below silently spawn ``code-review-graph
    serve`` on dev machines that happen to have CRG installed, then hang on
    the MCP read until pytest-timeout fires.
    """
    monkeypatch.setattr(crg_spike, "_crg_available", lambda: False)


# ── is_dml classification ──────────────────────────────────────────

class TestIsDml:
    def test_select_is_not_dml(self):
        assert is_dml("SELECT * FROM nodes") is False

    def test_pragma_is_not_dml(self):
        assert is_dml("PRAGMA table_info(nodes)") is False

    def test_explain_is_not_dml(self):
        assert is_dml("EXPLAIN QUERY PLAN SELECT 1") is False

    def test_insert_is_dml(self):
        assert is_dml("INSERT INTO nodes VALUES (1)") is True

    def test_update_is_dml(self):
        assert is_dml("UPDATE nodes SET name='x' WHERE id=1") is True

    def test_delete_is_dml(self):
        assert is_dml("DELETE FROM nodes WHERE id=1") is True

    def test_drop_is_dml(self):
        assert is_dml("DROP TABLE nodes") is True

    def test_create_is_dml(self):
        assert is_dml("CREATE TABLE foo (id INTEGER)") is True

    def test_alter_is_dml(self):
        assert is_dml("ALTER TABLE nodes ADD COLUMN x TEXT") is True

    def test_replace_is_dml(self):
        assert is_dml("REPLACE INTO nodes VALUES (1, 'a')") is True

    def test_case_insensitive(self):
        assert is_dml("insert into nodes values (1)") is True
        assert is_dml("select 1") is False

    def test_leading_whitespace(self):
        assert is_dml("   INSERT INTO nodes VALUES (1)") is True
        assert is_dml("\n  SELECT 1") is False

    def test_attach_is_dml(self):
        assert is_dml("ATTACH DATABASE ':memory:' AS tmp") is True

    def test_begin_is_not_dml(self):
        assert is_dml("BEGIN TRANSACTION") is False

    def test_commit_is_not_dml(self):
        assert is_dml("COMMIT") is False

    def test_with_cte_select_is_not_dml(self):
        assert is_dml("WITH cte AS (SELECT 1) SELECT * FROM cte") is False

    def test_savepoint_is_not_dml(self):
        assert is_dml("SAVEPOINT sp1") is False


# ── Tool list completeness ──────────────────────────────────────────

class TestToolLists:
    def test_read_tools_not_empty(self):
        assert len(READ_TOOLS) >= 8

    def test_mutating_tools_not_empty(self):
        assert len(MUTATING_TOOLS) >= 10

    def test_no_overlap(self):
        overlap = set(READ_TOOLS) & set(MUTATING_TOOLS)
        assert overlap == set(), f"tools in both lists: {overlap}"

    def test_mutating_tools_include_apply_refactor(self):
        assert "apply_refactor_tool" in MUTATING_TOOLS

    def test_mutating_tools_include_build(self):
        assert "build_or_update_graph_tool" in MUTATING_TOOLS

    def test_read_tools_include_get_minimal_context(self):
        assert "get_minimal_context_tool" in READ_TOOLS

    def test_read_tools_include_detect_changes(self):
        assert "detect_changes_tool" in READ_TOOLS


# ── ValidationResult structure ──────────────────────────────────────

class TestValidationResult:
    def test_passed_result(self):
        r = ValidationResult(gate="test", passed=True, details="ok")
        assert r.passed is True
        assert r.fallback is None
        assert r.measurements == {}

    def test_failed_with_fallback(self):
        r = ValidationResult(
            gate="test", passed=False, details="failed",
            fallback="use --disallowedTools",
        )
        assert r.passed is False
        assert r.fallback is not None

    def test_with_measurements(self):
        r = ValidationResult(
            gate="latency", passed=True, details="ok",
            measurements={"mean_ms": 150.0, "p95_ms": 200.0},
        )
        assert r.measurements["mean_ms"] == 150.0


# ── Gate 1: read tools no DML (unit, mocked) ───────────────────────

class TestValidateReadToolsNoDml:
    def test_returns_skip_when_crg_not_importable(self, tmp_path, crg_not_installed):
        db = tmp_path / "graph.db"
        db.touch()
        result = validate_read_tools_no_dml(str(db), str(tmp_path))
        assert result.passed is True
        assert "skip" in result.details.lower() or "not installed" in result.details.lower()

    @requires_crg
    @pytest.mark.timeout(15)
    def test_real_read_tools_emit_no_dml(self, tmp_path):
        """When CRG is installed, build a graph and verify read tools emit no DML."""
        import os
        import subprocess

        repo = tmp_path / "repo"
        repo.mkdir()
        (repo / "example.py").write_text("def hello(): return 42\n")
        subprocess.run(["git", "init"], cwd=str(repo), capture_output=True)
        subprocess.run(["git", "add", "."], cwd=str(repo), capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "init"],
            cwd=str(repo), capture_output=True,
            env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                 "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"},
        )
        data_dir = str(tmp_path / "crg_data")
        subprocess.run(
            ["code-review-graph", "build"],
            env={**os.environ, "CRG_REPO_ROOT": str(repo), "CRG_DATA_DIR": data_dir},
            capture_output=True, timeout=60,
        )
        db_path = os.path.join(data_dir, "graph.db")
        result = validate_read_tools_no_dml(db_path, str(repo))
        assert result.passed is True, f"DML detected: {result.details}"
        assert result.gate == "read_tools_no_dml"


# ── Gate 2: serve honors env vars (unit, mocked) ───────────────────

class TestValidateEnvVarHonor:
    def test_returns_skip_when_crg_not_installed(self, tmp_path, crg_not_installed):
        result = validate_env_var_honor(str(tmp_path), str(tmp_path))
        assert result.passed is True
        assert "skip" in result.details.lower() or "not installed" in result.details.lower()

    @requires_crg
    @pytest.mark.timeout(15)
    def test_serve_reads_from_env_var_location(self, tmp_path):
        """When CRG installed, verify serve reads from CRG_DATA_DIR, not project default."""
        import os
        import subprocess

        repo = tmp_path / "repo"
        repo.mkdir()
        (repo / "example.py").write_text("class Foo:\n    pass\n")
        subprocess.run(["git", "init"], cwd=str(repo), capture_output=True)
        subprocess.run(["git", "add", "."], cwd=str(repo), capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "init"],
            cwd=str(repo), capture_output=True,
            env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                 "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"},
        )
        data_dir = str(tmp_path / "custom_crg_dir")
        subprocess.run(
            ["code-review-graph", "build"],
            env={**os.environ, "CRG_REPO_ROOT": str(repo), "CRG_DATA_DIR": data_dir},
            capture_output=True, timeout=60,
        )
        result = validate_env_var_honor(data_dir, str(repo))
        assert result.passed is True, f"env var not honored: {result.details}"
        assert result.gate == "env_var_honor"


# ── Gate 3: startup latency (unit, mocked) ─────────────────────────

class TestMeasureServeStartupLatency:
    def test_returns_skip_when_crg_not_installed(self, tmp_path, crg_not_installed):
        result = measure_serve_startup_latency(str(tmp_path), str(tmp_path))
        assert result.passed is True
        assert "skip" in result.details.lower() or "not installed" in result.details.lower()

    @requires_crg
    @pytest.mark.timeout(15)
    def test_measures_latency(self, tmp_path):
        """When CRG installed, startup latency should be under 10s (generous threshold)."""
        import os
        import subprocess

        repo = tmp_path / "repo"
        repo.mkdir()
        (repo / "example.py").write_text("x = 1\n")
        subprocess.run(["git", "init"], cwd=str(repo), capture_output=True)
        subprocess.run(["git", "add", "."], cwd=str(repo), capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "init"],
            cwd=str(repo), capture_output=True,
            env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                 "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"},
        )
        data_dir = str(tmp_path / "crg_data")
        subprocess.run(
            ["code-review-graph", "build"],
            env={**os.environ, "CRG_REPO_ROOT": str(repo), "CRG_DATA_DIR": data_dir},
            capture_output=True, timeout=60,
        )
        result = measure_serve_startup_latency(str(repo), data_dir, iterations=3)
        assert result.passed is True, f"latency check failed: {result.details}"
        assert "mean_ms" in result.measurements
        assert result.measurements["mean_ms"] < 10_000


# ── run_all_gates ───────────────────────────────────────────────────

class TestRunAllGates:
    def test_returns_list_of_results(self, tmp_path):
        results = run_all_gates(str(tmp_path), str(tmp_path))
        assert isinstance(results, list)
        assert len(results) == 3
        assert all(isinstance(r, ValidationResult) for r in results)

    def test_all_gates_named(self, tmp_path):
        results = run_all_gates(str(tmp_path), str(tmp_path))
        gates = {r.gate for r in results}
        assert gates == {"read_tools_no_dml", "env_var_honor", "startup_latency"}

    def test_when_crg_missing_all_skip_as_passed(self, tmp_path, crg_not_installed):
        results = run_all_gates(str(tmp_path), str(tmp_path))
        assert all(r.passed for r in results)
