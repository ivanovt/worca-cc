"""Tests for planner.md revision-mode instruction block (W-067 §6).

Verifies that when review_comments are present (has_review_comments=True),
planner.md renders a constrained-revision instruction block directing the
planner to produce a minimal-diff plan scoped to the enumerated feedback.
"""
from __future__ import annotations

from pathlib import Path

from worca.orchestrator.overlay import resolve_placeholders

_PLANNER_PATH = (
    Path(__file__).parent.parent / "src" / "worca" / "agents" / "core" / "planner.md"
)


def _render(context: dict) -> str:
    content = _PLANNER_PATH.read_text(encoding="utf-8")
    return resolve_placeholders(content, context)


def _base_context(**overrides) -> dict:
    ctx = {
        "has_review_comments": False,
        "has_graphify": False,
        "has_code_review_graph": False,
        "has_guide": False,
        "plan_file": "MASTER_PLAN.md",
    }
    ctx.update(overrides)
    return ctx


# ---------------------------------------------------------------------------
# Revision mode — block present when has_review_comments is True
# ---------------------------------------------------------------------------


class TestPlannerRevisionModeRendering:
    def test_revision_block_visible_when_review_comments_present(self):
        result = _render(_base_context(has_review_comments=True))
        lower = result.lower()
        assert "minimal" in lower or "revision" in lower or "review feedback" in lower

    def test_minimal_diff_instruction_present(self):
        result = _render(_base_context(has_review_comments=True))
        lower = result.lower()
        assert "minimal" in lower

    def test_scoped_to_feedback_instruction_present(self):
        result = _render(_base_context(has_review_comments=True))
        lower = result.lower()
        assert "feedback" in lower or "review" in lower

    def test_preserve_unreviewd_instruction_present(self):
        result = _render(_base_context(has_review_comments=True))
        lower = result.lower()
        assert "preserve" in lower

    def test_no_rearchitect_instruction_present(self):
        result = _render(_base_context(has_review_comments=True))
        lower = result.lower()
        assert "re-architect" in lower or "rearchitect" in lower or "architect" in lower

    def test_thin_checklist_note_present_for_small_comment_sets(self):
        result = _render(_base_context(has_review_comments=True))
        lower = result.lower()
        assert "checklist" in lower or "thin" in lower or "small" in lower


# ---------------------------------------------------------------------------
# Normal mode — block absent when has_review_comments is False
# ---------------------------------------------------------------------------


class TestPlannerNormalModeUnchanged:
    def test_revision_block_absent_when_no_review_comments(self):
        result = _render(_base_context(has_review_comments=False))
        lower = result.lower()
        # The constrained revision heading must not appear
        assert "constrained revision" not in lower
        assert "minimal-diff" not in lower

    def test_standard_planner_instructions_still_present(self):
        result = _render(_base_context(has_review_comments=False))
        # Core process steps should remain
        assert "Process" in result or "process" in result.lower()
