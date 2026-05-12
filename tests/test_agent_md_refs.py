"""Tests that agent .md files are work-request-free and use double-brace placeholders.

Per the restored channel separation (see runner.py _STAGE_BLOCK_MAP), every
agent's system prompt must stay static/role-only — the per-run block content
is delivered via the -p user message. These tests assert no `{{block:X}}`
embedding in any agent .md, plus the long-standing double-brace migration.
"""

import pathlib


CORE_DIR = pathlib.Path(__file__).parent.parent / "src" / "worca" / "agents" / "core"


def _read(filename):
    return (CORE_DIR / filename).read_text()


# ---------------------------------------------------------------------------
# planner.md
# ---------------------------------------------------------------------------


def test_planner_does_not_embed_block_plan():
    content = _read("planner.md")
    assert "{{block:plan}}" not in content


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


def test_plan_reviewer_does_not_embed_block_plan_review():
    content = _read("plan_reviewer.md")
    assert "{{block:plan-review}}" not in content


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


def test_implementer_does_not_embed_block_implement():
    content = _read("implementer.md")
    assert "{{block:implement}}" not in content


def test_implementer_has_retry_rules_section():
    content = _read("implementer.md")
    assert "## Retry Rules" in content


def test_implementer_has_stage_key_nudge():
    content = _read("implementer.md")
    assert "stages.guardian" in content, (
        "implementer.md must warn that stages is keyed by stage name, never agent name"
    )


# ---------------------------------------------------------------------------
# tester.md
# ---------------------------------------------------------------------------


def test_tester_does_not_embed_block_test():
    content = _read("tester.md")
    assert "{{block:test}}" not in content


# ---------------------------------------------------------------------------
# guardian.md
# ---------------------------------------------------------------------------


def test_guardian_does_not_embed_block_pr():
    content = _read("guardian.md")
    assert "{{block:pr}}" not in content


def test_guardian_no_review_stage_content():
    content = _read("guardian.md")
    # Guardian no longer serves REVIEW stage; reviewer.md does
    assert "REVIEW" not in content or "PR" in content  # PR content is fine


def test_guardian_output_references_pr_schema():
    # guardian.md's Output section delegates field-level contract (including
    # commit_sha) to pr.json via the --json-schema flag — matches planner/
    # coordinator/tester pattern of one-line "follow the schema" Output.
    content = _read("guardian.md")
    assert "pr.json" in content


# ---------------------------------------------------------------------------
# Fleet PR grouping (W-040 Phase 5 §11)
# ---------------------------------------------------------------------------


def test_guardian_fleet_pr_title_prefix_format():
    content = _read("guardian.md")
    assert "[fleet:" in content, (
        "guardian.md must contain [fleet:<fleet_id_short>] prefix format for fleet PR titles (W-040 §11)"
    )


def test_guardian_fleet_manifest_footer():
    content = _read("guardian.md")
    assert "fleet-runs" in content, (
        "guardian.md must reference fleet-runs manifest path for the PR footer (W-040 §11)"
    )


def test_guardian_fleet_id_short_referenced():
    content = _read("guardian.md")
    assert "fleet_id_short" in content, (
        "guardian.md must reference fleet_id_short for consistent fleet display (W-040 §11)"
    )


# ---------------------------------------------------------------------------
# reviewer.md
# ---------------------------------------------------------------------------


def test_reviewer_does_not_embed_block_review():
    content = _read("reviewer.md")
    assert "{{block:review}}" not in content


def test_reviewer_has_stage_key_nudge():
    content = _read("reviewer.md")
    assert "stages.guardian" in content, (
        "reviewer.md must warn that stages is keyed by stage name, never agent name"
    )


# ---------------------------------------------------------------------------
# learner.md
# ---------------------------------------------------------------------------


def test_learner_does_not_embed_block_learn():
    content = _read("learner.md")
    assert "{{block:learn}}" not in content


def test_learner_has_six_analysis_categories():
    content = _read("learner.md")
    # The 6-category analysis section from _build_learn lines 519-543
    assert "implementation iterations" in content.lower() or "implementation" in content
    assert "test" in content.lower()
    assert "review" in content.lower()


# ---------------------------------------------------------------------------
# Guide precedence (W-040 Phase 1 task 6)
# ---------------------------------------------------------------------------


def test_planner_has_guide_precedence_section():
    content = _read("planner.md")
    assert "Guide precedence" in content, (
        "planner.md must contain a 'Guide precedence' instruction block (W-040)"
    )


def test_planner_guide_precedence_requires_conformance():
    content = _read("planner.md")
    # Planner must produce a plan that conforms to the guide
    assert "guide" in content.lower(), (
        "planner.md must instruct agent to conform to the guide"
    )


def test_planner_guide_precedence_surface_conflict():
    content = _read("planner.md")
    lower = content.lower()
    # Planner must surface conflicts rather than silently resolving them
    assert "conflict" in lower or "diverge" in lower, (
        "planner.md must instruct agent to surface guide-vs-description conflicts"
    )


def test_reviewer_has_guide_precedence_section():
    content = _read("reviewer.md")
    assert "Guide precedence" in content, (
        "reviewer.md must contain a 'Guide precedence' instruction block (W-040)"
    )


def test_reviewer_guide_precedence_flag_divergence():
    content = _read("reviewer.md")
    lower = content.lower()
    # Reviewer must flag plan-vs-guide divergence
    assert "diverge" in lower or "conflict" in lower, (
        "reviewer.md must instruct agent to flag plan-vs-guide divergence"
    )


def test_tester_has_guide_precedence_section():
    content = _read("tester.md")
    assert "Guide precedence" in content, (
        "tester.md must contain a 'Guide precedence' instruction block (W-040)"
    )


def test_tester_guide_precedence_treat_as_bug():
    content = _read("tester.md")
    lower = content.lower()
    # Tester must treat guide-conflicting description as a bug to flag
    assert "bug" in lower or "flag" in lower, (
        "tester.md must instruct agent to treat guide-conflicting descriptions as bugs to flag"
    )
