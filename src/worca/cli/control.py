"""worca lifecycle commands — pause, stop, resume, status, multi-status."""

from argparse import Namespace

from worca.cli.main import (
    _find_git_root,
    _inject_project_path,
    _require_project_worca,
)


def cmd_lifecycle(args: Namespace) -> None:
    """Delegate pause/stop/resume/status/multi-status to the project copy's worca_lifecycle."""
    git_root = _find_git_root()
    _require_project_worca(git_root)
    _inject_project_path(git_root)

    # Import from the project copy
    from worca.scripts.worca_lifecycle import main as worca_main

    # Re-invoke with the subcommand and its args
    argv = [args.lifecycle_command]
    if hasattr(args, "run_id") and args.run_id:
        argv.append(args.run_id)
    if hasattr(args, "base") and args.base:
        argv.extend(["--base", args.base])
    worca_main(argv)
