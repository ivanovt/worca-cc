# /// script
# requires-python = ">=3.8"
# ///
"""Fan out a single work-request to N independent project repositories (W-040).

Accepts N target project paths, one prompt (or --source), an optional
repeatable --guide, an optional --plan, and a --head-template / --base pair,
then launches N isolated pipelines under a shared fleet_id.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

from worca.orchestrator.fleet_manifest import read_fleet_manifest, update_fleet_status
from worca.utils.env import RESERVED_ENV_KEYS, RESERVED_PREFIXES

_FLEET_RUNS_DEFAULT = os.path.expanduser("~/.worca/fleet-runs")


_BRANCH_REJECTION_MSG = (
    "--branch is not a valid flag for run_fleet.py. You probably want one of:\n"
    "  --base <name>             PR base branch (= run_worktree.py --branch)\n"
    "  --head-template <tmpl>    Per-child head branch name template\n"
    "See W-040 §4 for the distinction."
)


def validate_base_branch(projects: list, base: str) -> list:
    """Return project paths where *base* branch is absent.

    Uses ``git -C <target> branch --list <base>`` per §4. Empty or
    whitespace-only output means the branch does not exist locally.
    """
    missing = []
    for project in projects:
        result = subprocess.run(
            ["git", "-C", project, "branch", "--list", base],
            capture_output=True,
            text=True,
        )
        if not result.stdout.strip():
            missing.append(project)
    return missing


def provision_target(project_dir: str, timeout: int) -> tuple:
    """Run ``worca init --upgrade`` in *project_dir* with the given timeout.

    Returns ``(True, None)`` on success, or ``(False, error_message)`` on any
    failure including subprocess timeout. The fleet continues regardless — the
    caller is responsible for tracking setup_failed targets.
    """
    try:
        result = subprocess.run(
            ["worca", "init", "--upgrade"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return False, f"init exceeded {timeout}s — target may be unreachable"

    if result.returncode != 0:
        error = result.stderr.strip() or f"worca init exited with code {result.returncode}"
        return False, error

    return True, None


def _resolve_init_timeout(timeout_flag, settings: dict) -> int:
    """Resolve effective init timeout: --init-timeout > settings > 60."""
    if timeout_flag is not None:
        return timeout_flag
    return settings.get("worca", {}).get("fleet", {}).get("init_timeout_seconds", 60)


def build_child_env(base_env: dict, *, fleet_id: str | None = None) -> dict:
    """Return a copy of *base_env* with all reserved pipeline keys stripped.

    Uses RESERVED_ENV_KEYS and RESERVED_PREFIXES from worca.utils.env as the
    single source of truth — no hand-maintained scrub list here.

    When *fleet_id* is supplied, ``WORCA_FLEET_ID`` is re-injected AFTER the
    scrub so the Guardian agent in the child pipeline can detect fleet
    membership and apply the ``[fleet:<short>]`` PR-title prefix (W-040 §11).
    The scrub strips it first (per §5) to drop any stale value inherited
    from the parent shell.
    """
    result = {}
    for key, value in base_env.items():
        if key in RESERVED_ENV_KEYS:
            continue
        if any(key.startswith(prefix) for prefix in RESERVED_PREFIXES):
            continue
        result[key] = value

    if fleet_id:
        result["WORCA_FLEET_ID"] = fleet_id

    return result


def build_child_cmd(
    project_dir: str,
    fleet_id: str,
    prompt: str | None = None,
    source: str | None = None,
    base: str | None = None,
    guide: list | None = None,
    plan: str | None = None,
) -> list:
    """Build the run_worktree.py command for a single fleet child.

    Each child receives --fleet-id and, when --base was supplied, --branch
    (which is the W-048 base branch parameter).
    """
    run_worktree = os.path.join(os.path.dirname(__file__), "run_worktree.py")
    cmd = [sys.executable, run_worktree]

    if source:
        cmd.extend(["--source", source])
    else:
        cmd.extend(["--prompt", prompt or ""])

    cmd.extend(["--fleet-id", fleet_id])

    if base:
        cmd.extend(["--branch", base])

    for g in guide or []:
        cmd.extend(["--guide", g])

    if plan:
        cmd.extend(["--plan", plan])

    return cmd


def _wait_for_plan(
    worktree_path: str,
    timeout: int = 3600,
    poll_interval: float = 5.0,
) -> str | None:
    """Poll for MASTER_PLAN.md in worktree_path. Returns absolute path or None on timeout."""
    plan_path = os.path.join(worktree_path, "MASTER_PLAN.md")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if os.path.exists(plan_path):
            return plan_path
        time.sleep(poll_interval)
    return None


def run_plan_first(
    *,
    reference_project: str,
    fleet_id: str,
    prompt: str | None,
    source: str | None,
    base: str | None,
    guide: list,
    fleet_runs_base: str | None = None,
) -> str | None:
    """Run the reference child (blocking) and wait for its Planner to produce a plan.

    Dispatches run_worktree.py for the reference project, then polls for
    MASTER_PLAN.md to appear in the resulting worktree. On success, copies the
    plan to <fleet_runs_base>/<fleet_id>/shared-plan.md and returns that path.
    Returns None if the reference child fails to start or the plan never appears.

    The reference child runs its full pipeline independently; only the plan file
    is extracted early to unblock the remaining N-1 children (§6).
    """
    child_env = build_child_env(os.environ.copy(), fleet_id=fleet_id)
    cmd = build_child_cmd(
        project_dir=reference_project,
        fleet_id=fleet_id,
        prompt=prompt,
        source=source,
        base=base,
        guide=guide,
        plan=None,  # reference child generates the plan
    )

    proc = subprocess.run(
        cmd,
        cwd=reference_project,
        env=child_env,
        capture_output=True,
        text=True,
    )

    if proc.returncode != 0:
        print(
            f"plan-first: reference project {reference_project!r} failed "
            f"(exit {proc.returncode})",
            file=sys.stderr,
        )
        return None

    # run_worktree.py prints: <run_id>\n<worktree_path>
    lines = proc.stdout.strip().splitlines()
    if len(lines) < 2:
        print(
            f"plan-first: unexpected output from reference child ({len(lines)} lines)",
            file=sys.stderr,
        )
        return None

    worktree_path = lines[1]

    plan_in_worktree = _wait_for_plan(worktree_path)
    if plan_in_worktree is None:
        print(
            f"plan-first: MASTER_PLAN.md not found in {worktree_path!r} "
            "(Planner may have failed or timed out)",
            file=sys.stderr,
        )
        return None

    if fleet_runs_base is None:
        fleet_runs_base = _FLEET_RUNS_DEFAULT
    fleet_dir = os.path.join(fleet_runs_base, fleet_id)
    os.makedirs(fleet_dir, exist_ok=True)
    shared_plan = os.path.join(fleet_dir, "shared-plan.md")
    shutil.copy2(plan_in_worktree, shared_plan)

    return shared_plan


_DISPATCH_POLL_INTERVAL_SECONDS = 0.2


def dispatch_fleet(
    targets: list,
    fleet_id: str,
    prompt: str | None,
    source: str | None,
    base: str | None,
    guide: list,
    plan: str | None,
    max_parallel: int,
    fleet_failure_threshold: float,
) -> dict:
    """Run fleet children in parallel with a semaphore-gated dispatch loop.

    Up to ``max_parallel`` children run concurrently. Each child is spawned as
    a ``subprocess.Popen`` (non-blocking) and the loop polls for completion
    every ``_DISPATCH_POLL_INTERVAL_SECONDS``. When the failure ratio crosses
    ``fleet_failure_threshold`` (and at least ``min(3, total)`` children have
    completed), the circuit breaker fires: no further children are spawned,
    but already-in-flight children are NEVER killed — they finish naturally
    so the fleet does not leave half-written repos behind (W-040 §7).

    Returns a dict mapping project_dir -> {"status": "completed"|"failed"|"halted"}.
    """
    results = {}
    total = len(targets)
    if total == 0:
        return results

    pending = [t["project_dir"] for t in targets]
    in_flight = {}  # project_dir -> Popen
    failed_count = 0
    halted = False

    def _check_breaker() -> bool:
        """Has the failure threshold been crossed?"""
        terminal_count = len(results)
        min_terminal = min(3, total)
        return (
            terminal_count >= min_terminal
            and failed_count / terminal_count >= fleet_failure_threshold
        )

    while pending or in_flight:
        # Spawn up to max_parallel children. Stops adding new ones once halted.
        while pending and len(in_flight) < max_parallel and not halted:
            project_dir = pending.pop(0)
            child_env = build_child_env(os.environ.copy(), fleet_id=fleet_id)
            cmd = build_child_cmd(
                project_dir=project_dir,
                fleet_id=fleet_id,
                prompt=prompt,
                source=source,
                base=base,
                guide=guide,
                plan=plan,
            )
            in_flight[project_dir] = subprocess.Popen(
                cmd, cwd=project_dir, env=child_env,
            )

        if not in_flight:
            break

        # Poll all in-flight children. Collect any that finished this tick.
        finished = []
        for project_dir, proc in in_flight.items():
            rc = proc.poll()
            if rc is not None:
                finished.append((project_dir, rc))

        if not finished:
            time.sleep(_DISPATCH_POLL_INTERVAL_SECONDS)
            continue

        for project_dir, rc in finished:
            del in_flight[project_dir]
            if rc != 0:
                results[project_dir] = {"status": "failed"}
                failed_count += 1
                if not halted and _check_breaker():
                    halted = True
                    update_fleet_status(
                        fleet_id, "halted", halt_reason="circuit_breaker"
                    )
            else:
                results[project_dir] = {"status": "completed"}

    # After the loop, any children still in `pending` were never launched.
    for project_dir in pending:
        results[project_dir] = {"status": "halted"}

    return results


def resume_fleet(fleet_id: str) -> int:
    """Resume a halted/failed fleet by re-launching failed/pending children.

    Reads the fleet manifest, resolves each child's current status from its
    project's pipelines.d/ directory, and dispatches only those with status
    in {pending, failed, setup_failed}.  Children with status completed,
    running, resuming, paused, or unrecoverable are left alone.

    When a failed child's worktree_path no longer exists on disk, the child is
    marked 'unrecoverable' in its pipelines.d/ entry and skipped.

    Returns 0 on success, 1 if the manifest is not found.
    """
    manifest = read_fleet_manifest(fleet_id)
    if manifest is None:
        print(f"error: fleet manifest not found: {fleet_id!r}", file=sys.stderr)
        return 1

    children = manifest.get("children", [])
    prompt = manifest.get("work_request", {}).get("description") or ""
    source = manifest.get("work_request", {}).get("source")
    base = manifest.get("base_branch")
    guide = manifest.get("guide", {}).get("paths") or []
    plan = manifest.get("plan", {}).get("path")
    max_parallel = manifest.get("max_parallel", 5)
    threshold = manifest.get("fleet_failure_threshold", 0.30)

    _SKIP_STATUSES = frozenset({"completed", "running", "resuming", "paused", "unrecoverable"})
    _RESUMABLE = frozenset({"failed", "pending", "setup_failed"})

    update_fleet_status(fleet_id, "resuming")

    targets = []
    for child in children:
        project_path = child.get("project_path")
        run_id = child.get("run_id")

        if not project_path:
            continue

        child_base = os.path.join(project_path, ".worca")
        entry = None

        if run_id:
            entry_path = os.path.join(
                child_base, "multi", "pipelines.d", f"{run_id}.json"
            )
            try:
                with open(entry_path) as f:
                    entry = json.load(f)
            except (OSError, json.JSONDecodeError):
                entry = None

        if entry is None:
            # No registry entry — treat as pending (never successfully dispatched)
            targets.append({"project_dir": project_path, "status": "pending"})
            continue

        status = entry.get("status", "running")

        if status in _SKIP_STATUSES:
            continue

        # For failed status only: check whether the worktree still exists.
        # setup_failed never created a worktree, so no existence check there.
        # If a failed child's worktree was cleaned up, mark it unrecoverable.
        if status == "failed":
            worktree_path = entry.get("worktree_path")
            if worktree_path and not os.path.exists(worktree_path):
                print(
                    f"skipping run {run_id} — worktree gone (cleaned up)",
                    file=sys.stderr,
                )
                from worca.orchestrator.registry import update_pipeline
                update_pipeline(run_id, status="unrecoverable", base=child_base)
                continue

        if status in _RESUMABLE:
            targets.append({"project_dir": project_path, "status": status})

    if not targets:
        return 0

    dispatch_fleet(
        targets=targets,
        fleet_id=fleet_id,
        prompt=prompt,
        source=source,
        base=base,
        guide=guide,
        plan=plan,
        max_parallel=max_parallel,
        fleet_failure_threshold=threshold,
    )

    return 0


def _load_global_settings() -> dict:
    """Load fleet-level settings from ~/.worca/settings.json."""
    from worca.utils.settings import load_settings
    return load_settings(os.path.expanduser("~/.worca/settings.json"))


class _RejectBranch(argparse.Action):
    """Custom action that immediately errors when --branch is supplied."""

    def __call__(self, parser, namespace, values, option_string=None):
        parser.error(_BRANCH_REJECTION_MSG)


def create_parser() -> argparse.ArgumentParser:
    """Build the argument parser for run_fleet."""
    parser = argparse.ArgumentParser(
        description="Fan out a single work-request to N project repositories",
    )

    # --branch is explicitly rejected per §4 to avoid flag-meaning collision
    # with run_worktree.py where --branch means PR base branch.
    parser.add_argument(
        "--branch",
        action=_RejectBranch,
        nargs="?",
        default=argparse.SUPPRESS,
        help=argparse.SUPPRESS,
    )

    # Target project paths
    parser.add_argument(
        "--projects",
        nargs="+",
        metavar="PATH",
        help="Absolute paths to target project repositories (repeatable)",
    )
    parser.add_argument(
        "--projects-file",
        metavar="FILE",
        help="Path to a file listing project paths (one per line)",
    )

    # Work request source — mutually exclusive
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--prompt", help="Text prompt for work request")
    group.add_argument(
        "--source", help="Source reference (gh:issue:42, bd:bd-abc)"
    )

    # Branch naming (§4 — two separate concepts)
    parser.add_argument(
        "--head-template",
        metavar="TEMPLATE",
        help=(
            "Per-child head branch name template. "
            "Placeholders: {project}, {fleet_id}, {slug}, {yyyymmdd}, {yyyymmddhhmm}. "
            "If no placeholder present, '/{project}' is appended automatically."
        ),
    )
    parser.add_argument(
        "--base",
        metavar="BRANCH",
        help=(
            "PR base branch shared across the fleet "
            "(= run_worktree.py --branch / W-048 target_branch). "
            "Omit to use each repo's default branch."
        ),
    )

    # Guide
    parser.add_argument(
        "--guide",
        action="append",
        metavar="PATH",
        help="Path to a reference guide (repeatable); resolved to absolute paths before dispatch",
    )

    # Plan modes (§6)
    parser.add_argument(
        "--plan",
        metavar="PATH",
        help="Shared plan file; every child receives it and skips the PLAN stage",
    )
    parser.add_argument(
        "--plan-first",
        nargs="?",
        const=True,
        default=False,
        metavar="PROJECT",
        help=(
            "Run the Planner on a reference project, then share its plan with all "
            "remaining children. Optional value: path to the reference project "
            "(defaults to first entry in --projects)."
        ),
    )

    # Concurrency / circuit breaker (§7)
    parser.add_argument(
        "--max-parallel",
        type=int,
        default=5,
        metavar="N",
        help="Maximum number of children dispatched in parallel (default: 5)",
    )
    parser.add_argument(
        "--fleet-failure-threshold",
        type=float,
        default=0.30,
        metavar="RATIO",
        help=(
            "Fraction of failed children that trips the circuit breaker and "
            "halts unstarted children (default: 0.30)"
        ),
    )

    # Resumability (§12)
    parser.add_argument(
        "--resume",
        metavar="FLEET_ID",
        help="Resume a previously halted/failed fleet by re-launching failed/pending children",
    )

    # Pre-generated fleet id (used by the worca-ui POST /api/fleet-runs route
    # so the manifest path is known before dispatch). When provided, manifest
    # creation uses this id verbatim — no random generation.
    parser.add_argument(
        "--fleet-id",
        metavar="ID",
        help="Use this pre-generated fleet id instead of generating one (UI integration)",
    )

    # Provisioning (§2)
    parser.add_argument(
        "--init-timeout",
        type=int,
        default=None,
        metavar="SECONDS",
        help=(
            "Per-target worca init --upgrade timeout in seconds "
            "(overrides worca.fleet.init_timeout_seconds; default: 60)"
        ),
    )

    return parser


def main(argv=None) -> int:
    """Entry point. Returns exit code."""
    parser = create_parser()
    args = parser.parse_args(argv)

    # Require a work request source unless resuming an existing fleet
    if not args.resume and not args.prompt and not args.source:
        print(
            "error: one of --prompt, --source, or --resume is required",
            file=sys.stderr,
        )
        return 2

    # --plan and --plan-first are mutually exclusive (§6)
    if args.plan and args.plan_first:
        print("error: --plan and --plan-first are mutually exclusive", file=sys.stderr)
        return 2

    # Handle --resume: re-launch failed/pending children of an existing fleet
    if args.resume:
        return resume_fleet(args.resume)

    # Base branch pre-flight: verify branch exists in every target repo (§4)
    if args.base:
        projects = list(args.projects or [])
        if projects:
            missing = validate_base_branch(projects, args.base)
            if missing:
                missing_list = "\n".join(f"  {p}" for p in missing)
                print(
                    f"error: base branch '{args.base}' not found in:\n{missing_list}",
                    file=sys.stderr,
                )
                return 1

    # Per-target provisioning: worca init --upgrade (§2)
    projects = list(args.projects or [])
    setup_failed = []
    if projects:
        settings = _load_global_settings()
        init_timeout = _resolve_init_timeout(args.init_timeout, settings)
        for project in projects:
            success, error = provision_target(project, init_timeout)
            if not success:
                print(
                    f"setup_failed: {project}: {error}",
                    file=sys.stderr,
                )
                setup_failed.append(project)

    # Write initial fleet manifest (§10)
    if projects and not args.resume:
        from worca.orchestrator.fleet_manifest import generate_fleet_id, write_fleet_manifest
        from datetime import datetime, timezone

        if args.fleet_id:
            # UI-integration path: caller supplied the id so the manifest
            # filename is known before dispatch. Derive fleet_id_short from
            # the trailing hex segment (matches generate_fleet_id() format
            # f_<yyyymmddhhmm>_<rand>).
            fleet_id = args.fleet_id
            fleet_id_short = fleet_id.rsplit("_", 1)[-1]
        else:
            fleet_id, fleet_id_short = generate_fleet_id()
        guide_paths = [os.path.abspath(g) for g in (args.guide or [])]
        guide_bytes = sum(
            os.path.getsize(p) for p in guide_paths if os.path.isfile(p)
        )
        plan_mode = "none"
        if args.plan:
            plan_mode = "explicit"
        elif args.plan_first:
            plan_mode = "plan-first"

        manifest = {
            "fleet_id": fleet_id,
            "fleet_id_short": fleet_id_short,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "work_request": {
                "title": "",
                "description": args.prompt or "",
                "source": args.source,
            },
            "guide": {
                "paths": guide_paths,
                "bytes": guide_bytes,
                "filenames": [os.path.basename(p) for p in guide_paths],
                "uploaded": False,
            },
            "plan": {
                "mode": plan_mode,
                "path": os.path.abspath(args.plan) if args.plan else None,
            },
            "head_template": args.head_template,
            "base_branch": args.base,
            "max_parallel": args.max_parallel,
            "fleet_failure_threshold": args.fleet_failure_threshold,
            "status": "running",
            "halt_reason": None,
            "children": [],
        }
        write_fleet_manifest(manifest)

    # --plan-first: dispatch reference child (blocking), wait for plan, then fan-out
    # §6: reference child runs Planner first; plan copied to fleet dir; N-1 others
    # launch with that plan. Fleet halts before fan-out if reference Planner fails.
    _plan_first_ref = None
    shared_plan = None
    if projects and not args.resume and args.plan_first:
        provisioned_tmp = [p for p in projects if p not in setup_failed]
        _plan_first_ref = (
            args.plan_first
            if isinstance(args.plan_first, str)
            else (provisioned_tmp[0] if provisioned_tmp else None)
        )
        if _plan_first_ref is not None:
            guide_abs_ref = [os.path.abspath(g) for g in (args.guide or [])]
            shared_plan = run_plan_first(
                reference_project=_plan_first_ref,
                fleet_id=fleet_id,
                prompt=args.prompt,
                source=args.source,
                base=args.base,
                guide=guide_abs_ref,
            )
            if shared_plan is None:
                print(
                    "plan-first: reference Planner failed — halting fleet before fan-out",
                    file=sys.stderr,
                )
                update_fleet_status(fleet_id, "halted", halt_reason="plan_first_failed")
                return 1

    # Dispatch fleet children — skip setup_failed targets
    if projects and not args.resume:
        provisioned = [p for p in projects if p not in setup_failed]
        guide_abs = [os.path.abspath(g) for g in (args.guide or [])]

        if _plan_first_ref is not None:
            # Reference already ran — dispatch remaining N-1 children with shared plan
            remaining = [p for p in provisioned if p != _plan_first_ref]
            dispatch_targets = [{"project_dir": p, "status": "pending"} for p in remaining]
            dispatch_plan = shared_plan
        else:
            dispatch_targets = [{"project_dir": p, "status": "pending"} for p in provisioned]
            dispatch_plan = os.path.abspath(args.plan) if args.plan else None

        dispatch_fleet(
            targets=dispatch_targets,
            fleet_id=fleet_id,
            prompt=args.prompt,
            source=args.source,
            base=args.base,
            guide=guide_abs,
            plan=dispatch_plan,
            max_parallel=args.max_parallel,
            fleet_failure_threshold=args.fleet_failure_threshold,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
