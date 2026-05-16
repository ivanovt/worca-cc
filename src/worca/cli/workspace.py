"""worca workspace init — scaffold a workspace.json for multi-repo coordination.

Usage:
  worca workspace init /path/to/parent     # Scan child dirs, generate workspace.json
  worca workspace init /path --force       # Overwrite existing workspace.json

Scans child directories for .git/, generates workspace.json with defaults
(depends_on: []), creates .worca/ dir, and prints the workspace definition.
Per plan §9.
"""

import json
import os
import sys


def scan_repos(parent_dir: str) -> list[dict]:
    """Scan child directories of parent_dir for git repos.

    Returns a sorted list of repo dicts with name, path, depends_on.
    Skips hidden directories (starting with '.').
    """
    repos = []
    for entry in sorted(os.listdir(parent_dir)):
        if entry.startswith("."):
            continue
        child = os.path.join(parent_dir, entry)
        if not os.path.isdir(child):
            continue
        if not os.path.isdir(os.path.join(child, ".git")):
            continue
        repos.append({
            "name": entry,
            "path": entry,
            "depends_on": [],
        })
    return repos


def generate_workspace_json(parent_dir: str) -> dict:
    """Generate a workspace.json document from discovered repos."""
    repos = scan_repos(parent_dir)
    name = os.path.basename(os.path.normpath(parent_dir))
    return {
        "name": name,
        "repos": repos,
    }


def cmd_workspace_init(path: str, force: bool = False) -> None:
    """Create workspace.json and .worca/ in the given parent directory."""
    if not os.path.isdir(path):
        print(f"error: directory not found: {path}", file=sys.stderr)
        raise SystemExit(1)

    ws_path = os.path.join(path, "workspace.json")
    if os.path.exists(ws_path) and not force:
        print(
            "error: workspace.json already exists. Use --force to overwrite.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    doc = generate_workspace_json(path)
    if not doc["repos"]:
        print(
            "error: no git repositories found in child directories",
            file=sys.stderr,
        )
        raise SystemExit(1)

    with open(ws_path, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")

    worca_dir = os.path.join(path, ".worca")
    os.makedirs(worca_dir, exist_ok=True)

    print(f"Workspace '{doc['name']}' initialized with {len(doc['repos'])} repo(s):")
    for repo in doc["repos"]:
        deps = ", ".join(repo["depends_on"]) if repo["depends_on"] else "none"
        print(f"  {repo['name']} — depends_on: {deps}")
    print(f"\nCreated: {ws_path}")
    print(f"Created: {worca_dir}/")
    print("\nEdit workspace.json to define depends_on relationships and add an integration test.")


def register_subcommand(sub) -> None:
    """Register the `workspace` subparser on the provided subparsers action."""
    ws_parser = sub.add_parser("workspace", help="Workspace management commands")
    ws_sub = ws_parser.add_subparsers(dest="workspace_command")

    init_parser = ws_sub.add_parser(
        "init", help="Initialize a workspace from a parent directory"
    )
    init_parser.add_argument(
        "path",
        help="Path to the parent directory containing git repositories",
    )
    init_parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing workspace.json",
    )
