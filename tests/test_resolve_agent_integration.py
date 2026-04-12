"""Integration tests for agent .md + block resolution.

Post channel-separation restoration (see runner.py _STAGE_BLOCK_MAP), the
agent .md files carry only static role/process/rules content — the per-run
block content travels via the -p user message. These tests split into two
suites:

1. Agent .md resolution (resolve_agent) — static content only; verifies
   placeholders like {{plan_file}} / {{run_id}} resolve, governance rules
   survive, and NO dynamic content (work_request, plan, failures, etc.)
   leaks into the system prompt.

2. Block resolution (resolve_block + resolve_placeholders) — verifies each
   .block.md renders the expected dynamic content for its stage.
"""

import pathlib

import pytest

from worca.orchestrator.overlay import (
    OverlayResolver,
    resolve_agent,
    resolve_placeholders,
)

CORE_DIR = pathlib.Path(__file__).parent.parent / "src" / "worca" / "agents" / "core"


def _make_resolver() -> OverlayResolver:
    return OverlayResolver(overrides_dir="/nonexistent/no/project/overrides")


def _load_agent(agent_name: str) -> str:
    return (CORE_DIR / f"{agent_name}.md").read_text()


def _resolve_agent(agent_name: str, context: dict) -> str:
    resolver = _make_resolver()
    return resolve_agent(_load_agent(agent_name), context, resolver, str(CORE_DIR))


def _resolve_block(block_name: str, context: dict) -> str:
    resolver = _make_resolver()
    raw = resolver.resolve_block(block_name, str(CORE_DIR))
    assert raw is not None, f"block '{block_name}' not found under {CORE_DIR}"
    return resolve_placeholders(raw, context)


# ---------------------------------------------------------------------------
# Agent .md — static role/rules only; no dynamic content leakage
# ---------------------------------------------------------------------------


_DYNAMIC_KEYS_BY_AGENT = {
    "planner":       ["Add user authentication", "# Plan v1", "My special plan content"],
    "plan_reviewer": ["Add user authentication", "# Plan under review"],
    "coordinator":   ["Add user authentication", "Use JWT tokens"],
    "implementer":   ["Add user authentication", "Create JWT middleware",
                      "401 != 200", "SQL injection"],
    "tester":        ["Add user authentication", "files: auth.py"],
    "reviewer":      ["Add user authentication", "PASSED", "auth.py"],
    "guardian":      ["Add user authentication", "JWT approach"],
    "learner":       ["Add user authentication", "run-xyz-99", '{"foo": 1}'],
}


@pytest.mark.parametrize("agent_name,needles", list(_DYNAMIC_KEYS_BY_AGENT.items()))
def test_agent_md_excludes_dynamic_content(agent_name, needles):
    """Agent .md must not embed any run-specific content — that lives in -p."""
    # Context values are deliberately supplied; they must be dropped on the floor
    # because the agent .md no longer embeds {{block:X}}.
    ctx = {
        "plan_file": "MASTER_PLAN.md",
        "run_id": "run-xyz-99",
        "work_request": "Add user authentication",
        "claude_md": "# Project CLAUDE.md content",
        "plan_content": "# Plan v1\n\nMy special plan content",
        "plan_summary": "Use JWT tokens. Tasks: auth module.",
        "plan_revision_mode": True,
        "plan_review_issues_formatted": "1. Missing error handling",
        "plan_review_history_formatted": "- Attempt 1: issue",
        "is_retry": True,
        "issue_type": "Test Failures",
        "attempt_count": "2",
        "test_failures_formatted": "1. **test_login** — AssertionError: 401 != 200",
        "review_issues_formatted": "1. [critical] `auth.py:42` — SQL injection",
        "previous_attempts": "",
        "assigned_task": "**worca-abc123**: Create JWT middleware",
        "test_results": "**Status:** PASSED",
        "files_changed_formatted": "- auth.py\n- middleware.py",
        "implementation_summary": "files: auth.py changed",
        "plan_approach": "JWT approach with refresh tokens",
        "termination_type": "success",
        "termination_reason": "",
        "run_data": '{"foo": 1}',
    }
    result = _resolve_agent(agent_name, ctx)
    for needle in needles:
        assert needle not in result, (
            f"{agent_name}.md leaked dynamic content '{needle}' into system prompt"
        )


def test_planner_agent_md_has_placeholder_resolved():
    result = _resolve_agent("planner", {"plan_file": "docs/plans/W-001-auth.md"})
    assert "docs/plans/W-001-auth.md" in result


def test_planner_agent_md_keeps_governance():
    result = _resolve_agent("planner", {"plan_file": "p.md"})
    assert "Do NOT write implementation" in result


def test_coordinator_agent_md_has_placeholders_resolved():
    result = _resolve_agent("coordinator", {"plan_file": "docs/plans/W-001.md", "run_id": "run-xyz-99"})
    assert "docs/plans/W-001.md" in result
    assert "run-xyz-99" in result


def test_coordinator_agent_md_keeps_governance():
    result = _resolve_agent("coordinator", {"plan_file": "p.md", "run_id": "r1"})
    assert "Do NOT write implementation" in result


def test_reviewer_agent_md_references_output_schema():
    result = _resolve_agent("reviewer", {})
    assert "review.json" in result


@pytest.mark.parametrize("agent_name,context", [
    ("planner", {"plan_file": "p.md"}),
    ("plan_reviewer", {}),
    ("coordinator", {"plan_file": "p.md", "run_id": "r1"}),
    ("implementer", {}),
    ("tester", {}),
    ("reviewer", {}),
    ("guardian", {}),
    ("learner", {}),
])
def test_agent_md_no_unresolved_block_tokens(agent_name, context):
    result = _resolve_agent(agent_name, context)
    assert "{{block:" not in result, (
        f"Agent '{agent_name}' resolved output still contains {{{{block:...}}}} tokens"
    )


# ---------------------------------------------------------------------------
# Block resolution — dynamic content flows through -p user message
# ---------------------------------------------------------------------------


def test_plan_block_initial_contains_work_request():
    result = _resolve_block("plan", {
        "work_request": "Add user authentication",
        "claude_md": "",
        "plan_revision_mode": False,
    })
    assert "Add user authentication" in result


def test_plan_block_includes_claude_md_when_provided():
    result = _resolve_block("plan", {
        "work_request": "Add auth",
        "claude_md": "# My Project\n\nUses FastAPI.",
        "plan_revision_mode": False,
    })
    assert "# My Project" in result and "FastAPI" in result


def test_plan_block_revision_contains_current_plan_and_issues():
    result = _resolve_block("plan", {
        "work_request": "Add auth",
        "plan_revision_mode": True,
        "plan_content": "# Plan v1\n\nMy special plan content",
        "plan_review_issues_formatted": "1. [critical] Security flaw in auth",
    })
    assert "My special plan content" in result
    assert "Security flaw in auth" in result


def test_coordinate_block_contains_work_request():
    result = _resolve_block("coordinate", {
        "work_request": "Add user authentication",
        "plan_summary": "",
    })
    assert "Add user authentication" in result


def test_coordinate_block_includes_plan_summary_when_present():
    result = _resolve_block("coordinate", {
        "work_request": "Add auth",
        "plan_summary": "Use JWT tokens. Tasks: auth module, middleware.",
    })
    assert "Use JWT tokens" in result


def test_coordinate_block_carries_decompose_framing():
    result = _resolve_block("coordinate", {"work_request": "X", "plan_summary": ""})
    # Must explicitly frame content as reference, not instructions (regression guard).
    assert "decompose" in result.lower()
    assert "do not implement" in result.lower() or "NOT implement" in result


def test_implement_block_initial_contains_work_request_and_task():
    result = _resolve_block("implement", {
        "is_retry": False,
        "work_request": "Add user authentication",
        "assigned_task": "**worca-abc123**: Create JWT middleware",
    })
    assert "Add user authentication" in result
    assert "worca-abc123" in result and "Create JWT middleware" in result


def test_implement_block_retry_contains_priority_and_failures():
    result = _resolve_block("implement", {
        "is_retry": True,
        "issue_type": "Test Failures",
        "attempt_count": "2",
        "test_failures_formatted": "1. **test_login** — AssertionError: 401 != 200",
        "review_issues_formatted": "",
        "previous_attempts": "",
        "assigned_task": "",
        "work_request": "Add auth",
    })
    assert "PRIORITY: Fix Test Failures" in result
    assert "test_login" in result and "401 != 200" in result


def test_implement_block_retry_review_issues_mode():
    result = _resolve_block("implement", {
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


def test_review_block_contains_work_request_and_test_results():
    result = _resolve_block("review", {
        "work_request": "Add user authentication",
        "test_results": "**Status:** PASSED\n**Coverage:** 87.5%",
        "files_changed_formatted": "- auth.py\n- middleware.py",
    })
    assert "Add user authentication" in result
    assert "PASSED" in result and "87.5%" in result
    assert "auth.py" in result and "middleware.py" in result


def test_plan_review_block_contains_read_only_framing():
    result = _resolve_block("plan-review", {
        "work_request": "Add auth",
        "plan_content": "# Plan v1",
        "plan_review_history_formatted": "",
    })
    assert "read-only analyst" in result.lower() or "do NOT modify" in result


def test_learn_block_contains_postmortem_framing_and_run_data():
    result = _resolve_block("learn", {
        "work_request": "Add auth",
        "termination_type": "success",
        "termination_reason": "",
        "plan_content": "",
        "run_id": "run-xyz-99",
        "run_data": '{"foo": 1}',
    })
    assert "post-mortem" in result.lower()
    assert "run-xyz-99" in result
    assert '{"foo": 1}' in result
