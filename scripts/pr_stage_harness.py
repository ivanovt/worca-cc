#!/usr/bin/env python3
"""Stage prompt harness — fast iteration on a single stage's instructions.

Runs one stage of the pipeline in isolation against a fresh worktree with
a small dummy change. Uses the runner's own prompt construction
(PromptBuilder + OverlayResolver + resolve_agent) so the rendered prompt
is byte-identical to what a real pipeline would send.

Usage:
    python scripts/pr_stage_harness.py <target_repo> [--stage pr|review|...] [--keep]

Defaults to the PR stage (guardian agent). Pass --stage review to run the
reviewer against the same dummy change instead — useful as a control to
verify the harness itself works for an agent that's known to emit
structured_output.

Reports envelope.structured_output presence, num_turns, cost, and the
final result text so prompt variations can be compared at a glance.
"""
import argparse
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Make the package importable when run from a checkout
_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT / "src"))

from worca.orchestrator.overlay import (  # noqa: E402
    OverlayResolver,
    resolve_agent,
    resolve_placeholders,
)
from worca.orchestrator.prompt_builder import PromptBuilder  # noqa: E402
from worca.orchestrator.stages import (  # noqa: E402
    STAGE_AGENT_MAP,
    STAGE_SCHEMA_MAP,
    Stage,
)
from worca.utils.claude_cli import run_agent  # noqa: E402
from worca.utils.runtime import copy_claude_config  # noqa: E402


def _git(args, *, cwd, check=True):
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        text=True,
        check=check,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def _new_run_id() -> str:
    return (
        datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        + "-"
        + uuid.uuid4().hex[:6]
    )


def create_worktree(target: Path, base_ref: str | None) -> tuple[Path, str, str]:
    run_id = _new_run_id()
    branch = f"harness/pr-{run_id}"
    worktree = target / ".worktrees" / f"harness-{run_id}"
    base = base_ref or "HEAD"
    _git(["worktree", "add", "-b", branch, str(worktree), base], cwd=target)
    return worktree, branch, run_id


def cleanup_worktree(target: Path, worktree: Path, branch: str) -> None:
    _git(["worktree", "remove", "--force", str(worktree)], cwd=target, check=False)
    _git(["branch", "-D", branch], cwd=target, check=False)


def write_dummy_change(worktree: Path, run_id: str) -> str:
    """Write an unstaged file the guardian must commit."""
    marker = worktree / "HARNESS_MARKER.txt"
    body = (
        f"PR-stage harness marker\n"
        f"run_id: {run_id}\n"
        f"timestamp: {datetime.now(timezone.utc).isoformat()}\n"
    )
    marker.write_text(body)
    return str(marker)


def build_prompt_and_agent(
    worktree: Path,
    stage: Stage,
    title: str,
    description: str,
    approach: str,
    branch: str,
) -> tuple[str, str, str]:
    """Render the stage's user prompt + agent system prompt.

    Mirrors runner.run_pipeline's prompt construction for any stage.

    Returns (rendered_user_prompt, resolved_agent_path, schema_path).
    """
    core_dir = str(worktree / ".claude" / "worca" / "agents" / "core")
    schemas_dir = worktree / ".claude" / "worca" / "schemas"

    if not Path(core_dir).is_dir():
        sys.exit(f"error: missing {core_dir} (worca runtime not installed in worktree)")
    schema_path = schemas_dir / STAGE_SCHEMA_MAP[stage]
    if not schema_path.exists():
        sys.exit(f"error: missing schema {schema_path}")

    overrides_dir = str(worktree / ".claude" / "agents")
    resolver = OverlayResolver(overrides_dir=overrides_dir)

    agent_name = STAGE_AGENT_MAP[stage]
    run_dir = worktree / ".worca" / "runs" / "harness"
    (run_dir / "agents").mkdir(parents=True, exist_ok=True)
    src_agent = Path(core_dir) / f"{agent_name}.md"
    dst_agent = run_dir / "agents" / src_agent.name
    dst_agent.write_text(src_agent.read_text())

    pb = PromptBuilder(
        work_request_title=title,
        work_request_description=description,
        claude_md_path=str(worktree / "CLAUDE.md"),
        master_plan_path=str(worktree / "MASTER_PLAN.md"),
        resolver=resolver,
        core_dir=core_dir,
        run_dir=str(run_dir),
    )
    pb.update_context("plan_approach", approach)
    pb.update_context("branch", branch)
    pb.update_context("title", title)
    pb.update_context("target_branch", "")

    ctx = pb.build_context(stage.value, iteration=0)

    agent_template = dst_agent.read_text()
    rendered_agent = resolve_agent(
        agent_template, ctx, resolver, core_dir, template_agents_dir=None
    )
    resolved_dir = run_dir / "agents" / "resolved"
    resolved_dir.mkdir(exist_ok=True)
    resolved_agent_path = resolved_dir / f"{stage.value}-{agent_name}-iter-1.md"
    resolved_agent_path.write_text(rendered_agent)

    block = resolver.resolve_block(stage.value, core_dir, template_agents_dir=None)
    if not block:
        sys.exit(f"error: could not resolve {stage.value}.block.md")
    user_prompt = resolve_placeholders(block, ctx).strip()

    return user_prompt, str(resolved_agent_path), str(schema_path)


def report(envelope: dict) -> int:
    """Print a single-line-per-metric report. Returns suggested exit code."""
    so = envelope.get("structured_output")
    subtype = envelope.get("subtype")
    is_error = envelope.get("is_error")
    turns = envelope.get("num_turns")
    cost = envelope.get("total_cost_usd", 0.0)
    duration_ms = envelope.get("duration_ms", 0)
    result = envelope.get("result", "") or ""

    print()
    print("=" * 72)
    if so is not None:
        print(f"  structured_output:  POPULATED  keys={sorted(so.keys())}")
    else:
        print("  structured_output:  None  (model did NOT invoke synthetic tool)")
    print(f"  subtype:            {subtype}")
    print(f"  is_error:           {is_error}")
    print(f"  num_turns:          {turns}")
    print(f"  cost_usd:           {cost:.4f}")
    print(f"  duration:           {duration_ms / 1000:.1f}s")
    print(f"  result length:      {len(result)} chars")
    if result:
        preview = result if len(result) <= 400 else result[:400] + "…"
        print(f"  result preview:     {preview!r}")
    print("=" * 72)

    return 0 if (so is not None and not is_error) else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", help="Path to a project that has .claude/worca installed")
    parser.add_argument(
        "--stage",
        default="pr",
        choices=[s.value for s in Stage if STAGE_AGENT_MAP.get(s)],
        help="Pipeline stage to run (default: pr). Useful to run --stage review as a control.",
    )
    parser.add_argument("--branch", default=None, help="Base branch/ref for the worktree (default: HEAD)")
    parser.add_argument("--keep", action="store_true", help="Don't clean up the worktree on exit")
    parser.add_argument(
        "--title", default="Harness canary: marker file commit",
        help="Work request title to feed into the prompt",
    )
    parser.add_argument(
        "--description",
        default=(
            "Stage HARNESS_MARKER.txt, commit it with a scoped message, push the branch, "
            "and open a PR. The file already exists on disk, unstaged."
        ),
        help="Work request description to feed into the prompt",
    )
    parser.add_argument(
        "--approach",
        default="Stage HARNESS_MARKER.txt, commit, push, open the PR.",
        help="Plan approach summary to feed into the prompt",
    )
    parser.add_argument("--model", default="claude-opus-4-6")
    args = parser.parse_args()

    target = Path(args.target).resolve()
    if not (target / ".claude" / "worca").is_dir():
        sys.exit(f"error: {target} does not have .claude/worca installed")

    stage = Stage(args.stage)
    worktree, branch, run_id = create_worktree(target, args.branch)
    print(f"[harness] stage:     {stage.value} (agent={STAGE_AGENT_MAP[stage]})")
    print(f"[harness] run_id:    {run_id}")
    print(f"[harness] worktree:  {worktree}")
    print(f"[harness] branch:    {branch}")

    try:
        # Replicate run_worktree.py's setup: copy parent's .claude/ (which is
        # gitignored) into the worktree so .claude/worca/ is available.
        copy_claude_config(str(target / ".claude"), str(worktree / ".claude"))

        marker = write_dummy_change(worktree, run_id)
        print(f"[harness] dummy change: {marker}")

        user_prompt, agent_path, schema_path = build_prompt_and_agent(
            worktree, stage, args.title, args.description, args.approach, branch,
        )
        print(f"[harness] schema:    {schema_path}")
        print(f"[harness] agent:     {agent_path}")
        print(f"[harness] user prompt: {len(user_prompt)} chars")

        log_path = worktree / ".worca" / "runs" / "harness" / "logs" / stage.value / "iter-1.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)

        # Run from the worktree so claude CLI sees the right cwd.
        cwd_was = os.getcwd()
        os.chdir(str(worktree))
        try:
            print(f"[harness] invoking claude (model={args.model})…")
            envelope = run_agent(
                prompt=user_prompt,
                agent=agent_path,
                json_schema=schema_path,
                model=args.model,
                log_path=str(log_path),
            )
        finally:
            os.chdir(cwd_was)

        rc = report(envelope)
        return rc
    finally:
        if args.keep:
            print(f"[harness] keeping worktree: {worktree}")
        else:
            print("[harness] cleaning up worktree…")
            cleanup_worktree(target, worktree, branch)


if __name__ == "__main__":
    sys.exit(main())
