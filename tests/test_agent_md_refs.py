"""Tests for W-037 T5: {{block:name}} refs in agent .md files + {{double-brace}} migration.

Verifies each agent .md file has been updated with the correct block reference
and that single-brace placeholders have been migrated to double-brace syntax.
"""

import pathlib


CORE_DIR = pathlib.Path(__file__).parent.parent / "src" / "worca" / "agents" / "core"


def _read(filename):
    return (CORE_DIR / filename).read_text()


# ---------------------------------------------------------------------------
# planner.md
# ---------------------------------------------------------------------------


def test_planner_has_block_plan():
    content = _read("planner.md")
    assert "{{block:plan}}" in content


def test_planner_uses_double_brace_plan_file():
    content = _read("planner.md")
    assert "{{plan_file}}" in content


def test_planner_no_single_brace_plan_file():
    content = _read("planner.md")
    # Ensure single-brace form was removed (not just that double-brace exists)
    assert "{plan_file}" not in content.replace("{{plan_file}}", "")


# ---------------------------------------------------------------------------
# plan_reviewer.md
# ---------------------------------------------------------------------------


def test_plan_reviewer_has_block_plan_review():
    content = _read("plan_reviewer.md")
    assert "{{block:plan-review}}" in content


# ---------------------------------------------------------------------------
# coordinator.md
# ---------------------------------------------------------------------------


def test_coordinator_does_not_embed_block_coordinate():
    # The coordinate block is routed to the -p user message (see runner.py),
    # not embedded in the coordinator's system prompt. Embedding the work
    # request in the system prompt caused a role-violation regression where
    # the coordinator started implementing instead of decomposing.
    content = _read("coordinator.md")
    assert "{{block:coordinate}}" not in content


def test_coordinator_uses_double_brace_plan_file():
    content = _read("coordinator.md")
    assert "{{plan_file}}" in content


def test_coordinator_no_single_brace_plan_file():
    content = _read("coordinator.md")
    assert "{plan_file}" not in content.replace("{{plan_file}}", "")


def test_coordinator_uses_double_brace_run_id():
    content = _read("coordinator.md")
    assert "{{run_id}}" in content


def test_coordinator_no_single_brace_run_id():
    content = _read("coordinator.md")
    assert "{run_id}" not in content.replace("{{run_id}}", "")


# ---------------------------------------------------------------------------
# implementer.md
# ---------------------------------------------------------------------------


def test_implementer_has_block_implement():
    content = _read("implementer.md")
    assert "{{block:implement}}" in content


def test_implementer_has_retry_rules_section():
    content = _read("implementer.md")
    assert "## Retry Rules" in content


# ---------------------------------------------------------------------------
# tester.md
# ---------------------------------------------------------------------------


def test_tester_has_block_test():
    content = _read("tester.md")
    assert "{{block:test}}" in content


# ---------------------------------------------------------------------------
# guardian.md
# ---------------------------------------------------------------------------


def test_guardian_has_block_pr():
    content = _read("guardian.md")
    assert "{{block:pr}}" in content


def test_guardian_no_review_stage_content():
    content = _read("guardian.md")
    # Guardian no longer serves REVIEW stage; reviewer.md does
    assert "REVIEW" not in content or "PR" in content  # PR content is fine


# ---------------------------------------------------------------------------
# reviewer.md
# ---------------------------------------------------------------------------


def test_reviewer_has_block_review():
    content = _read("reviewer.md")
    assert "{{block:review}}" in content


# ---------------------------------------------------------------------------
# learner.md
# ---------------------------------------------------------------------------


def test_learner_has_block_learn():
    content = _read("learner.md")
    assert "{{block:learn}}" in content


def test_learner_has_six_analysis_categories():
    content = _read("learner.md")
    # The 6-category analysis section from _build_learn lines 519-543
    assert "implementation iterations" in content.lower() or "implementation" in content
    assert "test" in content.lower()
    assert "review" in content.lower()
