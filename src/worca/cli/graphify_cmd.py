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
import subprocess
import sys
from pathlib import Path

from worca.utils.graphify import (
    _VALID_MODES,
    detect_graphify,
    effective_graphify_config,
)
from worca.utils.settings import load_settings


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


def _graph_stats(project_root: str, out_dir: str) -> dict | None:
    """Read basic stats from graph output directory if present."""
    graph_path = Path(project_root) / out_dir
    report_path = graph_path / "GRAPH_REPORT.md"
    if not report_path.exists():
        return None
    stat = report_path.stat()
    import time
    age_seconds = time.time() - stat.st_mtime
    return {
        "report_path": str(report_path),
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

    stats = _graph_stats(project_root, effective.out_dir)
    if stats:
        print(f"  Graph: {effective.out_dir}/ (updated {_format_age(stats['age_seconds'])})")
    else:
        print(f"  Graph: {effective.out_dir}/ (no report found)")


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
    """Delete graphify-out/ and run a clean build."""
    effective, _detect = _require_graphify_ready(
        project_settings_path, global_settings_path,
    )

    build_mode = mode or effective.mode
    out_dir = Path(project_root) / effective.out_dir
    if out_dir.exists():
        shutil.rmtree(out_dir)
        print(f"Deleted {effective.out_dir}/")

    cmd = ["graphify", "build"]
    if build_mode == "structural":
        cmd.append("--no-llm")

    print(f"Running: {' '.join(cmd)}")
    proc = subprocess.run(cmd, cwd=project_root, capture_output=True, text=True)
    if proc.returncode != 0:
        print(f"error: graphify build failed:\n{proc.stderr[:500]}", file=sys.stderr)
        raise SystemExit(1)

    print(f"Rebuild complete ({build_mode} mode).")


def cmd_graphify_update(
    *,
    project_settings_path: str,
    global_settings_path: str,
    project_root: str,
) -> None:
    """Run an incremental graphify update."""
    effective, _detect = _require_graphify_ready(
        project_settings_path, global_settings_path,
    )

    cmd = ["graphify", "--update"]
    if effective.mode == "structural":
        cmd.append("--no-llm")

    print(f"Running: {' '.join(cmd)}")
    proc = subprocess.run(cmd, cwd=project_root, capture_output=True, text=True)
    if proc.returncode != 0:
        print(f"error: graphify update failed:\n{proc.stderr[:500]}", file=sys.stderr)
        raise SystemExit(1)

    print(f"Update complete ({effective.mode} mode).")


def _update_project_graphify(settings_path: str, updates: dict) -> None:
    """Read project settings, update graphify keys, and write back atomically."""
    try:
        with open(settings_path) as f:
            settings = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        settings = {}

    worca_block = settings.setdefault("worca", {})
    graphify_block = worca_block.setdefault("graphify", {})
    graphify_block.update(updates)

    with open(settings_path, "w") as f:
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
        "rebuild", help="Force clean build (deletes graphify-out/ first)",
    )
    rebuild_parser.add_argument(
        "--mode",
        default=None,
        choices=sorted(_VALID_MODES),
        help="Override build mode for this run",
    )

    graphify_sub.add_parser("update", help="Incremental graph update")


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
    else:
        print("error: specify a subcommand, e.g. 'worca graphify status'", file=sys.stderr)
        raise SystemExit(1)
