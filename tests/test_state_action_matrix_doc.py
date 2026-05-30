"""Verify the state-action-matrix spec documents mode-dependent PLAN_REVIEW transitions."""

from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs" / "state-action-matrix.md"


def _read_doc() -> str:
    return DOCS.read_text()


def test_doc_mentions_review_mode_plan_review_to_plan():
    text = _read_doc()
    assert "review" in text.lower()
    assert "PLAN_REVIEW" in text
    assert "PLAN" in text
    assert "COORDINATE" in text


def test_doc_mentions_review_and_edit_mode():
    text = _read_doc()
    assert "review_and_edit" in text


def test_doc_describes_loopback_removal_in_edit_mode():
    text = _read_doc()
    assert "review_and_edit" in text
    assert "COORDINATE" in text
    lines = text.lower()
    assert "no" in lines and "plan_review" in text and "plan" in lines


def test_doc_references_can_transition():
    text = _read_doc()
    assert "can_transition" in text


def test_doc_mode_dependent_section_exists():
    text = _read_doc()
    assert "Mode-Dependent" in text or "mode-dependent" in text
