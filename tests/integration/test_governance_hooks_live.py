"""W-050 Phase 2 — live governance hook coverage.

These tests drive the real ``claude_hooks/*.py`` entry-points as subprocesses
via ``pipeline_env.run_hook``. The mock-Claude pipeline never emits actual
tool calls, so end-to-end runs leave the hook layer at 0% coverage. Phase 2
plugs that gap by simulating the JSON stdin payload the Claude Code harness
would send for each event, with WORCA_AGENT and other governance env vars set
to a real agent identity (Phase 0's ``set_governance_agent`` helper).

Per W-050 plan rule #9, **no file under ``src/worca/claude_hooks/`` or
``src/worca/hooks/`` may be modified by Phase 2** — these tests exercise the
existing hook code unchanged.
"""
import json

from tests.integration.helpers import read_stub_log


# ---------------------------------------------------------------------------
# plan_check — Write/Edit blocked until MASTER_PLAN.md exists
# ---------------------------------------------------------------------------


def test_plan_check_blocks_py_write_without_master_plan(pipeline_env):
    """plan_check must block source-file Write when no MASTER_PLAN.md exists."""
    pipeline_env.set_governance_agent("implementer")
    proc = pipeline_env.run_hook(
        "pre_tool_use",
        {"tool_name": "Write", "tool_input": {
            "file_path": "src/feature.py",
            "content": "def f(): ...",
        }},
    )
    assert proc.returncode == 2, (
        f"expected block, got {proc.returncode}\nstderr: {proc.stderr[:500]}"
    )
    assert "Blocked" in proc.stderr
    assert "plan" in proc.stderr.lower()


def test_plan_check_allows_py_write_after_master_plan_exists(pipeline_env):
    """Once MASTER_PLAN.md is present, plan_check yields and Write is allowed."""
    (pipeline_env.project / "MASTER_PLAN.md").write_text("# plan\n")
    pipeline_env.set_governance_agent("implementer")
    proc = pipeline_env.run_hook(
        "pre_tool_use",
        {"tool_name": "Write", "tool_input": {
            "file_path": "src/feature.py",
            "content": "def f(): ...",
        }},
    )
    assert proc.returncode == 0, (
        f"unexpected block: {proc.stderr[:500]}"
    )


# ---------------------------------------------------------------------------
# guard — guardian-only `git commit`
# ---------------------------------------------------------------------------


def test_git_commit_blocked_for_non_guardian(pipeline_env):
    """Implementer attempting `git commit` must be blocked by check_guard."""
    pipeline_env.set_governance_agent("implementer")
    proc = pipeline_env.run_hook(
        "pre_tool_use",
        {"tool_name": "Bash", "tool_input": {
            "command": "git commit -m 'wip'",
        }},
    )
    assert proc.returncode == 2, (
        f"expected block, got {proc.returncode}\nstderr: {proc.stderr[:500]}"
    )
    assert "guardian" in proc.stderr.lower()
    assert "commit" in proc.stderr.lower()


def test_git_commit_allowed_for_guardian(pipeline_env):
    """Guardian role bypasses the commit gate (its job is creating PRs)."""
    pipeline_env.set_governance_agent("guardian")
    proc = pipeline_env.run_hook(
        "pre_tool_use",
        {"tool_name": "Bash", "tool_input": {
            "command": "git commit -m 'feat: ship it'",
        }},
    )
    assert proc.returncode == 0, (
        f"guardian should be allowed to commit; stderr: {proc.stderr[:500]}"
    )


# ---------------------------------------------------------------------------
# guard — planner restricted to plan files only
# ---------------------------------------------------------------------------


def test_planner_blocked_from_writing_source_files(pipeline_env):
    """Planner may only write plan files (MASTER_PLAN.md or plan-NNN.md)."""
    pipeline_env.set_governance_agent("planner")
    proc = pipeline_env.run_hook(
        "pre_tool_use",
        {"tool_name": "Write", "tool_input": {
            "file_path": "src/feature.py",
            "content": "x = 1",
        }},
    )
    assert proc.returncode == 2
    assert "planner" in proc.stderr.lower()


# ---------------------------------------------------------------------------
# guard — read-only roles (reviewer/tester/coordinator/plan_reviewer)
# ---------------------------------------------------------------------------


def test_reviewer_blocked_from_writing_files(pipeline_env):
    """Reviewer is read-only — any Write/Edit must be blocked, regardless of
    file type. Guards against the W-039 incident where reviewer was observed
    writing files to verify claims (now part of the read-only agent list)."""
    pipeline_env.set_governance_agent("reviewer")
    proc = pipeline_env.run_hook(
        "pre_tool_use",
        {"tool_name": "Write", "tool_input": {
            "file_path": "notes.txt",
            "content": "review notes",
        }},
    )
    assert proc.returncode == 2
    assert "reviewer" in proc.stderr.lower()
    assert "read-only" in proc.stderr.lower()


# ---------------------------------------------------------------------------
# guard — guardian source-file restriction (PRs, not patches)
# ---------------------------------------------------------------------------


def test_guardian_blocked_from_writing_source_files(pipeline_env):
    """Guardian's job is creating PRs, not editing code — Write to .py is
    blocked but .md is allowed (PR descriptions, release notes)."""
    pipeline_env.set_governance_agent("guardian")

    proc_py = pipeline_env.run_hook(
        "pre_tool_use",
        {"tool_name": "Write", "tool_input": {
            "file_path": "src/feature.py",
            "content": "x = 1",
        }},
    )
    assert proc_py.returncode == 2, (
        f"guardian must not write .py; got rc={proc_py.returncode}, "
        f"stderr: {proc_py.stderr[:300]}"
    )
    assert "guardian" in proc_py.stderr.lower()

    proc_md = pipeline_env.run_hook(
        "pre_tool_use",
        {"tool_name": "Write", "tool_input": {
            "file_path": "RELEASE_NOTES.md",
            "content": "# 0.1.0\n",
        }},
    )
    assert proc_md.returncode == 0, (
        f"guardian should be allowed to write .md; stderr: {proc_md.stderr[:300]}"
    )


# ---------------------------------------------------------------------------
# guard — WORCA_AGENT evasion blocked (governance bypass)
# ---------------------------------------------------------------------------


def test_env_evasion_blocked(pipeline_env):
    """Attempting to unset WORCA_AGENT before running a restricted command
    must be blocked — the role check would otherwise pass once the env var
    is gone. The guard runs the evasion check on the *raw* command (not the
    cd-stripped form) so left-of-`&&` evasions are caught."""
    pipeline_env.set_governance_agent("implementer")
    proc = pipeline_env.run_hook(
        "pre_tool_use",
        {"tool_name": "Bash", "tool_input": {
            "command": "unset WORCA_AGENT && echo bypass",
        }},
    )
    assert proc.returncode == 2
    assert "WORCA_AGENT" in proc.stderr or "evasion" in proc.stderr.lower()


# ---------------------------------------------------------------------------
# guard — force push blocked (role-independent)
# ---------------------------------------------------------------------------


def test_force_push_blocked(pipeline_env):
    """`git push --force` is blocked regardless of role — protects shared
    branches from history rewrites. Runs as guardian to also confirm the
    block fires even for the role normally allowed to push."""
    pipeline_env.set_governance_agent("guardian")
    proc = pipeline_env.run_hook(
        "pre_tool_use",
        {"tool_name": "Bash", "tool_input": {
            "command": "git push --force origin master",
        }},
    )
    assert proc.returncode == 2
    assert "force" in proc.stderr.lower()


# ---------------------------------------------------------------------------
# tracking — subagent dispatch denylist
# ---------------------------------------------------------------------------


def test_dispatch_blocks_denylisted_subagent(pipeline_env):
    """`general-purpose` is unconditionally denylisted, even when settings
    would allow it. The denylist is enforced before the per-agent allow-list."""
    pipeline_env.set_governance_agent("implementer")
    proc = pipeline_env.run_hook(
        "subagent_start",
        {"agent_type": "general-purpose"},
    )
    assert proc.returncode == 2, (
        f"expected denylist block, got {proc.returncode}\n"
        f"stderr: {proc.stderr[:500]}"
    )
    assert "denylist" in proc.stderr.lower() or "blocked" in proc.stderr.lower()


# ---------------------------------------------------------------------------
# bd_create_hook — link new bead to current run via `run:<id>` label
# ---------------------------------------------------------------------------


def test_bd_create_hook_links_run_id_to_new_bead(pipeline_env):
    """post_tool_use scans `bd create` stdout for `Created issue: <id>` and
    invokes `bd label add <id> run:<run_id>` to tie the bead to the run.
    The bd stub records each invocation; we assert on the JSONL log."""
    pipeline_env.enable_beads()
    proc = pipeline_env.run_hook(
        "post_tool_use",
        {
            "tool_name": "Bash",
            "tool_input": {"command": "bd create --title='x' --type=task"},
            "tool_response": {
                "stdout": "Created issue: B-042\n",
                "exit_code": 0,
            },
        },
        env_overrides={"WORCA_RUN_ID": "test-run-9"},
    )
    assert proc.returncode == 0, (
        f"post_tool_use should not block on a successful bd create; "
        f"stderr: {proc.stderr[:500]}"
    )

    invocations = read_stub_log(pipeline_env.stub_log_path)
    label_calls = [
        inv for inv in invocations
        if inv["binary"] == "bd"
        and inv["argv"][:2] == ["label", "add"]
    ]
    assert len(label_calls) == 1, (
        f"expected exactly one `bd label add` invocation, got {len(label_calls)}\n"
        f"all invocations: {invocations}"
    )
    assert label_calls[0]["argv"] == ["label", "add", "B-042", "run:test-run-9"]


# ---------------------------------------------------------------------------
# test_gate — escalating strikes on consecutive pytest failures
# ---------------------------------------------------------------------------


def test_test_gate_warns_then_blocks_on_two_failures(pipeline_env, tmp_path):
    """First pytest failure warns (exit 0); second consecutive failure blocks
    (exit 2). State persists in $WORCA_RUN_DIR/test_gate_strikes.json so the
    second invocation reads the count the first one wrote."""
    run_dir = tmp_path / "phase2_run_dir"
    run_dir.mkdir()

    payload = {
        "tool_name": "Bash",
        "tool_input": {"command": "pytest tests/"},
        "tool_response": {"exit_code": 1},
    }

    first = pipeline_env.run_hook(
        "post_tool_use", payload,
        env_overrides={"WORCA_RUN_DIR": str(run_dir)},
    )
    assert first.returncode == 0, (
        f"first failure must warn (exit 0), got {first.returncode}\n"
        f"stderr: {first.stderr[:500]}"
    )
    assert "strike 1" in first.stderr.lower() or "warning" in first.stderr.lower()

    state_file = run_dir / "test_gate_strikes.json"
    assert state_file.exists(), "first invocation must persist strike state"
    assert json.loads(state_file.read_text()) == {"strikes": 1}

    second = pipeline_env.run_hook(
        "post_tool_use", payload,
        env_overrides={"WORCA_RUN_DIR": str(run_dir)},
    )
    assert second.returncode == 2, (
        f"second failure must block (exit 2), got {second.returncode}\n"
        f"stderr: {second.stderr[:500]}"
    )
    assert "blocked" in second.stderr.lower()
    assert "consecutive" in second.stderr.lower()
