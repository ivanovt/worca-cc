"""Integration tests for the investigate template PR flow.

Tests:
1. Pipeline flow: investigate template runs only PLAN + PR stages, sets template field
2. Governance: guardian can commit, md writes allowed by plan_check
3. Overlay isolation: investigate overlay doesn't leak to normal runs
"""
from tests.mock_claude.conftest import all_succeed, agent_fails

# ---------------------------------------------------------------------------
# Shared scenarios
# ---------------------------------------------------------------------------

_ALL_SUCCEED = all_succeed(delay_s=0.1)

_PLANNER_FAILS = agent_fails("planner", error="Analysis failed — no plan produced")


# ===========================================================================
# Pipeline flow tests
# ===========================================================================


class TestInvestigatePipelineFlow:
    """Verify investigate template runs correct stages and records metadata."""

    def test_investigate_pipeline_completes(self, pipeline_env):
        """Investigate template runs plan + pr stages and completes successfully."""
        result = pipeline_env.run(
            _ALL_SUCCEED,
            prompt="Analyze authentication flow",
            extra_args=["--template", "investigate"],
            timeout=60,
        )

        assert result.status.get("pipeline_status") == "completed", (
            f"Expected completed, got: {result.status.get('pipeline_status')}\n"
            f"stderr: {result.stderr[:500]}"
        )
        assert result.returncode == 0

    def test_investigate_pipeline_stages_correct(self, pipeline_env):
        """Only PLAN and PR stages complete; COORDINATE, IMPLEMENT, TEST, REVIEW are skipped."""
        result = pipeline_env.run(
            _ALL_SUCCEED,
            prompt="Analyze authentication flow",
            extra_args=["--template", "investigate"],
            timeout=60,
        )

        stages = result.status.get("stages", {})
        completed = {
            name for name, data in stages.items()
            if data.get("status") == "completed"
        }

        assert "plan" in completed, f"plan should be completed; stages: {stages}"
        assert "pr" in completed, f"pr should be completed; stages: {stages}"

        for skipped_stage in ("coordinate", "implement", "test", "review"):
            stage_data = stages.get(skipped_stage, {})
            assert stage_data.get("status") != "completed", (
                f"{skipped_stage} should not complete in investigate mode; "
                f"got status: {stage_data.get('status')}"
            )

    def test_investigate_pipeline_template_field(self, pipeline_env):
        """status.pipeline_template is set to 'builtin:investigate'."""
        result = pipeline_env.run(
            _ALL_SUCCEED,
            prompt="Analyze authentication flow",
            extra_args=["--template", "investigate"],
            timeout=60,
        )

        assert result.status.get("pipeline_template") == "builtin:investigate", (
            f"Expected 'builtin:investigate', got: {result.status.get('pipeline_template')}"
        )

    def test_investigate_planner_fails_no_pr(self, pipeline_env):
        """When planner fails, PR stage does not run."""
        result = pipeline_env.run(
            _PLANNER_FAILS,
            prompt="Analyze broken module",
            extra_args=["--template", "investigate"],
            timeout=60,
        )

        assert result.status.get("pipeline_status") == "failed", (
            f"Expected failed, got: {result.status.get('pipeline_status')}\n"
            f"stderr: {result.stderr[:500]}"
        )

        stages = result.status.get("stages", {})
        pr_data = stages.get("pr", {})
        assert pr_data.get("status") != "completed", (
            f"PR stage should not complete when planner fails; got: {pr_data}"
        )

    def test_investigate_without_source_issue(self, pipeline_env):
        """Investigate template works with just --prompt (no --source)."""
        result = pipeline_env.run(
            _ALL_SUCCEED,
            prompt="Analyze codebase structure",
            extra_args=["--template", "investigate"],
            timeout=60,
        )

        assert result.status.get("pipeline_status") == "completed", (
            f"Expected completed, got: {result.status.get('pipeline_status')}\n"
            f"stderr: {result.stderr[:500]}"
        )

        wr = result.status.get("work_request", {})
        assert wr.get("source_ref") is None, (
            f"Expected no source_ref for prompt-only run; got: {wr.get('source_ref')}"
        )


# ===========================================================================
# Governance tests
# ===========================================================================


class TestInvestigateGovernance:
    """Verify governance allows guardian operations in investigate mode."""

    def test_guardian_runs_in_pr_stage(self, pipeline_env):
        """The PR stage invokes the guardian agent successfully."""
        result = pipeline_env.run(
            _ALL_SUCCEED,
            prompt="Analyze test coverage",
            extra_args=["--template", "investigate"],
            timeout=60,
        )

        stages = result.status.get("stages", {})
        pr_data = stages.get("pr", {})
        assert pr_data.get("status") == "completed", (
            f"PR stage should complete (guardian ran); got: {pr_data}\n"
            f"stderr: {result.stderr[:500]}"
        )

    def test_investigate_no_blocked_errors(self, pipeline_env):
        """No governance-blocked errors appear in stderr for investigate runs."""
        result = pipeline_env.run(
            _ALL_SUCCEED,
            prompt="Analyze deployment flow",
            extra_args=["--template", "investigate"],
            timeout=60,
        )

        assert result.status.get("pipeline_status") == "completed"
        assert "Blocked" not in result.stderr, (
            f"Unexpected governance block in stderr: {result.stderr[:500]}"
        )


# ===========================================================================
# Overlay isolation tests
# ===========================================================================


class TestOverlayIsolation:
    """Verify investigate overlays don't leak to non-investigate runs."""

    def test_investigate_overlay_does_not_leak(self, pipeline_env):
        """After an investigate run, a normal run uses the base guardian (not investigate override)."""
        result_investigate = pipeline_env.run(
            _ALL_SUCCEED,
            prompt="Investigate auth",
            extra_args=["--template", "investigate"],
            timeout=60,
        )
        assert result_investigate.status.get("pipeline_status") == "completed"

        result_normal = pipeline_env.run(
            _ALL_SUCCEED,
            prompt="Fix the login bug",
            timeout=60,
        )
        assert result_normal.status.get("pipeline_status") == "completed", (
            f"Normal run should complete; got: {result_normal.status.get('pipeline_status')}\n"
            f"stderr: {result_normal.stderr[:500]}"
        )

        assert result_normal.status.get("pipeline_template") is None, (
            f"Normal run should not have pipeline_template; "
            f"got: {result_normal.status.get('pipeline_template')}"
        )

    def test_normal_run_has_all_stages(self, pipeline_env):
        """A non-investigate run enables the default stages (including implement, test, review)."""
        result = pipeline_env.run(
            _ALL_SUCCEED,
            prompt="Add user feature",
            timeout=60,
        )

        stages = result.status.get("stages", {})
        completed = {
            name for name, data in stages.items()
            if data.get("status") == "completed"
        }

        for expected in ("plan", "coordinate", "implement", "test", "review"):
            assert expected in completed, (
                f"{expected} should complete in a normal run; "
                f"completed stages: {completed}"
            )

    def test_investigate_then_normal_stages_differ(self, pipeline_env):
        """Investigate and normal runs produce different completed stage sets."""
        result_inv = pipeline_env.run(
            _ALL_SUCCEED,
            prompt="Investigate module",
            extra_args=["--template", "investigate"],
            timeout=60,
        )

        result_norm = pipeline_env.run(
            _ALL_SUCCEED,
            prompt="Build the widget",
            timeout=60,
        )

        inv_completed = {
            name for name, data in result_inv.status.get("stages", {}).items()
            if data.get("status") == "completed"
        }
        norm_completed = {
            name for name, data in result_norm.status.get("stages", {}).items()
            if data.get("status") == "completed"
        }

        assert "implement" not in inv_completed, "investigate should not run implement"
        assert "implement" in norm_completed, "normal run should run implement"
        assert "pr" in inv_completed, "investigate should run pr"
