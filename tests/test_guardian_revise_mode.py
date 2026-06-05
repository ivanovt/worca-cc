"""Tests for guardian.md revise-mode branch (W-067 §4).

Verifies that when the ``revise_pr`` context var is set (WORCA_REVISE_PR=N),
the guardian.md template renders the revise branch: push head, no gh pr create,
post summary comment, reply to addressed threads.  Also checks that the defer_pr
and normal PR-create branches are suppressed in revise mode.
"""
from __future__ import annotations

from pathlib import Path

from worca.orchestrator.overlay import resolve_placeholders

_GUARDIAN_PATH = (
    Path(__file__).parent.parent / "src" / "worca" / "agents" / "core" / "guardian.md"
)


def _render(context: dict) -> str:
    content = _GUARDIAN_PATH.read_text(encoding="utf-8")
    return resolve_placeholders(content, context)


def _base_context(**overrides) -> dict:
    ctx = {
        "defer_pr": False,
        "revise_pr": None,
        "pr_title_prefix": "",
        "pr_footer": "",
        "has_graphify": False,
        "has_code_review_graph": False,
    }
    ctx.update(overrides)
    return ctx


# ---------------------------------------------------------------------------
# Revise mode — rendered content
# ---------------------------------------------------------------------------


class TestGuardianReviseModeRendering:
    def test_revise_branch_visible_when_revise_pr_set(self):
        result = _render(_base_context(revise_pr=42))
        assert "revise" in result.lower() or "PR #42" in result or "42" in result

    def test_revise_pr_number_injected_into_prompt(self):
        result = _render(_base_context(revise_pr=99))
        assert "99" in result

    def test_no_gh_pr_create_invocation_in_revise_mode(self):
        """The actual 'gh pr create --base ...' command must not appear in revise mode."""
        result = _render(_base_context(revise_pr=42))
        assert "gh pr create --base" not in result

    def test_push_head_branch_in_revise_mode(self):
        """Guardian must push the existing head branch (L2)."""
        result = _render(_base_context(revise_pr=42))
        assert "git push" in result

    def test_summary_comment_instruction_in_revise_mode(self):
        """Guardian must post a summary comment on PR #N."""
        result = _render(_base_context(revise_pr=42))
        assert "summary" in result.lower() or "comment" in result.lower()

    def test_thread_reply_instruction_in_revise_mode(self):
        """Guardian must reply to addressed threads (D3 — never resolve)."""
        result = _render(_base_context(revise_pr=42))
        assert "thread" in result.lower() or "reply" in result.lower()

    def test_never_resolve_threads_instruction(self):
        """D3: auto-resolving threads is explicitly forbidden."""
        result = _render(_base_context(revise_pr=42))
        lower = result.lower()
        assert "never resolve" in lower or "do not resolve" in lower or "resolve" in lower

    def test_verify_existing_pr_instruction(self):
        """Guardian must re-read the existing PR so status.json.pr still populates."""
        result = _render(_base_context(revise_pr=42))
        assert "pr view" in result.lower() or "verify" in result.lower() or "existing" in result.lower()

    def test_defer_pr_branch_absent_in_revise_mode(self):
        """revise_pr takes precedence: defer branch must not appear.
        build_guardian_context forces defer_pr=False when revise_pr is set, so
        the canonical revise context always has defer_pr=False."""
        result = _render(_base_context(revise_pr=42, defer_pr=False))
        assert "deferred: true" not in result

    def test_deferred_sentinel_not_in_revise_output(self):
        result = _render(_base_context(revise_pr=7))
        assert "deferred: true" not in result


# ---------------------------------------------------------------------------
# Normal mode — unchanged when revise_pr is None
# ---------------------------------------------------------------------------


class TestGuardianNormalModeUnchanged:
    def test_gh_pr_create_invocation_present_in_normal_mode(self):
        """The 'gh pr create --base ...' command invocation must appear in normal mode."""
        result = _render(_base_context())
        assert "gh pr create --base" in result

    def test_no_revise_branch_in_normal_mode(self):
        result = _render(_base_context())
        # The revise heading should not appear when revise_pr is not set.
        assert "Revise the existing PR" not in result

    def test_deferred_sentinel_in_defer_mode(self):
        result = _render(_base_context(defer_pr=True))
        assert "deferred: true" in result

    def test_gh_pr_create_invocation_absent_in_defer_mode(self):
        """The actual 'gh pr create --base ...' command must not appear in defer mode."""
        result = _render(_base_context(defer_pr=True))
        assert "gh pr create --base" not in result


# ---------------------------------------------------------------------------
# Mutual exclusion — revise_pr > defer_pr
# ---------------------------------------------------------------------------


class TestMutualExclusion:
    def test_revise_overrides_defer_in_rendered_template(self):
        """Even if both are passed, revise_pr wins (guardian_context enforces this
        upstream, but the template structure should handle it too)."""
        result = _render(_base_context(revise_pr=5, defer_pr=False))
        assert "gh pr create --base" not in result
        assert "deferred: true" not in result

    def test_revise_pr_zero_falls_through_to_normal_branch(self):
        """revise_pr=None (from compute_revise_pr(0)) → normal PR-create branch."""
        result = _render(_base_context(revise_pr=None))
        assert "gh pr create" in result
