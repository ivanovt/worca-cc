"""Tests for scope framing paragraph in review.block.md (W-065 bead worca-cc-eh4)."""
import pathlib

REVIEW_BLOCK_MD = pathlib.Path(__file__).parent.parent / "src/worca/agents/core/review.block.md"


def _content():
    return REVIEW_BLOCK_MD.read_text()


def test_scope_framing_references_review_base():
    assert "{{review_base}}" in _content(), "scope framing must reference {{review_base}}"


def test_scope_framing_references_observations():
    assert "observations" in _content(), "scope framing must mention observations"


def test_scope_framing_has_conditional_fallback():
    content = _content()
    assert "{{#if review_base}}" in content, "must have {{#if review_base}} conditional"
    assert "{{else}}" in content, "must have {{else}} branch"
    assert "{{/if}}" in content, "must have {{/if}} closing"


def test_scope_framing_fallback_contains_merge_base_instruction():
    content = _content()
    assert "git merge-base HEAD origin/HEAD" in content, \
        "fallback branch must tell reviewer to use git merge-base HEAD origin/HEAD"


def test_scope_framing_after_first_line():
    lines = _content().splitlines()
    # First line should be the existing opening sentence
    assert lines[0].startswith("Review the code changes"), "first line unchanged"
    # Scope framing paragraph should appear somewhere after line 1
    rest = "\n".join(lines[1:])
    assert "{{review_base}}" in rest, "scope framing must appear after first line"
