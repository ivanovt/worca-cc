"""Tests for design_notes accumulation in the IMPLEMENT stage of runner.py."""

from worca.orchestrator.prompt_builder import PromptBuilder


def _make_prompt_builder():
    return PromptBuilder(work_request_title="test")


def test_runner_accumulates_design_notes():
    """Initial/next_bead trigger: non-empty design_notes appended to all_design_notes."""
    pb = _make_prompt_builder()
    result = {
        "bead_id": "beads-aaa",
        "files_changed": ["src/a.py"],
        "tests_added": [],
        "design_notes": "Use snake_case for helpers.",
    }
    _simulate_bead_close(pb, result, trigger="initial")

    notes = pb.get_context("all_design_notes")
    assert notes == [{"bead_id": "beads-aaa", "note": "Use snake_case for helpers."}]


def test_runner_skips_empty_design_notes():
    """Initial/next_bead trigger: empty or missing design_notes not appended."""
    pb = _make_prompt_builder()

    # Missing design_notes
    result1 = {"bead_id": "beads-bbb", "files_changed": ["src/b.py"], "tests_added": []}
    _simulate_bead_close(pb, result1, trigger="initial")
    assert pb.get_context("all_design_notes") == []

    # Empty string
    result2 = {"bead_id": "beads-ccc", "files_changed": ["src/c.py"], "tests_added": [], "design_notes": ""}
    _simulate_bead_close(pb, result2, trigger="next_bead")
    assert pb.get_context("all_design_notes") == []


def test_runner_retry_replaces_design_note():
    """Retry trigger: fix-mode emits bead_id='fix'; runner uses assigned_bead_id to replace."""
    pb = _make_prompt_builder()
    pb.update_context("assigned_bead_id", "beads-aaa")
    pb.update_context("all_design_notes", [{"bead_id": "beads-aaa", "note": "Old note."}])

    result = {
        "bead_id": "fix",
        "files_changed": ["src/a.py"],
        "tests_added": [],
        "design_notes": "Updated note.",
    }
    _simulate_retry(pb, result, trigger="test_failure")

    notes = pb.get_context("all_design_notes")
    assert notes == [{"bead_id": "beads-aaa", "note": "Updated note."}]


def test_runner_retry_empty_note_preserves_original():
    """Retry trigger: empty design_notes leaves existing entry unchanged."""
    pb = _make_prompt_builder()
    pb.update_context("all_design_notes", [{"bead_id": "beads-aaa", "note": "Original."}])

    result = {
        "bead_id": "beads-aaa",
        "files_changed": ["src/a.py"],
        "tests_added": [],
        "design_notes": "",
    }
    _simulate_retry(pb, result, trigger="test_failure")

    notes = pb.get_context("all_design_notes")
    assert notes == [{"bead_id": "beads-aaa", "note": "Original."}]


def test_runner_retry_appends_if_no_prior_note():
    """Retry trigger: non-empty note appends when no prior entry for this bead."""
    pb = _make_prompt_builder()
    pb.update_context("all_design_notes", [{"bead_id": "beads-other", "note": "Other note."}])

    result = {
        "bead_id": "beads-new",
        "files_changed": ["src/new.py"],
        "tests_added": [],
        "design_notes": "Brand new note.",
    }
    _simulate_retry(pb, result, trigger="review_changes")

    notes = pb.get_context("all_design_notes")
    assert len(notes) == 2
    assert notes[0] == {"bead_id": "beads-other", "note": "Other note."}
    assert notes[1] == {"bead_id": "beads-new", "note": "Brand new note."}


# ---------------------------------------------------------------------------
# Helpers that replicate the runner logic we're testing (extracted to keep
# tests independent of the full pipeline loop).  These will initially fail
# because the runner doesn't have the logic yet — the implementation will
# make them pass by adding equivalent code to runner.py.
# ---------------------------------------------------------------------------

def _accumulate_design_note(pb, result, trigger):
    """Replicate the design_notes accumulation logic from runner.py."""
    from worca.orchestrator.runner import _accumulate_design_note as impl
    impl(pb, result, trigger)


def _simulate_bead_close(pb, result, *, trigger):
    """Simulate an initial/next_bead trigger's design_notes handling."""
    _accumulate_design_note(pb, result, trigger)


def _simulate_retry(pb, result, *, trigger):
    """Simulate a retry trigger's design_notes handling."""
    _accumulate_design_note(pb, result, trigger)
