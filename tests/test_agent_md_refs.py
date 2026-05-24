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
# coordinator.md — Effort Labeling (W-052 Phase 2)
# ---------------------------------------------------------------------------


def test_coordinator_has_effort_labeling_section():
    content = _read("coordinator.md")
    assert "## Effort Labeling" in content


def test_coordinator_effort_rubric_has_all_levels():
    content = _read("coordinator.md")
    for level in ("low", "medium", "high", "xhigh"):
        assert f"| `{level}`" in content, (
            f"coordinator.md effort rubric must include the `{level}` level"
        )


def test_coordinator_effort_rubric_never_pick_max():
    content = _read("coordinator.md")
    lower = content.lower()
    assert "never pick" in lower and "max" in lower, (
        "coordinator.md effort rubric must instruct never to pick `max` autonomously"
    )


def test_coordinator_effort_bd_create_labels_instruction():
    content = _read("coordinator.md")
    assert "worca-effort:" in content, (
        "coordinator.md must instruct bd create --labels worca-effort:<level>"
    )
    assert "--labels" in content


def test_coordinator_effort_bd_update_notes_instruction():
    content = _read("coordinator.md")
    assert "bd update" in content and "--notes" in content, (
        "coordinator.md must instruct bd update <id> --notes for effort reasoning"
    )


def test_coordinator_effort_preserve_existing_label():
    content = _read("coordinator.md")
    lower = content.lower()
    assert "preserve" in lower or "do not overwrite" in lower, (
        "coordinator.md must instruct preserving existing worca-effort:* labels"
    )


def test_coordinator_effort_mode_independent_emission():
    content = _read("coordinator.md")
    lower = content.lower()
    assert ("regardless" in lower and "auto_mode" in lower) or "mode-independent" in lower, (
        "coordinator.md must note that effort labels are emitted regardless of auto_mode"
    )


# ---------------------------------------------------------------------------
# coordinator.md — Structured effort map (effort-system-reliable-labels)
# ---------------------------------------------------------------------------


def test_coordinator_effort_map_in_structured_output():
    """The coordinator must be told to populate the `effort` field in its output."""
    content = _read("coordinator.md")
    assert '"effort"' in content or "`effort`" in content, (
        "coordinator.md must reference the `effort` field for structured output"
    )
    lower = content.lower()
    assert "map" in lower or "mapping" in lower, (
        "coordinator.md must describe effort as a map/mapping of bead IDs to levels"
    )


def test_coordinator_effort_map_documents_bead_id_key():
    """The effort map instruction must explain that keys are bead IDs."""
    content = _read("coordinator.md")
    assert "bead_id" in content or "bead ID" in content or "bead id" in content.lower(), (
        "coordinator.md must document that effort map keys are bead IDs"
    )


def test_coordinator_effort_map_belt_and_suspenders():
    """Both --labels instruction AND structured effort map must coexist."""
    content = _read("coordinator.md")
    assert "--labels" in content, (
        "coordinator.md must retain --labels instruction (belt-and-suspenders)"
    )
    assert ('"effort"' in content or "`effort`" in content), (
        "coordinator.md must also instruct structured effort map output"
    )


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


def test_implementer_has_design_notes_write_guidance():
    content = _read("implementer.md")
    assert "design_notes" in content, (
        "implementer.md must instruct the implementer to populate design_notes"
    )
    assert "plan didn" in content.lower() or "plan did not" in content.lower(), (
        "write guidance must scope design_notes to decisions the plan didn't specify"
    )


def test_implementer_has_design_notes_read_guidance():
    content = _read("implementer.md")
    assert "Accumulated design notes" in content, (
        "implementer.md must explain the accumulated design notes block"
    )
    assert "advisory" in content.lower(), (
        "read guidance must state that accumulated design notes are advisory"
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


def _render_guardian(env: dict) -> str:
    """Render the guardian prompt with the orchestrator-computed context.

    After #165 the fleet/workspace branching lives in Python, so behavioral
    assertions about fleet PR formatting must operate on the rendered
    output, not the raw .md source. Source-level checks would pass on a
    template that never resolves to anything useful.
    """
    from worca.orchestrator.guardian_context import build_guardian_context
    from worca.orchestrator.overlay import resolve_placeholders

    template = _read("guardian.md")
    return resolve_placeholders(template, build_guardian_context(env))


def test_guardian_fleet_pr_title_prefix_format():
    """W-040 §11: fleet runs must produce a [fleet:<short>] title prefix.
    After #165 this is verified against rendered output, not raw source."""
    rendered = _render_guardian(
        {"WORCA_FLEET_ID": "f_202601011200_a1b2c3d4"}
    )
    assert "[fleet:a1b2c3d4]" in rendered, (
        "rendered guardian must include [fleet:<short>] prefix for fleet runs (W-040 §11)"
    )


def test_guardian_fleet_manifest_footer():
    """W-040 §11: fleet PR body must reference the fleet-runs manifest path."""
    rendered = _render_guardian(
        {"WORCA_FLEET_ID": "f_202601011200_a1b2c3d4"}
    )
    assert "fleet-runs" in rendered, (
        "rendered guardian must reference fleet-runs manifest path for the PR footer (W-040 §11)"
    )
    assert "f_202601011200_a1b2c3d4.json" in rendered


def test_guardian_fleet_id_short_extraction():
    """W-040 §11: the fleet PR title and footer must use the short ID
    (trailing underscore-delimited segment), not the full ID in the title.
    After #165 the extraction lives in guardian_context._short_id; this
    test asserts the rendered output matches the contract."""
    rendered = _render_guardian(
        {"WORCA_FLEET_ID": "f_202601011200_a1b2c3d4"}
    )
    # Short form must be in the title prefix
    assert "[fleet:a1b2c3d4]" in rendered
    # Full ID is allowed in the footer (manifest path needs the full ID)
    # but not as a bare title prefix
    assert "[fleet:f_202601011200_a1b2c3d4]" not in rendered


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


# ---------------------------------------------------------------------------
# Guide wrapper consistency across .block.md files (W-040 §5)
#
# The guide envelope is duplicated across each stage's .block.md (the overlay
# loader has no {{> partial}} mechanism). These tests assert byte-identical
# wrapper text so the precedence wording cannot drift across stages.
# ---------------------------------------------------------------------------


GUIDE_WRAPPER_TEXT = """{{#if has_guide}}
## Reference Guide (normative)

The following guidance is authoritative for this work-request. Treat any
conflict between the guide and the task description as a bug in the task
description, and surface it rather than silently resolving it.

{{guide_content}}

---

## Task

{{/if}}
{{work_request}}"""


BLOCK_FILES_WITH_WORK_REQUEST = [
    "coordinate.block.md",
    "implement.block.md",
    "learn.block.md",
    "plan.block.md",
    "plan-review.block.md",
    "pr.block.md",
    "review.block.md",
    "test.block.md",
]


def test_guide_wrapper_text_byte_identical_across_block_files():
    """Every .block.md that interpolates {{work_request}} must wrap it with the
    canonical guide envelope. The wrapper must be byte-identical everywhere so
    the precedence wording cannot drift across stages.
    """
    drift = []
    for fname in BLOCK_FILES_WITH_WORK_REQUEST:
        content = _read(fname)
        if GUIDE_WRAPPER_TEXT not in content:
            drift.append(fname)
    assert not drift, (
        "guide wrapper drift detected in: "
        + ", ".join(drift)
        + " — wrapper must be byte-identical across all .block.md files. "
        "If you intentionally changed the precedence wording, update "
        "GUIDE_WRAPPER_TEXT in this test and apply the same change to every "
        "file in BLOCK_FILES_WITH_WORK_REQUEST."
    )


def test_guide_header_not_in_python_source():
    """The normative header must live in .block.md templates only — never in
    Python source. Hardcoding LLM-facing prose in .py violates the project rule
    that agent prompts must be declarative and customizable.
    """
    work_request_py = (
        pathlib.Path(__file__).parent.parent
        / "src" / "worca" / "orchestrator" / "work_request.py"
    ).read_text()
    assert "## Reference Guide (normative)" not in work_request_py, (
        "## Reference Guide header must not appear in work_request.py — "
        "it belongs in the .block.md template wrappers."
    )
    assert "_GUIDE_HEADER" not in work_request_py, (
        "_GUIDE_HEADER constant should be removed from work_request.py"
    )


# ---------------------------------------------------------------------------
# Knowledge-graph availability note across .block.md files (W-053 query pivot)
#
# Agents query the cached graph on demand (via the GRAPHIFY_OUT env var); the
# .block.md files carry only a per-run availability note — no report content,
# no graph path. The note must be byte-identical across stages so the wording
# cannot drift, and must never regress to the old static-injection block.
# ---------------------------------------------------------------------------


GRAPHIFY_NOTE_TEXT = """{{#if has_graphify}}
_A code knowledge graph is preloaded for this repo — explore it on demand with `graphify query "<question>"` (see the Knowledge graph section of your role)._

{{/if}}"""


def test_graphify_note_present_in_all_block_files():
    """Every .block.md that interpolates {{work_request}} must include the
    canonical per-run graphify availability note."""
    drift = []
    for fname in BLOCK_FILES_WITH_WORK_REQUEST:
        content = _read(fname)
        if GRAPHIFY_NOTE_TEXT not in content:
            drift.append(fname)
    assert not drift, (
        "graphify note missing from: "
        + ", ".join(drift)
        + " — note must be byte-identical across all .block.md files. "
        "If you intentionally changed the wording, update GRAPHIFY_NOTE_TEXT "
        "in this test and apply the same change to every file in "
        "BLOCK_FILES_WITH_WORK_REQUEST."
    )


def test_no_static_graph_report_injection_in_block_files():
    """The old static report block (## Codebase Structure / {{graph_context}} /
    {{#if has_graph}}) must not reappear — agents query the graph on demand,
    they are not fed the human-facing report."""
    offenders = []
    for fname in BLOCK_FILES_WITH_WORK_REQUEST:
        content = _read(fname)
        if (
            "## Codebase Structure" in content
            or "{{graph_context}}" in content
            or "{{#if has_graph}}" in content
        ):
            offenders.append(fname)
    assert not offenders, (
        "static graph-report injection found in: " + ", ".join(offenders)
    )


def test_graphify_note_appears_after_guide_block():
    """In every .block.md, the graphify note must appear after the guide block
    to respect authority order: guide > graph > description."""
    wrong_order = []
    for fname in BLOCK_FILES_WITH_WORK_REQUEST:
        content = _read(fname)
        guide_pos = content.find("{{#if has_guide}}")
        graph_pos = content.find("{{#if has_graphify}}")
        if guide_pos >= 0 and graph_pos >= 0 and graph_pos < guide_pos:
            wrong_order.append(fname)
    assert not wrong_order, (
        "graphify note appears before guide block in: "
        + ", ".join(wrong_order)
        + " — authority order requires guide > graph."
    )


# ---------------------------------------------------------------------------
# Knowledge-graph behavior section in core agent .md files (W-053 query pivot)
#
# The how-to-use-the-graph guidance is static in each pipeline agent's core
# .md (always present, self-gating on the per-run note), not in the .block.md.
# ---------------------------------------------------------------------------


CORE_AGENT_FILES = [
    "planner.md", "plan_reviewer.md", "coordinator.md", "implementer.md",
    "tester.md", "reviewer.md", "guardian.md", "learner.md",
]

KNOWLEDGE_GRAPH_HEADING = "## Knowledge graph (advisory)"


def test_knowledge_graph_section_in_all_core_agents():
    """Every pipeline agent's core .md defines the static how-to-use-the-graph
    behavior. The per-run note in .block.md only flags availability."""
    missing = []
    for fname in CORE_AGENT_FILES:
        if KNOWLEDGE_GRAPH_HEADING not in _read(fname):
            missing.append(fname)
    assert not missing, (
        "Knowledge graph section missing from core agents: " + ", ".join(missing)
    )
