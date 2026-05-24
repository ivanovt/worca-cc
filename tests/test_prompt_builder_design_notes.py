"""Tests for design notes rendering in PromptBuilder."""

from worca.orchestrator.prompt_builder import PromptBuilder, _render_notes, _DESIGN_NOTES_CAP


def test_render_notes_empty_list():
    assert _render_notes([], 2000) == ""


def test_render_notes_single_note():
    notes = [{"bead_id": "bead-1", "note": "Use snake_case for helpers"}]
    result = _render_notes(notes, 2000)
    assert result == "- [bead-1] Use snake_case for helpers"


def test_render_notes_multiple_notes():
    notes = [
        {"bead_id": "bead-1", "note": "Use snake_case"},
        {"bead_id": "bead-2", "note": "Error codes are ints"},
    ]
    result = _render_notes(notes, 2000)
    assert "- [bead-1] Use snake_case" in result
    assert "- [bead-2] Error codes are ints" in result
    lines = result.strip().split("\n")
    assert len(lines) == 2


def test_render_notes_drop_oldest_cap():
    notes = [
        {"bead_id": "bead-old", "note": "A" * 100},
        {"bead_id": "bead-new", "note": "B" * 50},
    ]
    cap = len("- [bead-new] " + "B" * 50) + 10
    result = _render_notes(notes, cap)
    assert "bead-new" in result
    assert "bead-old" not in result


def test_render_notes_cap_zero_returns_empty():
    notes = [{"bead_id": "x", "note": "hello"}]
    assert _render_notes(notes, 0) == ""


def test_design_notes_cap_constant():
    assert _DESIGN_NOTES_CAP == 2000


def test_build_context_renders_accumulated_notes():
    pb = PromptBuilder("Title", "Desc")
    pb.update_context("all_design_notes", [
        {"bead_id": "bead-1", "note": "Use snake_case"},
        {"bead_id": "bead-2", "note": "Error codes are ints"},
    ])
    pb.update_context("assigned_bead_id", "bead-3")
    ctx = pb.build_context("implement", iteration=0)
    assert ctx["has_design_notes"] is True
    assert "bead-1" in ctx["accumulated_design_notes"]
    assert "bead-2" in ctx["accumulated_design_notes"]


def test_build_context_excludes_current_bead():
    pb = PromptBuilder("Title", "Desc")
    pb.update_context("all_design_notes", [
        {"bead_id": "bead-1", "note": "Keep this"},
        {"bead_id": "bead-2", "note": "Exclude this"},
    ])
    pb.update_context("assigned_bead_id", "bead-2")
    ctx = pb.build_context("implement", iteration=0)
    assert "bead-1" in ctx["accumulated_design_notes"]
    assert "bead-2" not in ctx["accumulated_design_notes"]


def test_build_context_no_notes():
    pb = PromptBuilder("Title", "Desc")
    pb.update_context("assigned_bead_id", "bead-1")
    ctx = pb.build_context("implement", iteration=0)
    assert ctx["has_design_notes"] is False
    assert ctx["accumulated_design_notes"] == ""


def test_build_context_all_notes_from_current_bead():
    pb = PromptBuilder("Title", "Desc")
    pb.update_context("all_design_notes", [
        {"bead_id": "bead-1", "note": "My own note"},
    ])
    pb.update_context("assigned_bead_id", "bead-1")
    ctx = pb.build_context("implement", iteration=0)
    assert ctx["has_design_notes"] is False
    assert ctx["accumulated_design_notes"] == ""


def test_build_context_design_notes_on_retry():
    pb = PromptBuilder("Title", "Desc")
    pb.update_context("all_design_notes", [
        {"bead_id": "bead-1", "note": "Use snake_case"},
    ])
    pb.update_context("assigned_bead_id", "bead-2")
    ctx = pb.build_context("implement", iteration=1)
    assert ctx["has_design_notes"] is True
    assert "bead-1" in ctx["accumulated_design_notes"]


def test_implement_block_no_notes_no_section():
    """When has_design_notes is False, the block template should not contain
    the design notes section. We verify by checking the template source."""
    import os
    block_path = os.path.join(
        os.path.dirname(os.path.dirname(__file__)),
        "src", "worca", "agents", "core", "implement.block.md",
    )
    with open(block_path) as f:
        content = f.read()
    assert "{{#if has_design_notes}}" in content
    assert "{{accumulated_design_notes}}" in content
    assert "{{/if}}" in content
