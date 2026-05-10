"""Integration tests for context survival across kill+resume.

Three scenarios verify that prompt_builder context is correctly saved before
each loopback continue site in runner.py, so that context keys survive a
SIGKILL and are available on resume:

  A. Multi-bead kill after bead-1 continue (runner.py:2638):
     all_files_changed must be in prompt_context.json after kill.
  B. Test-failure kill after TEST→IMPLEMENT continue (runner.py:2743):
     test_failures and test_failure_history must be in prompt_context.json.
  C. Review-changes kill after REVIEW→IMPLEMENT continue (runner.py:2869):
     review_issues and review_history must be in prompt_context.json.

Plan rule #12: every multi-run test carries timeout(180).
Plan rule #13: scenarios keep delay_s <= 0.05.
"""
from __future__ import annotations

import json
import sys
import time

import pytest

from tests.integration.helpers import (
    _find_latest_run_id,
    _find_latest_status,
    run_and_act,
    send_sigkill,
)


# ---------------------------------------------------------------------------
# Local helpers
# ---------------------------------------------------------------------------

def _wait_for_context_key(
    worca_dir,
    key: str,
    timeout: float = 30.0,
) -> None:
    """Poll prompt_context.json until key is present and non-empty.

    Raises TimeoutError if the key does not appear within timeout seconds.
    This correctly signals that save_context was never called at the expected
    loopback site — the regression this test file guards against.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            run_id = _find_latest_run_id(worca_dir)
            ctx_path = worca_dir / "runs" / run_id / "prompt_context.json"
            if ctx_path.exists():
                ctx = json.loads(ctx_path.read_text())
                if ctx.get(key):
                    return
        except Exception:
            pass
        time.sleep(0.1)
    raise TimeoutError(
        f"prompt_context.json did not contain non-empty {key!r} within {timeout}s; "
        f"save_context may not have been called before the loopback continue"
    )


def _read_prompt_context(worca_dir) -> dict:
    """Read prompt_context.json from the latest run directory."""
    run_id = _find_latest_run_id(worca_dir)
    ctx_path = worca_dir / "runs" / run_id / "prompt_context.json"
    if not ctx_path.exists():
        return {}
    return json.loads(ctx_path.read_text())


# All-succeed scenario used for the resume leg — every agent returns
# a plain success result with no structured_output.
_ALL_SUCCEED = {"default": {"action": "succeed", "delay_s": 0.05}}


# ---------------------------------------------------------------------------
# Scenario A: multi-bead kill after bead-1 continue
# ---------------------------------------------------------------------------

def _bd_responses_multi_bead(tmp_path):
    """Write and return a bd stub response file for a multi-bead scenario.

    'bd ready ...' always returns beads-aaa (the stub does not track closures,
    so even after bd close beads-aaa, the next bd ready call still returns it).
    This causes the runner's next_bead check (runner.py:2622) to see a bead,
    triggering the bead loopback and saving all_files_changed at runner.py:2628.
    """
    path = tmp_path / "bd_responses.json"
    path.write_text(json.dumps({
        "show beads-aaa": {
            "stdout": (
                "○ beads-aaa · Bead AAA Task   [● P2 · OPEN]\n\n"
                "DESCRIPTION\nImplement feature A.\n"
            ),
            "exit": 0,
        },
        "ready": {
            "stdout": (
                "📋 Ready work (1 issues with no blockers):\n"
                "1. [● P2] [task] beads-aaa: Bead AAA Task\n"
            ),
            "exit": 0,
        },
        "default": {"stdout": "", "exit": 0},
    }))
    return path


@pytest.mark.timeout(180)
@pytest.mark.skipif(sys.platform == "win32", reason="signal-based tests require Unix")
def test_multi_bead_kill_after_bead1_continue_context_survives(pipeline_env, tmp_path):
    """SIGKILL during bead-2: all_files_changed from bead-1 must survive in
    prompt_context.json and be available to a resumed run.

    Flow:
      coordinator → beads_ids=["beads-aaa","beads-bbb"] (max_beads=2)
      implement iter_1 → succeeds, files_changed=["bead_a.py"]
      runner: save_context (all_files_changed=["bead_a.py"]), continue to iter_2
      implement iter_2 → hangs (SIGKILL during hang)
      assert prompt_context.json["all_files_changed"] contains bead_a.py
      --resume → pipeline completes
    """
    bd_resp = _bd_responses_multi_bead(tmp_path)
    pipeline_env.enable_beads(response_file=bd_resp)

    scenario = {
        "agents": {
            "coordinator": {
                "action": "succeed",
                "delay_s": 0.05,
                "structured_output": {
                    "beads_ids": ["beads-aaa", "beads-bbb"],
                    "dependency_graph": {},
                },
            },
            "implementer": {
                "iter_1": {
                    "action": "succeed",
                    "delay_s": 0.05,
                    "structured_output": {
                        "files_changed": ["bead_a.py"],
                        "tests_added": [],
                    },
                },
                "iter_2": {"action": "hang"},
                "default": {"action": "succeed", "delay_s": 0.05},
            },
        },
        "default": {"action": "succeed", "delay_s": 0.05},
    }

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

    ctx = _read_prompt_context(pipeline_env.worca_dir)
    assert "all_files_changed" in ctx, (
        f"prompt_context.json must contain all_files_changed after bead-1 continue; "
        f"keys present: {sorted(ctx.keys())}"
    )
    assert "bead_a.py" in (ctx.get("all_files_changed") or []), (
        f"all_files_changed must include bead_a.py from bead-1; "
        f"got: {ctx.get('all_files_changed')}"
    )

    resumed = pipeline_env.run(_ALL_SUCCEED, extra_args=["--resume"], timeout=60)
    assert resumed.returncode == 0, (
        f"resume must complete cleanly; rc={resumed.returncode}\n"
        f"stderr: {resumed.stderr[:500]}"
    )
    assert resumed.status.get("pipeline_status") == "completed"


# ---------------------------------------------------------------------------
# Scenario B: test-failure kill after TEST→IMPLEMENT continue
# ---------------------------------------------------------------------------

@pytest.mark.timeout(180)
@pytest.mark.skipif(sys.platform == "win32", reason="signal-based tests require Unix")
def test_test_failure_kill_after_continue_context_survives(pipeline_env):
    """SIGKILL during implement-fix iter: test_failures and test_failure_history
    must survive in prompt_context.json so the resumed run can use them.

    Flow:
      implement iter_1 → succeeds, files_changed=["foo.py"]
      test iter_1 → fails, failures=[{test_name:t_smoke, error:AssertionError}]
      runner: save_context (test_failures + test_failure_history), continue to iter_2
      implement iter_2 → hangs (SIGKILL during hang)
      assert prompt_context.json has test_failures and test_failure_history
      --resume → pipeline completes
    """
    scenario = {
        "agents": {
            "tester": {
                "iter_1": {
                    "action": "succeed",
                    "delay_s": 0.05,
                    "structured_output": {
                        "passed": False,
                        "failures": [
                            {"test_name": "t_smoke", "error": "AssertionError"},
                        ],
                    },
                },
                "default": {
                    "action": "succeed",
                    "delay_s": 0.05,
                    "structured_output": {"passed": True},
                },
            },
            "implementer": {
                "iter_1": {
                    "action": "succeed",
                    "delay_s": 0.05,
                    "structured_output": {
                        "files_changed": ["foo.py"],
                        "tests_added": [],
                    },
                },
                "iter_2": {"action": "hang"},
                "default": {"action": "succeed", "delay_s": 0.05},
            },
        },
        "default": {"action": "succeed", "delay_s": 0.05},
    }

    def _act(proc, env):
        _wait_for_context_key(env.worca_dir, "test_failures")
        send_sigkill(proc, env)

    first = run_and_act(pipeline_env, scenario, _act, timeout=40)

    assert first.status.get("pipeline_status") not in (
        "completed", "failed", "interrupted"
    ), (
        f"run must be non-terminal after SIGKILL; "
        f"got {first.status.get('pipeline_status')!r}"
    )

    ctx = _read_prompt_context(pipeline_env.worca_dir)
    assert "test_failures" in ctx, (
        f"prompt_context.json must contain test_failures after TEST→IMPLEMENT continue; "
        f"keys present: {sorted(ctx.keys())}"
    )
    assert "test_failure_history" in ctx, (
        f"prompt_context.json must contain test_failure_history; "
        f"keys present: {sorted(ctx.keys())}"
    )
    assert ctx.get("test_failures"), (
        f"test_failures must be non-empty; got: {ctx.get('test_failures')}"
    )
    assert ctx.get("test_failure_history"), (
        f"test_failure_history must be non-empty; got: {ctx.get('test_failure_history')}"
    )

    resumed = pipeline_env.run(_ALL_SUCCEED, extra_args=["--resume"], timeout=60)
    assert resumed.returncode == 0, (
        f"resume must complete cleanly; rc={resumed.returncode}\n"
        f"stderr: {resumed.stderr[:500]}"
    )
    assert resumed.status.get("pipeline_status") == "completed"


# ---------------------------------------------------------------------------
# Scenario C: review-changes kill after REVIEW→IMPLEMENT continue
# ---------------------------------------------------------------------------

@pytest.mark.timeout(180)
@pytest.mark.skipif(sys.platform == "win32", reason="signal-based tests require Unix")
def test_review_changes_kill_after_continue_context_survives(pipeline_env):
    """SIGKILL during implement-fix iter after review request_changes:
    review_issues and review_history must survive in prompt_context.json.

    Flow:
      implement iter_1 → succeeds, files_changed=["foo.py"]
      test iter_1 → passes
      review iter_1 → request_changes, issues=[{severity:critical,...}]
      runner: save_context (review_history + review_issues), continue to iter_2
      implement iter_2 → hangs (SIGKILL during hang)
      assert prompt_context.json has review_issues and review_history
      --resume → pipeline completes
    """
    scenario = {
        "agents": {
            "tester": {
                "action": "succeed",
                "delay_s": 0.05,
                "structured_output": {"passed": True},
            },
            "reviewer": {
                "iter_1": {
                    "action": "succeed",
                    "delay_s": 0.05,
                    "structured_output": {
                        "outcome": "request_changes",
                        "issues": [
                            {"severity": "critical", "description": "Fix the bug"},
                        ],
                    },
                },
                "default": {
                    "action": "succeed",
                    "delay_s": 0.05,
                    "structured_output": {"outcome": "approve", "issues": []},
                },
            },
            "implementer": {
                "iter_1": {
                    "action": "succeed",
                    "delay_s": 0.05,
                    "structured_output": {
                        "files_changed": ["foo.py"],
                        "tests_added": [],
                    },
                },
                "iter_2": {"action": "hang"},
                "default": {"action": "succeed", "delay_s": 0.05},
            },
        },
        "default": {"action": "succeed", "delay_s": 0.05},
    }

    def _act(proc, env):
        _wait_for_context_key(env.worca_dir, "review_issues")
        send_sigkill(proc, env)

    first = run_and_act(pipeline_env, scenario, _act, timeout=40)

    assert first.status.get("pipeline_status") not in (
        "completed", "failed", "interrupted"
    ), (
        f"run must be non-terminal after SIGKILL; "
        f"got {first.status.get('pipeline_status')!r}"
    )

    ctx = _read_prompt_context(pipeline_env.worca_dir)
    assert "review_issues" in ctx, (
        f"prompt_context.json must contain review_issues after REVIEW→IMPLEMENT continue; "
        f"keys present: {sorted(ctx.keys())}"
    )
    assert "review_history" in ctx, (
        f"prompt_context.json must contain review_history; "
        f"keys present: {sorted(ctx.keys())}"
    )
    assert ctx.get("review_issues"), (
        f"review_issues must be non-empty; got: {ctx.get('review_issues')}"
    )
    assert ctx.get("review_history"), (
        f"review_history must be non-empty; got: {ctx.get('review_history')}"
    )

    resumed = pipeline_env.run(_ALL_SUCCEED, extra_args=["--resume"], timeout=60)
    assert resumed.returncode == 0, (
        f"resume must complete cleanly; rc={resumed.returncode}\n"
        f"stderr: {resumed.stderr[:500]}"
    )
    assert resumed.status.get("pipeline_status") == "completed"
