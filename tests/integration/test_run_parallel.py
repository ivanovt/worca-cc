"""W-050 Phase 3 — `run_parallel.py` integration coverage.

Drives ``python -m worca.scripts.run_parallel --prompts ...`` via
``pipeline_env.run_parallel``. Unlike ``run_worktree`` (fire-and-forget),
``run_parallel`` is synchronous from the caller's perspective: it spawns N
pipeline subprocesses through a ProcessPoolExecutor and waits for them all
via ``as_completed`` before printing a summary and exiting.

The mock-claude scenario is shared across all parallel pipelines (mock_claude
is keyed on agent role, not prompt), so a scenario that succeeds applies
uniformly and a scenario that fails fails uniformly — which gives us the
right shape of "all-OK" and "all-failed" tests for the executor's per-task
result handling.

Setup note: ``run_parallel.py`` does NOT copy ``.claude/`` into the new
worktrees the way ``run_worktree.py`` does — it relies on the runtime being
present in tracked files. The fixture-installed ``.claude/`` is untracked by
default, so each test commits it before running so ``git worktree add`` will
populate the runtime in the new worktree's working tree.
"""
from __future__ import annotations

import subprocess



def _commit_claude_runtime(project) -> None:
    """Commit .claude/ so `git worktree add` includes the runtime.

    run_parallel.py expects .claude/worca/scripts/run_pipeline.py to exist in
    each created worktree's cwd, but git worktrees only inherit *tracked*
    files. The integration fixture installs .claude/ via `worca init` but
    leaves it untracked (matching real-world projects that gitignore .claude/).
    Tests that exercise run_parallel.py compensate by committing the runtime
    once at test setup; tests for run_worktree don't need this because that
    script copies .claude/ into the new worktree explicitly.
    """
    subprocess.run(["git", "add", ".claude"], cwd=str(project),
                   check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "test: add .claude runtime"],
                   cwd=str(project), check=True, capture_output=True)


_HAPPY = {"default": {"action": "succeed", "delay_s": 0}}

# Scenario where the tester always fails — the pipeline should retry up to
# the configured cap and end up reporting failure. The integration fixture
# sets max iterations low so this resolves quickly.
_TESTER_FAILS = {
    "agents": {
        "tester": {"action": "fail", "result_text": "boom"},
    },
    "default": {"action": "succeed", "delay_s": 0},
}


def test_run_parallel_completes_two_prompts(pipeline_env):
    """Two parallel prompts both run to completion and return rc=0 from
    run_parallel.py. The summary contains one entry per prompt with the
    worktree path and the inner pipeline's returncode."""
    _commit_claude_runtime(pipeline_env.project)
    result = pipeline_env.run_parallel(_HAPPY, prompts=["task one", "task two"])

    assert result.returncode == 0, (
        f"run_parallel should exit 0 when all pipelines succeed; "
        f"stderr: {result.stderr[:500]}"
    )
    assert len(result.summary) == 2
    for entry in result.summary:
        assert entry["returncode"] == 0, (
            f"per-prompt entry should report rc=0; got {entry}"
        )
        assert entry.get("worktree"), "summary entry must include worktree path"
        assert entry.get("prompt"), "summary entry must include the prompt"


def test_run_parallel_aggregates_per_prompt_failures(pipeline_env):
    """When the shared scenario causes every pipeline to fail, run_parallel
    must still finish, return rc=1, and produce one summary entry per prompt
    — i.e. one task's failure does NOT abort the others. This exercises the
    executor's ``except Exception`` / non-zero-rc handling at runner.py line
    197 onward."""
    _commit_claude_runtime(pipeline_env.project)
    result = pipeline_env.run_parallel(
        _TESTER_FAILS, prompts=["fail one", "fail two"],
    )

    assert result.returncode == 1, (
        f"run_parallel must return rc=1 when any pipeline fails; "
        f"got {result.returncode}\nstderr: {result.stderr[:500]}"
    )
    assert len(result.summary) == 2, (
        f"summary must have one entry per prompt even on failure; "
        f"got {len(result.summary)}: {result.summary}"
    )
    # Every entry should report a non-zero returncode (or an explicit error
    # field if the executor caught an exception); the executor must not have
    # silently dropped any prompt.
    for entry in result.summary:
        rc = entry.get("returncode")
        assert rc != 0, (
            f"failed scenario should produce non-zero rc per prompt; got {entry}"
        )


def test_run_parallel_summary_json_shape(pipeline_env):
    """The summary file at ``.worktrees/parallel-results.json`` is a list of
    dicts with stable keys (worktree, prompt, returncode, stdout, stderr).
    Downstream tooling (run reports, fleet UI) depends on this shape."""
    _commit_claude_runtime(pipeline_env.project)
    result = pipeline_env.run_parallel(_HAPPY, prompts=["shape test"])

    assert result.returncode == 0
    assert isinstance(result.summary, list)
    assert len(result.summary) == 1

    entry = result.summary[0]
    expected_keys = {"worktree", "prompt", "returncode", "stdout", "stderr"}
    assert expected_keys.issubset(entry.keys()), (
        f"summary entry missing keys; got {sorted(entry.keys())}, "
        f"expected superset of {sorted(expected_keys)}"
    )
    assert isinstance(entry["returncode"], int)
    assert isinstance(entry["stdout"], str)
    assert isinstance(entry["stderr"], str)
