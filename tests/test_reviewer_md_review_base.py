"""Tests for reviewer.md process step 2 using review_base (W-065)."""
import pathlib

REVIEWER_MD = pathlib.Path(__file__).parent.parent / "src/worca/agents/core/reviewer.md"


def _content():
    return REVIEWER_MD.read_text()


def test_uses_review_base_template_var():
    assert "{{review_base}}" in _content(), "step 2 must reference {{review_base}}"


def test_uses_stat_diff_command():
    assert "git diff {{review_base}}..HEAD --stat" in _content()


def test_uses_per_file_diff_command():
    assert "git diff {{review_base}}..HEAD -- <file>" in _content()


def test_has_merge_base_fallback():
    assert "git merge-base HEAD origin/HEAD" in _content()


def test_does_not_detect_base_via_symbolic_ref():
    # The old step 2 used symbolic-ref to detect the base branch; that usage must be gone.
    assert "git symbolic-ref refs/remotes/origin/HEAD" not in _content(), (
        "step 2 must NOT use git symbolic-ref refs/remotes/origin/HEAD to detect base branch"
    )
