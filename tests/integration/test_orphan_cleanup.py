"""Integration tests for orphan process cleanup on resume and the persistent
terminal-event guard.

Test 9a: resume kills orphaned process groups registered in ``<run_dir>/procs/``.
Test 9b: a separate Python subprocess that attempts a terminal state-write after
         the pipeline has already completed is blocked by the persistent guard —
         no duplicate ``pipeline.run.completed`` event in ``events.jsonl``.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time

import pytest

from tests.integration.helpers import (
    _find_latest_run_id,
    run_and_act,
    send_sigkill,
)

_HANG_AT_IMPLEMENT = {
    "agents": {"implementer": {"action": "hang"}},
    "default": {"action": "succeed", "delay_s": 0.05},
}

_ALL_SUCCEED = {"default": {"action": "succeed", "delay_s": 0.05}}

_HAPPY_SCENARIO = {
    "agents": {
        "tester": {"action": "succeed", "delay_s": 0.05,
                   "structured_output": {"passed": True}},
        "reviewer": {"action": "succeed", "delay_s": 0.05,
                     "structured_output": {"outcome": "approve", "issues": []}},
    },
    "default": {"action": "succeed", "delay_s": 0.05},
}


def _events_of(events: list, event_type: str) -> list:
    return [e for e in events if e.get("event_type") == event_type]


# ---------------------------------------------------------------------------
# 9a — Resume kills orphaned process groups
# ---------------------------------------------------------------------------


def _spawn_orphan_sleeper() -> subprocess.Popen:
    """Spawn a ``sleep`` process in its own process group (mimics an orphaned
    claude subprocess left behind after a crash)."""
    return subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(300)"],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _register_orphan(run_dir, proc: subprocess.Popen) -> int:
    """Register *proc* in the per-run process-group registry so
    ``kill_all_tracked`` finds it on resume."""
    pgid = os.getpgid(proc.pid)
    procs_dir = os.path.join(str(run_dir), "procs")
    os.makedirs(procs_dir, exist_ok=True)

    from worca.utils.proc_registry import _get_process_create_time
    entry = {
        "pgid": pgid,
        "pid": proc.pid,
        "stage": "implement",
        "iteration": 99,
        "start_time": _get_process_create_time(proc.pid) or time.monotonic(),
    }
    with open(os.path.join(procs_dir, f"{pgid}.json"), "w") as f:
        json.dump(entry, f)
    return pgid


def _is_group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except (ProcessLookupError, PermissionError, OSError):
        return False


@pytest.mark.timeout(180)
@pytest.mark.skipif(sys.platform == "win32", reason="signal-based tests require Unix")
def test_resume_kills_orphaned_process_groups(pipeline_env):
    """SIGKILL the pipeline mid-implementer, plant an orphan sleeper in the
    run's procs/ registry, then ``--resume``.  The resume path must
    ``kill_all_tracked`` before re-executing, so the orphan should be dead
    by the time the resumed pipeline completes."""

    # 1. Run pipeline until implementer hangs, then SIGKILL it.
    first = run_and_act(
        pipeline_env, _HANG_AT_IMPLEMENT, send_sigkill,
        act_after_stage="implement", timeout=20,
    )
    assert first.status.get("pipeline_status") not in (
        "completed", "failed", "interrupted",
    ), f"first run must be non-terminal after SIGKILL; got {first.status.get('pipeline_status')}"

    run_id = _find_latest_run_id(pipeline_env.worca_dir)
    run_dir = pipeline_env.worca_dir / "runs" / run_id

    # 2. Spawn a real subprocess that simulates an orphaned agent group and
    #    register it in the procs/ directory.
    orphan = _spawn_orphan_sleeper()
    pgid = _register_orphan(run_dir, orphan)
    assert _is_group_alive(pgid), "orphan sleeper should be alive before resume"

    # 3. Resume — the resume path calls kill_all_tracked() before execution.
    resumed = pipeline_env.run(_ALL_SUCCEED, extra_args=["--resume"], timeout=60)

    # 4. Verify the orphan was killed.
    # pytest is the orphan's parent here, so a killed orphan lingers as a zombie
    # until reaped — os.killpg(pgid, 0) still succeeds for a zombie on Linux. In
    # production the orphan's parent (the crashed runner) is gone, so init reaps
    # it immediately. Reap it ourselves to mirror that. If the resume did NOT
    # kill it, this wait() times out (the orphan is a 300s sleep) and the group
    # stays alive below, so the assertion still catches a real regression.
    try:
        orphan.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    time.sleep(0.3)  # grace for process-group teardown after reap
    assert not _is_group_alive(pgid), (
        "orphan process group should have been killed during resume"
    )
    assert resumed.status.get("pipeline_status") == "completed"

    # The resume stderr should mention killing orphaned groups.
    assert "orphaned process group" in resumed.stderr.lower() or "orphan" in resumed.stderr.lower(), (
        f"resume should log orphan cleanup; stderr: {resumed.stderr[:500]}"
    )

    # Cleanup: ensure orphan is dead even if test assertions fail above.
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, OSError):
        pass
    try:
        orphan.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


# ---------------------------------------------------------------------------
# 9b — Cross-process terminal guard blocks duplicate run.completed
# ---------------------------------------------------------------------------

# Inline script that simulates an orphaned runner process trying to drive a
# second terminal state-write after the real pipeline has already completed.
_ORPHAN_TERMINAL_SCRIPT = r"""
import json, os, sys

status_path = sys.argv[1]
events_path = sys.argv[2]

# --- Replicate the persistent terminal guard from runner.py ---
from worca.state.status import PIPELINE_ALL_TERMINAL

def _is_already_terminal(path):
    try:
        with open(path) as f:
            data = json.load(f)
        return data.get("pipeline_status") in PIPELINE_ALL_TERMINAL
    except Exception:
        return False

if _is_already_terminal(status_path):
    print("GUARD_BLOCKED", flush=True)
    sys.exit(0)

# If the guard didn't fire, write a duplicate terminal event (should not happen).
with open(status_path) as f:
    status = json.load(f)
status["pipeline_status"] = "completed"
status["completed_at"] = "2099-01-01T00:00:00Z"
with open(status_path, "w") as f:
    json.dump(status, f)

event = {"type": "pipeline.run.completed", "duplicate": True}
with open(events_path, "a") as f:
    f.write(json.dumps(event) + "\n")

print("GUARD_MISSED", flush=True)
"""


@pytest.mark.timeout(120)
@pytest.mark.skipif(sys.platform == "win32", reason="signal-based tests require Unix")
def test_terminal_guard_blocks_cross_process_duplicate(pipeline_env):
    """Run the pipeline to completion, then spawn a separate Python subprocess
    that attempts to write a second ``pipeline.run.completed`` event.  The
    persistent terminal guard (``_is_already_terminal`` reading ``status.json``
    from disk) should block the write, producing exactly one terminal event."""

    # 1. Complete a normal pipeline run.
    result = pipeline_env.run(_HAPPY_SCENARIO, timeout=120)
    assert result.status.get("pipeline_status") == "completed", (
        f"pipeline should complete; got {result.status.get('pipeline_status')}\n"
        f"stderr: {result.stderr[-500:]}"
    )

    run_id = _find_latest_run_id(pipeline_env.worca_dir)
    run_dir = pipeline_env.worca_dir / "runs" / run_id
    status_path = run_dir / "status.json"
    events_path = run_dir / "events.jsonl"

    completed_events_before = _events_of(result.events, "pipeline.run.completed")
    assert len(completed_events_before) == 1, (
        f"expected exactly 1 run.completed before orphan attempt; got {len(completed_events_before)}"
    )

    # 2. Spawn a separate subprocess that tries to drive a duplicate terminal event.
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    env = {**os.environ, "PYTHONPATH": os.path.join(repo_root, "src")}
    orphan_result = subprocess.run(
        [sys.executable, "-c", _ORPHAN_TERMINAL_SCRIPT,
         str(status_path), str(events_path)],
        capture_output=True, text=True, timeout=10, env=env,
    )

    assert "GUARD_BLOCKED" in orphan_result.stdout, (
        f"orphan process should have been blocked by terminal guard; "
        f"stdout={orphan_result.stdout!r}, stderr={orphan_result.stderr!r}"
    )

    # 3. Verify no duplicate event was appended to events.jsonl.
    all_events = []
    if events_path.exists():
        for line in events_path.read_text().splitlines():
            if line.strip():
                all_events.append(json.loads(line))

    completed_events_after = [
        e for e in all_events if e.get("event_type") == "pipeline.run.completed"
    ]
    assert len(completed_events_after) == 1, (
        f"expected exactly 1 run.completed after orphan attempt; got {len(completed_events_after)}"
    )
    assert not any(e.get("duplicate") for e in all_events), (
        "duplicate-marked event should NOT appear in events.jsonl"
    )
