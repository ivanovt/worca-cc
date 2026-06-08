"""Unit tests for ``worca.orchestrator.guardian_context``.

Covers the four pure helpers that derive the guardian agent's template
variables from the run environment. Each test passes a plain dict (not
``os.environ``) so the suite is hermetic.

Issue: https://github.com/SinishaDjukic/worca-cc/issues/165
"""
from __future__ import annotations

from worca.orchestrator.guardian_context import (
    _short_id,
    build_guardian_context,
    compute_defer_pr,
    compute_pr_footer,
    compute_pr_title_prefix,
    compute_revise_pr,
)


# ---------------------------------------------------------------------------
# _short_id
# ---------------------------------------------------------------------------


class TestShortId:
    def test_fleet_id_short_is_trailing_random_segment(self):
        assert _short_id("f_202601011200_a1b2c3d4") == "a1b2c3d4"

    def test_workspace_id_short_is_trailing_random_segment(self):
        assert _short_id("ws_202601011200_b3c4d5e6") == "b3c4d5e6"

    def test_no_underscore_returns_input(self):
        assert _short_id("standalone") == "standalone"


# ---------------------------------------------------------------------------
# compute_pr_title_prefix
# ---------------------------------------------------------------------------


class TestComputePrTitlePrefix:
    def test_standalone_returns_empty(self):
        assert compute_pr_title_prefix({}) == ""

    def test_fleet_returns_fleet_prefix(self):
        env = {"WORCA_FLEET_ID": "f_202601011200_a1b2c3d4"}
        assert compute_pr_title_prefix(env) == "[fleet:a1b2c3d4]"

    def test_workspace_returns_workspace_prefix(self):
        env = {"WORCA_WORKSPACE_ID": "ws_202601011200_b3c4d5e6"}
        assert compute_pr_title_prefix(env) == "[workspace:b3c4d5e6]"

    def test_both_set_prefers_fleet_for_pre_w047_compat(self):
        """Mutual exclusion is enforced upstream by register_pipeline; if it
        ever slips, the historical (pre-W-047) fleet behavior wins so we don't
        accidentally relabel an in-flight fleet run as a workspace run."""
        env = {
            "WORCA_FLEET_ID": "f_202601011200_a1b2c3d4",
            "WORCA_WORKSPACE_ID": "ws_202601011200_b3c4d5e6",
        }
        assert compute_pr_title_prefix(env) == "[fleet:a1b2c3d4]"

    def test_empty_string_treated_as_unset(self):
        env = {"WORCA_FLEET_ID": "", "WORCA_WORKSPACE_ID": ""}
        assert compute_pr_title_prefix(env) == ""

    def test_empty_fleet_falls_through_to_workspace(self):
        env = {
            "WORCA_FLEET_ID": "",
            "WORCA_WORKSPACE_ID": "ws_202601011200_b3c4d5e6",
        }
        assert compute_pr_title_prefix(env) == "[workspace:b3c4d5e6]"


# ---------------------------------------------------------------------------
# compute_pr_footer
# ---------------------------------------------------------------------------


class TestComputePrFooter:
    def test_standalone_returns_empty(self):
        assert compute_pr_footer({}) == ""

    def test_fleet_footer_contains_manifest_pointer(self):
        env = {"WORCA_FLEET_ID": "f_202601011200_a1b2c3d4"}
        footer = compute_pr_footer(env)
        assert footer.startswith("---\n")
        assert "Fleet manifest:" in footer
        assert "f_202601011200_a1b2c3d4.json" in footer
        assert footer.endswith("\n")

    def test_workspace_footer_contains_name_and_id(self):
        env = {
            "WORCA_WORKSPACE_ID": "ws_202601011200_b3c4d5e6",
            "WORCA_WORKSPACE_NAME": "my-platform",
        }
        footer = compute_pr_footer(env)
        assert footer.startswith("---\n")
        assert "**Workspace:** my-platform" in footer
        assert "`ws_202601011200_b3c4d5e6`" in footer

    def test_workspace_footer_defaults_when_name_missing(self):
        env = {"WORCA_WORKSPACE_ID": "ws_202601011200_b3c4d5e6"}
        footer = compute_pr_footer(env)
        assert "**Workspace:** (unnamed)" in footer

    def test_fleet_takes_precedence_when_both_set(self):
        env = {
            "WORCA_FLEET_ID": "f_202601011200_a1b2c3d4",
            "WORCA_WORKSPACE_ID": "ws_202601011200_b3c4d5e6",
            "WORCA_WORKSPACE_NAME": "my-platform",
        }
        footer = compute_pr_footer(env)
        assert "Fleet manifest" in footer
        assert "Workspace" not in footer


# ---------------------------------------------------------------------------
# compute_defer_pr
# ---------------------------------------------------------------------------


class TestComputeDeferPr:
    def test_default_false(self):
        assert compute_defer_pr({}) is False

    def test_one_is_true(self):
        assert compute_defer_pr({"WORCA_DEFER_PR": "1"}) is True

    def test_zero_is_false(self):
        assert compute_defer_pr({"WORCA_DEFER_PR": "0"}) is False

    def test_true_string_is_false(self):
        """Only literal "1" counts — matches the shell convention used by
        dag_executor.py when setting the env var. Treating "true" as true
        would invite silent defers on misconfiguration."""
        assert compute_defer_pr({"WORCA_DEFER_PR": "true"}) is False

    def test_empty_string_is_false(self):
        assert compute_defer_pr({"WORCA_DEFER_PR": ""}) is False


# ---------------------------------------------------------------------------
# compute_revise_pr
# ---------------------------------------------------------------------------


class TestComputeRevisePr:
    def test_default_none(self):
        assert compute_revise_pr({}) is None

    def test_numeric_value_returns_int(self):
        assert compute_revise_pr({"WORCA_REVISE_PR": "123"}) == 123

    def test_zero_is_none(self):
        """PR numbers start at 1; 0 is not a valid PR number."""
        assert compute_revise_pr({"WORCA_REVISE_PR": "0"}) is None

    def test_negative_is_none(self):
        assert compute_revise_pr({"WORCA_REVISE_PR": "-1"}) is None

    def test_non_numeric_is_none(self):
        assert compute_revise_pr({"WORCA_REVISE_PR": "abc"}) is None

    def test_empty_string_is_none(self):
        assert compute_revise_pr({"WORCA_REVISE_PR": ""}) is None

    def test_whitespace_only_is_none(self):
        assert compute_revise_pr({"WORCA_REVISE_PR": "  "}) is None

    def test_large_pr_number(self):
        assert compute_revise_pr({"WORCA_REVISE_PR": "99999"}) == 99999


# ---------------------------------------------------------------------------
# build_guardian_context
# ---------------------------------------------------------------------------


class TestBuildGuardianContext:
    def test_returns_exactly_four_keys(self):
        ctx = build_guardian_context({})
        assert set(ctx.keys()) == {"defer_pr", "revise_pr", "pr_title_prefix", "pr_footer"}

    def test_standalone(self):
        ctx = build_guardian_context({})
        assert ctx == {
            "defer_pr": False,
            "revise_pr": None,
            "pr_title_prefix": "",
            "pr_footer": "",
        }

    def test_workspace_with_defer(self):
        env = {
            "WORCA_WORKSPACE_ID": "ws_202601011200_b3c4d5e6",
            "WORCA_WORKSPACE_NAME": "my-platform",
            "WORCA_DEFER_PR": "1",
        }
        ctx = build_guardian_context(env)
        assert ctx["defer_pr"] is True
        assert ctx["revise_pr"] is None
        assert ctx["pr_title_prefix"] == "[workspace:b3c4d5e6]"
        assert "my-platform" in ctx["pr_footer"]

    def test_fleet_without_defer(self):
        env = {"WORCA_FLEET_ID": "f_202601011200_a1b2c3d4"}
        ctx = build_guardian_context(env)
        assert ctx["defer_pr"] is False
        assert ctx["revise_pr"] is None
        assert ctx["pr_title_prefix"] == "[fleet:a1b2c3d4]"
        assert "Fleet manifest" in ctx["pr_footer"]

    # --- revise_pr context var ---

    def test_revise_pr_set_returns_pr_number(self):
        ctx = build_guardian_context({"WORCA_REVISE_PR": "42"})
        assert ctx["revise_pr"] == 42

    def test_revise_pr_suppresses_defer_pr(self):
        """revise_pr > defer_pr: when revising an existing PR, defer is a no-op."""
        env = {"WORCA_REVISE_PR": "42", "WORCA_DEFER_PR": "1"}
        ctx = build_guardian_context(env)
        assert ctx["revise_pr"] == 42
        assert ctx["defer_pr"] is False

    def test_defer_pr_alone_still_works(self):
        """Mutual exclusion only activates when revise_pr is set."""
        env = {"WORCA_DEFER_PR": "1"}
        ctx = build_guardian_context(env)
        assert ctx["revise_pr"] is None
        assert ctx["defer_pr"] is True

    def test_revise_pr_invalid_does_not_suppress_defer(self):
        """An invalid WORCA_REVISE_PR (not a positive int) → revise_pr=None,
        defer_pr is unaffected."""
        env = {"WORCA_REVISE_PR": "not-a-number", "WORCA_DEFER_PR": "1"}
        ctx = build_guardian_context(env)
        assert ctx["revise_pr"] is None
        assert ctx["defer_pr"] is True
