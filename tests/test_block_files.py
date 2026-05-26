"""Tests for W-037 T3: 8 block files in src/worca/agents/core/.

Verifies each block file exists and contains expected placeholder tokens.
"""

import pathlib

import pytest

CORE_DIR = pathlib.Path(__file__).parent.parent / "src" / "worca" / "agents" / "core"

BLOCK_FILES = [
    "plan.block.md",
    "plan-review.block.md",
    "coordinate.block.md",
    "implement.block.md",
    "test.block.md",
    "review.block.md",
    "pr.block.md",
    "learn.block.md",
]


@pytest.mark.parametrize("filename", BLOCK_FILES)
def test_block_file_exists(filename):
    assert (CORE_DIR / filename).exists(), f"{filename} not found in {CORE_DIR}"


def _read(filename):
    return (CORE_DIR / filename).read_text()


# ---------------------------------------------------------------------------
# plan.block.md
# ---------------------------------------------------------------------------


def test_plan_block_has_work_request():
    content = _read("plan.block.md")
    assert "{{work_request}}" in content


def test_plan_block_has_revision_conditional():
    content = _read("plan.block.md")
    assert "{{#if plan_revision_mode}}" in content
    assert "{{/if}}" in content


def test_plan_block_has_plan_content_conditional():
    content = _read("plan.block.md")
    assert "{{#if plan_content}}" in content


def test_plan_block_has_plan_review_issues():
    content = _read("plan.block.md")
    assert "{{#if plan_review_issues_formatted}}" in content


def test_plan_block_has_plan_review_history():
    content = _read("plan.block.md")
    assert "{{#if plan_review_history_formatted}}" in content


def test_plan_block_has_claude_md_conditional():
    content = _read("plan.block.md")
    assert "{{#if claude_md}}" in content


# ---------------------------------------------------------------------------
# plan-review.block.md
# ---------------------------------------------------------------------------


def test_plan_review_block_has_work_request():
    content = _read("plan-review.block.md")
    assert "{{work_request}}" in content


def test_plan_review_block_has_plan_content_conditional():
    content = _read("plan-review.block.md")
    assert "{{#if plan_content}}" in content


def test_plan_review_block_has_history_conditional():
    content = _read("plan-review.block.md")
    assert "{{#if plan_review_history_formatted}}" in content


def test_plan_review_block_has_convergence_directive():
    content = _read("plan-review.block.md")
    assert "verify convergence" in content


def test_plan_review_block_convergence_inside_history_conditional():
    content = _read("plan-review.block.md")
    if_tag = "{{#if plan_review_history_formatted}}"
    endif_tag = "{{/if}}"
    start = content.index(if_tag)
    end = content.index(endif_tag, start)
    history_block = content[start:end]
    assert "verify convergence" in history_block


# ---------------------------------------------------------------------------
# coordinate.block.md
# ---------------------------------------------------------------------------


def test_coordinate_block_has_work_request():
    content = _read("coordinate.block.md")
    assert "{{work_request}}" in content


def test_coordinate_block_has_plan_summary_conditional():
    content = _read("coordinate.block.md")
    assert "{{#if plan_summary}}" in content


def test_coordinate_block_has_unresolved_plan_issues_conditional():
    content = _read("coordinate.block.md")
    assert "{{#if unresolved_plan_issues_formatted}}" in content


# ---------------------------------------------------------------------------
# implement.block.md
# ---------------------------------------------------------------------------


def test_implement_block_has_work_request():
    content = _read("implement.block.md")
    assert "{{work_request}}" in content


def test_implement_block_has_retry_conditional():
    content = _read("implement.block.md")
    assert "{{#if is_retry}}" in content
    assert "{{/if}}" in content


def test_implement_block_has_test_failures_conditional():
    content = _read("implement.block.md")
    assert "{{#if test_failures_formatted}}" in content


def test_implement_block_has_review_issues_conditional():
    content = _read("implement.block.md")
    assert "{{#if review_issues_formatted}}" in content


def test_implement_block_has_issue_type():
    content = _read("implement.block.md")
    assert "{{issue_type}}" in content


def test_implement_block_has_attempt_count():
    content = _read("implement.block.md")
    assert "{{attempt_count}}" in content


def test_implement_block_has_assigned_task_conditional():
    content = _read("implement.block.md")
    assert "{{#if assigned_task}}" in content


# ---------------------------------------------------------------------------
# test.block.md
# ---------------------------------------------------------------------------


def test_test_block_has_work_request():
    content = _read("test.block.md")
    assert "{{work_request}}" in content


def test_test_block_has_implementation_summary_conditional():
    content = _read("test.block.md")
    assert "{{#if implementation_summary}}" in content


# ---------------------------------------------------------------------------
# review.block.md
# ---------------------------------------------------------------------------


def test_review_block_has_work_request():
    content = _read("review.block.md")
    assert "{{work_request}}" in content


def test_review_block_has_test_results_conditional():
    content = _read("review.block.md")
    assert "{{#if test_results}}" in content


def test_review_block_has_files_changed_conditional():
    content = _read("review.block.md")
    assert "{{#if files_changed_formatted}}" in content


# ---------------------------------------------------------------------------
# pr.block.md
# ---------------------------------------------------------------------------


def test_pr_block_has_work_request():
    content = _read("pr.block.md")
    assert "{{work_request}}" in content


def test_pr_block_has_plan_approach_conditional():
    content = _read("pr.block.md")
    assert "{{#if plan_approach}}" in content


# ---------------------------------------------------------------------------
# learn.block.md
# ---------------------------------------------------------------------------


def test_learn_block_has_work_request():
    content = _read("learn.block.md")
    assert "{{work_request}}" in content


def test_learn_block_has_termination_type():
    content = _read("learn.block.md")
    assert "{{termination_type" in content


def test_learn_block_has_termination_reason_conditional():
    content = _read("learn.block.md")
    assert "{{#if termination_reason}}" in content


def test_learn_block_has_plan_content_conditional():
    content = _read("learn.block.md")
    assert "{{#if plan_content}}" in content


def test_learn_block_has_run_id():
    content = _read("learn.block.md")
    assert "{{run_id}}" in content


def test_learn_block_has_run_data():
    content = _read("learn.block.md")
    assert "{{run_data}}" in content
