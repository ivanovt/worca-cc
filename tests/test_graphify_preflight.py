"""Tests for graphify preflight (W-053 per-commit cache layout) + runner wiring.

The preflight resolves a content-addressed snapshot at
<cache>/ast/<repo-id>/<commit-sha>/, building under a lock and publishing a
.complete marker. Freshness controls dirty-tree handling.
"""

import contextlib
import os
from unittest.mock import MagicMock, patch

import pytest

from worca.scripts.graphify_preflight import run_graphify_preflight
from worca.utils.graphify import (
    EffectiveGraphifyConfig,
    GraphifyDetect,
    graphify_report_path,
    graphify_snapshot_dir,
    is_snapshot_complete,
    mark_snapshot_complete,
)


def _make_config(
    enabled=True,
    mode="structural",
    backend=None,
    model_profile=None,
    out_dir="graphify-out",
    update_on_preflight=True,
    update_on_guardian_post_commit=True,
    min_repo_files=100,
    version_range=">=0.8.16,<1",
    preflight_timeout_seconds=300,
    freshness="clean_only",
    reason=None,
):
    return EffectiveGraphifyConfig(
        enabled=enabled,
        mode=mode,
        backend=backend,
        model_profile=model_profile,
        out_dir=out_dir,
        update_on_preflight=update_on_preflight,
        update_on_guardian_post_commit=update_on_guardian_post_commit,
        min_repo_files=min_repo_files,
        version_range=version_range,
        preflight_timeout_seconds=preflight_timeout_seconds,
        freshness=freshness,
        reason=reason,
    )


def _fake_build(report="# Graph Report (mock)\n", fail=False):
    """A subprocess.run stand-in that writes GRAPH_REPORT.md into GRAPHIFY_OUT."""

    def _run(cmd, cwd=None, env=None, capture_output=True, text=True, timeout=None):
        if fail:
            return MagicMock(returncode=1, stdout="", stderr="boom")
        out = (env or {}).get("GRAPHIFY_OUT")
        if out:
            os.makedirs(out, exist_ok=True)
            with open(os.path.join(out, "GRAPH_REPORT.md"), "w") as f:
                f.write(report)
        return MagicMock(returncode=0, stdout="", stderr="")

    return _run


@contextlib.contextmanager
def _patched(cfg, *, clean=True, sha="deadbeef", rid="repo1", run=None,
             installed=True, compatible=True):
    detect = GraphifyDetect(
        installed=installed,
        version="0.8.0" if installed else None,
        compatible=compatible,
        backend_env_present=[],
        error=None if (installed and compatible) else "incompatible",
    )
    run = run if run is not None else _fake_build()
    with (
        patch("worca.scripts.graphify_preflight.effective_graphify_config", return_value=cfg),
        patch("worca.scripts.graphify_preflight.detect_graphify", return_value=detect),
        patch("worca.scripts.graphify_preflight.repo_id", return_value=rid),
        patch("worca.scripts.graphify_preflight.get_current_git_head", return_value=sha),
        patch("worca.scripts.graphify_preflight.is_working_tree_clean", return_value=clean),
        patch("worca.scripts.graphify_preflight.subprocess.run", side_effect=run) as mr,
    ):
        yield mr


@pytest.fixture
def cache(tmp_path, monkeypatch):
    root = tmp_path / "cache"
    monkeypatch.setenv("WORCA_CACHE", str(root))
    return str(root)


def _call(tmp_path):
    return run_graphify_preflight(
        settings_path=str(tmp_path / "s.json"), project_root=str(tmp_path)
    )


class TestPreflightGating:
    def test_disabled_returns_skipped(self, tmp_path, cache):
        with _patched(_make_config(enabled=False, reason="global-off")):
            result = _call(tmp_path)
        assert result["status"] == "skipped"
        assert "disabled" in result["reason"]

    def test_degraded_when_not_installed(self, tmp_path, cache):
        with _patched(_make_config(), installed=False, compatible=False):
            result = _call(tmp_path)
        assert result["status"] == "degraded"

    def test_degraded_when_not_a_git_repo(self, tmp_path, cache):
        with _patched(_make_config(), rid="", sha=""):
            result = _call(tmp_path)
        assert result["status"] == "degraded"
        assert result["reason"] == "not_a_git_repo"


class TestPreflightBuild:
    def test_clean_build_publishes_snapshot(self, tmp_path, cache):
        with _patched(_make_config(), clean=True) as mr:
            result = _call(tmp_path)
        assert result["status"] == "ready"
        snap = graphify_snapshot_dir("repo1", "deadbeef", cache_dir=cache)
        assert result["report_path"] == graphify_report_path(snap)
        assert is_snapshot_complete(snap)
        # built with `graphify update <abs project>`, run FROM the cache dir
        # (cwd == snapshot dir, not the project) so graphify's graphify-out/
        # manifest side-effect can't dirty the project working tree. Output
        # still redirected via GRAPHIFY_OUT.
        cmd = mr.call_args[0][0]
        assert cmd == ["graphify", "update", os.path.abspath(str(tmp_path))]
        assert mr.call_args.kwargs["cwd"] == snap
        assert mr.call_args.kwargs["env"]["GRAPHIFY_OUT"] == os.path.join(snap, "graphify")

    def test_structural_uses_update_command(self, tmp_path, cache):
        with _patched(_make_config(mode="structural")) as mr:
            _call(tmp_path)
        assert mr.call_args[0][0] == ["graphify", "update", os.path.abspath(str(tmp_path))]
        # never runs from the project tree
        assert mr.call_args.kwargs["cwd"] != os.path.abspath(str(tmp_path))

    def test_full_uses_same_update_command(self, tmp_path, cache):
        # Full mode runs the same command; the LLM pass is env/key-driven, not
        # a CLI flag — so the argv is identical to structural.
        with _patched(_make_config(mode="full")) as mr:
            _call(tmp_path)
        assert mr.call_args[0][0] == ["graphify", "update", os.path.abspath(str(tmp_path))]

    def test_cache_hit_skips_build(self, tmp_path, cache):
        snap = graphify_snapshot_dir("repo1", "deadbeef", cache_dir=cache)
        os.makedirs(os.path.join(snap, "graphify"))
        with open(graphify_report_path(snap), "w") as f:
            f.write("# cached")
        mark_snapshot_complete(snap)
        with _patched(_make_config()) as mr:
            result = _call(tmp_path)
        assert result["status"] == "ready"
        assert result["report_path"] == graphify_report_path(snap)
        mr.assert_not_called()

    def test_build_failure_degrades(self, tmp_path, cache):
        with _patched(_make_config(), run=_fake_build(fail=True)):
            result = _call(tmp_path)
        assert result["status"] == "degraded"


class TestPreflightFreshness:
    def test_dirty_clean_only_builds_throwaway(self, tmp_path, cache):
        with _patched(_make_config(freshness="clean_only"), clean=False) as mr:
            result = _call(tmp_path)
        assert result["status"] == "ready"
        snap = graphify_snapshot_dir("repo1", "deadbeef", cache_dir=cache)
        # The real snapshot is NOT published; a ".dirty" throwaway is used.
        assert not is_snapshot_complete(snap)
        assert result["report_path"] == graphify_report_path(snap + ".dirty")
        assert ".dirty" in mr.call_args.kwargs["env"]["GRAPHIFY_OUT"]

    def test_dirty_base_sha_builds_real_snapshot(self, tmp_path, cache):
        with _patched(_make_config(freshness="base_sha"), clean=False):
            result = _call(tmp_path)
        snap = graphify_snapshot_dir("repo1", "deadbeef", cache_dir=cache)
        assert result["status"] == "ready"
        assert is_snapshot_complete(snap)


class TestPreflightUpdateFlag:
    def test_no_build_when_update_off_and_no_snapshot(self, tmp_path, cache):
        with _patched(_make_config(update_on_preflight=False)) as mr:
            result = _call(tmp_path)
        assert result["status"] == "skipped"
        mr.assert_not_called()

    def test_reads_existing_snapshot_when_update_off(self, tmp_path, cache):
        snap = graphify_snapshot_dir("repo1", "deadbeef", cache_dir=cache)
        os.makedirs(os.path.join(snap, "graphify"))
        with open(graphify_report_path(snap), "w") as f:
            f.write("# cached")
        mark_snapshot_complete(snap)
        with _patched(_make_config(update_on_preflight=False)) as mr:
            result = _call(tmp_path)
        assert result["status"] == "ready"
        mr.assert_not_called()


class TestPreflightTimeout:
    def test_uses_config_timeout_when_arg_none(self, tmp_path, cache):
        with _patched(_make_config(preflight_timeout_seconds=42)) as mr:
            _call(tmp_path)
        assert mr.call_args.kwargs["timeout"] == 42

    def test_timeout_degrades(self, tmp_path, cache):
        import subprocess as _sp

        def _raise(*a, **k):
            raise _sp.TimeoutExpired(cmd="graphify", timeout=1)

        with _patched(_make_config(), run=_raise):
            result = _call(tmp_path)
        assert result["status"] == "degraded"
        assert result["reason"] == "timeout"


class TestRunnerGraphifyIntegration:
    """Tests that runner.run_preflight chains graphify when enabled."""

    def test_runner_chains_graphify_after_base_preflight(self, tmp_path, monkeypatch):
        """run_preflight calls run_graphify_preflight after base preflight succeeds."""
        from worca.orchestrator.runner import run_preflight

        logs_dir = tmp_path / "logs"
        logs_dir.mkdir()

        preflight_script = tmp_path / "preflight.py"
        preflight_script.write_text('import json, sys; print(json.dumps({"status":"pass","checks":[],"summary":"ok"}))')

        monkeypatch.setattr(
            "worca.orchestrator.runner.load_settings",
            lambda *a, **kw: {"worca": {"graphify": {"enabled": True}, "stages": {"preflight": {"script": str(preflight_script)}}}},
        )
        monkeypatch.setattr(
            "worca.orchestrator.runner.run_graphify_preflight",
            lambda **kw: {"status": "ready", "report_path": "/tmp/report.md"},
        )

        context = {"_logs_dir": str(logs_dir)}
        result = run_preflight(context, settings_path="unused")

        assert result.get("graphify_status") == "ready"
        assert result.get("graphify_report_path") == "/tmp/report.md"

    def test_runner_skips_graphify_when_disabled(self, tmp_path, monkeypatch):
        """run_preflight does not call graphify preflight when disabled."""
        from worca.orchestrator.runner import run_preflight

        logs_dir = tmp_path / "logs"
        logs_dir.mkdir()

        preflight_script = tmp_path / "preflight.py"
        preflight_script.write_text('import json, sys; print(json.dumps({"status":"pass","checks":[],"summary":"ok"}))')

        monkeypatch.setattr(
            "worca.orchestrator.runner.load_settings",
            lambda *a, **kw: {"worca": {"graphify": {"enabled": False}, "stages": {"preflight": {"script": str(preflight_script)}}}},
        )
        monkeypatch.setattr(
            "worca.orchestrator.runner.run_graphify_preflight",
            lambda **kw: {"status": "skipped", "reason": "disabled"},
        )

        context = {"_logs_dir": str(logs_dir)}
        result = run_preflight(context, settings_path="unused")

        assert result.get("graphify_status") == "skipped"

    def test_runner_graphify_degraded_does_not_fail_preflight(self, tmp_path, monkeypatch):
        """When graphify returns degraded, the overall preflight still passes."""
        from worca.orchestrator.runner import run_preflight

        logs_dir = tmp_path / "logs"
        logs_dir.mkdir()

        preflight_script = tmp_path / "preflight.py"
        preflight_script.write_text('import json, sys; print(json.dumps({"status":"pass","checks":[],"summary":"ok"}))')

        monkeypatch.setattr(
            "worca.orchestrator.runner.load_settings",
            lambda *a, **kw: {"worca": {"graphify": {"enabled": True}, "stages": {"preflight": {"script": str(preflight_script)}}}},
        )
        monkeypatch.setattr(
            "worca.orchestrator.runner.run_graphify_preflight",
            lambda **kw: {"status": "degraded", "reason": "build_failed"},
        )

        context = {"_logs_dir": str(logs_dir)}
        result = run_preflight(context, settings_path="unused")

        assert result["status"] == "pass"
        assert result["graphify_status"] == "degraded"


class _FakePromptBuilder:
    """Minimal stand-in capturing set_graphify_available() calls."""

    def __init__(self):
        self.graphify_available = None

    def set_graphify_available(self, value):
        self.graphify_available = value


class TestGraphifyResumeReattach:
    """F5: resuming past PREFLIGHT re-flags graphify availability and returns
    the GRAPHIFY_OUT dir (the snapshot's ``graphify/`` directory)."""

    def test_reattaches_from_persisted_report_path(self, tmp_path):
        from worca.orchestrator.runner import _reattach_graphify_on_resume

        graphify_dir = tmp_path / "graphify"
        graphify_dir.mkdir()
        report = graphify_dir / "GRAPH_REPORT.md"
        report.write_text("# Graph\nnodes: 5")
        pb = _FakePromptBuilder()

        out = _reattach_graphify_on_resume(
            {"graphify_report_path": str(report)}, pb
        )

        # Returns the graphify/ dir (dirname of the report) → exported as
        # GRAPHIFY_OUT for resumed agents; no report content is read.
        assert out == str(graphify_dir)
        assert pb.graphify_available is True

    def test_noop_when_no_report_path(self):
        from worca.orchestrator.runner import _reattach_graphify_on_resume

        pb = _FakePromptBuilder()
        out = _reattach_graphify_on_resume({}, pb)
        assert out is None
        assert pb.graphify_available is None

    def test_noop_when_report_missing_on_disk(self, tmp_path):
        from worca.orchestrator.runner import _reattach_graphify_on_resume

        pb = _FakePromptBuilder()
        out = _reattach_graphify_on_resume(
            {"graphify_report_path": str(tmp_path / "missing.md")}, pb
        )
        assert out is None
        assert pb.graphify_available is None
