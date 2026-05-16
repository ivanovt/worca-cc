# /// script
# requires-python = ">=3.8"
# ///
"""Workspace coordinator entry point (W-047 §8).

Loads a workspace.json from the given parent directory, builds the
dependency DAG, and dispatches tier-ordered child pipelines via
run_worktree.py. In --dry-run mode, prints the DAG and exits without
launching any children.
"""
import argparse
import json
import os
import secrets
import sys
import tempfile
from datetime import datetime, timezone

import jsonschema

import worca
from worca.state.status import WorkspaceStatus
from worca.utils.claude_cli import run_agent
from worca.workspace.manifest import Workspace

_AGENTS_DIR = os.path.join(os.path.dirname(worca.__file__), "agents", "core")
_SCHEMAS_DIR = os.path.join(os.path.dirname(worca.__file__), "schemas")


_POINTER_DIR_DEFAULT = os.path.expanduser("~/.worca/workspace-runs")


def generate_workspace_id(*, now=None) -> tuple:
    """Return (workspace_id, workspace_id_short) with format ws_<yyyymmddhhmm>_<rand>."""
    if now is None:
        now = datetime.now(timezone.utc)
    timestamp = now.strftime("%Y%m%d%H%M")
    ws_id_short = secrets.token_hex(4)
    ws_id = f"ws_{timestamp}_{ws_id_short}"
    return ws_id, ws_id_short


def create_workspace_run_dir(workspace_root: str, workspace_id: str) -> str:
    """Create {workspace_root}/.worca/workspace-runs/{workspace_id}/ and return its path."""
    run_dir = os.path.join(workspace_root, ".worca", "workspace-runs", workspace_id)
    os.makedirs(run_dir, exist_ok=True)
    return run_dir


def write_pointer_file(
    workspace_id: str,
    workspace_root: str,
    *,
    pointer_dir: str = None,
) -> str:
    """Write a lightweight pointer at ~/.worca/workspace-runs/{workspace_id}.json.

    The pointer lets the UI discover workspace runs globally without scanning
    every project directory.
    """
    if pointer_dir is None:
        pointer_dir = _POINTER_DIR_DEFAULT
    os.makedirs(pointer_dir, exist_ok=True)

    pointer_path = os.path.join(pointer_dir, f"{workspace_id}.json")
    data = {"workspace_root": workspace_root, "workspace_id": workspace_id}

    fd, tmp_path = tempfile.mkstemp(dir=pointer_dir, prefix=".tmp_", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp_path, pointer_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

    return pointer_path


def create_workspace_manifest(
    *,
    workspace_id: str,
    workspace_root: str,
    workspace_name: str,
    prompt: str | None,
    source: str | None,
    guide_paths: list[str],
    branch_template: str,
    max_parallel: int,
    skip_integration: bool,
    skip_planning: bool,
    tiers: list[list[str]],
    repos_by_name: dict[str, str],
    dependency_graph: dict[str, list[str]],
    failure_threshold: float | None = None,
) -> dict:
    """Build the workspace manifest dict (extends fleet manifest schema per §7)."""
    guide_bytes = sum(
        os.path.getsize(p) for p in guide_paths if os.path.isfile(p)
    )

    dag_tiers = [
        {"tier": i, "repos": tier_repos, "status": "pending"}
        for i, tier_repos in enumerate(tiers)
    ]

    return {
        "workspace_id": workspace_id,
        "workspace_name": workspace_name,
        "workspace_root": workspace_root,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "work_request": {
            "title": "",
            "description": prompt or "",
            "source": source,
        },
        "guide": {
            "paths": list(guide_paths),
            "bytes": guide_bytes,
            "filenames": [os.path.basename(p) for p in guide_paths],
        },
        "branch_template": branch_template,
        "max_parallel": max_parallel,
        "skip_integration": skip_integration,
        "skip_planning": skip_planning,
        "status": WorkspaceStatus.PLANNING,
        "halt_reason": None,
        "dag": {"tiers": dag_tiers, "dependency_graph": dependency_graph},
        "repos_by_name": repos_by_name,
        "failure_threshold": failure_threshold,
        "children": [],
        "integration_test": {"status": "pending", "exit_code": None, "log_path": None},
    }


def write_workspace_manifest(manifest: dict, run_dir: str) -> str:
    """Write workspace-manifest.json atomically into the run directory."""
    path = os.path.join(run_dir, "workspace-manifest.json")
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(dir=parent, prefix=".tmp_", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(manifest, f, indent=2)
            f.write("\n")
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

    return path


def gather_repo_context(
    workspace: Workspace,
    workspace_root: str,
    *,
    max_bytes: int = 4096,
) -> dict[str, str]:
    """Read CLAUDE.md from each repo, truncate to max_bytes."""
    contexts: dict[str, str] = {}
    for repo in workspace.repos:
        claude_md_path = os.path.join(workspace_root, repo.path, "CLAUDE.md")
        try:
            with open(claude_md_path, encoding="utf-8") as f:
                content = f.read()
            encoded = content.encode("utf-8")
            if len(encoded) > max_bytes:
                content = encoded[:max_bytes].decode("utf-8", errors="ignore")
        except FileNotFoundError:
            content = ""
        contexts[repo.name] = content
    return contexts


def build_planner_prompt(
    workspace: Workspace,
    prompt: str,
    repo_contexts: dict[str, str],
    guide_paths: list[str],
) -> str:
    """Build the prompt for the workspace planner agent."""
    topology = {
        "name": workspace.name,
        "repos": [
            {
                "name": r.name,
                "path": r.path,
                "depends_on": r.depends_on,
            }
            for r in workspace.repos
        ],
    }

    sections = []
    sections.append("## Workspace Topology\n")
    sections.append(f"```json\n{json.dumps(topology, indent=2)}\n```\n")

    sections.append("## Per-Repo Context (CLAUDE.md)\n")
    for repo in workspace.repos:
        ctx = repo_contexts.get(repo.name, "")
        if ctx:
            sections.append(f"### {repo.name}\n\n{ctx}\n")
        else:
            sections.append(f"### {repo.name}\n\n(no CLAUDE.md found)\n")

    if guide_paths:
        sections.append("## Reference Guide (normative)\n")
        for gp in guide_paths:
            try:
                with open(gp, encoding="utf-8") as f:
                    guide_content = f.read()
                sections.append(f"### {os.path.basename(gp)}\n\n{guide_content}\n")
            except FileNotFoundError:
                sections.append(f"### {os.path.basename(gp)}\n\n(file not found)\n")

    sections.append("## Work Request\n")
    sections.append(prompt + "\n")

    return "\n".join(sections)


def validate_workspace_plan(plan: dict, workspace: Workspace) -> list[str]:
    """Validate plan against workspace_plan.json schema and workspace repos."""
    errors: list[str] = []

    schema_path = os.path.join(_SCHEMAS_DIR, "workspace_plan.json")
    with open(schema_path) as f:
        schema = json.load(f)

    try:
        jsonschema.validate(plan, schema)
    except jsonschema.ValidationError as e:
        errors.append(f"schema validation: {e.message}")
        return errors

    known_repos = {r.name for r in workspace.repos}
    for repo_entry in plan.get("repos", []):
        name = repo_entry.get("name", "")
        if name not in known_repos:
            errors.append(f"unknown repo '{name}' not in workspace.json")

    return errors


def format_workspace_plan_md(plan: dict) -> str:
    """Format workspace plan as human-readable markdown."""
    lines = ["# Workspace Plan\n"]
    lines.append(f"## Summary\n\n{plan['summary']}\n")

    lines.append("## Repos\n")
    for repo in plan["repos"]:
        skip_tag = " (skipped)" if repo.get("skip") else ""
        lines.append(f"### {repo['name']}{skip_tag}\n")
        lines.append(f"{repo['description']}\n")
        if repo.get("depends_on"):
            lines.append(f"**Depends on:** {', '.join(repo['depends_on'])}\n")
        lines.append("**Acceptance Criteria:**\n")
        for ac in repo["acceptance_criteria"]:
            lines.append(f"- {ac}")
        lines.append("")

    if plan.get("integration_expectations"):
        lines.append("## Integration Expectations\n")
        for ie in plan["integration_expectations"]:
            lines.append(f"- {ie}")
        lines.append("")

    return "\n".join(lines)


def format_repo_plan_md(repo_entry: dict, workspace_summary: str) -> str:
    """Format a single repo's plan as markdown for --plan injection."""
    lines = [f"# Plan: {repo_entry['name']}\n"]
    lines.append(f"## Workspace Context\n\n{workspace_summary}\n")
    lines.append(f"## Description\n\n{repo_entry['description']}\n")
    if repo_entry.get("depends_on"):
        lines.append(f"## Dependencies\n\nDepends on: {', '.join(repo_entry['depends_on'])}\n")
    lines.append("## Acceptance Criteria\n")
    for ac in repo_entry["acceptance_criteria"]:
        lines.append(f"- {ac}")
    lines.append("")
    return "\n".join(lines)


def write_workspace_plan_files(plan: dict, run_dir: str) -> dict[str, str]:
    """Write workspace-plan.md, workspace-plan.json, per-repo {repo}-plan.md.

    Returns {repo_name: absolute_path_to_plan_md} for non-skipped repos.
    """
    json_path = os.path.join(run_dir, "workspace-plan.json")
    with open(json_path, "w") as f:
        json.dump(plan, f, indent=2)
        f.write("\n")

    md_path = os.path.join(run_dir, "workspace-plan.md")
    with open(md_path, "w") as f:
        f.write(format_workspace_plan_md(plan))

    repo_plan_paths: dict[str, str] = {}
    for repo in plan["repos"]:
        if repo.get("skip"):
            continue
        plan_path = os.path.join(run_dir, f"{repo['name']}-plan.md")
        with open(plan_path, "w") as f:
            f.write(format_repo_plan_md(repo, plan["summary"]))
        repo_plan_paths[repo["name"]] = plan_path

    return repo_plan_paths


def run_workspace_planner(
    prompt: str,
    run_dir: str,
    *,
    model: str | None = None,
    model_env: dict | None = None,
) -> dict:
    """Invoke workspace planner agent via Claude CLI, return parsed plan."""
    agent_path = os.path.join(_AGENTS_DIR, "workspace_planner.md")
    schema_path = os.path.join(_SCHEMAS_DIR, "workspace_plan.json")
    log_path = os.path.join(run_dir, "workspace-planner.log")

    event = run_agent(
        prompt=prompt,
        agent=agent_path,
        json_schema=schema_path,
        model=model or "opus",
        model_env=model_env,
        log_path=log_path,
    )

    result_text = event.get("result", "")
    return json.loads(result_text)


def load_workspace_manifest(
    workspace_id: str,
    *,
    pointer_dir: str | None = None,
) -> dict | None:
    """Load a workspace manifest by ID using the pointer file.

    Returns the parsed manifest dict, or None if the pointer or manifest
    file is missing/corrupt.
    """
    if pointer_dir is None:
        pointer_dir = _POINTER_DIR_DEFAULT

    pointer_path = os.path.join(pointer_dir, f"{workspace_id}.json")
    try:
        with open(pointer_path) as f:
            pointer = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None

    workspace_root = pointer.get("workspace_root")
    if not workspace_root:
        return None

    manifest_path = os.path.join(
        workspace_root, ".worca", "workspace-runs", workspace_id, "workspace-manifest.json",
    )
    try:
        with open(manifest_path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def classify_children_for_resume(
    children: list[dict],
) -> tuple[set[str], set[str]]:
    """Classify manifest children into skip vs. redispatch sets.

    Returns (skip_repos, redispatch_repos).
    - skip: completed children — left as-is, worktrees retained for context.
    - redispatch: failed/blocked/halted children — re-dispatched fresh.
    """
    skip: set[str] = set()
    redispatch: set[str] = set()

    for child in children:
        repo = child["repo"]
        status = child.get("status", "")
        if status == "completed":
            skip.add(repo)
        else:
            redispatch.add(repo)

    return skip, redispatch


def rebuild_resume_manifest(
    manifest: dict,
    skip_repos: set[str],
    redispatch_repos: set[str],
) -> dict:
    """Rebuild a manifest for resume: reset non-completed tiers/children.

    Mutates and returns the manifest.
    """
    manifest["halt_reason"] = None

    manifest["children"] = [
        c for c in manifest["children"] if c["repo"] in skip_repos
    ]

    all_children_done = len(redispatch_repos) == 0

    if all_children_done:
        manifest["status"] = WorkspaceStatus.INTEGRATION_TESTING
    else:
        manifest["status"] = WorkspaceStatus.RUNNING

    for tier in manifest["dag"]["tiers"]:
        tier_repos = set(tier["repos"])
        if tier_repos <= skip_repos:
            tier["status"] = "completed"
        else:
            if all_children_done:
                tier["status"] = "completed"
            else:
                tier["status"] = "pending"

    manifest["integration_test"] = {
        "status": "pending",
        "exit_code": None,
        "log_path": None,
    }

    return manifest


def _print_dag(workspace: Workspace, *, skip_integration: bool) -> None:
    """Print the DAG in a human-readable format for --dry-run."""
    print(f"Workspace: {workspace.name}")
    print(f"Repos:     {len(workspace.repos)}")
    print(f"Tiers:     {len(workspace.tiers)}")
    print()

    repo_map = {r.name: r for r in workspace.repos}
    for i, tier in enumerate(workspace.tiers):
        print(f"  Tier {i}:")
        for name in tier:
            repo = repo_map[name]
            deps = f" (depends on: {', '.join(repo.depends_on)})" if repo.depends_on else ""
            print(f"    - {name}{deps}")
        print()

    if workspace.integration_test and not skip_integration:
        print(f"  Integration test: {workspace.integration_test.command}")
        print(f"    working_dir: {workspace.integration_test.working_dir}")
    elif skip_integration:
        print("  Integration test: skipped")
    else:
        print("  Integration test: none configured")


def create_parser() -> argparse.ArgumentParser:
    """Build the argument parser for run_workspace."""
    parser = argparse.ArgumentParser(
        description="Run a coordinated multi-repo workspace pipeline (W-047)",
    )

    parser.add_argument(
        "workspace_root",
        metavar="WORKSPACE_ROOT",
        help="Path to workspace parent directory containing workspace.json",
    )

    work = parser.add_mutually_exclusive_group()
    work.add_argument("--prompt", help="Text prompt for work request")
    work.add_argument("--source", help="Source reference (gh:issue:42, bd:bd-abc)")

    parser.add_argument(
        "--guide",
        action="append",
        metavar="PATH",
        help="Path to a reference guide (repeatable)",
    )

    parser.add_argument(
        "--branch",
        default="workspace/{slug}/{repo}",
        metavar="TEMPLATE",
        help=(
            "Branch name template with {workspace}, {repo}, {slug} placeholders. "
            "Default: workspace/{slug}/{repo}"
        ),
    )

    parser.add_argument(
        "--skip-integration",
        action="store_true",
        default=False,
        help="Skip the integration test phase",
    )

    parser.add_argument(
        "--skip-planning",
        action="store_true",
        default=False,
        help="Skip the master planner; use --plan per-repo instead",
    )

    parser.add_argument(
        "--resume",
        metavar="WORKSPACE_ID",
        help="Resume a failed/halted workspace run",
    )

    parser.add_argument(
        "--workspace-id",
        metavar="WORKSPACE_ID",
        help=(
            "Use this workspace_id instead of generating a new one. The caller "
            "(typically the UI server) may pre-create the manifest at this ID "
            "to keep the dispatched run aligned with what the UI navigated to."
        ),
    )

    parser.add_argument(
        "--max-parallel",
        type=int,
        default=5,
        metavar="N",
        help="Max concurrent children within a tier (default: 5)",
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Print the DAG and exit without launching children",
    )

    parser.add_argument(
        "--settings",
        default=".claude/settings.json",
        help="Path to settings.json",
    )

    return parser


def _resume_workspace(workspace_root: str, workspace_id: str) -> int:
    """Resume a failed/halted/integration_failed workspace run.

    Loads the manifest, classifies children, rebuilds state, and
    re-dispatches via DagExecutor or re-runs integration only.
    """
    from worca.workspace.dag_executor import DagExecutor
    from worca.workspace.integration_test import run_integration_test

    manifest = load_workspace_manifest(workspace_id)
    if manifest is None:
        print(
            f"error: workspace manifest not found for {workspace_id}",
            file=sys.stderr,
        )
        return 1

    status = manifest.get("status", "")
    if status == WorkspaceStatus.COMPLETED:
        print(f"Workspace {workspace_id} already completed — nothing to resume.")
        return 0

    try:
        ws = Workspace.load(workspace_root)
    except Exception as e:
        print(f"error: failed to load workspace: {e}", file=sys.stderr)
        return 1

    run_dir = os.path.join(
        workspace_root, ".worca", "workspace-runs", workspace_id,
    )

    skip, redispatch = classify_children_for_resume(manifest["children"])

    all_repos = {r.name for r in ws.repos}
    missing = all_repos - skip - redispatch
    for repo in missing:
        redispatch.add(repo)

    rebuild_resume_manifest(manifest, skip, redispatch)
    write_workspace_manifest(manifest, run_dir)

    if manifest["status"] == WorkspaceStatus.INTEGRATION_TESTING:
        print(f"Resuming workspace {workspace_id} — re-running integration test only")
        it_result = run_integration_test(manifest, ws, run_dir)
        manifest["integration_test"] = it_result

        if it_result["status"] == "failed":
            manifest["status"] = WorkspaceStatus.INTEGRATION_FAILED
            write_workspace_manifest(manifest, run_dir)
            print("Integration test failed again.")
            return 1
        else:
            manifest["status"] = WorkspaceStatus.COMPLETED
            write_workspace_manifest(manifest, run_dir)
            print("Integration test passed. Workspace completed.")
            return 0

    print(f"Resuming workspace {workspace_id} — re-dispatching {len(redispatch)} repo(s)")

    executor = DagExecutor(manifest, run_dir)
    result = executor.execute()

    if result["status"] != "completed":
        print(f"Workspace dispatch {result['status']}.")
        return 1

    if not manifest.get("skip_integration"):
        manifest["status"] = WorkspaceStatus.INTEGRATION_TESTING
        write_workspace_manifest(manifest, run_dir)

        it_result = run_integration_test(manifest, ws, run_dir)
        manifest["integration_test"] = it_result

        if it_result["status"] == "failed":
            manifest["status"] = WorkspaceStatus.INTEGRATION_FAILED
            write_workspace_manifest(manifest, run_dir)
            print("Integration test failed.")
            return 1

    manifest["status"] = WorkspaceStatus.COMPLETED
    write_workspace_manifest(manifest, run_dir)
    print(f"Workspace {workspace_id} resumed successfully.")
    return 0


def main(argv=None) -> int:
    """Entry point. Returns exit code."""
    parser = create_parser()
    args = parser.parse_args(argv)

    workspace_root = os.path.abspath(args.workspace_root)

    if not args.resume and not args.prompt and not args.source:
        print(
            "error: one of --prompt, --source, or --resume is required",
            file=sys.stderr,
        )
        return 1

    try:
        ws = Workspace.load(workspace_root)
    except FileNotFoundError:
        print(
            f"error: workspace.json not found in {workspace_root}",
            file=sys.stderr,
        )
        return 1
    except Exception as e:
        print(f"error: failed to load workspace: {e}", file=sys.stderr)
        return 1

    if args.resume:
        return _resume_workspace(workspace_root, args.resume)

    if args.dry_run:
        _print_dag(ws, skip_integration=args.skip_integration)
        return 0

    if args.workspace_id:
        ws_id = args.workspace_id
        # Derive a stable short ID from the supplied workspace_id rather than
        # generating a fresh random one. Format is ws_<ts>_<short>, so take the
        # trailing token; if it doesn't parse, fall back to a fresh short.
        parts = ws_id.split("_")
        ws_id_short = parts[-1] if len(parts) >= 3 else secrets.token_hex(4)
    else:
        ws_id, ws_id_short = generate_workspace_id()

    run_dir = create_workspace_run_dir(workspace_root, ws_id)
    write_pointer_file(ws_id, workspace_root)

    repos_by_name = {r.name: r.path for r in ws.repos}
    guide_paths = [os.path.abspath(g) for g in (args.guide or [])]

    from worca.utils.settings import load_settings
    settings = load_settings(args.settings)
    failure_threshold = settings.get("worca", {}).get("workspace", {}).get("failure_threshold")

    dependency_graph = {r.name: r.depends_on for r in ws.repos}

    manifest = create_workspace_manifest(
        workspace_id=ws_id,
        workspace_root=workspace_root,
        workspace_name=ws.name,
        prompt=args.prompt,
        source=args.source,
        guide_paths=guide_paths,
        branch_template=args.branch,
        max_parallel=args.max_parallel,
        skip_integration=args.skip_integration,
        skip_planning=args.skip_planning,
        tiers=ws.tiers,
        repos_by_name=repos_by_name,
        dependency_graph=dependency_graph,
        failure_threshold=failure_threshold,
    )

    write_workspace_manifest(manifest, run_dir)

    if not args.skip_planning:
        print(f"Running workspace planner for {ws.name}...")
        repo_contexts = gather_repo_context(ws, workspace_root)
        planner_prompt = build_planner_prompt(
            ws, args.prompt or "", repo_contexts, guide_paths,
        )

        try:
            plan = run_workspace_planner(planner_prompt, run_dir)
        except Exception as e:
            print(f"error: workspace planner failed: {e}", file=sys.stderr)
            manifest["status"] = WorkspaceStatus.FAILED
            write_workspace_manifest(manifest, run_dir)
            return 1

        errors = validate_workspace_plan(plan, ws)
        if errors:
            print(
                "error: workspace plan validation failed:\n"
                + "\n".join(f"  - {e}" for e in errors),
                file=sys.stderr,
            )
            manifest["status"] = WorkspaceStatus.FAILED
            write_workspace_manifest(manifest, run_dir)
            return 1

        repo_plan_paths = write_workspace_plan_files(plan, run_dir)
        manifest["status"] = WorkspaceStatus.RUNNING
        manifest["plan"] = {
            "workspace_plan_path": os.path.join(run_dir, "workspace-plan.json"),
            "repo_plans": repo_plan_paths,
        }
        write_workspace_manifest(manifest, run_dir)
        print(f"Workspace plan written: {len(repo_plan_paths)} repo plan(s)")
    else:
        manifest["status"] = WorkspaceStatus.RUNNING
        write_workspace_manifest(manifest, run_dir)

    from worca.workspace.dag_executor import DagExecutor
    from worca.workspace.integration_test import run_integration_test

    print(f"Workspace run {ws_id} — dispatching {len(ws.repos)} repo(s)")

    executor = DagExecutor(manifest, run_dir)
    result = executor.execute()

    if result["status"] != "completed":
        print(f"Workspace dispatch {result['status']}.")
        return 1

    if not args.skip_integration:
        manifest["status"] = WorkspaceStatus.INTEGRATION_TESTING
        write_workspace_manifest(manifest, run_dir)

        it_result = run_integration_test(manifest, ws, run_dir)
        manifest["integration_test"] = it_result

        if it_result["status"] == "failed":
            manifest["status"] = WorkspaceStatus.INTEGRATION_FAILED
            write_workspace_manifest(manifest, run_dir)
            print("Integration test failed.")
            return 1

    manifest["status"] = WorkspaceStatus.COMPLETED
    write_workspace_manifest(manifest, run_dir)
    print(f"Workspace {ws_id} completed successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
