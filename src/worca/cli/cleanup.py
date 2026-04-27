"""worca cleanup — remove completed pipeline worktrees.

Usage:
  worca cleanup                    # Interactive: list worktrees, prompt
  worca cleanup --all              # Remove all completed/failed worktrees
  worca cleanup --run-id <id>      # Remove a specific worktree by run ID
  worca cleanup --dry-run          # List what would be removed
  worca cleanup --older-than 7d    # Remove worktrees started more than 7 days ago

Running worktrees are never eligible for cleanup.

Extensibility: CLEANUP_SOURCES is a list of source objects. Each source
implements list_eligible(filters) and remove(entry). W-040 (FleetSource) and
W-047 (WorkspaceSource) are stubs — add them to CLEANUP_SOURCES when ready.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

from worca.cli.main import _find_git_root
from worca.orchestrator.registry import deregister_pipeline, list_pipelines
from worca.utils.git import remove_pipeline_worktree


# Cleanup-specific: 'failed' is terminal here so failed runs can be reaped.
# Differs from runner/resume, which exclude 'failed' so failed runs stay resumable.
_TERMINAL_STATUSES = {"completed", "failed"}


def _parse_duration(value: str) -> timedelta:
    """Parse a duration string (7d, 24h, 30m) into a timedelta."""
    import re

    m = re.match(r"^(\d+)([dhm])$", value)
    if not m:
        raise argparse.ArgumentTypeError(
            f"Invalid duration {value!r}. Use format: 7d, 24h, 30m"
        )
    amount, unit = int(m.group(1)), m.group(2)
    if unit == "d":
        return timedelta(days=amount)
    if unit == "h":
        return timedelta(hours=amount)
    return timedelta(minutes=amount)


def _format_bytes(n: int) -> str:
    """Return a human-readable byte count string."""
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def _dir_size(path: str) -> int:
    """Return total size of all files under path in bytes.

    Tries `du -sb` first (matches worca-ui/server/worktrees-routes.js so both
    surfaces report the same number for the same worktree); falls back to a
    Python walk on Windows or when du is unavailable.
    """
    try:
        import subprocess
        out = subprocess.check_output(
            ["du", "-sb", path],
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        return int(out.split(b"\t", 1)[0])
    except (OSError, ValueError, subprocess.SubprocessError):
        pass

    total = 0
    for dirpath, _, filenames in os.walk(path):
        for fname in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, fname))
            except OSError:
                pass
    return total


def _read_worktree_status(worktree_path: str) -> str | None:
    """Read pipeline_status from the worktree's status.json files.

    Scans <worktree>/.worca/runs/*/status.json (W-048 layout) and falls back
    to the legacy flat <worktree>/.worca/status.json. Returns None if unreadable.
    """
    runs_dir = os.path.join(worktree_path, ".worca", "runs")
    if os.path.isdir(runs_dir):
        for entry in os.listdir(runs_dir):
            status_path = os.path.join(runs_dir, entry, "status.json")
            if os.path.isfile(status_path):
                try:
                    with open(status_path) as f:
                        data = json.load(f)
                    status = data.get("pipeline_status")
                    if status:
                        return status
                except (json.JSONDecodeError, OSError):
                    pass

    flat = os.path.join(worktree_path, ".worca", "status.json")
    if os.path.isfile(flat):
        try:
            with open(flat) as f:
                data = json.load(f)
            return data.get("pipeline_status")
        except (json.JSONDecodeError, OSError):
            pass

    return None


class WorktreeSource:
    """Cleanup source for pipelines registered in pipelines.d/ with a worktree_path."""

    def __init__(self, base: str = ".worca"):
        self.base = base

    def list_eligible(self, filters: dict) -> list[dict]:
        """Return registry entries eligible for cleanup under the given filters.

        Filters keys (all optional):
          run_id      — only include this specific run
          older_than  — timedelta; only include entries started before now - delta
        """
        eligible = []
        for reg in list_pipelines(base=self.base):
            worktree_path = reg.get("worktree_path")
            if not worktree_path:
                continue

            run_id = reg.get("run_id", "")

            if "run_id" in filters and filters["run_id"] != run_id:
                continue

            if not os.path.isdir(worktree_path):
                continue

            # Cross-reference actual pipeline_status from the worktree's status.json.
            # The outer registry entry stays "running" permanently (run_id mismatch),
            # so we read status.json for the ground truth. Fall back to registry status
            # when no status.json exists yet (pipeline hasn't started).
            pipeline_status = _read_worktree_status(worktree_path)
            if pipeline_status is None:
                pipeline_status = reg.get("status")

            if pipeline_status not in _TERMINAL_STATUSES:
                continue

            if "older_than" in filters and filters["older_than"] is not None:
                started_at = reg.get("started_at")
                if started_at:
                    started = datetime.fromisoformat(started_at)
                    if started.tzinfo is None:
                        started = started.replace(tzinfo=timezone.utc)
                    cutoff = datetime.now(timezone.utc) - filters["older_than"]
                    if started >= cutoff:
                        continue

            eligible.append(
                {
                    "run_id": run_id,
                    "worktree_path": worktree_path,
                    "title": reg.get("title", ""),
                    "pipeline_status": pipeline_status,
                    "started_at": reg.get("started_at"),
                }
            )

        return eligible

    def remove(self, entry: dict) -> bool:
        """Remove the worktree from disk and deregister from the registry.

        Returns True on success. Returns False if git worktree removal fails,
        in which case the registry entry is left intact.
        """
        run_id = entry["run_id"]
        worktree_path = entry["worktree_path"]

        if os.path.isdir(worktree_path):
            if not remove_pipeline_worktree(worktree_path):
                return False

        deregister_pipeline(run_id, base=self.base)
        return True


# FleetSource and WorkspaceSource are stubs for W-040 and W-047.
# Uncomment and implement when those plans ship.
#
# class FleetSource:
#     """W-040: cleanup fleet manifests and their child worktrees."""
#     def list_eligible(self, filters): return []
#     def remove(self, entry): return True
#
# class WorkspaceSource:
#     """W-047: cleanup workspace run directories."""
#     def list_eligible(self, filters): return []
#     def remove(self, entry): return True


def _build_sources(base: str) -> list:
    return [WorktreeSource(base=base)]


def cmd_cleanup(args: argparse.Namespace) -> None:
    """Handle the `worca cleanup` subcommand."""
    git_root = _find_git_root()
    base = str(git_root / ".worca")

    filters: dict = {}
    if getattr(args, "run_id", None):
        filters["run_id"] = args.run_id
    if getattr(args, "older_than", None) is not None:
        filters["older_than"] = args.older_than

    sources = _build_sources(base)

    eligible: list[tuple] = []
    for source in sources:
        for entry in source.list_eligible(filters):
            eligible.append((source, entry))

    if not eligible:
        print("No eligible worktrees to clean up.")
        return

    if args.dry_run:
        print(f"Would remove {len(eligible)} worktree(s):")
        for _, entry in eligible:
            size = _dir_size(entry["worktree_path"]) if os.path.isdir(entry["worktree_path"]) else 0
            print(f"  {entry['run_id']}  {entry['title']}  ({_format_bytes(size)})")
        return

    proceed = args.all or bool(getattr(args, "run_id", None))
    if not proceed:
        print(f"Found {len(eligible)} eligible worktree(s):")
        for _, entry in eligible:
            size = _dir_size(entry["worktree_path"]) if os.path.isdir(entry["worktree_path"]) else 0
            print(f"  {entry['run_id']}  {entry['title']}  ({_format_bytes(size)})")
        answer = input("Remove all? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("Aborted.")
            return

    removed = 0
    errors = 0
    total_freed = 0
    for source, entry in eligible:
        worktree_path = entry["worktree_path"]
        size = _dir_size(worktree_path) if os.path.isdir(worktree_path) else 0
        if source.remove(entry):
            total_freed += size
            removed += 1
        else:
            print(
                f"  warning: failed to remove {entry['run_id']} ({worktree_path})",
                file=sys.stderr,
            )
            errors += 1

    print(f"Removed {removed} worktree(s), freed {_format_bytes(total_freed)}.")
    if errors:
        print(f"  {errors} removal error(s) — see warnings above.", file=sys.stderr)


def register_subcommand(sub) -> None:
    """Register the `cleanup` subparser on the provided subparsers action."""
    p = sub.add_parser("cleanup", help="Remove completed pipeline worktrees")
    p.add_argument(
        "--all",
        action="store_true",
        help="Remove all completed/failed worktrees without prompting",
    )
    p.add_argument(
        "--run-id",
        default=None,
        metavar="ID",
        help="Remove a specific worktree by run ID",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="List what would be removed without removing anything",
    )
    p.add_argument(
        "--older-than",
        type=_parse_duration,
        default=None,
        metavar="DURATION",
        help="Only remove worktrees started more than this long ago (e.g. 7d, 24h, 30m)",
    )
