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
import json
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


def _copy_claude_config(src_dir: str, dst_dir: str) -> None:
    """Copy .claude/ contents into the worktree.

    Most projects gitignore .claude/ (or just don't commit it), so a fresh
    worktree starts with no .claude/ at all — preflight then fails on the
    missing settings.json. Copy everything from the project's .claude/ into
    the worktree, with three rules:

    - Skip settings.local.json (machine-specific; never propagate verbatim).
    - Never clobber files git has already placed in the worktree (i.e. the
      project does commit parts of .claude/). Tracked files win.
    - Narrow exception to the local-skip rule: a small allowlist of
      worca-namespace runtime keys (webhooks, events) is merged from the
      parent's settings.local.json into the worktree's settings.json. Without
      this, the worca-ui's auto-installed loopback webhook (which lives in
      the parent's settings.local.json) doesn't reach the worktree pipeline,
      and the UI receives zero pipeline events from worktree runs.
    """
    skip_top_level = {"settings.local.json"}
    if not os.path.isdir(src_dir):
        return
    for root, _dirs, files in os.walk(src_dir):
        rel = os.path.relpath(root, src_dir)
        if rel == ".":
            files = [f for f in files if f not in skip_top_level]
        for f in files:
            dst_file = os.path.join(dst_dir, rel, f)
            if os.path.exists(dst_file):
                continue  # tracked-files-win
            os.makedirs(os.path.dirname(dst_file), exist_ok=True)
            shutil.copy2(os.path.join(root, f), dst_file)

    _propagate_runtime_local_keys(src_dir, dst_dir)


# Allowlist of worca-namespace keys that are derived from the parent's
# runtime (host:port of the local UI, etc.) but must follow the run into
# the worktree. Everything else in settings.local.json stays parent-only.
_PROPAGATED_LOCAL_WORCA_KEYS = ("webhooks", "events")


def _propagate_runtime_local_keys(src_dir: str, dst_dir: str) -> None:
    """Merge a narrow allowlist of worca-namespace keys from the parent's
    settings.local.json into the worktree's settings.json.

    No-op when:
    - The parent has no settings.local.json.
    - The local file has no worca-namespace runtime keys.
    - The worktree's settings.json was tracked by git (we never clobber it).
    """
    src_local = os.path.join(src_dir, "settings.local.json")
    dst_settings = os.path.join(dst_dir, "settings.json")
    if not os.path.exists(src_local) or not os.path.exists(dst_settings):
        return

    try:
        with open(src_local) as f:
            local = json.load(f)
    except (OSError, json.JSONDecodeError):
        return

    local_worca = (local.get("worca") if isinstance(local, dict) else None) or {}
    overlay = {
        k: local_worca[k]
        for k in _PROPAGATED_LOCAL_WORCA_KEYS
        if k in local_worca
    }
    if not overlay:
        return

    try:
        with open(dst_settings) as f:
            base = json.load(f)
    except (OSError, json.JSONDecodeError):
        base = {}
    if not isinstance(base, dict):
        base = {}

    base_worca = base.get("worca")
    if not isinstance(base_worca, dict):
        base_worca = {}

    # Apply each allowlisted key with deep-merge semantics consistent with
    # worca.utils.settings.load_settings: dicts merge recursively, lists/
    # scalars from the overlay replace wholesale.
    for key, value in overlay.items():
        if (
            isinstance(value, dict)
            and isinstance(base_worca.get(key), dict)
        ):
            base_worca[key] = _deep_merge(base_worca[key], value)
        else:
            base_worca[key] = value

    base["worca"] = base_worca

    with open(dst_settings, "w") as f:
        json.dump(base, f, indent=2)
        f.write("\n")


def _deep_merge(base: dict, override: dict) -> dict:
    """Same semantics as worca.utils.settings.deep_merge — dict-recursive,
    list/scalar replace. Local copy to keep this script self-contained."""
    result = dict(base)
    for k, v in override.items():
        if (
            k in result
            and isinstance(result[k], dict)
            and isinstance(v, dict)
        ):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result


def _build_pipeline_cmd(args: argparse.Namespace, run_id: str = "") -> list:
    """Build the run_pipeline.py argv to spawn inside the worktree.

    Pure function over parsed args — no filesystem or env side effects — so
    tests can assert the exact argv shape without mocking Popen.

    When run_id is given (called from main()), it is forwarded as --run-id
    so the runner uses the same key as the multi-pipeline registry entry
    written by register_pipeline(). When empty, --run-id is omitted and the
    runner falls back to generating one (legacy in-place callers).
    """
    cmd = [
        sys.executable,
        os.path.join(".claude", "worca", "scripts", "run_pipeline.py"),
        "--worktree",
        "--registry-base",
        os.path.abspath(".worca"),
    ]
    if run_id:
        cmd.extend(["--run-id", run_id])

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

    # Step 3: create git worktree at the configured base dir
    # (worca.parallel.worktree_base_dir, default .worktrees relative to
    # the project root; absolute and ~-prefixed paths are honored).
    from worca.utils.settings import load_settings
    _settings = load_settings(args.settings)
    _wt_base = (
        _settings.get("worca", {})
        .get("parallel", {})
        .get("worktree_base_dir", ".worktrees")
    )
    worktree_path = create_pipeline_worktree(run_id, slug, base_branch, _wt_base)
    if not worktree_path:
        print(f"error: failed to create worktree for run {run_id}", file=sys.stderr)
        return 1

    # Step 4: copy .claude/ into the worktree (settings.json, agents/, hooks/,
    # scripts/, skills/, templates/, worca/, etc.). Most projects gitignore
    # .claude/, so the worktree starts empty; without this copy preflight
    # fails on missing settings.json. Files git already placed in the
    # worktree are preserved.
    _copy_claude_config(".claude", os.path.join(worktree_path, ".claude"))

    # Step 5: init beads in worktree
    init_worktree_beads(worktree_path)

    # Step 6: register in pipelines.d/. The branch is the worktree's own
    # branch (worca/<slug>-<run_id>, written by create_pipeline_worktree);
    # storing it lets the Worktrees view show it without reaching into the
    # worktree's status.json.
    register_pipeline(
        run_id=run_id,
        worktree_path=worktree_path,
        title=wr.title,
        pid=os.getpid(),
        branch=f"worca/{slug}-{run_id}",
        fleet_id=args.fleet_id,
        target_branch=args.branch,
    )

    # Step 7: build and spawn run_pipeline.py --worktree (detached, fire-and-forget)
    cmd = _build_pipeline_cmd(args, run_id=run_id)

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
