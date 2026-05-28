"""Tests for CRG preflight: base snapshot + run-scoped copy (W-057 §3+§7).

The CRG preflight builds a content-addressed base snapshot under
<cache>/ast/<repo-id>/<commit-sha>/code-review-graph/graph.db, then copies
it into a run-scoped writable dir.  WAL checkpoint before copy ensures a
clean single-file transfer.
"""

import contextlib
import os
import sqlite3
from unittest.mock import MagicMock, patch

import pytest

from worca.utils.ast_cache import ast_snapshot_dir, is_snapshot_complete
from worca.utils.code_review_graph import CrgDetect, EffectiveCrgConfig


def _make_config(
    enabled=True,
    embeddings=False,
    update_on_preflight=True,
    update_on_post_implement=True,
    update_on_guardian_post_commit=True,
    min_repo_files=100,
    version_range=">=2,<3",
    fastmcp_min="3.2.4",
    preflight_timeout_seconds=300,
    freshness="clean_only",
    stage_tools=None,
    reason=None,
):
    return EffectiveCrgConfig(
        enabled=enabled,
        embeddings=embeddings,
        update_on_preflight=update_on_preflight,
        update_on_post_implement=update_on_post_implement,
        update_on_guardian_post_commit=update_on_guardian_post_commit,
        min_repo_files=min_repo_files,
        version_range=version_range,
        fastmcp_min=fastmcp_min,
        preflight_timeout_seconds=preflight_timeout_seconds,
        freshness=freshness,
        stage_tools=stage_tools,
        reason=reason,
    )


def _fake_build(fail=False):
    """subprocess.run stand-in that creates a minimal graph.db in CRG_DATA_DIR."""

    def _run(cmd, cwd=None, env=None, capture_output=True, text=True, timeout=None):
        if fail:
            return MagicMock(returncode=1, stdout="", stderr="build failed")
        data_dir = (env or {}).get("CRG_DATA_DIR")
        if data_dir:
            os.makedirs(data_dir, exist_ok=True)
            db_path = os.path.join(data_dir, "graph.db")
            conn = sqlite3.connect(db_path)
            conn.execute("CREATE TABLE IF NOT EXISTS nodes (id INTEGER PRIMARY KEY)")
            conn.execute("INSERT INTO nodes VALUES (1)")
            conn.commit()
            conn.close()
        return MagicMock(returncode=0, stdout="", stderr="")

    return _run


@contextlib.contextmanager
def _patched(cfg, *, clean=True, sha="deadbeef", rid="repo1", run=None,
             installed=True, compatible=True, fastmcp_ok=True):
    detect = CrgDetect(
        installed=installed,
        version="2.1.0" if installed else None,
        compatible=compatible,
        fastmcp_ok=fastmcp_ok,
        error=None if (installed and compatible and fastmcp_ok) else "not ready",
    )
    run = run if run is not None else _fake_build()
    with (
        patch("worca.scripts.crg_preflight.effective_crg_config", return_value=cfg),
        patch("worca.scripts.crg_preflight.detect_code_review_graph", return_value=detect),
        patch("worca.scripts.crg_preflight.repo_id", return_value=rid),
        patch("worca.scripts.crg_preflight.get_current_git_head", return_value=sha),
        patch("worca.scripts.crg_preflight.is_working_tree_clean", return_value=clean),
        patch("worca.scripts.crg_preflight.subprocess.run", side_effect=run) as mr,
    ):
        yield mr


@pytest.fixture
def cache(tmp_path, monkeypatch):
    root = tmp_path / "cache"
    monkeypatch.setenv("WORCA_CACHE", str(root))
    return str(root)


def _call(tmp_path, run_dir=None):
    from worca.scripts.crg_preflight import run_crg_preflight

    return run_crg_preflight(
        settings_path=str(tmp_path / "s.json"),
        project_root=str(tmp_path),
        run_dir=run_dir or str(tmp_path / "run"),
    )


class TestCrgPreflightGating:
    def test_disabled_returns_skipped(self, tmp_path, cache):
        with _patched(_make_config(enabled=False, reason="global-off")):
            result = _call(tmp_path)
        assert result["status"] == "skipped"
        assert "disabled" in result["reason"]

    def test_degraded_when_not_installed(self, tmp_path, cache):
        with _patched(_make_config(), installed=False, compatible=False, fastmcp_ok=False):
            result = _call(tmp_path)
        assert result["status"] == "degraded"

    def test_degraded_when_fastmcp_not_ok(self, tmp_path, cache):
        with _patched(_make_config(), fastmcp_ok=False):
            result = _call(tmp_path)
        assert result["status"] == "degraded"

    def test_degraded_when_not_a_git_repo(self, tmp_path, cache):
        with _patched(_make_config(), rid="", sha=""):
            result = _call(tmp_path)
        assert result["status"] == "degraded"
        assert result["reason"] == "not_a_git_repo"


class TestCrgPreflightBaseBuild:
    def test_clean_build_publishes_snapshot_and_copies(self, tmp_path, cache):
        run_dir = str(tmp_path / "run")
        with _patched(_make_config(), clean=True) as mr:
            result = _call(tmp_path, run_dir=run_dir)
        assert result["status"] == "ready"
        snap = ast_snapshot_dir("repo1", "deadbeef", cache_dir=cache)
        assert is_snapshot_complete(snap)
        # Build command uses code-review-graph build
        cmd = mr.call_args_list[0][0][0]
        assert cmd == ["code-review-graph", "build"]
        # Env has CRG_REPO_ROOT and CRG_DATA_DIR
        env = mr.call_args_list[0].kwargs["env"]
        assert env["CRG_REPO_ROOT"] == os.path.abspath(str(tmp_path))
        assert env["CRG_DATA_DIR"] == os.path.join(snap, "code-review-graph")
        # Run-scoped copy exists
        run_db = os.path.join(run_dir, "code-review-graph", "graph.db")
        assert os.path.isfile(run_db)
        assert result["crg_data_dir"] == os.path.join(run_dir, "code-review-graph")

    def test_cache_hit_skips_build_copies_to_run(self, tmp_path, cache):
        snap = ast_snapshot_dir("repo1", "deadbeef", cache_dir=cache)
        crg_dir = os.path.join(snap, "code-review-graph")
        os.makedirs(crg_dir, exist_ok=True)
        db_path = os.path.join(crg_dir, "graph.db")
        conn = sqlite3.connect(db_path)
        conn.execute("CREATE TABLE nodes (id INTEGER PRIMARY KEY)")
        conn.commit()
        conn.close()
        from worca.utils.ast_cache import mark_snapshot_complete
        mark_snapshot_complete(snap)

        run_dir = str(tmp_path / "run")
        with _patched(_make_config()) as mr:
            result = _call(tmp_path, run_dir=run_dir)
        assert result["status"] == "ready"
        mr.assert_not_called()
        # Run-scoped copy still created
        assert os.path.isfile(os.path.join(run_dir, "code-review-graph", "graph.db"))

    def test_build_failure_degrades(self, tmp_path, cache):
        with _patched(_make_config(), run=_fake_build(fail=True)):
            result = _call(tmp_path)
        assert result["status"] == "degraded"
        assert "build failed" in result["reason"]

    def test_wal_checkpoint_runs_before_copy(self, tmp_path, cache):
        """After build, PRAGMA wal_checkpoint(TRUNCATE) is called on base DB."""
        original_build = _fake_build()
        def tracking_build(cmd, cwd=None, env=None, capture_output=True, text=True, timeout=None):
            result = original_build(cmd, cwd=cwd, env=env, capture_output=capture_output, text=text, timeout=timeout)
            return result

        run_dir = str(tmp_path / "run")
        with _patched(_make_config(), run=tracking_build):
            with patch("worca.scripts.crg_preflight._wal_checkpoint") as mock_ckpt:
                result = _call(tmp_path, run_dir=run_dir)
        assert result["status"] == "ready"
        mock_ckpt.assert_called_once()
        # The checkpoint path should be the base snapshot DB
        ckpt_path = mock_ckpt.call_args[0][0]
        assert "code-review-graph" in ckpt_path
        assert ckpt_path.endswith("graph.db")


class TestCrgPreflightFreshness:
    def test_dirty_clean_only_builds_run_scoped_directly(self, tmp_path, cache):
        run_dir = str(tmp_path / "run")
        with _patched(_make_config(freshness="clean_only"), clean=False) as mr:
            result = _call(tmp_path, run_dir=run_dir)
        assert result["status"] == "ready"
        snap = ast_snapshot_dir("repo1", "deadbeef", cache_dir=cache)
        assert not is_snapshot_complete(snap)
        # Built directly into run-scoped dir
        env = mr.call_args_list[0].kwargs["env"]
        assert env["CRG_DATA_DIR"] == os.path.join(run_dir, "code-review-graph")
        assert result["crg_data_dir"] == os.path.join(run_dir, "code-review-graph")

    def test_dirty_base_sha_builds_and_publishes(self, tmp_path, cache):
        run_dir = str(tmp_path / "run")
        with _patched(_make_config(freshness="base_sha"), clean=False):
            result = _call(tmp_path, run_dir=run_dir)
        snap = ast_snapshot_dir("repo1", "deadbeef", cache_dir=cache)
        assert result["status"] == "ready"
        assert is_snapshot_complete(snap)


class TestCrgPreflightUpdateFlag:
    def test_no_build_when_update_off_and_no_snapshot(self, tmp_path, cache):
        with _patched(_make_config(update_on_preflight=False)) as mr:
            result = _call(tmp_path)
        assert result["status"] == "skipped"
        assert result["reason"] == "update_on_preflight disabled"
        mr.assert_not_called()

    def test_reads_existing_snapshot_when_update_off(self, tmp_path, cache):
        snap = ast_snapshot_dir("repo1", "deadbeef", cache_dir=cache)
        crg_dir = os.path.join(snap, "code-review-graph")
        os.makedirs(crg_dir, exist_ok=True)
        conn = sqlite3.connect(os.path.join(crg_dir, "graph.db"))
        conn.execute("CREATE TABLE nodes (id INTEGER PRIMARY KEY)")
        conn.commit()
        conn.close()
        from worca.utils.ast_cache import mark_snapshot_complete
        mark_snapshot_complete(snap)

        run_dir = str(tmp_path / "run")
        with _patched(_make_config(update_on_preflight=False)) as mr:
            result = _call(tmp_path, run_dir=run_dir)
        assert result["status"] == "ready"
        mr.assert_not_called()
        assert os.path.isfile(os.path.join(run_dir, "code-review-graph", "graph.db"))


class TestCrgPreflightTimeout:
    def test_uses_config_timeout(self, tmp_path, cache):
        run_dir = str(tmp_path / "run")
        with _patched(_make_config(preflight_timeout_seconds=42)) as mr:
            _call(tmp_path, run_dir=run_dir)
        assert mr.call_args_list[0].kwargs["timeout"] == 42

    def test_timeout_degrades(self, tmp_path, cache):
        import subprocess as _sp

        def _raise(*a, **k):
            raise _sp.TimeoutExpired(cmd="code-review-graph", timeout=1)

        with _patched(_make_config(), run=_raise):
            result = _call(tmp_path)
        assert result["status"] == "degraded"
        assert result["reason"] == "timeout"


class TestCrgPreflightDegraded:
    def test_degraded_when_graph_db_missing_after_build(self, tmp_path, cache):
        """If build succeeds but graph.db isn't produced, degrade."""

        def _empty_build(cmd, cwd=None, env=None, capture_output=True, text=True, timeout=None):
            return MagicMock(returncode=0, stdout="", stderr="")

        with _patched(_make_config(), run=_empty_build):
            result = _call(tmp_path)
        assert result["status"] == "degraded"
        assert "graph.db" in result["reason"]


class TestRunnerCrgIntegration:
    """Tests that runner.run_preflight chains CRG when enabled."""

    def test_runner_chains_crg_after_graphify(self, tmp_path, monkeypatch):
        from worca.orchestrator.runner import run_preflight

        logs_dir = tmp_path / "logs"
        logs_dir.mkdir()

        preflight_script = tmp_path / "preflight.py"
        preflight_script.write_text(
            'import json, sys; print(json.dumps({"status":"pass","checks":[],"summary":"ok"}))'
        )

        monkeypatch.setattr(
            "worca.orchestrator.runner.load_settings",
            lambda *a, **kw: {
                "worca": {
                    "stages": {"preflight": {"script": str(preflight_script)}},
                }
            },
        )
        monkeypatch.setattr(
            "worca.orchestrator.runner.run_graphify_preflight",
            lambda **kw: {"status": "skipped", "reason": "disabled"},
        )
        monkeypatch.setattr(
            "worca.orchestrator.runner.run_crg_preflight",
            lambda **kw: {"status": "ready", "crg_data_dir": "/tmp/run/code-review-graph"},
        )

        context = {"_logs_dir": str(logs_dir)}
        result = run_preflight(context, settings_path="unused")

        assert result.get("crg_status") == "ready"
        assert result.get("crg_data_dir") == "/tmp/run/code-review-graph"

    def test_runner_crg_degraded_does_not_fail_preflight(self, tmp_path, monkeypatch):
        from worca.orchestrator.runner import run_preflight

        logs_dir = tmp_path / "logs"
        logs_dir.mkdir()

        preflight_script = tmp_path / "preflight.py"
        preflight_script.write_text(
            'import json, sys; print(json.dumps({"status":"pass","checks":[],"summary":"ok"}))'
        )

        monkeypatch.setattr(
            "worca.orchestrator.runner.load_settings",
            lambda *a, **kw: {
                "worca": {
                    "stages": {"preflight": {"script": str(preflight_script)}},
                }
            },
        )
        monkeypatch.setattr(
            "worca.orchestrator.runner.run_graphify_preflight",
            lambda **kw: {"status": "skipped", "reason": "disabled"},
        )
        monkeypatch.setattr(
            "worca.orchestrator.runner.run_crg_preflight",
            lambda **kw: {"status": "degraded", "reason": "not installed"},
        )

        context = {"_logs_dir": str(logs_dir)}
        result = run_preflight(context, settings_path="unused")

        assert result["status"] == "pass"
        assert result["crg_status"] == "degraded"
