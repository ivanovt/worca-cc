"""Integration tests for W-037: resolve_agent() golden-fragment tests per stage × mode.

Verifies that the full resolve_agent() pipeline — block insertion + placeholder
resolution — produces output containing expected content fragments for each stage.

Uses real block files and agent .md templates from src/worca/agents/core/.
"""

import pathlib

import pytest

from worca.orchestrator.overlay import OverlayResolver, resolve_agent

CORE_DIR = pathlib.Path(__file__).parent.parent / "src" / "worca" / "agents" / "core"


def _make_resolver(core_dir: pathlib.Path) -> OverlayResolver:
    """Build a resolver with no project overrides (uses only core tier)."""
    resolver = OverlayResolver(overrides_dir="/nonexistent/no/project/overrides")
    return resolver


def _load_agent(agent_name: str) -> str:
    return (CORE_DIR / f"{agent_name}.md").read_text()


def _resolve(agent_name: str, context: dict, core_dir: pathlib.Path = CORE_DIR) -> str:
    resolver = _make_resolver(core_dir)
    agent_content = _load_agent(agent_name)
    return resolve_agent(agent_content, context, resolver, str(core_dir))


# ---------------------------------------------------------------------------
# Plan stage — initial (no revision)
# ---------------------------------------------------------------------------


def test_plan_initial_contains_work_request():
    result = _resolve("planner", {
        "plan_file": "MASTER_PLAN.md",
        "work_request": "Add user authentication",
        "claude_md": "",
    })
    assert "Add user authentication" in result


def test_plan_initial_contains_plan_file():
    result = _resolve("planner", {
        "plan_file": "docs/plans/W-001-auth.md",
        "work_request": "Add auth",
        "claude_md": "",
    })
    assert "docs/plans/W-001-auth.md" in result


def test_plan_initial_contains_governance():
    result = _resolve("planner", {
        "plan_file": "MASTER_PLAN.md",
        "work_request": "Add auth",
        "claude_md": "",
    })
    assert "Do NOT write implementation" in result


def test_plan_initial_contains_output_schema():
    result = _resolve("planner", {
        "plan_file": "MASTER_PLAN.md",
        "work_request": "Add auth",
        "claude_md": "",
    })
    assert "plan.json" in result


def test_plan_initial_includes_claude_md_when_provided():
    result = _resolve("planner", {
        "plan_file": "MASTER_PLAN.md",
        "work_request": "Add auth",
        "claude_md": "# My Project\n\nUses FastAPI.",
    })
    assert "# My Project" in result
    assert "FastAPI" in result


def test_plan_initial_omits_claude_md_section_when_empty():
    result = _resolve("planner", {
        "plan_file": "MASTER_PLAN.md",
        "work_request": "Add auth",
        "claude_md": "",
    })
    assert "Project Context (from CLAUDE.md)" not in result


def test_plan_initial_no_unresolved_placeholders():
    result = _resolve("planner", {
        "plan_file": "MASTER_PLAN.md",
        "work_request": "Add auth",
        "claude_md": "",
    })
    assert "{{block:" not in result
    assert "{{plan_file}}" not in result


# ---------------------------------------------------------------------------
# Plan stage — revision mode
# ---------------------------------------------------------------------------


def test_plan_revision_contains_work_request():
    result = _resolve("planner", {
        "plan_file": "MASTER_PLAN.md",
        "work_request": "Add user authentication",
        "plan_revision_mode": True,
        "plan_content": "# Plan v1\n\nPhase 1...",
        "plan_review_issues_formatted": "1. [major] Missing error handling",
        "plan_review_history_formatted": "",
    })
    assert "Add user authentication" in result


def test_plan_revision_shows_revision_header():
    result = _resolve("planner", {
        "plan_file": "MASTER_PLAN.md",
        "work_request": "Add auth",
        "plan_revision_mode": True,
        "plan_content": "# Plan v1",
        "plan_review_issues_formatted": "1. [major] Issue here",
        "plan_review_history_formatted": "",
    })
    assert "Revision" in result


def test_plan_revision_contains_current_plan():
    result = _resolve("planner", {
        "plan_file": "MASTER_PLAN.md",
        "work_request": "Add auth",
        "plan_revision_mode": True,
        "plan_content": "# Plan v1\n\nMy special plan content",
        "plan_review_issues_formatted": "",
        "plan_review_history_formatted": "",
    })
    assert "My special plan content" in result


def test_plan_revision_contains_issues():
    result = _resolve("planner", {
        "plan_file": "MASTER_PLAN.md",
        "work_request": "Add auth",
        "plan_revision_mode": True,
        "plan_content": "# Plan",
        "plan_review_issues_formatted": "1. [critical] Security flaw in auth",
        "plan_review_history_formatted": "",
    })
    assert "Security flaw in auth" in result


# ---------------------------------------------------------------------------
# Coordinate stage
# ---------------------------------------------------------------------------


def test_coordinator_system_prompt_excludes_work_request():
    # The work request is delivered via the -p user message (see runner.py
    # special-case for COORDINATE stage), NOT embedded in the coordinator's
    # system prompt. Embedding it caused a role-violation regression where
    # the coordinator started implementing instead of decomposing.
    result = _resolve("coordinator", {
        "plan_file": "MASTER_PLAN.md",
        "run_id": "run-20260411",
        "work_request": "Add user authentication",
        "plan_summary": "",
    })
    assert "Add user authentication" not in result


def test_coordinate_contains_plan_file():
    result = _resolve("coordinator", {
        "plan_file": "docs/plans/W-001.md",
        "run_id": "run-abc",
        "work_request": "Add auth",
        "plan_summary": "",
    })
    assert "docs/plans/W-001.md" in result


def test_coordinate_contains_run_id():
    result = _resolve("coordinator", {
        "plan_file": "MASTER_PLAN.md",
        "run_id": "run-xyz-99",
        "work_request": "Add auth",
        "plan_summary": "",
    })
    assert "run-xyz-99" in result


def test_coordinate_contains_governance():
    result = _resolve("coordinator", {
        "plan_file": "MASTER_PLAN.md",
        "run_id": "run-1",
        "work_request": "Add auth",
        "plan_summary": "",
    })
    assert "Do NOT write implementation" in result


def test_coordinator_system_prompt_excludes_plan_summary():
    # Like the work request, plan_summary is delivered via the -p user message
    # (see coordinate.block.md), not in the coordinator's system prompt.
    result = _resolve("coordinator", {
        "plan_file": "MASTER_PLAN.md",
        "run_id": "run-1",
        "work_request": "Add auth",
        "plan_summary": "Use JWT tokens. Tasks: auth module, middleware.",
    })
    assert "Use JWT tokens" not in result


def test_coordinate_no_unresolved_placeholders():
    result = _resolve("coordinator", {
        "plan_file": "MASTER_PLAN.md",
        "run_id": "run-1",
        "work_request": "Add auth",
        "plan_summary": "",
    })
    assert "{{block:" not in result
    assert "{{plan_file}}" not in result
    assert "{{run_id}}" not in result


# ---------------------------------------------------------------------------
# Implement stage — initial
# ---------------------------------------------------------------------------


def test_implement_initial_contains_work_request():
    result = _resolve("implementer", {
        "is_retry": False,
        "work_request": "Add user authentication",
        "assigned_task": "",
    })
    assert "Add user authentication" in result


def test_implement_initial_no_retry_header():
    result = _resolve("implementer", {
        "is_retry": False,
        "work_request": "Add auth",
        "assigned_task": "",
    })
    assert "PRIORITY: Fix" not in result


def test_implement_initial_contains_assigned_task_when_present():
    result = _resolve("implementer", {
        "is_retry": False,
        "work_request": "Add auth",
        "assigned_task": "**worca-abc123**: Create JWT middleware",
    })
    assert "worca-abc123" in result
    assert "Create JWT middleware" in result


def test_implement_initial_no_unresolved_placeholders():
    result = _resolve("implementer", {
        "is_retry": False,
        "work_request": "Add auth",
        "assigned_task": "",
    })
    assert "{{block:" not in result
    assert "{{is_retry}}" not in result


# ---------------------------------------------------------------------------
# Implement stage — retry
# ---------------------------------------------------------------------------


def test_implement_retry_contains_priority_header():
    result = _resolve("implementer", {
        "is_retry": True,
        "issue_type": "Test Failures",
        "attempt_count": "2",
        "test_failures_formatted": "1. **test_auth** — AssertionError: 401 != 200",
        "review_issues_formatted": "",
        "previous_attempts": "",
        "assigned_task": "",
        "work_request": "Add auth",
    })
    assert "PRIORITY: Fix Test Failures" in result


def test_implement_retry_contains_attempt_count():
    result = _resolve("implementer", {
        "is_retry": True,
        "issue_type": "Test Failures",
        "attempt_count": "3",
        "test_failures_formatted": "1. **test_x** — error",
        "review_issues_formatted": "",
        "previous_attempts": "",
        "assigned_task": "",
        "work_request": "Add auth",
    })
    assert "3" in result


def test_implement_retry_contains_failures():
    result = _resolve("implementer", {
        "is_retry": True,
        "issue_type": "Test Failures",
        "attempt_count": "2",
        "test_failures_formatted": "1. **test_login** — AssertionError: 401 != 200",
        "review_issues_formatted": "",
        "previous_attempts": "",
        "assigned_task": "",
        "work_request": "Add auth",
    })
    assert "test_login" in result
    assert "401 != 200" in result


def test_implement_retry_review_issues_mode():
    result = _resolve("implementer", {
        "is_retry": True,
        "issue_type": "Review Issues",
        "attempt_count": "1",
        "test_failures_formatted": "",
        "review_issues_formatted": "1. [critical] `auth.py:42` — SQL injection",
        "previous_attempts": "",
        "assigned_task": "",
        "work_request": "Add auth",
    })
    assert "Review Issues" in result
    assert "SQL injection" in result


# ---------------------------------------------------------------------------
# Review stage
# ---------------------------------------------------------------------------


def test_review_contains_work_request():
    result = _resolve("reviewer", {
        "work_request": "Add user authentication",
        "test_results": "",
        "files_changed_formatted": "",
    })
    assert "Add user authentication" in result


def test_review_contains_test_results_when_present():
    result = _resolve("reviewer", {
        "work_request": "Add auth",
        "test_results": "**Status:** PASSED\n**Coverage:** 87.5%",
        "files_changed_formatted": "",
    })
    assert "PASSED" in result
    assert "87.5%" in result


def test_review_contains_files_changed_when_present():
    result = _resolve("reviewer", {
        "work_request": "Add auth",
        "test_results": "",
        "files_changed_formatted": "- auth.py\n- middleware.py",
    })
    assert "auth.py" in result
    assert "middleware.py" in result


def test_review_contains_output_schema():
    result = _resolve("reviewer", {
        "work_request": "Add auth",
        "test_results": "",
        "files_changed_formatted": "",
    })
    assert "review.json" in result


def test_review_no_unresolved_placeholders():
    result = _resolve("reviewer", {
        "work_request": "Add auth",
        "test_results": "",
        "files_changed_formatted": "",
    })
    assert "{{block:" not in result


# ---------------------------------------------------------------------------
# No raw block tokens remain after resolution
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("agent_name,context", [
    ("planner", {"plan_file": "p.md", "work_request": "WR", "claude_md": ""}),
    ("plan_reviewer", {"work_request": "WR", "plan_content": "# Plan", "plan_review_history_formatted": ""}),
    ("coordinator", {"plan_file": "p.md", "run_id": "r1", "work_request": "WR", "plan_summary": ""}),
    ("implementer", {"is_retry": False, "work_request": "WR", "assigned_task": ""}),
    ("tester", {"work_request": "WR", "implementation_summary": ""}),
    ("reviewer", {"work_request": "WR", "test_results": "", "files_changed_formatted": ""}),
    ("guardian", {"work_request": "WR", "plan_approach": ""}),
    ("learner", {"work_request": "WR", "termination_type": "success", "termination_reason": "", "plan_content": "", "run_id": "r1", "run_data": "{}"}),
])
def test_no_unresolved_block_tokens(agent_name, context):
    """After resolution, no {{block:...}} tokens should remain."""
    result = _resolve(agent_name, context)
    assert "{{block:" not in result, (
        f"Agent '{agent_name}' resolved output still contains {{{{block:...}}}} tokens"
    )
