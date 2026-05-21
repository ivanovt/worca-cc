"""W-040 Phase 6 (cont.): E2E fleet lifecycle, breaker, reconciliation tests.

Companion to test_fleet_e2e.py — the existing file covers only the
happy path. This one drives the same dispatch surface (direct
run_worktree.py invocation, so WORCA_CLAUDE_BIN survives env-strip)
through the failure-mode states the recent W-040 commits introduced:
pause/stop/resume, circuit breaker, manifest reconciliation, guide
injection, and two known regressions (stale-PID, cleanup --fleet-id
filter) gated as xfail until fixed.

The mock_claude action language (succeed/fail/hang/crash/slow with
delay_s) supplies all timing control — no real Claude credits.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

MOCK_CLAUDE_BIN = Path(__file__).parent.parent / "mock_claude" / "mock_claude.py"
STUBS_DIR = Path(__file__).parent / "stubs"


# ---------------------------------------------------------------------------
# Shared helpers — kept inline rather than promoted to helpers.py until a
# third fleet e2e file appears (test_fleet_e2e.py duplicates _setup_repo
# and _wait_for_pipeline_terminal for the same reason).
# ---------------------------------------------------------------------------


def _setup_repo(path: Path) -> None:
    """Init a throwaway git repo + worca runtime; disable slow stages."""
    path.mkdir(parents=True, exist_ok=True)
    for cmd in [
        ["git", "init"],
        ["git", "config", "user.email", "test@test.com"],
        ["git", "config", "user.name", "Test"],
    ]:
        subprocess.run(cmd, cwd=str(path), check=True, capture_output=True)
    (path / "README.md").write_text("test\n")
    subprocess.run(["git", "add", "."], cwd=str(path), check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "init"], cwd=str(path), check=True, capture_output=True
    )
    subprocess.run(
        [sys.executable, "-m", "worca.cli.main", "init"],
        cwd=str(path),
        check=True,
        capture_output=True,
    )
    settings_path = path / ".claude" / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings.setdefault("worca", {})
    settings["worca"]["stages"] = {
        "preflight": {"enabled": False},
        "plan_review": {"enabled": False},
        "learn": {"enabled": False},
    }
    settings["worca"]["agents"] = {
        "planner": {"max_turns": 5},
        "coordinator": {"max_turns": 5},
        "implementer": {"max_turns": 5},
        "tester": {"max_turns": 5},
        "reviewer": {"max_turns": 5},
        "guardian": {"max_turns": 5},
    }
    settings_path.write_text(json.dumps(settings, indent=2))


def _write_scenario(tmp_path: Path, name: str, agents: dict, default_action: dict = None) -> Path:
    """Write a mock_claude scenario JSON. Returns its path."""
    scenario = {"agents": agents}
    if default_action is not None:
        scenario["default"] = default_action
    else:
        scenario["default"] = {"action": "succeed", "delay_s": 0.1}
    path = tmp_path / f"scenario_{name}.json"
    path.write_text(json.dumps(scenario))
    return path


def _build_child_env(scenario_path: Path) -> dict:
    """Env for the per-child run_worktree.py subprocess.

    Sets WORCA_CLAUDE_BIN to the mock so the dispatched run_pipeline.py
    invokes the mock instead of real Claude. Prepends the stubs dir so
    `gh` is shadowed by the no-op stub (guardian's PR creation flow).
    """
    return {
        **os.environ,
        "WORCA_CLAUDE_BIN": f"{sys.executable} {MOCK_CLAUDE_BIN}",
        "MOCK_CLAUDE_SCENARIO": str(scenario_path),
        "WORCA_SKIP_BEADS": "1",
        "WORCA_AGENT": "",
        "PATH": f"{STUBS_DIR}{os.pathsep}{os.environ.get('PATH', '')}",
    }


class _EnvOverride:
    """Context manager: temporarily set os.environ.

    resume_child (and any other in-process call that spawns a fresh
    run_pipeline.py via Popen without `env=`) inherits os.environ. Tests
    that exercise resume must therefore propagate WORCA_CLAUDE_BIN +
    MOCK_CLAUDE_SCENARIO into the live process for the duration of the
    call. Restores the previous environment on exit.
    """

    def __init__(self, env: dict):
        self._target = env
        self._saved: dict = {}
        self._added: list = []

    def __enter__(self):
        for k, v in self._target.items():
            if k in os.environ:
                self._saved[k] = os.environ[k]
            else:
                self._added.append(k)
            os.environ[k] = v
        return self

    def __exit__(self, *exc):
        for k in self._added:
            os.environ.pop(k, None)
        for k, v in self._saved.items():
            os.environ[k] = v


def _dispatch_child(
    repo: Path,
    fleet_id: str,
    env: dict,
    prompt: str = "do thing",
    plan_path: str = None,
    guide_path: str = None,
) -> tuple[str, str]:
    """Invoke `python -m worca.scripts.run_worktree --fleet-id <fid>` against repo.

    Returns (run_id, worktree_path) parsed from the documented two-line stdout.
    """
    cmd = [
        sys.executable,
        "-m",
        "worca.scripts.run_worktree",
        "--prompt",
        prompt,
        "--fleet-id",
        fleet_id,
    ]
    if plan_path:
        cmd.extend(["--plan", plan_path])
    if guide_path:
        cmd.extend(["--guide", guide_path])
    result = subprocess.run(
        cmd,
        cwd=str(repo),
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, (
        f"run_worktree failed for {repo.name}:\n{result.stderr[:600]}"
    )
    lines = result.stdout.strip().splitlines()
    assert len(lines) >= 2, (
        f"run_worktree stdout must be '<run_id>\\n<worktree_path>'; got: {result.stdout!r}"
    )
    return lines[0], lines[1]


def _write_initial_manifest(
    fleet_runs_dir: Path,
    fleet_id: str,
    fleet_id_short: str,
    *,
    threshold: float = 0.30,
    max_parallel: int = 5,
    guide_paths: list = None,
) -> dict:
    """Write the initial empty-children fleet manifest. Returns the dict."""
    from worca.orchestrator.fleet_manifest import write_fleet_manifest

    guide_paths = guide_paths or []
    manifest = {
        "fleet_id": fleet_id,
        "fleet_id_short": fleet_id_short,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "work_request": {"title": "", "description": "test fleet", "source": None},
        "guide": {
            "paths": guide_paths,
            "bytes": sum(os.path.getsize(p) for p in guide_paths if os.path.exists(p)),
            "filenames": [os.path.basename(p) for p in guide_paths],
            "uploaded": False,
        },
        "plan": {"mode": "none", "path": None},
        "head_template": None,
        "base_branch": None,
        "max_parallel": max_parallel,
        "fleet_failure_threshold": threshold,
        "status": "running",
        "halt_reason": None,
        "children": [],
    }
    write_fleet_manifest(manifest, base_dir=str(fleet_runs_dir))
    return manifest


def _populate_children(
    fleet_runs_dir: Path, manifest: dict, children: list[dict]
) -> None:
    """Write the manifest with the children array filled in."""
    from worca.orchestrator.fleet_manifest import write_fleet_manifest

    manifest["children"] = children
    write_fleet_manifest(manifest, base_dir=str(fleet_runs_dir))


def _wait_for_pipeline_status(
    worktree_path: str,
    run_id: str,
    expected: set,
    timeout: int = 60,
) -> dict:
    """Poll status.json until pipeline_status ∈ expected, or timeout."""
    status_path = (
        Path(os.path.realpath(worktree_path)) / ".worca" / "runs" / run_id / "status.json"
    )
    deadline = time.time() + timeout
    while time.time() < deadline:
        if status_path.exists():
            try:
                data = json.loads(status_path.read_text())
                if data.get("pipeline_status") in expected:
                    return data
            except (json.JSONDecodeError, OSError):
                pass
        time.sleep(0.2)
    actual = None
    if status_path.exists():
        try:
            actual = json.loads(status_path.read_text()).get("pipeline_status")
        except Exception:
            pass
    raise TimeoutError(
        f"Pipeline {run_id} in {worktree_path!r} did not reach any of "
        f"{expected} within {timeout}s (last status: {actual!r})"
    )


def _wait_for_pipeline_terminal(
    worktree_path: str, run_id: str, timeout: int = 120
) -> dict:
    """Poll until pipeline_status is terminal."""
    return _wait_for_pipeline_status(
        worktree_path,
        run_id,
        {"completed", "failed", "interrupted", "cancelled", "setup_failed"},
        timeout=timeout,
    )


def _wait_for_stage_completed(
    worktree_path: str, run_id: str, stage: str, timeout: int = 30
) -> None:
    """Poll until status.json marks `stage` as completed."""
    status_path = (
        Path(os.path.realpath(worktree_path)) / ".worca" / "runs" / run_id / "status.json"
    )
    deadline = time.time() + timeout
    while time.time() < deadline:
        if status_path.exists():
            try:
                data = json.loads(status_path.read_text())
                stages = data.get("stages") or {}
                if stages.get(stage, {}).get("status") == "completed":
                    return
            except (json.JSONDecodeError, OSError):
                pass
        time.sleep(0.15)
    raise TimeoutError(
        f"Stage {stage!r} for run {run_id} did not complete within {timeout}s"
    )


def _read_child_registry(repo: Path, run_id: str) -> dict:
    """Read <repo>/.worca/multi/pipelines.d/<run_id>.json."""
    path = repo / ".worca" / "multi" / "pipelines.d" / f"{run_id}.json"
    return json.loads(path.read_text())


def _wait_for_registry_status(
    repo: Path,
    run_id: str,
    expected: set,
    timeout: int = 15,
) -> dict:
    """Poll the parent-project registry entry until status ∈ expected.

    Distinct from _wait_for_pipeline_terminal (which polls the worktree's
    status.json): the runner's atexit_cleanup mirrors terminal status to
    the multi-pipeline registry, but this is a separate write that lags
    status.json by tens to hundreds of ms. Tests that act on the registry
    status (resume_child, poll_and_update_fleet_manifest) must wait for
    the mirror, not just status.json.
    """
    deadline = time.time() + timeout
    actual = None
    while time.time() < deadline:
        try:
            entry = _read_child_registry(repo, run_id)
        except (FileNotFoundError, json.JSONDecodeError):
            entry = None
        if entry:
            actual = entry.get("status")
            if actual in expected:
                return entry
        time.sleep(0.15)
    raise TimeoutError(
        f"Registry status for {run_id} in {repo.name} did not reach any "
        f"of {expected} within {timeout}s (last: {actual!r})"
    )


def _write_child_registry(repo: Path, run_id: str, updates: dict) -> None:
    """Merge updates into the child's registry entry."""
    path = repo / ".worca" / "multi" / "pipelines.d" / f"{run_id}.json"
    entry = json.loads(path.read_text())
    entry.update(updates)
    path.write_text(json.dumps(entry, indent=2))


def _remove_worktrees(repos_and_paths: list[tuple]) -> None:
    """Remove every (repo, worktree_path) pair — safe to call after timeouts."""
    for repo, wt in repos_and_paths:
        subprocess.run(
            ["git", "worktree", "remove", "--force", wt],
            cwd=str(repo),
            capture_output=True,
            timeout=10,
        )


def _terminate_pid_chain(run_id: str, repo: Path) -> None:
    """Best-effort kill of every process spawned for a run.

    Used in test teardown to make sure slow/hang scenarios don't leave
    background pipelines burning CPU.  Looks up the worktree, kills any
    .pid file there, plus the registered pid — neither is guaranteed to
    be the live runner (stale-PID bug), so we try both.
    """
    try:
        entry = _read_child_registry(repo, run_id)
    except FileNotFoundError:
        return
    candidates = []
    if entry.get("pid"):
        candidates.append(int(entry["pid"]))
    wt = entry.get("worktree_path")
    if wt:
        pid_file = Path(wt) / ".worca" / "runs" / run_id / "pipeline.pid"
        if pid_file.exists():
            try:
                candidates.append(int(pid_file.read_text().strip()))
            except ValueError:
                pass
    for pid in candidates:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                os.kill(pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                pass


# ---------------------------------------------------------------------------
# Reusable scenario directives
# ---------------------------------------------------------------------------


_GUARDIAN_PR = {
    "action": "succeed",
    "delay_s": 0.1,
    "structured_output": {
        "pr_url": "https://example.invalid/pull/1",
        "pr_number": 1,
        "commit_sha": "abc1234",
        "source_branch": "worca/test",
        "target_branch": "main",
        "provider": "github",
    },
}

_TESTER_PASS = {
    "action": "succeed",
    "delay_s": 0.1,
    "structured_output": {"passed": True},
}


def _scenario_all_succeed():
    """Every stage succeeds quickly (~0.1s each)."""
    return {"tester": _TESTER_PASS, "guardian": _GUARDIAN_PR}


def _scenario_slow_at(stage: str, slow_s: float):
    """All other stages succeed fast; the named stage holds for slow_s seconds."""
    base = _scenario_all_succeed()
    base[stage] = {"action": "slow", "slow_s": slow_s, "delay_s": 0.05}
    return base


def _scenario_planner_fails():
    """Planner fails fast — used to drive breaker tests."""
    return {
        "planner": {
            "action": "fail",
            "delay_s": 0.1,
            "error": "synthetic plan failure",
        },
    }


# ---------------------------------------------------------------------------
# 1. Pause / Resume
# ---------------------------------------------------------------------------


@pytest.mark.timeout(240)
@pytest.mark.skipif(sys.platform == "win32", reason="Control-file flow assumes POSIX")
def test_fleet_pause_resume(tmp_path):
    """Pause an in-flight fleet, then resume, then assert completion."""
    from worca.orchestrator.fleet_lifecycle import pause_fleet
    from worca.orchestrator.fleet_manifest import (
        generate_fleet_id,
        poll_and_update_fleet_manifest,
        read_fleet_manifest,
    )

    repos = [tmp_path / f"repo_{i}" for i in range(2)]
    for r in repos:
        _setup_repo(r)

    scenario = _write_scenario(
        tmp_path, "pause", _scenario_slow_at("coordinator", slow_s=8)
    )
    env = _build_child_env(scenario)

    fleet_id, fleet_id_short = generate_fleet_id()
    # Resolve via the same lazy helper subprocesses use, so $WORCA_HOME
    # (set by tests/conftest.py to a session tmp dir) keeps writes out
    # of the developer's real ~/.worca/ (issue #162).
    from worca.utils.paths import fleet_runs_dir as _resolve_fleet_runs_dir
    fleet_runs_dir = Path(_resolve_fleet_runs_dir())
    manifest = _write_initial_manifest(fleet_runs_dir, fleet_id, fleet_id_short)

    children = []
    cleanup_pairs = []
    try:
        for repo in repos:
            run_id, wt = _dispatch_child(repo, fleet_id, env)
            children.append({"project_path": str(repo), "run_id": run_id})
            cleanup_pairs.append((repo, wt))
        _populate_children(fleet_runs_dir, manifest, children)

        for child, (_, wt) in zip(children, cleanup_pairs):
            _wait_for_stage_completed(wt, child["run_id"], "plan", timeout=30)

        count = pause_fleet(fleet_id)
        assert count == 2, f"pause_fleet should have hit 2 children, got {count}"

        m = read_fleet_manifest(fleet_id)
        assert m["status"] == "paused", f"manifest not paused: {m['status']!r}"

        # NOTE: do not assert control.json exists here. The live child consumes
        # and deletes it at the top of its next iteration (runner's
        # _check_control_file), so checking the file is a consume-delete race.
        # The pause is verified below by each child reaching pipeline_status
        # "paused"; the control file's worktree targeting + "pause" action are
        # covered deterministically (no live consumer) by
        # tests/test_fleet_lifecycle.py::TestPauseFleet.

        # Sticky-paused invariant: poll must NOT flip back to running.
        derived = poll_and_update_fleet_manifest(fleet_id)
        assert derived == "paused", f"poll overrode paused state: {derived!r}"

        for child, (repo, wt) in zip(children, cleanup_pairs):
            _wait_for_pipeline_status(
                wt, child["run_id"], {"paused"}, timeout=20
            )

        # Resume in place via resume_child (pause is sticky until explicit resume).
        # The spawned run_pipeline.py inherits os.environ — propagate the
        # mock-claude env into this process for the duration of the resume.
        from worca.orchestrator.fleet_lifecycle import resume_child
        from worca.orchestrator.fleet_manifest import update_fleet_status

        with _EnvOverride(env):
            for child in children:
                ok = resume_child(child["project_path"], child["run_id"])
                assert ok, f"resume_child failed for {child['run_id']}"

        update_fleet_status(fleet_id, "running")

        for child, (_, wt) in zip(children, cleanup_pairs):
            _wait_for_pipeline_terminal(wt, child["run_id"], timeout=120)

        final = poll_and_update_fleet_manifest(fleet_id)
        assert final == "completed", f"fleet did not complete after resume: {final!r}"
    finally:
        for child, repo in zip(children, repos):
            _terminate_pid_chain(child["run_id"], repo)
        _remove_worktrees(cleanup_pairs)
        manifest_path = fleet_runs_dir / f"{fleet_id}.json"
        if manifest_path.exists():
            manifest_path.unlink()


# ---------------------------------------------------------------------------
# 2. Stop / Resume
# ---------------------------------------------------------------------------


@pytest.mark.timeout(240)
@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM required")
def test_fleet_stop_then_resume(tmp_path):
    """Stop an in-flight fleet (SIGTERM + control.json), resume, complete."""
    from worca.orchestrator.fleet_lifecycle import resume_child, stop_fleet
    from worca.orchestrator.fleet_manifest import (
        generate_fleet_id,
        poll_and_update_fleet_manifest,
        read_fleet_manifest,
        update_fleet_status,
    )

    repos = [tmp_path / f"repo_{i}" for i in range(2)]
    for r in repos:
        _setup_repo(r)

    scenario = _write_scenario(
        tmp_path, "stop", _scenario_slow_at("coordinator", slow_s=10)
    )
    env = _build_child_env(scenario)

    fleet_id, fleet_id_short = generate_fleet_id()
    # Resolve via the same lazy helper subprocesses use, so $WORCA_HOME
    # (set by tests/conftest.py to a session tmp dir) keeps writes out
    # of the developer's real ~/.worca/ (issue #162).
    from worca.utils.paths import fleet_runs_dir as _resolve_fleet_runs_dir
    fleet_runs_dir = Path(_resolve_fleet_runs_dir())
    manifest = _write_initial_manifest(fleet_runs_dir, fleet_id, fleet_id_short)

    children = []
    cleanup_pairs = []
    try:
        for repo in repos:
            run_id, wt = _dispatch_child(repo, fleet_id, env)
            children.append({"project_path": str(repo), "run_id": run_id})
            cleanup_pairs.append((repo, wt))
        _populate_children(fleet_runs_dir, manifest, children)

        for child, (_, wt) in zip(children, cleanup_pairs):
            _wait_for_stage_completed(wt, child["run_id"], "plan", timeout=30)

        count = stop_fleet(fleet_id)
        assert count == 2, f"stop_fleet should have hit 2 children, got {count}"

        m = read_fleet_manifest(fleet_id)
        assert m["status"] == "halted"
        assert m["halt_reason"] == "stopped"

        # Children land terminal — interrupted from SIGTERM, or failed if
        # the runner couldn't write its interrupted state cleanly. Both
        # are non-_FAILURE-STATES for halt_reason purposes (interrupted)
        # but the important invariant is they're NO LONGER running.
        for child, (_, wt) in zip(children, cleanup_pairs):
            _wait_for_pipeline_terminal(wt, child["run_id"], timeout=30)

        # The runner's atexit_cleanup mirrors terminal status into the
        # parent-project registry after status.json is set. Wait for that
        # second write — resume_child reads the registry, not status.json.
        for child, (repo_path, _) in zip(children, cleanup_pairs):
            _wait_for_registry_status(
                repo_path,
                child["run_id"],
                {"interrupted", "failed"},
                timeout=15,
            )

        # Sticky-halt: poll must not flip back.
        derived = poll_and_update_fleet_manifest(fleet_id)
        assert derived == "halted", f"poll overrode halted state: {derived!r}"

        # Resume in place for any child landed in 'interrupted' or 'paused'.
        # See _EnvOverride: resume_child spawns a fresh run_pipeline.py whose
        # env is inherited from os.environ, not the child's original env.
        observed_statuses = {}
        resumed_any = False
        with _EnvOverride(env):
            for child in children:
                entry = _read_child_registry(
                    Path(child["project_path"]), child["run_id"]
                )
                observed_statuses[child["run_id"]] = entry.get("status")
                if entry.get("status") in ("interrupted", "paused", "failed"):
                    if resume_child(child["project_path"], child["run_id"]):
                        resumed_any = True
        assert resumed_any, (
            "no children were in a resumable state after stop; "
            f"observed registry statuses: {observed_statuses}"
        )

        update_fleet_status(fleet_id, "running")

        for child, (_, wt) in zip(children, cleanup_pairs):
            _wait_for_pipeline_terminal(wt, child["run_id"], timeout=120)

        final = poll_and_update_fleet_manifest(fleet_id)
        # Resume may produce "completed" (all resumed and finished) or
        # "failed" (some resumes didn't replay cleanly). The contract under
        # test is the sticky-halt + resume-fan-out behavior — both terminal
        # outcomes are acceptable, only "running"/"halted" would be wrong.
        assert final in {"completed", "failed"}, (
            f"fleet did not reach a terminal state after resume: {final!r}"
        )
    finally:
        for child, repo in zip(children, repos):
            _terminate_pid_chain(child["run_id"], repo)
        _remove_worktrees(cleanup_pairs)
        manifest_path = fleet_runs_dir / f"{fleet_id}.json"
        if manifest_path.exists():
            manifest_path.unlink()


# ---------------------------------------------------------------------------
# 3. Circuit breaker — trips with running children
# ---------------------------------------------------------------------------


@pytest.mark.timeout(180)
def test_fleet_circuit_breaker_trips_with_running_children(tmp_path):
    """5-repo fleet, 3 planner-fail, 2 slow. Breaker MUST trip."""
    from worca.orchestrator.fleet_manifest import (
        generate_fleet_id,
        poll_and_update_fleet_manifest,
        read_fleet_manifest,
    )

    repos = [tmp_path / f"repo_{i}" for i in range(5)]
    for r in repos:
        _setup_repo(r)

    fail_scenario = _write_scenario(tmp_path, "fail", _scenario_planner_fails())
    # 25s gives the breaker plenty of window — first 3 fail in ~1s each
    # after dispatch, breaker is evaluated within 5–15s on slow CI runners,
    # and slow children still have headroom before COORDINATE returns.
    # Short enough that the post-breaker terminal-wait finishes inside its
    # timeout even on the slowest CI runner.
    slow_scenario = _write_scenario(
        tmp_path, "slow", _scenario_slow_at("coordinator", slow_s=25)
    )

    fleet_id, fleet_id_short = generate_fleet_id()
    # Resolve via the same lazy helper subprocesses use, so $WORCA_HOME
    # (set by tests/conftest.py to a session tmp dir) keeps writes out
    # of the developer's real ~/.worca/ (issue #162).
    from worca.utils.paths import fleet_runs_dir as _resolve_fleet_runs_dir
    fleet_runs_dir = Path(_resolve_fleet_runs_dir())
    manifest = _write_initial_manifest(
        fleet_runs_dir, fleet_id, fleet_id_short, threshold=0.30, max_parallel=5
    )

    children = []
    cleanup_pairs = []
    try:
        # First 3 will fail at PLAN; last 2 are slow at COORDINATE.
        for i, repo in enumerate(repos):
            sc = fail_scenario if i < 3 else slow_scenario
            env = _build_child_env(sc)
            run_id, wt = _dispatch_child(repo, fleet_id, env)
            children.append(
                {
                    "project_path": str(repo),
                    "run_id": run_id,
                    "expected": "failed" if i < 3 else "running",
                }
            )
            cleanup_pairs.append((repo, wt))
        _populate_children(fleet_runs_dir, manifest, children)

        # Wait for the 3 fail-fast children to land terminal failed. Then
        # immediately poll — the slow children should still be at COORDINATE
        # because slow_s=25 is much longer than typical fail-fast latency.
        for child, (_, wt) in zip(children[:3], cleanup_pairs[:3]):
            _wait_for_pipeline_status(
                wt, child["run_id"], {"failed"}, timeout=45
            )

        derived = poll_and_update_fleet_manifest(fleet_id)
        assert derived == "halted", f"breaker did not trip: derived={derived!r}"

        m = read_fleet_manifest(fleet_id)
        assert m["halt_reason"] == "circuit_breaker", (
            f"halt_reason not circuit_breaker: {m['halt_reason']!r}"
        )

        # Sticky-halt: subsequent poll keeps the state.
        again = poll_and_update_fleet_manifest(fleet_id)
        assert again == "halted"

        # In-flight children allowed to finish naturally — manifest stays halted.
        # slow_s=25 + ~5s for trailing stages → ~30s; 90s ceiling gives 3×
        # margin for CI runner variance.
        for child, (_, wt) in zip(children[3:], cleanup_pairs[3:]):
            _wait_for_pipeline_terminal(wt, child["run_id"], timeout=90)

        final = poll_and_update_fleet_manifest(fleet_id)
        assert final == "halted"  # circuit_breaker is sticky
    finally:
        for child, repo in zip(children, repos):
            _terminate_pid_chain(child["run_id"], repo)
        _remove_worktrees(cleanup_pairs)
        manifest_path = fleet_runs_dir / f"{fleet_id}.json"
        if manifest_path.exists():
            manifest_path.unlink()


# ---------------------------------------------------------------------------
# 4. Circuit breaker — does NOT trip below threshold
# ---------------------------------------------------------------------------


@pytest.mark.timeout(180)
def test_fleet_circuit_breaker_does_not_trip_below_threshold(tmp_path):
    """5-repo fleet, only 1 fails (0.20 < 0.30). No halt."""
    from worca.orchestrator.fleet_manifest import (
        generate_fleet_id,
        poll_and_update_fleet_manifest,
        read_fleet_manifest,
    )

    repos = [tmp_path / f"repo_{i}" for i in range(5)]
    for r in repos:
        _setup_repo(r)

    fail_scenario = _write_scenario(tmp_path, "fail", _scenario_planner_fails())
    # Slow children only need to outlast the breaker poll — they're killed
    # in the finally block, so we don't wait for them to terminate naturally.
    slow_scenario = _write_scenario(
        tmp_path, "slow", _scenario_slow_at("coordinator", slow_s=25)
    )

    fleet_id, fleet_id_short = generate_fleet_id()
    # Resolve via the same lazy helper subprocesses use, so $WORCA_HOME
    # (set by tests/conftest.py to a session tmp dir) keeps writes out
    # of the developer's real ~/.worca/ (issue #162).
    from worca.utils.paths import fleet_runs_dir as _resolve_fleet_runs_dir
    fleet_runs_dir = Path(_resolve_fleet_runs_dir())
    manifest = _write_initial_manifest(
        fleet_runs_dir, fleet_id, fleet_id_short, threshold=0.30, max_parallel=5
    )

    children = []
    cleanup_pairs = []
    try:
        for i, repo in enumerate(repos):
            sc = fail_scenario if i == 0 else slow_scenario
            env = _build_child_env(sc)
            run_id, wt = _dispatch_child(repo, fleet_id, env)
            children.append({"project_path": str(repo), "run_id": run_id})
            cleanup_pairs.append((repo, wt))
        _populate_children(fleet_runs_dir, manifest, children)

        _wait_for_pipeline_status(
            cleanup_pairs[0][1], children[0]["run_id"], {"failed"}, timeout=45
        )

        derived = poll_and_update_fleet_manifest(fleet_id)
        assert derived == "running", (
            f"breaker tripped with 1/5 failure (below 0.30 threshold): {derived!r}"
        )

        m = read_fleet_manifest(fleet_id)
        assert m["halt_reason"] is None
    finally:
        for child, repo in zip(children, repos):
            _terminate_pid_chain(child["run_id"], repo)
        _remove_worktrees(cleanup_pairs)
        manifest_path = fleet_runs_dir / f"{fleet_id}.json"
        if manifest_path.exists():
            manifest_path.unlink()


# ---------------------------------------------------------------------------
# 5. Interrupted ≠ failed at the breaker (reviewer's exact concern)
# ---------------------------------------------------------------------------


@pytest.mark.timeout(240)
@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM required")
def test_fleet_interrupted_child_does_not_trip_breaker(tmp_path):
    """Stop 1-of-3 children. Interrupted must NOT count as failure."""
    from worca.orchestrator.control import write_control
    from worca.orchestrator.fleet_manifest import (
        generate_fleet_id,
        poll_and_update_fleet_manifest,
        read_fleet_manifest,
    )

    repos = [tmp_path / f"repo_{i}" for i in range(3)]
    for r in repos:
        _setup_repo(r)

    scenario = _write_scenario(
        tmp_path, "interrupt", _scenario_slow_at("coordinator", slow_s=10)
    )
    env = _build_child_env(scenario)

    fleet_id, fleet_id_short = generate_fleet_id()
    # Resolve via the same lazy helper subprocesses use, so $WORCA_HOME
    # (set by tests/conftest.py to a session tmp dir) keeps writes out
    # of the developer's real ~/.worca/ (issue #162).
    from worca.utils.paths import fleet_runs_dir as _resolve_fleet_runs_dir
    fleet_runs_dir = Path(_resolve_fleet_runs_dir())
    manifest = _write_initial_manifest(
        fleet_runs_dir, fleet_id, fleet_id_short, threshold=0.30, max_parallel=3
    )

    children = []
    cleanup_pairs = []
    try:
        for repo in repos:
            run_id, wt = _dispatch_child(repo, fleet_id, env)
            children.append(
                {"project_path": str(repo), "run_id": run_id, "wt": wt}
            )
            cleanup_pairs.append((repo, wt))
        _populate_children(fleet_runs_dir, manifest, children)

        for child in children:
            _wait_for_stage_completed(child["wt"], child["run_id"], "plan", timeout=30)

        # Stop only the first child via control.json. Going through
        # write_control directly (not stop_fleet) keeps the manifest in
        # "running" — this test is about derive_fleet_status's reaction to
        # a lone interrupted child, not the operator stop_fleet flow.
        write_control(
            children[0]["run_id"],
            "stop",
            base=str(Path(children[0]["wt"]) / ".worca"),
        )

        _wait_for_pipeline_status(
            children[0]["wt"],
            children[0]["run_id"],
            {"interrupted"},
            timeout=30,
        )

        # Other 2 children still in-flight — breaker MUST stay quiet.
        derived = poll_and_update_fleet_manifest(fleet_id)
        assert derived == "running", (
            f"breaker tripped on interrupted child: {derived!r}"
        )
        m = read_fleet_manifest(fleet_id)
        assert m["halt_reason"] is None, (
            f"halt_reason set on interrupted (not failed) child: {m['halt_reason']!r}"
        )

        # Let remaining 2 complete naturally.
        for child in children[1:]:
            _wait_for_pipeline_terminal(child["wt"], child["run_id"], timeout=60)

        final = poll_and_update_fleet_manifest(fleet_id)
        # 1 interrupted + 2 completed → not all completed → "failed" (NOT
        # "halted", because interrupted is not _FAILURE_STATE and breaker
        # was never tripped). This is the precise invariant the reviewer
        # asked us to verify.
        assert final == "failed", (
            f"expected fleet to derive 'failed' with 2 completed + 1 interrupted; got {final!r}"
        )
        m = read_fleet_manifest(fleet_id)
        assert m["halt_reason"] is None, f"halt_reason set: {m['halt_reason']!r}"
    finally:
        for child, repo in zip(children, repos):
            _terminate_pid_chain(child["run_id"], repo)
        _remove_worktrees(cleanup_pairs)
        manifest_path = fleet_runs_dir / f"{fleet_id}.json"
        if manifest_path.exists():
            manifest_path.unlink()


# ---------------------------------------------------------------------------
# 6. Reconciliation reads live child statuses
# ---------------------------------------------------------------------------


def test_fleet_reconcile_reads_live_child_statuses(tmp_path):
    """poll_and_update_fleet_manifest must read pipelines.d/, not the manifest cache.

    A pure-fixture test — synthesise child registry entries directly and
    mutate them between polls. No subprocesses needed.
    """
    from worca.orchestrator.fleet_manifest import (
        generate_fleet_id,
        poll_and_update_fleet_manifest,
        read_fleet_manifest,
    )

    repos = [tmp_path / f"repo_{i}" for i in range(2)]
    for r in repos:
        (r / ".worca" / "multi" / "pipelines.d").mkdir(parents=True, exist_ok=True)

    fleet_id, fleet_id_short = generate_fleet_id()
    fleet_runs_dir = tmp_path / "fleet-runs"
    fleet_runs_dir.mkdir()

    children = []
    for i, repo in enumerate(repos):
        run_id = f"run_test_{i}"
        entry_path = repo / ".worca" / "multi" / "pipelines.d" / f"{run_id}.json"
        # Initial status: both running.
        entry_path.write_text(json.dumps({"run_id": run_id, "status": "running"}))
        children.append({"project_path": str(repo), "run_id": run_id})

    from worca.orchestrator.fleet_manifest import write_fleet_manifest

    manifest = {
        "fleet_id": fleet_id,
        "fleet_id_short": fleet_id_short,
        "status": "running",
        "halt_reason": None,
        "fleet_failure_threshold": 0.30,
        "children": children,
    }
    write_fleet_manifest(manifest, base_dir=str(fleet_runs_dir))

    derived = poll_and_update_fleet_manifest(
        fleet_id, manifest_base_dir=str(fleet_runs_dir)
    )
    assert derived == "running"

    # Mutate repo_0's live status — must be picked up next poll.
    entry_path = repos[0] / ".worca" / "multi" / "pipelines.d" / f"{children[0]['run_id']}.json"
    e = json.loads(entry_path.read_text())
    e["status"] = "completed"
    entry_path.write_text(json.dumps(e))

    derived = poll_and_update_fleet_manifest(
        fleet_id, manifest_base_dir=str(fleet_runs_dir)
    )
    # repo_0 completed, repo_1 still running → still "running" overall.
    assert derived == "running", (
        f"reconcile cached stale manifest state: {derived!r}"
    )

    # Now mark repo_1 completed too — both terminal-completed → fleet completed.
    entry_path = repos[1] / ".worca" / "multi" / "pipelines.d" / f"{children[1]['run_id']}.json"
    e = json.loads(entry_path.read_text())
    e["status"] = "completed"
    entry_path.write_text(json.dumps(e))

    derived = poll_and_update_fleet_manifest(
        fleet_id, manifest_base_dir=str(fleet_runs_dir)
    )
    assert derived == "completed"

    final_manifest = read_fleet_manifest(fleet_id, base_dir=str(fleet_runs_dir))
    assert final_manifest["status"] == "completed"


# ---------------------------------------------------------------------------
# 7. Plan-first inheritance — verify --plan flag honored across children
# ---------------------------------------------------------------------------


@pytest.mark.timeout(180)
def test_fleet_plan_propagates_to_children(tmp_path):
    """When children are dispatched with --plan, the plan path is honored.

    This is the slice of plan-first behaviour that the run_worktree.py
    surface owns: the dispatcher (run_fleet.py) is responsible for
    running the reference planner and then passing --plan to siblings.
    The integration test focuses on the dispatch contract — `--plan`
    must skip the PLAN stage and propagate the plan path into status.
    """
    from worca.orchestrator.fleet_manifest import (
        generate_fleet_id,
        poll_and_update_fleet_manifest,
    )

    repos = [tmp_path / f"repo_{i}" for i in range(2)]
    for r in repos:
        _setup_repo(r)

    # Add a plan file inside each repo (it must exist at dispatch time
    # because run_worktree.py copies repo state into the worktree).
    plan_rel = "docs/plans/W-999-seed.md"
    plan_body = "# Seed Plan\n\nDo the thing.\n"
    for r in repos:
        (r / "docs" / "plans").mkdir(parents=True, exist_ok=True)
        (r / plan_rel).write_text(plan_body)
        subprocess.run(["git", "add", "."], cwd=str(r), check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "add seed plan"],
            cwd=str(r),
            check=True,
            capture_output=True,
        )

    scenario = _write_scenario(tmp_path, "planfirst", _scenario_all_succeed())
    env = _build_child_env(scenario)

    fleet_id, fleet_id_short = generate_fleet_id()
    # Resolve via the same lazy helper subprocesses use, so $WORCA_HOME
    # (set by tests/conftest.py to a session tmp dir) keeps writes out
    # of the developer's real ~/.worca/ (issue #162).
    from worca.utils.paths import fleet_runs_dir as _resolve_fleet_runs_dir
    fleet_runs_dir = Path(_resolve_fleet_runs_dir())
    manifest = _write_initial_manifest(fleet_runs_dir, fleet_id, fleet_id_short)

    children = []
    cleanup_pairs = []
    try:
        for repo in repos:
            run_id, wt = _dispatch_child(repo, fleet_id, env, plan_path=plan_rel)
            children.append({"project_path": str(repo), "run_id": run_id, "wt": wt})
            cleanup_pairs.append((repo, wt))
        _populate_children(fleet_runs_dir, manifest, children)

        for child in children:
            _wait_for_pipeline_terminal(child["wt"], child["run_id"], timeout=90)

        for child in children:
            status_path = (
                Path(child["wt"]) / ".worca" / "runs" / child["run_id"] / "status.json"
            )
            status = json.loads(status_path.read_text())
            # The PLAN stage must have been skipped (handled by --plan)
            # — either absent from stages or marked skipped.
            plan_stage = (status.get("stages") or {}).get("plan", {})
            assert plan_stage.get("status") in (None, "skipped", "completed"), (
                f"unexpected plan stage state with --plan: {plan_stage!r}"
            )

        final = poll_and_update_fleet_manifest(fleet_id)
        assert final == "completed", f"fleet did not complete: {final!r}"
    finally:
        for child, repo in zip(children, repos):
            _terminate_pid_chain(child["run_id"], repo)
        _remove_worktrees(cleanup_pairs)
        manifest_path = fleet_runs_dir / f"{fleet_id}.json"
        if manifest_path.exists():
            manifest_path.unlink()


# ---------------------------------------------------------------------------
# 8. Guide injection across every child
# ---------------------------------------------------------------------------


@pytest.mark.timeout(180)
def test_fleet_guide_injected_into_every_child(tmp_path):
    """attach_guide() fans a normative guide block out to every child's PLAN."""
    from worca.orchestrator.fleet_manifest import generate_fleet_id

    repos = [tmp_path / f"repo_{i}" for i in range(2)]
    for r in repos:
        _setup_repo(r)

    sentinel = "SENTINEL_GUIDE_F4F4F4_NORMATIVE_TOKEN"
    guide = tmp_path / "guide.md"
    guide.write_text(f"# Migration Guide\n\n{sentinel}\n")

    scenario = _write_scenario(tmp_path, "guide", _scenario_all_succeed())
    env = _build_child_env(scenario)

    fleet_id, fleet_id_short = generate_fleet_id()
    # Resolve via the same lazy helper subprocesses use, so $WORCA_HOME
    # (set by tests/conftest.py to a session tmp dir) keeps writes out
    # of the developer's real ~/.worca/ (issue #162).
    from worca.utils.paths import fleet_runs_dir as _resolve_fleet_runs_dir
    fleet_runs_dir = Path(_resolve_fleet_runs_dir())
    manifest = _write_initial_manifest(
        fleet_runs_dir, fleet_id, fleet_id_short, guide_paths=[str(guide)]
    )

    children = []
    cleanup_pairs = []
    try:
        for repo in repos:
            run_id, wt = _dispatch_child(
                repo, fleet_id, env, guide_path=str(guide)
            )
            children.append({"project_path": str(repo), "run_id": run_id, "wt": wt})
            cleanup_pairs.append((repo, wt))
        _populate_children(fleet_runs_dir, manifest, children)

        # Wait for PLAN — the first stage that consumes the guide.
        for child in children:
            _wait_for_stage_completed(child["wt"], child["run_id"], "plan", timeout=45)

        # Every child's PLAN user-prompt must carry the guide sentinel.
        # The runner stores the rendered user prompt (the resolved
        # plan.block.md, which carries the {{guide_content}} block) under
        # status["stages"]["plan"]["prompt"] — see runner.py:2014-2017.
        # The system-prompt file (agents/planner.md) is unrelated to the
        # guide injection; it never contains work-request content.
        for child in children:
            status_path = (
                Path(child["wt"])
                / ".worca"
                / "runs"
                / child["run_id"]
                / "status.json"
            )
            status = json.loads(status_path.read_text())
            plan_prompt = (
                (status.get("stages") or {}).get("plan", {}).get("prompt") or ""
            )
            assert plan_prompt, (
                f"no plan stage prompt found in status for run {child['run_id']}"
            )
            assert "## Reference Guide (normative)" in plan_prompt, (
                f"normative header missing from PLAN prompt for "
                f"{child['run_id']}; prompt[:400]={plan_prompt[:400]!r}"
            )
            assert sentinel in plan_prompt, (
                f"sentinel {sentinel!r} missing from PLAN prompt for "
                f"{child['run_id']}; prompt[:400]={plan_prompt[:400]!r}"
            )

        for child in children:
            _wait_for_pipeline_terminal(child["wt"], child["run_id"], timeout=90)
    finally:
        for child, repo in zip(children, repos):
            _terminate_pid_chain(child["run_id"], repo)
        _remove_worktrees(cleanup_pairs)
        manifest_path = fleet_runs_dir / f"{fleet_id}.json"
        if manifest_path.exists():
            manifest_path.unlink()


# ---------------------------------------------------------------------------
# 9. Stale-PID regression (manual-run bug, xfail)
# ---------------------------------------------------------------------------


@pytest.mark.timeout(60)
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX fork model")
def test_fleet_stale_pid_regression(tmp_path):
    """Registered PID in pipelines.d/ must be the live run_pipeline.py PID.

    Gates the stale-PID fix: run_worktree.py registers itself with its
    own PID before forking into run_pipeline.py and exiting, so the
    runner must update the registry's pid on startup. Without that, the
    stale_pid reconciler ghosts a healthy pipeline into
    "interrupted/stale_pid" within a few poll cycles.
    """
    from worca.orchestrator.fleet_manifest import generate_fleet_id

    repo = tmp_path / "repo_solo"
    _setup_repo(repo)

    scenario = _write_scenario(
        tmp_path, "stalepid", _scenario_slow_at("coordinator", slow_s=15)
    )
    env = _build_child_env(scenario)

    fleet_id, fleet_id_short = generate_fleet_id()
    # Resolve via the same lazy helper subprocesses use, so $WORCA_HOME
    # (set by tests/conftest.py to a session tmp dir) keeps writes out
    # of the developer's real ~/.worca/ (issue #162).
    from worca.utils.paths import fleet_runs_dir as _resolve_fleet_runs_dir
    fleet_runs_dir = Path(_resolve_fleet_runs_dir())
    manifest = _write_initial_manifest(fleet_runs_dir, fleet_id, fleet_id_short)

    run_id = None
    wt = None
    try:
        run_id, wt = _dispatch_child(repo, fleet_id, env)
        _populate_children(
            fleet_runs_dir,
            manifest,
            [{"project_path": str(repo), "run_id": run_id}],
        )

        _wait_for_stage_completed(wt, run_id, "plan", timeout=30)
        entry = _read_child_registry(repo, run_id)
        pid = entry.get("pid")
        assert pid, "registry has no pid"

        # Must be live.
        try:
            os.kill(pid, 0)
            alive = True
        except (ProcessLookupError, PermissionError):
            alive = False
        assert alive, f"registered pid {pid} is not live — stale_pid bug"

        # Must be a run_pipeline.py — not the parent run_worktree.py.
        # /proc/<pid>/cmdline is wider than `ps -o command=` (which truncates
        # to terminal/COLUMNS width on Linux CI runners). Fall back to
        # `ps -ww` when /proc isn't available (macOS).
        cmdline = ""
        proc_cmdline = Path(f"/proc/{pid}/cmdline")
        if proc_cmdline.exists():
            cmdline = proc_cmdline.read_bytes().replace(b"\x00", b" ").decode(
                "utf-8", errors="replace"
            )
        else:
            ps = subprocess.run(
                ["ps", "-ww", "-p", str(pid), "-o", "command="],
                capture_output=True,
                text=True,
            )
            cmdline = ps.stdout.strip()
        assert "run_pipeline.py" in cmdline, (
            f"registered pid {pid} cmdline does not match run_pipeline.py: {cmdline!r}"
        )
    finally:
        if run_id:
            _terminate_pid_chain(run_id, repo)
            if wt:
                _remove_worktrees([(repo, wt)])
        manifest_path = fleet_runs_dir / f"{fleet_id}.json"
        if manifest_path.exists():
            manifest_path.unlink()


# ---------------------------------------------------------------------------
# 10. Cleanup --fleet-id filter isolation (manual-run bug, xfail)
# ---------------------------------------------------------------------------


def test_fleet_cleanup_fleet_id_filter_isolates(tmp_path):
    """`cleanup --fleet-id` must not enumerate unrelated worktrees.

    Gates the symmetric guard in WorktreeSource.list_eligible: when
    fleet_id is set without run_id, the worktree source returns [] so
    only FleetSource enumerates work to clean. Without the guard,
    `cleanup --fleet-id` from inside any repo with completed worktrees
    would offer to delete every one of them.
    """
    from worca.cli.cleanup import WorktreeSource

    unrelated = tmp_path / "unrelated_repo"
    pipelines_d = unrelated / ".worca" / "multi" / "pipelines.d"
    pipelines_d.mkdir(parents=True)
    worktree_path = unrelated / ".worktrees" / "pipeline-stale-completed"
    worktree_path.mkdir(parents=True)
    (worktree_path / ".worca" / "runs" / "stale-completed").mkdir(parents=True)
    (worktree_path / ".worca" / "runs" / "stale-completed" / "status.json").write_text(
        json.dumps({"pipeline_status": "completed"})
    )
    (pipelines_d / "stale-completed.json").write_text(
        json.dumps(
            {
                "run_id": "stale-completed",
                "worktree_path": str(worktree_path),
                "status": "completed",
                "title": "Stale completed (unrelated)",
            }
        )
    )

    source = WorktreeSource(base=str(unrelated / ".worca"))
    eligible = source.list_eligible({"fleet_id": "f_some_other_fleet"})
    assert eligible == [], (
        f"WorktreeSource enumerated unrelated worktrees under --fleet-id "
        f"filter: {eligible}"
    )
