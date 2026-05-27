"""worca workspace init / migrate — scaffold or migrate a workspace.json.

Usage:
  worca workspace init /path/to/parent     # Scan child dirs, generate workspace.json
  worca workspace init /path --force       # Overwrite existing workspace.json
  worca workspace migrate /path/to/parent  # Convert legacy `repos` → `projects`

Scans child directories for .git/, generates workspace.json with defaults
(depends_on: []), creates .worca/ dir, and prints the workspace definition.
Per plan §9.

`migrate` is a one-shot helper for workspace.json files written before the
naming sweep that renamed the workspace member key from `repos` to
`projects`. It rewrites the file in place and leaves a `.bak` next to it.
"""

import json
import os
import sys


def scan_projects(parent_dir: str) -> list[dict]:
    """Scan child directories of parent_dir for git repos.

    Returns a sorted list of project dicts with name, path, depends_on.
    Skips hidden directories (starting with '.').
    """
    projects = []
    for entry in sorted(os.listdir(parent_dir)):
        if entry.startswith("."):
            continue
        child = os.path.join(parent_dir, entry)
        if not os.path.isdir(child):
            continue
        if not os.path.isdir(os.path.join(child, ".git")):
            continue
        projects.append({
            "name": entry,
            "path": entry,
            "depends_on": [],
        })
    return projects


def generate_workspace_json(parent_dir: str) -> dict:
    """Generate a workspace.json document from discovered projects."""
    projects = scan_projects(parent_dir)
    name = os.path.basename(os.path.normpath(parent_dir))
    return {
        "name": name,
        "projects": projects,
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
    if not doc["projects"]:
        print(
            "error: no git repositories found in child directories",
            file=sys.stderr,
        )
        raise SystemExit(1)

    with open(ws_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")

    worca_dir = os.path.join(path, ".worca")
    os.makedirs(worca_dir, exist_ok=True)

    print(f"Workspace '{doc['name']}' initialized with {len(doc['projects'])} project(s):")
    for project in doc["projects"]:
        deps = ", ".join(project["depends_on"]) if project["depends_on"] else "none"
        print(f"  {project['name']} — depends_on: {deps}")
    print(f"\nCreated: {ws_path}")
    print(f"Created: {worca_dir}/")
    print("\nEdit workspace.json to define depends_on relationships and add an integration test.")


def cmd_workspace_migrate(path: str) -> None:
    """Convert a legacy workspace.json (using `repos`) to the current schema (`projects`).

    Reads <path>/workspace.json, renames the `repos` key to `projects`,
    writes a `.bak` of the original, and overwrites the file in place.
    No-op (with a clear message) when the file already uses `projects`.
    """
    if not os.path.isdir(path):
        print(f"error: directory not found: {path}", file=sys.stderr)
        raise SystemExit(1)

    ws_path = os.path.join(path, "workspace.json")
    if not os.path.isfile(ws_path):
        print(f"error: workspace.json not found at {ws_path}", file=sys.stderr)
        raise SystemExit(1)

    with open(ws_path, encoding="utf-8") as f:
        doc = json.load(f)

    if "projects" in doc and "repos" not in doc:
        print("workspace.json already uses `projects`; nothing to do.")
        return

    if "repos" not in doc:
        print(
            "error: workspace.json has neither `repos` nor `projects` key — "
            "cannot migrate.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    backup_path = ws_path + ".bak"
    with open(backup_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")

    doc["projects"] = doc.pop("repos")

    with open(ws_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")

    print(f"Migrated {ws_path}: `repos` → `projects` ({len(doc['projects'])} entries).")
    print(f"Backup written: {backup_path}")


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

    migrate_parser = ws_sub.add_parser(
        "migrate",
        help="Convert a legacy workspace.json (`repos`) to the current schema (`projects`)",
    )
    migrate_parser.add_argument(
        "path",
        help="Path to the parent directory containing workspace.json",
    )
