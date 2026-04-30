# /// script
# requires-python = ">=3.8"
# ///
"""Launch a single work request in an isolated git worktree pipeline.

Creates a git worktree, copies the worca runtime into it, registers in the
multi-pipeline registry, and spawns run_pipeline.py --worktree as a detached
subprocess. Exits immediately (fire-and-forget).

Usage:
    python .claude/worca/scripts/run_worktree.py \
        --prompt "Add user auth" \
        --branch feature/auth \
        --plan path/to/plan.md \
        --fleet-id f_20260426_abc
"""
import argparse
import os
import re
import secrets
import shutil
import subprocess
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from worca.orchestrator.registry import register_pipeline
from worca.orchestrator.work_request import normalize
from worca.utils.git import create_pipeline_worktree, init_worktree_beads


def _generate_run_id() -> str:
    """Generate a unique run ID in YYYYMMDD-HHMMSS-mmm-xxxx format."""
    now = datetime.now(timezone.utc)
    millis = now.microsecond // 1000
    suffix = secrets.token_hex(2)
    return f"{now.strftime('%Y%m%d-%H%M%S')}-{millis:03d}-{suffix}"


def _slugify(title: str) -> str:
    """Convert a title to a filesystem-safe slug (max 30 chars)."""
    name = title.lower().strip()
    name = re.sub(r"[^a-z0-9\-]", "-", name)
    name = re.sub(r"-+", "-", name)
    return name.strip("-")[:30]


def _build_pipeline_cmd(args: argparse.Namespace) -> list:
    """Build the run_pipeline.py argv to spawn inside the worktree.

    Pure function over parsed args — no filesystem or env side effects — so
    tests can assert the exact argv shape without mocking Popen.
    """
    cmd = [
        sys.executable,
        os.path.join(".claude", "worca", "scripts", "run_pipeline.py"),
        "--worktree",
        "--registry-base",
        os.path.abspath(".worca"),
    ]

    if args.source:
        cmd.extend(["--source", args.source])
    else:
        cmd.extend(["--prompt", args.prompt])

    if args.plan:
        cmd.extend(["--plan", args.plan])

    if args.guide:
        for guide_path in args.guide:
            cmd.extend(["--guide", os.path.abspath(guide_path)])

    if args.branch:
        cmd.extend(["--branch", args.branch])

    if args.msize != 1:
        cmd.extend(["--msize", str(args.msize)])

    if args.mloops != 1:
        cmd.extend(["--mloops", str(args.mloops)])

    if args.template:
        cmd.extend(["--template", args.template])

    if args.param:
        for p in args.param:
            cmd.extend(["--param", p])

    if args.skip_preflight:
        cmd.append("--skip-preflight")

    return cmd


def create_parser() -> argparse.ArgumentParser:
    """Build the argument parser for run_worktree."""
    parser = argparse.ArgumentParser(
        description="Launch a single worca-cc pipeline in an isolated git worktree"
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--prompt", help="Text prompt for work request")
    group.add_argument("--source", help="Source reference (gh:issue:42, bd:bd-abc)")

    parser.add_argument(
        "--branch",
        help="Base branch to fork the worktree from (default: HEAD); stored as target_branch",
    )
    parser.add_argument("--plan", help="Path to pre-made plan file (skips PLAN stage)")
    parser.add_argument(
        "--guide",
        action="append",
        metavar="PATH",
        help="Path to a reference guide (repeatable); resolved to absolute path",
    )
    parser.add_argument("--fleet-id", help="Fleet group ID (from run_fleet.py)")
    parser.add_argument(
        "--msize",
        type=int,
        default=1,
        choices=range(1, 11),
        metavar="[1-10]",
        help="Task size multiplier for max_turns (default: 1)",
    )
    parser.add_argument(
        "--mloops",
        type=int,
        default=1,
        choices=range(1, 11),
        metavar="[1-10]",
        help="Loop multiplier for max iterations (default: 1)",
    )
    parser.add_argument("--template", help="Template ID to apply before running")
    parser.add_argument(
        "--param",
        action="append",
        metavar="KEY=VALUE",
        help="Template parameter override (repeatable)",
    )
    parser.add_argument(
        "--skip-preflight",
        action="store_true",
        help="Skip the PREFLIGHT stage",
    )
    parser.add_argument(
        "--settings",
        default=".claude/settings.json",
        help="Path to settings.json",
    )
    return parser


def main(argv=None) -> int:
    """Entry point. Returns exit code (0 = launched, 1 = worktree failed, 2 = bad args)."""
    parser = create_parser()
    args = parser.parse_args(argv)

    if not args.prompt and not args.source:
        print("error: one of --prompt or --source is required", file=sys.stderr)
        return 2

    # Normalize work request to get a title for the slug and registry entry
    if args.source:
        wr = normalize("source", args.source)
    else:
        wr = normalize("prompt", args.prompt)

    # Validate the worca runtime exists before any side effects (worktree create,
    # registry write, Popen). Without it the spawned run_pipeline.py crashes
    # under stdout=DEVNULL — UI shows "started" then nothing.
    src_worca = os.path.join(".claude", "worca")
    if not os.path.isdir(src_worca):
        print(
            f"error: worca runtime not found at {src_worca}/ — run `worca init .` first",
            file=sys.stderr,
        )
        return 1

    # Steps 1-2: generate run_id and derive slug
    run_id = _generate_run_id()
    slug = _slugify(wr.title)
    base_branch = args.branch or "HEAD"

    # Step 3: create git worktree
    worktree_path = create_pipeline_worktree(run_id, slug, base_branch)
    if not worktree_path:
        print(f"error: failed to create worktree for run {run_id}", file=sys.stderr)
        return 1

    # Step 4: copy .claude/worca/ runtime into worktree (gitignored, won't exist otherwise)
    dst_worca = os.path.join(worktree_path, ".claude", "worca")
    shutil.copytree(src_worca, dst_worca)

    # Step 5: init beads in worktree
    init_worktree_beads(worktree_path)

    # Step 6: register in pipelines.d/
    register_pipeline(
        run_id=run_id,
        worktree_path=worktree_path,
        title=wr.title,
        pid=os.getpid(),
        fleet_id=args.fleet_id,
        target_branch=args.branch,
    )

    # Step 7: build and spawn run_pipeline.py --worktree (detached, fire-and-forget)
    cmd = _build_pipeline_cmd(args)

    env = os.environ.copy()
    env.pop("CLAUDECODE", None)

    subprocess.Popen(
        cmd,
        cwd=worktree_path,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )

    # Step 8: print run_id + path and exit immediately
    print(run_id)
    print(worktree_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
