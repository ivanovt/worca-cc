"""Render-output tests for the guardian agent prompt.

After issue #165 the env-var branching that used to live in
``guardian.md`` prose now lives in
``worca.orchestrator.guardian_context``. These tests render the
template via ``resolve_placeholders`` for each fleet/workspace/standalone
combination and assert on the resolved output.

The previous content-grep assertions against the raw .md file are still
expressed here (now as render-output assertions) so the behavioral
contract from W-040 §11 / W-047 §6 / W-048 §10 is preserved.

Issue: https://github.com/SinishaDjukic/worca-cc/issues/165
"""
from __future__ import annotations

import pathlib
import re

from worca.orchestrator.guardian_context import build_guardian_context
from worca.orchestrator.overlay import resolve_placeholders


GUARDIAN_PATH = (
    pathlib.Path(__file__).parent.parent
    / "src"
    / "worca"
    / "agents"
    / "core"
    / "guardian.md"
)

RUNNER_PATH = (
    pathlib.Path(__file__).parent.parent
    / "src"
    / "worca"
    / "orchestrator"
    / "runner.py"
)


def _render(env: dict) -> str:
    template = GUARDIAN_PATH.read_text()
    return resolve_placeholders(template, build_guardian_context(env))


# ---------------------------------------------------------------------------
# Issue #165 — Step 5 test table (render-output assertions)
# ---------------------------------------------------------------------------


class TestStandaloneRendering:
    def test_standalone_run_renders_pr_creation(self):
        """Empty env → rendered text contains 'Open the PR', does NOT contain
        'deferred', prefix slot resolves to empty."""
        rendered = _render({})
        assert "Open the PR" in rendered
        assert "deferred" not in rendered
        # Prefix slot resolves to an empty backtick pair
        assert "**Prefix:** ``" in rendered

    def test_standalone_footer_is_empty(self):
        rendered = _render({})
        # The footer code fence contains only whitespace
        m = re.search(r"\*\*Footer:\*\*\s*\n+```\n(.*?)```", rendered, re.DOTALL)
        assert m is not None
        assert m.group(1).strip() == ""


class TestDeferPrRendering:
    def test_defer_pr_renders_skip_branch(self):
        """WORCA_DEFER_PR=1 → rendered text contains 'deferred' and does NOT
        contain the 'Open the PR' heading or the imperative
        'gh pr create --base' invocation.

        Note: the literal string 'gh pr create' can still appear in the
        deferred branch in a 'do not call gh pr create' instruction. We
        check for the imperative invocation pattern instead."""
        rendered = _render({"WORCA_DEFER_PR": "1"})
        assert "deferred" in rendered
        assert "Open the PR" not in rendered
        assert "gh pr create --base" not in rendered
        # The skip-instruction must be explicit and unambiguous
        assert "Do not" in rendered or "do not" in rendered

    def test_defer_pr_specifies_deferred_output_shape(self):
        """The deferred branch must spec the JSON shape the orchestrator
        expects: deferred:true + commit_sha, no pr_number/pr_url. Without
        this the guardian would emit a malformed output that fails
        pr.json validation and _verify_pr_stage."""
        rendered = _render({"WORCA_DEFER_PR": "1"})
        # Tells the model the discriminator field
        assert "deferred: true" in rendered or "deferred=true" in rendered or "`deferred`" in rendered
        # Tells the model to include commit_sha
        assert "commit_sha" in rendered
        # Tells the model NOT to include pr_number / pr_url
        assert "pr_number" in rendered  # mentioned as "do not include"
        assert "pr_url" in rendered
        assert "Do NOT" in rendered or "Do not" in rendered or "do not" in rendered

    def test_defer_pr_zero_does_not_defer(self):
        """Only literal '1' should defer — '0' must render the PR-creation
        branch normally."""
        rendered = _render({"WORCA_DEFER_PR": "0"})
        assert "Open the PR" in rendered
        assert "deferred" not in rendered


class TestFleetRendering:
    def test_fleet_prefix_appears_in_rendered_prompt(self):
        """WORCA_FLEET_ID=f_..._a1b2c3d4 → rendered text contains
        '[fleet:a1b2c3d4]' and the fleet manifest footer."""
        env = {"WORCA_FLEET_ID": "f_202601011200_a1b2c3d4"}
        rendered = _render(env)
        assert "[fleet:a1b2c3d4]" in rendered
        assert "Fleet manifest:" in rendered
        assert "f_202601011200_a1b2c3d4.json" in rendered


class TestWorkspaceRendering:
    def test_workspace_prefix_appears_in_rendered_prompt(self):
        """WORCA_WORKSPACE_ID=ws_..._b3c4d5e6 + name → rendered text
        contains '[workspace:b3c4d5e6]' and the workspace name."""
        env = {
            "WORCA_WORKSPACE_ID": "ws_202601011200_b3c4d5e6",
            "WORCA_WORKSPACE_NAME": "my-platform",
        }
        rendered = _render(env)
        assert "[workspace:b3c4d5e6]" in rendered
        assert "**Workspace:** my-platform" in rendered
        assert "`ws_202601011200_b3c4d5e6`" in rendered

    def test_workspace_without_defer_still_creates_pr(self):
        """A workspace-tagged run with no defer flag falls back to normal PR
        creation (this is not the production path but the rendering must
        still produce a coherent prompt)."""
        env = {
            "WORCA_WORKSPACE_ID": "ws_202601011200_b3c4d5e6",
            "WORCA_WORKSPACE_NAME": "my-platform",
        }
        rendered = _render(env)
        assert "Open the PR" in rendered
        assert "deferred" not in rendered


class TestSourcePromptHygiene:
    """Acceptance: 'No WORCA_* env-var inspection prose survives outside the
    explicit "do NOT read" rule.'"""

    def test_source_prompt_does_not_inspect_env_vars(self):
        """The raw guardian.md source must not contain WORCA_FLEET_ID /
        WORCA_WORKSPACE_ID / WORCA_DEFER_PR / WORCA_WORKSPACE_NAME
        outside the single 'do NOT read' rule in ## Rules."""
        source = GUARDIAN_PATH.read_text()

        # Split off the ## Rules section — the "do NOT read" line is allowed there.
        body, _, _rules = source.partition("## Rules")

        for var in (
            "WORCA_FLEET_ID",
            "WORCA_WORKSPACE_ID",
            "WORCA_DEFER_PR",
            "WORCA_WORKSPACE_NAME",
        ):
            assert var not in body, (
                f"env var {var} still referenced in guardian.md outside ## Rules — "
                "the whole point of #165 is to remove env-var inspection from the prompt"
            )

    def test_source_prompt_does_not_contain_bash_id_extraction(self):
        """The bash 'sed' one-liner that derived fleet_id_short / workspace_short
        must be gone — the orchestrator pre-computes the prefix."""
        source = GUARDIAN_PATH.read_text()
        assert "sed 's/.*_//'" not in source
        assert "fleet_id_short" not in source
        assert "workspace_short" not in source

    def test_source_prompt_uses_template_variables(self):
        """The template variables must actually appear in the source."""
        source = GUARDIAN_PATH.read_text()
        assert "{{#if defer_pr}}" in source
        assert "{{#if revise_pr}}" in source
        assert "{{pr_title_prefix}}" in source
        assert "{{pr_footer}}" in source

    def test_source_prompt_no_orphan_placeholders_after_render(self):
        """After rendering with a representative env, no `{{...}}` tokens
        should remain (catches typos like {{pr_title_perfix}}).

        We render the three modes that matter — standalone, fleet, workspace
        with defer — and confirm none leave unresolved placeholders."""
        for env in (
            {},
            {"WORCA_FLEET_ID": "f_202601011200_a1b2c3d4"},
            {
                "WORCA_WORKSPACE_ID": "ws_202601011200_b3c4d5e6",
                "WORCA_WORKSPACE_NAME": "my-platform",
                "WORCA_DEFER_PR": "1",
            },
            {"WORCA_REVISE_PR": "42"},
        ):
            rendered = _render(env)
            assert "{{" not in rendered, (
                f"unresolved placeholder in rendered guardian for env={env}:\n{rendered}"
            )


# ---------------------------------------------------------------------------
# Behavior preservation — assertions from the pre-#165 state machine tests,
# rewritten to operate on the rendered output instead of raw source.
# ---------------------------------------------------------------------------


class TestRunnerWiring:
    """Acceptance: build_guardian_context output must reach the
    prompt_builder context so dispatch-time resolve_agent resolves the
    new placeholders in guardian.md.

    During implementation we found that the dict passed to
    `_render_agent_templates` is dead code — that function only does
    overlay merging, never placeholder substitution. Placeholder
    resolution happens later via `resolve_agent` against
    `prompt_builder.build_context(...)`. So the correct wiring site is
    `prompt_builder.update_context(...)`, not the call-site dict literal
    named in the issue spec."""

    def test_runner_imports_build_guardian_context(self):
        src = RUNNER_PATH.read_text()
        assert "from worca.orchestrator.guardian_context import build_guardian_context" in src

    def test_runner_threads_context_via_prompt_builder(self):
        """The guardian context must be wired into prompt_builder, not just
        the _render_agent_templates call-site dict (which is unused by the
        renderer). Regression catch for the wiring bug discovered in the
        first real-run smoke test."""
        src = RUNNER_PATH.read_text()
        # The call to build_guardian_context must appear adjacent to an
        # update_context call to prove the values land in prompt_builder.
        assert "build_guardian_context(os.environ)" in src
        # Crude proximity check: both tokens within the same 300-char window.
        idx = src.find("build_guardian_context(os.environ)")
        window = src[max(0, idx - 300):idx + 300]
        assert "prompt_builder.update_context" in window, (
            "build_guardian_context output must be threaded into "
            "prompt_builder.update_context; otherwise dispatch-time "
            "resolve_agent will not have the keys and guardian.md will "
            "render with raw {{...}} placeholders"
        )


class TestEndToEndDispatchRendering:
    """Simulate the dispatch-time path: load the rendered overlay file from
    a fake run_dir, build a prompt-builder-style context, run resolve_agent,
    and assert the resolved output is clean. Catches the same bug as the
    real-run smoke test without spending pipeline cycles."""

    def _resolve_via_dispatch_path(self, env: dict, tmp_path) -> str:
        """Replicate what runner.py does: _render_agent_templates writes the
        merged template; resolve_agent then renders it with the dispatch
        context (prompt_builder.build_context output)."""
        from worca.orchestrator.overlay import OverlayResolver, resolve_agent

        # Stage 1: simulate _render_agent_templates (overlay merge only —
        # the function does NOT call resolve_placeholders).
        agents_core_dir = tmp_path / "agents" / "core"
        agents_core_dir.mkdir(parents=True)
        # Copy the source guardian.md to the simulated core dir.
        (agents_core_dir / "guardian.md").write_text(GUARDIAN_PATH.read_text())

        merged = (agents_core_dir / "guardian.md").read_text()

        # Stage 2: dispatch-time resolve_agent with the full context.
        # Build the context the way prompt_builder.build_context would: it
        # carries arbitrary keys including those updated via
        # prompt_builder.update_context — which after #165 must include
        # the build_guardian_context output.
        ctx: dict = {
            "plan_file": "plan-001.md",
            "run_id": "20260517-000000-000-abcd",
            "branch": "test-branch",
            "title": "test",
            "work_request": "test wr",
            "assigned_task": "",
            "guide_content": "",
            "has_guide": False,
        }
        ctx.update(build_guardian_context(env))

        resolver = OverlayResolver(overrides_dir=str(tmp_path / "overrides"))
        return resolve_agent(
            merged, ctx, resolver, str(agents_core_dir),
            template_agents_dir=None,
        )

    def test_standalone_dispatch_resolves_cleanly(self, tmp_path):
        resolved = self._resolve_via_dispatch_path({}, tmp_path)
        assert "{{" not in resolved, f"orphan placeholder:\n{resolved}"
        assert "Open the PR" in resolved
        assert "deferred" not in resolved

    def test_fleet_dispatch_resolves_cleanly(self, tmp_path):
        env = {"WORCA_FLEET_ID": "f_202601011200_a1b2c3d4"}
        resolved = self._resolve_via_dispatch_path(env, tmp_path)
        assert "{{" not in resolved
        assert "[fleet:a1b2c3d4]" in resolved
        assert "Fleet manifest:" in resolved

    def test_workspace_defer_dispatch_resolves_cleanly(self, tmp_path):
        env = {
            "WORCA_WORKSPACE_ID": "ws_202601011200_b3c4d5e6",
            "WORCA_WORKSPACE_NAME": "my-platform",
            "WORCA_DEFER_PR": "1",
        }
        resolved = self._resolve_via_dispatch_path(env, tmp_path)
        assert "{{" not in resolved
        assert "deferred" in resolved
        assert "gh pr create --base" not in resolved


class TestBehaviorPreservation:
    """Each test mirrors a pre-#165 assertion to prove no behavioral
    regression from the refactor."""

    def test_defer_pr_short_circuits(self):
        """Pre-#165: defer rule documented. Now: deferred branch is what
        actually renders when WORCA_DEFER_PR=1 — the imperative
        'gh pr create --base' invocation is gone."""
        rendered = _render({"WORCA_DEFER_PR": "1"})
        assert "deferred" in rendered
        assert "gh pr create --base" not in rendered

    def test_fleet_title_prefix(self):
        """Pre-#165: '[fleet:' and 'fleet_id_short' both appear in source.
        Now: the rendered prefix is '[fleet:<short>]' and the source no
        longer needs to describe the extraction."""
        rendered = _render({"WORCA_FLEET_ID": "f_202601011200_a1b2c3d4"})
        assert "[fleet:a1b2c3d4]" in rendered

    def test_workspace_title_prefix(self):
        rendered = _render({"WORCA_WORKSPACE_ID": "ws_202601011200_b3c4d5e6"})
        assert "[workspace:b3c4d5e6]" in rendered

    def test_target_branch_used_in_base(self):
        """The target_branch → --base instruction must still be present so the
        agent knows to read status.json and pass --base."""
        rendered = _render({})
        assert "target_branch" in rendered
        assert "--base" in rendered

    def test_combined_workspace_run_renders_all_clauses(self):
        """All six clauses from the old §6.5 still produce correct output:
        defer respect, workspace title, target_branch base, workspace body
        line. (Repo role was removed in ed9161e and is not asserted here.)"""
        env = {
            "WORCA_WORKSPACE_ID": "ws_202601011200_b3c4d5e6",
            "WORCA_WORKSPACE_NAME": "my-platform",
            "WORCA_DEFER_PR": "1",
        }
        rendered = _render(env)
        # defer wins — PR-creation imperative absent
        assert "deferred" in rendered
        assert "gh pr create --base" not in rendered
        assert "target_branch" not in rendered  # base-branch step is in the PR-create branch
        assert "**Workspace:**" not in rendered  # footer is only emitted on the PR-create branch

        # Now flip defer off — workspace + body augmentation should appear.
        env_no_defer = dict(env)
        del env_no_defer["WORCA_DEFER_PR"]
        rendered_no_defer = _render(env_no_defer)
        assert "[workspace:b3c4d5e6]" in rendered_no_defer
        assert "target_branch" in rendered_no_defer
        assert "**Workspace:** my-platform" in rendered_no_defer
