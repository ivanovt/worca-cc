"""worca graphify — manage the optional Graphify knowledge-graph integration.

Subcommands:
  worca graphify status     — show effective config + detection + graph stats
  worca graphify recommend  — survey project file count vs threshold
  worca graphify enable     — write project setting (prints privacy notice for --mode=full)
  worca graphify disable    — write project setting
  worca graphify rebuild    — force clean build (deletes graphify-out/ first)
  worca graphify update     — incremental graph update
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

from worca.utils.ast_cache import is_snapshot_complete
from worca.utils.git import get_current_git_head, repo_id
from worca.utils.graphify import (
    _VALID_MODES,
    detect_graphify,
    effective_graphify_config,
    graphify_report_path,
    graphify_snapshot_dir,
)
from worca.utils.paths import worca_cache_dir
from worca.utils.settings import load_settings


def _snapshot_for_head(project_root: str) -> tuple[str, str] | None:
    """Return (repo_id, snapshot_dir) for the project's current HEAD, or None."""
    rid = repo_id(project_root)
    sha = get_current_git_head()
    if not rid or not sha:
        return None
    return rid, graphify_snapshot_dir(rid, sha)


def _count_source_files(project_root: str) -> int:
    """Count source files in the project (common extensions, excluding hidden/vendor dirs)."""
    extensions = {
        ".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java",
        ".rb", ".php", ".c", ".cpp", ".h", ".hpp", ".cs", ".swift",
        ".kt", ".scala", ".ex", ".exs", ".erl", ".hs", ".ml",
    }
    skip_dirs = {
        ".git", "node_modules", "vendor", ".venv", "venv", "__pycache__",
        ".tox", "dist", "build", ".next", "target", "graphify-out",
    }
    count = 0
    for dirpath, dirnames, filenames in os.walk(project_root):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs and not d.startswith(".")]
        for name in filenames:
            if Path(name).suffix in extensions:
                count += 1
    return count


def _graph_stats(project_root: str) -> dict | None:
    """Read basic stats from the current HEAD's cache snapshot, if complete."""
    resolved = _snapshot_for_head(project_root)
    if resolved is None:
        return None
    _rid, snapshot_dir = resolved
    if not is_snapshot_complete(snapshot_dir):
        return None
    report_path = Path(graphify_report_path(snapshot_dir))
    if not report_path.exists():
        return None
    stat = report_path.stat()
    import time
    age_seconds = time.time() - stat.st_mtime
    return {
        "report_path": str(report_path),
        "snapshot_dir": snapshot_dir,
        "age_seconds": age_seconds,
        "size_bytes": stat.st_size,
    }


def _format_age(seconds: float) -> str:
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{int(seconds / 60)} minutes ago"
    if seconds < 86400:
        return f"{int(seconds / 3600)} hours ago"
    return f"{int(seconds / 86400)} days ago"


def cmd_graphify_status(
    *,
    project_settings_path: str,
    global_settings_path: str,
    project_root: str,
) -> None:
    """Show effective graphify configuration, detection state, and graph stats."""
    global_cfg = load_settings(global_settings_path)
    project_cfg = load_settings(project_settings_path)
    effective = effective_graphify_config(global_cfg, project_cfg)

    if not effective.enabled:
        reason_label = {
            "global-off": "disabled globally",
            "project-off": "disabled by project",
        }.get(effective.reason or "", "disabled")
        print(f"Graphify: disabled ({reason_label})")
        print(f"  Global:  {'enabled' if global_cfg.get('worca', {}).get('graphify', {}).get('enabled') else 'disabled'}")
        print(f"  Project: {'enabled' if project_cfg.get('worca', {}).get('graphify', {}).get('enabled') else 'disabled'}")
        print(f"  Mode:    {effective.mode} (would be used if enabled)")
        return

    print(f"Graphify: enabled · {effective.mode}")

    detect = detect_graphify(effective.version_range)
    if not detect.installed:
        print(f"  Detected: not installed ({detect.error})")
    elif not detect.compatible:
        print(f"  Detected: graphify {detect.version} (incompatible — requires {effective.version_range})")
    else:
        print(f"  Detected: graphify {detect.version} (compatible with {effective.version_range})")

    if detect.backend_env_present:
        print(f"  Backend env: {', '.join(detect.backend_env_present)}")

    if effective.backend:
        print(f"  Backend: {effective.backend}")
    if effective.model_profile:
        print(f"  Model profile: {effective.model_profile}")

    print(f"  Freshness: {effective.freshness}")
    stats = _graph_stats(project_root)
    if stats:
        print(
            f"  Graph: {stats['snapshot_dir']} "
            f"(built {_format_age(stats['age_seconds'])})"
        )
    else:
        resolved = _snapshot_for_head(project_root)
        loc = resolved[1] if resolved else f"{worca_cache_dir()}/ast/<repo>/<sha>"
        print(f"  Graph: {loc} (no snapshot for current HEAD)")


def cmd_graphify_recommend(
    *,
    project_settings_path: str,
    global_settings_path: str,
    project_root: str,
) -> None:
    """Survey project file count and recommend enable/skip based on threshold."""
    global_cfg = load_settings(global_settings_path)
    project_cfg = load_settings(project_settings_path)
    effective = effective_graphify_config(global_cfg, project_cfg)

    file_count = _count_source_files(project_root)
    threshold = effective.min_repo_files

    print(f"Source files found: {file_count}")
    print(f"Threshold:          {threshold}")
    print()

    if file_count >= threshold:
        print(
            f"Recommendation: enable Graphify (structural mode).\n"
            f"  {file_count} source files exceed the {threshold}-file threshold.\n"
            f"  Run: worca graphify enable"
        )
    else:
        print(
            f"Recommendation: skip for now.\n"
            f"  {file_count} source files is below the {threshold}-file threshold.\n"
            f"  Graphify benefits are most visible on larger codebases."
        )


def cmd_graphify_enable(
    *,
    project_settings_path: str,
    global_settings_path: str,
    mode: str,
) -> None:
    """Write graphify enabled=true + mode to project settings."""
    if mode not in _VALID_MODES:
        print(
            f"error: invalid mode {mode!r}, expected one of {sorted(_VALID_MODES)}",
            file=sys.stderr,
        )
        raise SystemExit(1)

    _update_project_graphify(project_settings_path, {"enabled": True, "mode": mode})

    if mode == "full":
        print(
            "Graphify enabled (mode: full).\n"
            "\n"
            "  PRIVACY NOTICE: 'full' mode sends document and diagram summaries\n"
            "  (never raw source code) to the configured LLM provider for semantic\n"
            "  analysis. Use 'structural' mode for zero outbound LLM calls.\n"
        )
    else:
        print(f"Graphify enabled (mode: {mode}).")


def cmd_graphify_disable(
    *,
    project_settings_path: str,
    global_settings_path: str,
) -> None:
    """Write graphify enabled=false to project settings."""
    _update_project_graphify(project_settings_path, {"enabled": False})
    print("Graphify disabled for this project.")


def _require_graphify_ready(
    project_settings_path: str,
    global_settings_path: str,
):
    """Resolve effective config + detect graphify, exit on failure.

    Returns (effective_config, detect_result) when both are OK.
    """
    global_cfg = load_settings(global_settings_path)
    project_cfg = load_settings(project_settings_path)
    effective = effective_graphify_config(global_cfg, project_cfg)

    if not effective.enabled:
        print(
            "error: graphify is not enabled. Run 'worca graphify enable' first.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    detect = detect_graphify(effective.version_range)
    if not detect.installed or not detect.compatible:
        msg = detect.error or "graphify CLI not found or incompatible"
        print(f"error: {msg}", file=sys.stderr)
        raise SystemExit(1)

    return effective, detect


def cmd_graphify_rebuild(
    *,
    project_settings_path: str,
    global_settings_path: str,
    project_root: str,
    mode: str | None,
) -> None:
    """Delete the current HEAD's cache snapshot, then build a fresh one."""
    _require_graphify_ready(project_settings_path, global_settings_path)

    resolved = _snapshot_for_head(project_root)
    if resolved is None:
        print("error: not a git repository (no HEAD)", file=sys.stderr)
        raise SystemExit(1)
    _rid, snapshot_dir = resolved
    if Path(snapshot_dir).exists():
        shutil.rmtree(snapshot_dir)
        print(f"Deleted snapshot {snapshot_dir}")

    _build_head_snapshot(project_settings_path, project_root, label="Rebuild")


def cmd_graphify_update(
    *,
    project_settings_path: str,
    global_settings_path: str,
    project_root: str,
) -> None:
    """Build the current HEAD's cache snapshot if it isn't already present."""
    _require_graphify_ready(project_settings_path, global_settings_path)
    _build_head_snapshot(project_settings_path, project_root, label="Update")


def _build_head_snapshot(project_settings_path: str, project_root: str, *, label: str) -> None:
    """Build + publish the current HEAD snapshot via the locked preflight path."""
    from worca.scripts.graphify_preflight import run_graphify_preflight

    print(f"{label}: building knowledge graph for current HEAD…")
    result = run_graphify_preflight(
        settings_path=project_settings_path, project_root=project_root
    )
    if result.get("status") == "ready":
        print(f"{label} complete: {result.get('report_path')}")
    else:
        print(
            f"error: graphify {label.lower()} {result.get('status')}: "
            f"{result.get('reason', '')}",
            file=sys.stderr,
        )
        raise SystemExit(1)


def cmd_graphify_gc(
    *,
    project_settings_path: str,
    global_settings_path: str,
    project_root: str,
) -> None:
    """Remove ALL cached graph snapshots for this repository."""
    rid = repo_id(project_root)
    if not rid:
        print("error: not a git repository", file=sys.stderr)
        raise SystemExit(1)
    repo_cache = Path(worca_cache_dir()) / "ast" / rid
    if repo_cache.exists():
        shutil.rmtree(repo_cache)
        print(f"Cleared graph cache: {repo_cache}")
    else:
        print(f"No graph cache to clear ({repo_cache} does not exist).")


def _update_project_graphify(settings_path: str, updates: dict) -> None:
    """Read project settings, update graphify keys, and write back atomically."""
    try:
        with open(settings_path, encoding="utf-8") as f:
            settings = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        settings = {}

    worca_block = settings.setdefault("worca", {})
    graphify_block = worca_block.setdefault("graphify", {})
    graphify_block.update(updates)

    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")


def register_subcommand(sub) -> None:
    """Register `worca graphify` with its sub-subcommands."""
    graphify_parser = sub.add_parser("graphify", help="Manage Graphify integration")
    graphify_sub = graphify_parser.add_subparsers(dest="graphify_command")

    graphify_sub.add_parser("status", help="Show effective config and detection state")
    graphify_sub.add_parser("recommend", help="Survey project and recommend enable/skip")

    enable_parser = graphify_sub.add_parser("enable", help="Enable Graphify for this project")
    enable_parser.add_argument(
        "--mode",
        default="structural",
        choices=sorted(_VALID_MODES),
        help="Graph build mode (default: structural)",
    )

    graphify_sub.add_parser("disable", help="Disable Graphify for this project")

    rebuild_parser = graphify_sub.add_parser(
        "rebuild", help="Delete the current HEAD's cache snapshot and rebuild it",
    )
    rebuild_parser.add_argument(
        "--mode",
        default=None,
        choices=sorted(_VALID_MODES),
        help="Override build mode for this run",
    )

    graphify_sub.add_parser("update", help="Build the current HEAD snapshot if missing")
    graphify_sub.add_parser("gc", help="Remove all cached graph snapshots for this repo")


def cmd_graphify(args: argparse.Namespace) -> None:
    """Dispatch graphify subcommands."""
    from worca.cli.main import _find_git_root

    git_root = _find_git_root()
    project_settings_path = str(git_root / ".claude" / "settings.json")
    global_settings_path = os.path.expanduser("~/.worca/settings.json")

    if args.graphify_command == "status":
        cmd_graphify_status(
            project_settings_path=project_settings_path,
            global_settings_path=global_settings_path,
            project_root=str(git_root),
        )
    elif args.graphify_command == "recommend":
        cmd_graphify_recommend(
            project_settings_path=project_settings_path,
            global_settings_path=global_settings_path,
            project_root=str(git_root),
        )
    elif args.graphify_command == "enable":
        cmd_graphify_enable(
            project_settings_path=project_settings_path,
            global_settings_path=global_settings_path,
            mode=args.mode,
        )
    elif args.graphify_command == "disable":
        cmd_graphify_disable(
            project_settings_path=project_settings_path,
            global_settings_path=global_settings_path,
        )
    elif args.graphify_command == "rebuild":
        cmd_graphify_rebuild(
            project_settings_path=project_settings_path,
            global_settings_path=global_settings_path,
            project_root=str(git_root),
            mode=args.mode,
        )
    elif args.graphify_command == "update":
        cmd_graphify_update(
            project_settings_path=project_settings_path,
            global_settings_path=global_settings_path,
            project_root=str(git_root),
        )
    elif args.graphify_command == "gc":
        cmd_graphify_gc(
            project_settings_path=project_settings_path,
            global_settings_path=global_settings_path,
            project_root=str(git_root),
        )
    else:
        print("error: specify a subcommand, e.g. 'worca graphify status'", file=sys.stderr)
        raise SystemExit(1)
