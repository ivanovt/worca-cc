"""worca crg — manage the optional Code Review Graph (CRG) integration.

Subcommands:
  worca crg status     — show effective config + detection + base-snapshot state
  worca crg recommend  — survey project file count vs threshold
  worca crg enable     — write project setting
  worca crg disable    — write project setting
  worca crg rebuild    — force clean base build
"""

import argparse
import json
import os
import sys

from worca.cli.graphify_cmd import _count_source_files
from worca.utils.code_review_graph import (
    detect_code_review_graph,
    effective_crg_config,
)
from worca.utils.settings import load_settings


def cmd_crg_status(
    *,
    project_settings_path: str,
    global_settings_path: str,
    project_root: str,
) -> None:
    """Show effective CRG configuration and detection state."""
    global_cfg = load_settings(global_settings_path)
    project_cfg = load_settings(project_settings_path)
    effective = effective_crg_config(global_cfg, project_cfg)

    if not effective.enabled:
        reason_label = {
            "global-off": "disabled globally",
            "project-off": "disabled by project",
        }.get(effective.reason or "", "disabled")
        print(f"Code Review Graph: disabled ({reason_label})")
        g_val = global_cfg.get("worca", {}).get("code_review_graph", {}).get("enabled")
        p_val = project_cfg.get("worca", {}).get("code_review_graph", {}).get("enabled")
        print(f"  Global:  {'enabled' if g_val else 'disabled'}")
        print(f"  Project: {'enabled' if p_val else 'disabled'}")
        return

    print("Code Review Graph: enabled")

    detect = detect_code_review_graph(
        version_range=effective.version_range,
        fastmcp_min=effective.fastmcp_min,
    )
    if not detect.installed:
        print(f"  Detected: not installed ({detect.error})")
    elif not detect.compatible:
        print(
            f"  Detected: code-review-graph {detect.version} "
            f"(incompatible — requires {effective.version_range})"
        )
    else:
        print(
            f"  Detected: code-review-graph {detect.version} "
            f"(compatible with {effective.version_range})"
        )

    if detect.installed and detect.compatible:
        if detect.fastmcp_ok:
            print("  fastmcp:  OK")
        else:
            print(f"  fastmcp:  {detect.error}")

    print(f"  Freshness: {effective.freshness}")
    print(f"  Embeddings: {effective.embeddings}")


def cmd_crg_recommend(
    *,
    project_settings_path: str,
    global_settings_path: str,
    project_root: str,
) -> None:
    """Survey project file count and recommend enable/skip based on threshold."""
    global_cfg = load_settings(global_settings_path)
    project_cfg = load_settings(project_settings_path)
    effective = effective_crg_config(global_cfg, project_cfg)

    file_count = _count_source_files(project_root)
    threshold = effective.min_repo_files

    print(f"Source files found: {file_count}")
    print(f"Threshold:          {threshold}")
    print()

    if file_count >= threshold:
        print(
            f"Recommendation: enable Code Review Graph.\n"
            f"  {file_count} source files exceed the {threshold}-file threshold.\n"
            f"  Run: worca crg enable"
        )
    else:
        print(
            f"Recommendation: skip for now.\n"
            f"  {file_count} source files is below the {threshold}-file threshold.\n"
            f"  CRG benefits are most visible on larger codebases."
        )


def cmd_crg_enable(
    *,
    project_settings_path: str,
    global_settings_path: str,
) -> None:
    """Write code_review_graph enabled=true to project settings."""
    _update_project_crg(project_settings_path, {"enabled": True})
    print("Code Review Graph enabled for this project.")


def cmd_crg_disable(
    *,
    project_settings_path: str,
    global_settings_path: str,
) -> None:
    """Write code_review_graph enabled=false to project settings."""
    _update_project_crg(project_settings_path, {"enabled": False})
    print("Code Review Graph disabled for this project.")


def _require_crg_ready(
    project_settings_path: str,
    global_settings_path: str,
):
    """Resolve effective config + detect CRG, exit on failure.

    Returns (effective_config, detect_result) when both are OK.
    """
    global_cfg = load_settings(global_settings_path)
    project_cfg = load_settings(project_settings_path)
    effective = effective_crg_config(global_cfg, project_cfg)

    if not effective.enabled:
        print(
            "error: code-review-graph is not enabled. Run 'worca crg enable' first.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    detect = detect_code_review_graph(
        version_range=effective.version_range,
        fastmcp_min=effective.fastmcp_min,
    )
    if not detect.installed or not detect.compatible:
        msg = detect.error or "code-review-graph CLI not found or incompatible"
        print(f"error: {msg}", file=sys.stderr)
        raise SystemExit(1)

    if not detect.fastmcp_ok:
        msg = detect.error or "fastmcp not found or incompatible"
        print(f"error: {msg}", file=sys.stderr)
        raise SystemExit(1)

    return effective, detect


def cmd_crg_rebuild(
    *,
    project_settings_path: str,
    global_settings_path: str,
    project_root: str,
) -> None:
    """Validate readiness for a CRG rebuild.

    The actual build infrastructure (crg_preflight) is wired in Phase 2.
    This command validates that CRG is enabled and detected, preparing the
    CLI surface for when the preflight module lands.
    """
    _require_crg_ready(project_settings_path, global_settings_path)
    print(
        "CRG rebuild: tooling detected and ready.\n"
        "  The preflight build infrastructure will be available in Phase 2."
    )


def _update_project_crg(settings_path: str, updates: dict) -> None:
    """Read project settings, update code_review_graph keys, and write back."""
    try:
        with open(settings_path, encoding="utf-8") as f:
            settings = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        settings = {}

    worca_block = settings.setdefault("worca", {})
    crg_block = worca_block.setdefault("code_review_graph", {})
    crg_block.update(updates)

    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")


def register_subcommand(sub) -> None:
    """Register `worca crg` with its sub-subcommands."""
    crg_parser = sub.add_parser("crg", help="Manage Code Review Graph integration")
    crg_sub = crg_parser.add_subparsers(dest="crg_command")

    crg_sub.add_parser("status", help="Show effective config and detection state")
    crg_sub.add_parser("recommend", help="Survey project and recommend enable/skip")
    crg_sub.add_parser("enable", help="Enable CRG for this project")
    crg_sub.add_parser("disable", help="Disable CRG for this project")
    crg_sub.add_parser("rebuild", help="Delete current HEAD cache and rebuild it")


def cmd_crg(args: argparse.Namespace) -> None:
    """Dispatch CRG subcommands."""
    from worca.cli.main import _find_git_root

    git_root = _find_git_root()
    project_settings_path = str(git_root / ".claude" / "settings.json")
    global_settings_path = os.path.expanduser("~/.worca/settings.json")

    if args.crg_command == "status":
        cmd_crg_status(
            project_settings_path=project_settings_path,
            global_settings_path=global_settings_path,
            project_root=str(git_root),
        )
    elif args.crg_command == "recommend":
        cmd_crg_recommend(
            project_settings_path=project_settings_path,
            global_settings_path=global_settings_path,
            project_root=str(git_root),
        )
    elif args.crg_command == "enable":
        cmd_crg_enable(
            project_settings_path=project_settings_path,
            global_settings_path=global_settings_path,
        )
    elif args.crg_command == "disable":
        cmd_crg_disable(
            project_settings_path=project_settings_path,
            global_settings_path=global_settings_path,
        )
    elif args.crg_command == "rebuild":
        cmd_crg_rebuild(
            project_settings_path=project_settings_path,
            global_settings_path=global_settings_path,
            project_root=str(git_root),
        )
    else:
        print("error: specify a subcommand, e.g. 'worca crg status'", file=sys.stderr)
        raise SystemExit(1)
