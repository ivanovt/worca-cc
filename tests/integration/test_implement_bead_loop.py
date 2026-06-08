"""End-to-end pins for the IMPLEMENT bead-loop drain semantics.

These tests use mock_claude + the stateful bd stub (or controlled bd_close
behavior) to exercise the production-realistic interaction between
``_query_ready_bead`` and ``bd_close`` — the layer unit-test mocks of
``_query_ready_bead`` cannot reach.

Coverage gaps these tests close:

* ``test_multi_bead_happy_path_stateful_stub`` — multi-bead Phase-1 fan-out
  drains via the stateful bd stub. Previously only covered by the effort
  tests, which interleave effort-level assertions with the loop semantics.
* ``test_resume_after_kill_processes_remaining_beads_stateful`` — the
  scenario this PR is meant to fix, with a stub that *actually drops closed
  beads* (unlike ``test_multi_bead_kill_after_bead1_continue_context_survives``
  in ``test_resume_context.py``). Pins that post-kill resume processes the
  remaining beads end-to-end, not just that the rc is 0.
* ``test_resume_with_envelope_shape_coordinate_log`` — verifies that the
  coordinate iter log produced by mock_claude is the same envelope shape
  ``resume.backfill_prompt_context`` now unwraps, closing the loop on the
  ``resume.py`` fix at the integration layer.
* ``test_bd_close_failure_does_not_reimplement`` — pins the
  ``implemented_bead_ids`` tracking record-on-attempt semantics: even if
  ``bd_close`` returns non-zero, the runner must not loop on the same bead.

Plan rules followed:
* ``timeout(180)`` on every multi-run test (rule #12)
* ``delay_s <= 0.05`` in every scenario (rule #13)
* signal-based tests are skipped on Windows
"""
from __future__ import annotations

import json
import sys
import time

import pytest

from tests.integration.helpers import (
    _find_latest_run_id,
    make_iteration_scenario,
    run_and_act,
    send_sigkill,
)


# ---------------------------------------------------------------------------
# Local helpers
# ---------------------------------------------------------------------------

def _build_scenario(*, coord_beads, impl_per_iter=None):
    """Build a minimal happy-path scenario carrying coordinator beads.

    Mirrors the shape of ``_happy_scenario`` in ``test_effort_integration``
    but trimmed to the agents this test file actually exercises (planner,
    coordinator, implementer) — tester/reviewer/guardian fall through to
    the scenario default and produce trivial passes.
    """
    agents = {
        "coordinator": {
            "action": "succeed",
            "structured_output": {"beads_ids": coord_beads, "dependency_graph": {}},
        },
        "tester": {"action": "succeed", "structured_output": {"passed": True}},
        "reviewer": {"action": "succeed", "structured_output": {"outcome": "approve"}},
        "guardian": {
            "action": "succeed",
            "structured_output": {
                "pr_url": "https://github.com/test/test/pull/1",
                "pr_number": 1,
            },
        },
    }
    if impl_per_iter:
        agents["implementer"] = impl_per_iter
    else:
        agents["implementer"] = {
            "action": "succeed",
            "structured_output": {
                "files_changed": ["src/foo.py"],
                "tests_added": ["tests/test_foo.py"],
            },
        }
    return make_iteration_scenario(agents, default={"action": "succeed", "delay_s": 0.05})


def _setup_bead_pool(pipeline_env, bead_ids):
    """Activate the stateful bd stub seeded with the given bead IDs."""
    beads_file = pipeline_env.tmp_path / "bd_pool.json"
    beads_file.write_text(json.dumps({
        "beads": [{"id": bid, "title": f"Bead {bid}"} for bid in bead_ids],
    }))
    pipeline_env.enable_beads(beads_file=beads_file)
    return beads_file


def _read_prompt_context(worca_dir, run_id=None):
    """Read prompt_context.json from a specific run (or the latest)."""
    if run_id is None:
        run_id = _find_latest_run_id(worca_dir)
    ctx_path = worca_dir / "runs" / run_id / "prompt_context.json"
    if not ctx_path.exists():
        return {}
    return json.loads(ctx_path.read_text())


def _read_coordinate_iter_log(worca_dir, run_id=None, iter_n=1):
    """Read coordinate/iter-N.json — the artifact resume.py unwraps."""
    if run_id is None:
        run_id = _find_latest_run_id(worca_dir)
    path = worca_dir / "runs" / run_id / "logs" / "coordinate" / f"iter-{iter_n}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text())


def _wait_for_context_key(worca_dir, key, timeout=30.0):
    """Poll prompt_context.json for a non-empty key — used to time signals."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            ctx = _read_prompt_context(worca_dir)
            if ctx.get(key):
                return
        except Exception:
            pass
        time.sleep(0.1)
    raise TimeoutError(
        f"prompt_context.json did not contain non-empty {key!r} within {timeout}s"
    )


# ---------------------------------------------------------------------------
# 1. Multi-bead happy path through the stateful stub
# ---------------------------------------------------------------------------

@pytest.mark.timeout(180)
def test_multi_bead_happy_path_stateful_stub(pipeline_env):
    """3-bead Phase-1 fan-out: each bead is processed exactly once, the queue
    drains via ``_query_ready_bead is None``, IMPLEMENT completes.

    Pins that the loop:
      - records each bead in ``implemented_bead_ids`` (visible in prompt_context)
      - advances ``bead_iteration`` once per bead (not per pass)
      - never re-implements a closed bead even though the stub honors close
    """
    bead_ids = ["bd-loop-a", "bd-loop-b", "bd-loop-c"]
    _setup_bead_pool(pipeline_env, bead_ids)

    scenario = _build_scenario(coord_beads=bead_ids)
    result = pipeline_env.run(scenario, prompt="multi-bead drain", timeout=60)

    assert result.returncode == 0, f"Pipeline failed: {result.stderr[:500]}"
    assert result.status.get("pipeline_status") == "completed"
    assert result.status["loop_counters"]["bead_iteration"] == 3, (
        f"bead_iteration must equal bead count; got "
        f"{result.status['loop_counters']['bead_iteration']}"
    )

    ctx = _read_prompt_context(pipeline_env.worca_dir)
    assert sorted(ctx.get("implemented_bead_ids") or []) == sorted(bead_ids), (
        f"implemented_bead_ids must list all 3 beads; got "
        f"{ctx.get('implemented_bead_ids')}"
    )

    # IMPLEMENT stage has 3 iteration records — one per bead.
    impl_iters = result.status["stages"]["implement"].get("iterations", [])
    assert len(impl_iters) == 3, f"expected 3 IMPLEMENT iterations; got {len(impl_iters)}"


# ---------------------------------------------------------------------------
# 2. Post-kill resume processes remaining beads (stateful stub)
# ---------------------------------------------------------------------------

@pytest.mark.timeout(180)
@pytest.mark.skipif(sys.platform == "win32", reason="signal-based tests require Unix")
def test_resume_after_kill_processes_remaining_beads_stateful(pipeline_env):
    """SIGKILL after bead-aaa; resume must close bd-loop-b AND bd-loop-c.

    This is the production-realistic version of
    ``test_multi_bead_kill_after_bead1_continue_context_survives`` — the
    stateful stub actually drops closed beads, so unlike the stateless
    counterpart this test fails if the runner doesn't enter IMPLEMENT a
    second time on resume.
    """
    bead_ids = ["bd-loop-a", "bd-loop-b", "bd-loop-c"]
    _setup_bead_pool(pipeline_env, bead_ids)

    # iter_1 succeeds (bead-aaa), iter_2 hangs — we kill while iter_2 is
    # in-flight, leaving b and c unfinished.
    scenario = _build_scenario(
        coord_beads=bead_ids,
        impl_per_iter={
            "iter_1": {
                "action": "succeed",
                "delay_s": 0.05,
                "structured_output": {"files_changed": ["bead_a.py"], "tests_added": []},
            },
            "iter_2": {"action": "hang"},
            "default": {"action": "succeed", "delay_s": 0.05},
        },
    )

    def _act(proc, env):
        _wait_for_context_key(env.worca_dir, "all_files_changed")
        send_sigkill(proc, env)

    first = run_and_act(pipeline_env, scenario, _act, timeout=40)
    assert first.status.get("pipeline_status") not in (
        "completed", "failed", "interrupted"
    ), (
        f"run must be non-terminal after SIGKILL; "
        f"got {first.status.get('pipeline_status')!r}"
    )

    # Resume with all-succeed; the stateful stub still has b and c open.
    resume_scenario = _build_scenario(coord_beads=bead_ids)
    resumed = pipeline_env.run(resume_scenario, extra_args=["--resume"], timeout=60)

    assert resumed.returncode == 0, (
        f"resume must complete cleanly; rc={resumed.returncode}\n"
        f"stderr: {resumed.stderr[:500]}"
    )
    assert resumed.status.get("pipeline_status") == "completed"

    ctx = _read_prompt_context(pipeline_env.worca_dir)
    implemented = sorted(ctx.get("implemented_bead_ids") or [])
    assert implemented == sorted(bead_ids), (
        f"resume must close all 3 beads; implemented_bead_ids={implemented}"
    )


# ---------------------------------------------------------------------------
# 3. Resume reads the envelope-shape coordinate iter log
# ---------------------------------------------------------------------------

@pytest.mark.timeout(180)
@pytest.mark.skipif(sys.platform == "win32", reason="signal-based tests require Unix")
def test_resume_with_envelope_shape_coordinate_log(pipeline_env):
    """The coordinate log mock_claude produces is envelope-shaped, and
    resume.backfill_prompt_context unwraps it to recover beads_ids.

    Without the resume.py fix in this PR, max_beads stays 0 after resume
    and the implement loop silently falsely completes. This test pins the
    end-to-end behavior: the artifact on disk matches the envelope shape,
    and a fresh resume picks up the correct bead set.
    """
    bead_ids = ["bd-env-a", "bd-env-b"]
    _setup_bead_pool(pipeline_env, bead_ids)

    scenario = _build_scenario(
        coord_beads=bead_ids,
        impl_per_iter={
            "iter_1": {
                "action": "succeed",
                "delay_s": 0.05,
                "structured_output": {"files_changed": ["a.py"], "tests_added": []},
            },
            "iter_2": {"action": "hang"},
            "default": {"action": "succeed", "delay_s": 0.05},
        },
    )

    def _act(proc, env):
        _wait_for_context_key(env.worca_dir, "all_files_changed")
        send_sigkill(proc, env)

    first = run_and_act(pipeline_env, scenario, _act, timeout=40)
    assert first.status.get("pipeline_status") not in (
        "completed", "failed", "interrupted"
    ), (
        f"run must be non-terminal after SIGKILL; "
        f"got {first.status.get('pipeline_status')!r}"
    )
    run_id = _find_latest_run_id(pipeline_env.worca_dir)

    # The coordinate iter log on disk is the envelope shape that
    # resume.backfill_prompt_context now unwraps. If mock_claude or the
    # runner ever changed this contract, this assertion catches it.
    coord_log = _read_coordinate_iter_log(pipeline_env.worca_dir, run_id=run_id)
    assert coord_log is not None, "coordinate iter-1.json missing"
    assert "structured_output" in coord_log, (
        f"coordinate iter-1.json must be envelope-shaped for backfill to "
        f"exercise the unwrap path; keys={sorted(coord_log)}"
    )
    so = coord_log["structured_output"]
    assert so.get("beads_ids") == bead_ids, (
        f"envelope.structured_output.beads_ids must match coordinator output; "
        f"got {so.get('beads_ids')}"
    )

    # Resume — backfill must populate beads_ids from the envelope, so
    # max_beads is restored and the second bead is processed.
    resume_scenario = _build_scenario(coord_beads=bead_ids)
    resumed = pipeline_env.run(resume_scenario, extra_args=["--resume"], timeout=60)
    assert resumed.returncode == 0, (
        f"resume must complete cleanly; rc={resumed.returncode}\n"
        f"stderr: {resumed.stderr[:500]}"
    )

    ctx = _read_prompt_context(pipeline_env.worca_dir)
    assert sorted(ctx.get("implemented_bead_ids") or []) == sorted(bead_ids), (
        f"resume must close both beads after envelope unwrap; got "
        f"{ctx.get('implemented_bead_ids')}"
    )
    # Confirm backfill actually restored beads_ids (would be missing if
    # the unwrap regressed).
    assert sorted(ctx.get("beads_ids") or []) == sorted(bead_ids)


# ---------------------------------------------------------------------------
# 4. bd_close failure does not re-implement the same bead
# ---------------------------------------------------------------------------

@pytest.mark.timeout(180)
def test_bd_close_failure_does_not_reimplement(pipeline_env):
    """When bd_close exits non-zero, the runner records the bead in
    ``implemented_bead_ids`` anyway and treats the next bd_ready hit on it
    as a drained queue — no loop, no re-implementation.

    Uses the canned-response stub (stateless) with ``close`` rigged to fail
    and ``ready`` always returning the same bead. With record-on-attempt the
    runner advances to TEST after iter_1; without it the loop either keeps
    re-implementing the same bead or hits the safety cap.
    """
    bead_id = "bd-close-fail"
    response_file = pipeline_env.tmp_path / "bd_close_fail_responses.json"
    response_file.write_text(json.dumps({
        f"show {bead_id}": {
            "stdout": f"○ {bead_id} · Close-fail bead   [● P2 · OPEN]\n",
            "exit": 0,
        },
        "ready": {
            "stdout": (
                "📋 Ready work (1 issues with no blockers):\n"
                f"1. [● P2] [task] {bead_id}: Close-fail bead\n"
            ),
            "exit": 0,
        },
        f"close {bead_id}": {"stdout": "", "stderr": "boom", "exit": 1},
        "default": {"stdout": "", "exit": 0},
    }))
    pipeline_env.enable_beads(response_file=response_file)

    scenario = _build_scenario(coord_beads=[bead_id])
    result = pipeline_env.run(scenario, prompt="bd close fail", timeout=60)

    assert result.returncode == 0, f"Pipeline failed: {result.stderr[:500]}"
    assert result.status.get("pipeline_status") == "completed"

    impl_iters = result.status["stages"]["implement"].get("iterations", [])
    assert len(impl_iters) == 1, (
        f"bd_close failure must not trigger re-implementation; "
        f"got {len(impl_iters)} IMPLEMENT iterations"
    )

    ctx = _read_prompt_context(pipeline_env.worca_dir)
    assert ctx.get("implemented_bead_ids") == [bead_id], (
        f"record-on-attempt: bead must land in implemented_bead_ids even "
        f"when bd_close fails; got {ctx.get('implemented_bead_ids')}"
    )

    # The runner should have logged both the close failure AND the
    # already-implemented drain on the next bd_ready hit.
    assert "Failed to close" in result.stderr or "boom" in result.stderr.lower() \
        or "bd_close failed" in result.stderr.lower(), (
        f"expected a bd_close failure log; stderr was:\n{result.stderr[:500]}"
    )
    assert "already-implemented" in result.stderr, (
        f"expected the already-implemented drain log when bd ready "
        f"re-surfaces a closed bead; stderr was:\n{result.stderr[:500]}"
    )
