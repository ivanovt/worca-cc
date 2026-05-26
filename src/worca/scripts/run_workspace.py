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
import signal
import sys
import tempfile
from datetime import datetime, timezone

import jsonschema

import worca
from worca.events import types as event_types
from worca.events.workspace_emitter import emit_workspace_event
from worca.state.status import WorkspaceStatus
from worca.utils.claude_cli import run_agent
from worca.utils.paths import workspace_runs_dir as resolve_workspace_runs_dir
from worca.workspace.manifest import Workspace


# Module-level state for the SIGTERM/SIGINT handler. Set when a workspace run
# becomes "owned" by this process (after manifest creation / resume load) so
# the handler can flush manifest state if the coordinator is killed mid-run.
_active_run_state: dict | None = None


def _install_signal_handlers() -> None:
    """Install SIGTERM and SIGINT handlers that flush manifest state on kill.

    When the workspace coordinator is killed while children are in-flight
    (e.g. operator stop, OOM killer, deploy bouncing the host), the default
    Python handler terminates without writing anything. That leaves child
    pipelines orphaned and the next `--resume` cannot tell they were ever
    dispatched. The handler installed here marks the workspace as halted
    with halt_reason="signal", flips any in-flight children to
    "interrupted", and writes the manifest before exiting. Resume then
    treats those children as needing redispatch + worktree cleanup.

    Re-raises via sys.exit(128+signum) so the parent shell still sees a
    signal-style exit code.
    """
    def _handler(signum, _frame):
        _on_signal_flush(signum)

    try:
        signal.signal(signal.SIGTERM, _handler)
        signal.signal(signal.SIGINT, _handler)
    except (ValueError, OSError):
        # signal.signal only works on the main thread; in test/embedded
        # contexts it may raise — silently skip rather than block startup.
        pass


def _on_signal_flush(signum: int) -> None:
    """Best-effort manifest flush before exit. Never raises."""
    state = _active_run_state
    if state is None:
        sys.exit(128 + signum)

    workspace_id = state.get("workspace_id")
    run_dir = state.get("run_dir")
    manifest = state.get("manifest")
    settings_path = state.get("settings_path")
    workspace_name = state.get("workspace_name", "")

    try:
        if manifest is not None and run_dir:
            for child in manifest.get("children", []):
                if child.get("status") == "running":
                    child["status"] = "interrupted"
            manifest["status"] = WorkspaceStatus.HALTED
            manifest["halt_reason"] = "signal"
            write_workspace_manifest(manifest, run_dir)
    except Exception:
        pass

    try:
        if workspace_id and settings_path:
            emit_workspace_event(
                workspace_id,
                event_types.WORKSPACE_HALTED,
                event_types.workspace_halted_payload(
                    workspace_name=workspace_name,
                    halt_reason="signal",
                    completed_tiers=sum(
                        1 for t in (manifest or {}).get("dag", {}).get("tiers", [])
                        if t.get("status") == "completed"
                    ),
                    pending_tiers=sum(
                        1 for t in (manifest or {}).get("dag", {}).get("tiers", [])
                        if t.get("status") in ("pending", "halted", "running")
                    ),
                ),
                settings_path=settings_path,
            )
    except Exception:
        pass

    sys.exit(128 + signum)


def _register_active_run(
    *,
    workspace_id: str,
    workspace_name: str,
    run_dir: str,
    manifest: dict,
    settings_path: str,
) -> None:
    """Tell the signal handler which run to flush if a signal arrives."""
    global _active_run_state
    _active_run_state = {
        "workspace_id": workspace_id,
        "workspace_name": workspace_name,
        "run_dir": run_dir,
        "manifest": manifest,
        "settings_path": settings_path,
    }


def _clear_active_run() -> None:
    """Clear the active-run state after a clean exit (no signal flush needed)."""
    global _active_run_state
    _active_run_state = None


def _settings_path_for_workspace(workspace_root: str, settings_arg: str) -> str:
    """Resolve --settings into an absolute path anchored at workspace_root.

    The workspace coordinator runs from cwd (typically workspace_root or a
    parent), and `_resume_workspace` may be invoked from anywhere. Anchor
    against the workspace root so emit_workspace_event always finds the
    right settings file for hook + webhook dispatch.
    """
    if os.path.isabs(settings_arg):
        return settings_arg
    return os.path.join(workspace_root, settings_arg)


def _ms_since(started_iso: str | None) -> int | None:
    """Compute elapsed ms since `started_iso` (UTC ISO 8601). None if unset."""
    if not started_iso:
        return None
    try:
        started = datetime.fromisoformat(started_iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    now = datetime.now(timezone.utc)
    delta = now - started
    return int(delta.total_seconds() * 1000)


def _read_log_tail(log_path: str | None, max_lines: int = 10) -> str | None:
    """Read the last `max_lines` of a log file, capped to 2 KB.

    Used by workspace.integration_test.failed payloads so chat subscribers
    can show a meaningful snippet without dragging the full log over the
    webhook channel.
    """
    if not log_path or not os.path.isfile(log_path):
        return None
    try:
        with open(log_path, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return None
    tail = "".join(lines[-max_lines:])
    return tail[-2048:] if len(tail) > 2048 else tail

class WorkspacePlanError(Exception):
    """Raised when a user-supplied workspace plan is invalid."""


_AGENTS_DIR = os.path.join(os.path.dirname(worca.__file__), "agents", "core")
_SCHEMAS_DIR = os.path.join(os.path.dirname(worca.__file__), "schemas")


# Module-level override slot.  Resolves lazily via
# worca.utils.paths.workspace_runs_dir — None means "use $WORCA_HOME or
# ~/.worca" (issue #162).
_POINTER_DIR_DEFAULT: str | None = None


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
        pointer_dir = resolve_workspace_runs_dir(_POINTER_DIR_DEFAULT)
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
    projects_by_name: dict[str, str],
    dependency_graph: dict[str, list[str]],
    failure_threshold: float | None = None,
) -> dict:
    """Build the workspace manifest dict (extends fleet manifest schema per §7)."""
    guide_bytes = sum(
        os.path.getsize(p) for p in guide_paths if os.path.isfile(p)
    )

    dag_tiers = [
        {"tier": i, "projects": tier_projects, "status": "pending"}
        for i, tier_projects in enumerate(tiers)
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
        "projects_by_name": projects_by_name,
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


def gather_project_context(
    workspace: Workspace,
    workspace_root: str,
    *,
    max_bytes: int = 4096,
) -> dict[str, str]:
    """Read CLAUDE.md from each project, truncate to max_bytes."""
    contexts: dict[str, str] = {}
    for project in workspace.projects:
        claude_md_path = os.path.join(workspace_root, project.path, "CLAUDE.md")
        try:
            with open(claude_md_path, encoding="utf-8") as f:
                content = f.read()
            encoded = content.encode("utf-8")
            if len(encoded) > max_bytes:
                content = encoded[:max_bytes].decode("utf-8", errors="ignore")
        except FileNotFoundError:
            content = ""
        contexts[project.name] = content
    return contexts


def build_planner_prompt(
    workspace: Workspace,
    prompt: str,
    project_contexts: dict[str, str],
    guide_paths: list[str],
) -> str:
    """Build the prompt for the workspace planner agent."""
    topology = {
        "name": workspace.name,
        "projects": [
            {
                "name": p.name,
                "path": p.path,
                "depends_on": p.depends_on,
            }
            for p in workspace.projects
        ],
    }

    sections = []
    sections.append("## Workspace Topology\n")
    sections.append(f"```json\n{json.dumps(topology, indent=2)}\n```\n")

    sections.append("## Per-Project Context (CLAUDE.md)\n")
    for project in workspace.projects:
        ctx = project_contexts.get(project.name, "")
        if ctx:
            sections.append(f"### {project.name}\n\n{ctx}\n")
        else:
            sections.append(f"### {project.name}\n\n(no CLAUDE.md found)\n")

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
    """Validate plan against workspace_plan.json schema and workspace projects."""
    errors: list[str] = []

    schema_path = os.path.join(_SCHEMAS_DIR, "workspace_plan.json")
    with open(schema_path) as f:
        schema = json.load(f)

    try:
        jsonschema.validate(plan, schema)
    except jsonschema.ValidationError as e:
        errors.append(f"schema validation: {e.message}")
        return errors

    known_projects = {p.name for p in workspace.projects}
    for project_entry in plan.get("projects", []):
        name = project_entry.get("name", "")
        if name not in known_projects:
            errors.append(f"unknown project '{name}' not in workspace.json")

    return errors


def format_workspace_plan_md(plan: dict) -> str:
    """Format workspace plan as human-readable markdown."""
    lines = ["# Workspace Plan\n"]
    lines.append(f"## Summary\n\n{plan['summary']}\n")

    lines.append("## Projects\n")
    for project in plan["projects"]:
        skip_tag = " (skipped)" if project.get("skip") else ""
        lines.append(f"### {project['name']}{skip_tag}\n")
        lines.append(f"{project['description']}\n")
        if project.get("depends_on"):
            lines.append(f"**Depends on:** {', '.join(project['depends_on'])}\n")
        lines.append("**Acceptance Criteria:**\n")
        for ac in project["acceptance_criteria"]:
            lines.append(f"- {ac}")
        lines.append("")

    if plan.get("integration_expectations"):
        lines.append("## Integration Expectations\n")
        for ie in plan["integration_expectations"]:
            lines.append(f"- {ie}")
        lines.append("")

    return "\n".join(lines)


def format_project_plan_md(project_entry: dict, workspace_summary: str) -> str:
    """Format a single project's plan as markdown for --plan injection."""
    lines = [f"# Plan: {project_entry['name']}\n"]
    lines.append(f"## Workspace Context\n\n{workspace_summary}\n")
    lines.append(f"## Description\n\n{project_entry['description']}\n")
    if project_entry.get("depends_on"):
        lines.append(f"## Dependencies\n\nDepends on: {', '.join(project_entry['depends_on'])}\n")
    lines.append("## Acceptance Criteria\n")
    for ac in project_entry["acceptance_criteria"]:
        lines.append(f"- {ac}")
    lines.append("")
    return "\n".join(lines)


def write_workspace_plan_files(plan: dict, run_dir: str) -> dict[str, str]:
    """Write workspace-plan.md, workspace-plan.json, per-project {project}-plan.md.

    Returns {project_name: absolute_path_to_plan_md} for non-skipped projects.
    """
    json_path = os.path.join(run_dir, "workspace-plan.json")
    with open(json_path, "w") as f:
        json.dump(plan, f, indent=2)
        f.write("\n")

    md_path = os.path.join(run_dir, "workspace-plan.md")
    with open(md_path, "w") as f:
        f.write(format_workspace_plan_md(plan))

    project_plan_paths: dict[str, str] = {}
    for project in plan["projects"]:
        if project.get("skip"):
            continue
        plan_path = os.path.join(run_dir, f"{project['name']}-plan.md")
        with open(plan_path, "w") as f:
            f.write(format_project_plan_md(project, plan["summary"]))
        project_plan_paths[project["name"]] = plan_path

    return project_plan_paths


def _load_workspace_plan_from_file(path: str) -> dict:
    """Read and parse a workspace-plan.json from disk."""
    if not os.path.isfile(path):
        raise WorkspacePlanError(f"workspace plan not found: {path}")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        raise WorkspacePlanError(f"failed to parse workspace plan: {e}") from e


def _materialize_per_project_plans(
    project_plan_args: list[str],
    workspace: Workspace,
    run_dir: str,
) -> dict[str, str]:
    """Parse NAME=PATH entries, validate, copy into run_dir, return {name: path}."""
    import shutil

    known_projects = {p.name for p in workspace.projects}
    project_plan_paths: dict[str, str] = {}

    for entry in project_plan_args:
        if "=" not in entry:
            raise WorkspacePlanError(
                f"invalid --project-plan format '{entry}': expected NAME=PATH"
            )
        name, path = entry.split("=", 1)
        if name not in known_projects:
            raise WorkspacePlanError(
                f"unknown project '{name}' in --project-plan; "
                f"known projects: {', '.join(sorted(known_projects))}"
            )
        if not os.path.isfile(path):
            raise WorkspacePlanError(
                f"project plan not found for '{name}': {path}"
            )
        with open(path, encoding="utf-8") as f:
            content = f.read()
        if not content.strip():
            raise WorkspacePlanError(
                f"project plan for '{name}' is empty: {path}"
            )
        dest = os.path.join(run_dir, f"{name}-plan.md")
        shutil.copy2(path, dest)
        project_plan_paths[name] = dest

    return project_plan_paths


def _materialize_plan(
    args, ws, run_dir, manifest, parser,
    *, workspace_id=None, settings_path=None,
) -> str:
    """Populate manifest['plan']; return the planning mode used."""
    if args.skip_planning and (args.workspace_plan or args.project_plan):
        parser.error(
            "--skip-planning cannot be combined with "
            "--workspace-plan or --project-plan"
        )

    if args.skip_planning:
        return "independent"

    if args.workspace_plan:
        plan = _load_workspace_plan_from_file(args.workspace_plan)
        errors = validate_workspace_plan(plan, ws)
        if errors:
            raise WorkspacePlanError("; ".join(errors))
        project_plan_paths = write_workspace_plan_files(plan, run_dir)
        manifest["plan"] = {
            "workspace_plan_path": os.path.join(run_dir, "workspace-plan.json"),
            "project_plans": project_plan_paths,
            "source": "existing",
        }
        if workspace_id and settings_path:
            emit_workspace_event(
                workspace_id,
                event_types.WORKSPACE_PLAN_LOADED,
                event_types.workspace_plan_loaded_payload(
                    ws.name,
                    mode="existing",
                    project_count=len(project_plan_paths),
                    covered_projects=sorted(project_plan_paths),
                ),
                settings_path=settings_path,
            )
        return "existing"

    if args.project_plan:
        project_plan_paths = _materialize_per_project_plans(
            args.project_plan, ws, run_dir,
        )
        all_projects = {p.name for p in ws.projects}
        covered = set(project_plan_paths)
        uncovered = sorted(all_projects - covered)

        manifest["plan"] = {
            "workspace_plan_path": None,
            "project_plans": project_plan_paths,
            "source": "per-repo",
        }

        if workspace_id and settings_path:
            if uncovered:
                emit_workspace_event(
                    workspace_id,
                    event_types.WORKSPACE_PLAN_PARTIAL,
                    event_types.workspace_plan_partial_payload(
                        ws.name,
                        mode="per-repo",
                        project_count=len(all_projects),
                        covered_projects=sorted(covered),
                        uncovered_projects=uncovered,
                    ),
                    settings_path=settings_path,
                )
            else:
                emit_workspace_event(
                    workspace_id,
                    event_types.WORKSPACE_PLAN_LOADED,
                    event_types.workspace_plan_loaded_payload(
                        ws.name,
                        mode="per-repo",
                        project_count=len(all_projects),
                        covered_projects=sorted(covered),
                    ),
                    settings_path=settings_path,
                )
        return "per-repo"

    return "master"


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

    # Claude CLI returns the schema-constrained JSON in `structured_output`
    # (matches what orchestrator/runner.py does for every other agent stage).
    # The `result` field carries the model's natural-language summary, which
    # is NOT valid JSON for the workspace_plan schema. Reading `result` here
    # caused "Expecting value: line 1 column 1 (char 0)" on every workspace
    # run — the planner appeared to succeed in the log but the parse failed.
    if isinstance(event, dict) and event.get("structured_output"):
        return event["structured_output"]

    # Fallback for older Claude CLI versions that don't surface
    # structured_output: try to parse the result field as JSON anyway.
    result_text = event.get("result", "") if isinstance(event, dict) else ""
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
        pointer_dir = resolve_workspace_runs_dir(_POINTER_DIR_DEFAULT)

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

    Returns (skip_projects, redispatch_projects).
    - skip: completed children — left as-is, worktrees retained for context.
    - redispatch: everything else (failed/blocked/halted/running/interrupted)
      — re-dispatched fresh. "running" and "interrupted" entries are produced
      by the SIGTERM/SIGINT handler in `run_workspace.main`.
    """
    skip: set[str] = set()
    redispatch: set[str] = set()

    for child in children:
        project = child["project"]
        status = child.get("status", "")
        if status == "completed":
            skip.add(project)
        else:
            redispatch.add(project)

    return skip, redispatch


def collect_stale_worktrees(
    children: list[dict],
    redispatch_projects: set[str],
) -> list[tuple[str, str | None, str | None]]:
    """Capture (project, worktree_path, project_path) for redispatch children.

    Called BEFORE `rebuild_resume_manifest` filters non-completed children
    out of the manifest, so the resume path still knows which worktrees
    need cleanup before re-dispatch can create fresh ones at the same
    branch.
    """
    stale: list[tuple[str, str | None, str | None]] = []
    for child in children:
        project = child["project"]
        if project not in redispatch_projects:
            continue
        stale.append((
            project,
            child.get("worktree_path"),
            child.get("project_path"),
        ))
    return stale


def cleanup_stale_worktrees(
    stale: list[tuple[str, str | None, str | None]],
) -> None:
    """Best-effort removal of worktrees left behind by interrupted children.

    Without this, a subsequent `git worktree add <path> <branch>` for the
    re-dispatched project hits either "already exists" (if the path is
    still there) or "branch already used by worktree" (if the registration
    survived but the path was reaped). We do `git worktree remove --force`
    on the known path, then `git worktree prune` in the project checkout
    so any leftover registrations are dropped. All failures are swallowed
    — the worst case is the re-dispatch surfaces the real error.
    """
    import subprocess

    for project, worktree_path, project_path in stale:
        if not project_path:
            continue
        try:
            if worktree_path:
                subprocess.run(
                    ["git", "worktree", "remove", "--force", worktree_path],
                    cwd=project_path,
                    capture_output=True,
                    text=True,
                )
            subprocess.run(
                ["git", "worktree", "prune"],
                cwd=project_path,
                capture_output=True,
                text=True,
            )
        except Exception:
            continue


def rebuild_resume_manifest(
    manifest: dict,
    skip_projects: set[str],
    redispatch_projects: set[str],
) -> dict:
    """Rebuild a manifest for resume: reset non-completed tiers/children.

    Mutates and returns the manifest.
    """
    manifest["halt_reason"] = None

    manifest["children"] = [
        c for c in manifest["children"] if c["project"] in skip_projects
    ]

    all_children_done = len(redispatch_projects) == 0

    if all_children_done:
        manifest["status"] = WorkspaceStatus.INTEGRATION_TESTING
    else:
        manifest["status"] = WorkspaceStatus.RUNNING

    # A tier that was mid-run at crash time (some children completed, some
    # in-flight) is reset to "pending" here. That tier status is cosmetic —
    # DagExecutor uses its own _completed_projects set (derived from
    # manifest["children"]) as the authoritative source for which projects
    # to skip on re-dispatch, so already-completed children within a
    # "pending" tier will not be re-run.
    for tier in manifest["dag"]["tiers"]:
        tier_projects = set(tier["projects"])
        if tier_projects <= skip_projects:
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
    print(f"Projects:  {len(workspace.projects)}")
    print(f"Tiers:     {len(workspace.tiers)}")
    print()

    project_map = {p.name: p for p in workspace.projects}
    for i, tier in enumerate(workspace.tiers):
        print(f"  Tier {i}:")
        for name in tier:
            project = project_map[name]
            deps = f" (depends on: {', '.join(project.depends_on)})" if project.depends_on else ""
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
        description="Run a coordinated multi-project workspace pipeline (W-047)",
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
        default="workspace/{slug}/{project}",
        metavar="TEMPLATE",
        help=(
            "Branch name template with {workspace}, {project}, {slug} placeholders. "
            "Default: workspace/{slug}/{project}"
        ),
    )

    parser.add_argument(
        "--skip-integration",
        action="store_true",
        default=False,
        help="Skip the integration test phase",
    )

    plan_source = parser.add_mutually_exclusive_group()
    plan_source.add_argument(
        "--workspace-plan",
        metavar="PATH",
        help="Path to an existing workspace-plan.json to reuse",
    )
    plan_source.add_argument(
        "--project-plan",
        action="append",
        metavar="NAME=PATH",
        help="Per-project plan file as NAME=PATH (repeatable)",
    )

    parser.add_argument(
        "--skip-planning",
        action="store_true",
        default=False,
        help="Skip the master planner; every child runs its own Planner",
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

    all_projects = {p.name for p in ws.projects}
    missing = all_projects - skip - redispatch
    for project in missing:
        redispatch.add(project)

    from_state = status

    # Capture worktree paths of redispatch children before rebuild_resume_manifest
    # filters them out, then clean them up so re-dispatch's `git worktree add`
    # does not collide with the prior partial run.
    stale = collect_stale_worktrees(manifest["children"], redispatch)

    rebuild_resume_manifest(manifest, skip, redispatch)
    write_workspace_manifest(manifest, run_dir)

    if stale:
        cleanup_stale_worktrees(stale)

    settings_path = _settings_path_for_workspace(workspace_root, ".claude/settings.json")
    resume_started_at = datetime.now(timezone.utc).isoformat()

    _register_active_run(
        workspace_id=workspace_id,
        workspace_name=ws.name,
        run_dir=run_dir,
        manifest=manifest,
        settings_path=settings_path,
    )

    emit_workspace_event(
        workspace_id,
        event_types.WORKSPACE_RESUMED,
        event_types.workspace_resumed_payload(
            workspace_name=ws.name,
            from_state=from_state,
            redispatch_count=len(redispatch),
            skip_count=len(skip),
        ),
        settings_path=settings_path,
    )

    if manifest["status"] == WorkspaceStatus.INTEGRATION_TESTING:
        print(f"Resuming workspace {workspace_id} — re-running integration test only")
        integration_started_at = None
        if ws.integration_test is not None:
            integration_started_at = datetime.now(timezone.utc).isoformat()
            emit_workspace_event(
                workspace_id,
                event_types.WORKSPACE_INTEGRATION_STARTED,
                event_types.workspace_integration_started_payload(
                    workspace_name=ws.name,
                    command=ws.integration_test.command,
                    working_dir=ws.integration_test.working_dir,
                ),
                settings_path=settings_path,
            )
        it_result = run_integration_test(manifest, ws, run_dir)
        manifest["integration_test"] = it_result

        if it_result["status"] == "failed":
            manifest["status"] = WorkspaceStatus.INTEGRATION_FAILED
            write_workspace_manifest(manifest, run_dir)
            print("Integration test failed again.")
            emit_workspace_event(
                workspace_id,
                event_types.WORKSPACE_INTEGRATION_FAILED,
                event_types.workspace_integration_failed_payload(
                    workspace_name=ws.name,
                    exit_code=it_result.get("exit_code"),
                    duration_ms=_ms_since(integration_started_at),
                    log_path=it_result.get("log_path"),
                    log_tail=_read_log_tail(it_result.get("log_path")),
                ),
                settings_path=settings_path,
            )
            emit_workspace_event(
                workspace_id,
                event_types.WORKSPACE_FAILED,
                event_types.workspace_failed_payload(
                    workspace_name=ws.name,
                    tier_count=len(manifest["dag"]["tiers"]),
                    completed_count=sum(
                        1 for c in manifest["children"]
                        if c.get("status") == "completed"
                    ),
                    failed_count=0,
                    duration_ms=_ms_since(resume_started_at),
                ),
                settings_path=settings_path,
            )
            return 1
        else:
            manifest["status"] = WorkspaceStatus.COMPLETED
            write_workspace_manifest(manifest, run_dir)
            print("Integration test passed. Workspace completed.")
            if it_result["status"] == "passed":
                emit_workspace_event(
                    workspace_id,
                    event_types.WORKSPACE_INTEGRATION_PASSED,
                    event_types.workspace_integration_passed_payload(
                        workspace_name=ws.name,
                        duration_ms=_ms_since(integration_started_at),
                        log_path=it_result.get("log_path"),
                    ),
                    settings_path=settings_path,
                )
            emit_workspace_event(
                workspace_id,
                event_types.WORKSPACE_COMPLETED,
                event_types.workspace_completed_payload(
                    workspace_name=ws.name,
                    tier_count=len(manifest["dag"]["tiers"]),
                    child_count=len(manifest.get("children", [])),
                    integration_passed=True,
                    duration_ms=_ms_since(resume_started_at),
                ),
                settings_path=settings_path,
            )
            return 0

    print(f"Resuming workspace {workspace_id} — re-dispatching {len(redispatch)} project(s)")

    executor = DagExecutor(manifest, run_dir, settings_path=settings_path)
    result = executor.execute()

    if result["status"] == "halted":
        print("Workspace dispatch halted.")
        return 1

    if result["status"] != "completed":
        print(f"Workspace dispatch {result['status']}.")
        emit_workspace_event(
            workspace_id,
            event_types.WORKSPACE_FAILED,
            event_types.workspace_failed_payload(
                workspace_name=ws.name,
                tier_count=len(manifest["dag"]["tiers"]),
                completed_count=sum(
                    1 for c in manifest["children"]
                    if c.get("status") == "completed"
                ),
                failed_count=sum(
                    1 for c in manifest["children"]
                    if c.get("status") in ("failed", "blocked", "setup_failed")
                ),
                duration_ms=_ms_since(resume_started_at),
            ),
            settings_path=settings_path,
        )
        return 1

    integration_passed = True
    if not manifest.get("skip_integration"):
        manifest["status"] = WorkspaceStatus.INTEGRATION_TESTING
        write_workspace_manifest(manifest, run_dir)

        integration_started_at = None
        if ws.integration_test is not None:
            integration_started_at = datetime.now(timezone.utc).isoformat()
            emit_workspace_event(
                workspace_id,
                event_types.WORKSPACE_INTEGRATION_STARTED,
                event_types.workspace_integration_started_payload(
                    workspace_name=ws.name,
                    command=ws.integration_test.command,
                    working_dir=ws.integration_test.working_dir,
                ),
                settings_path=settings_path,
            )

        it_result = run_integration_test(manifest, ws, run_dir)
        manifest["integration_test"] = it_result

        if it_result["status"] == "failed":
            integration_passed = False
            manifest["status"] = WorkspaceStatus.INTEGRATION_FAILED
            write_workspace_manifest(manifest, run_dir)
            print("Integration test failed.")
            emit_workspace_event(
                workspace_id,
                event_types.WORKSPACE_INTEGRATION_FAILED,
                event_types.workspace_integration_failed_payload(
                    workspace_name=ws.name,
                    exit_code=it_result.get("exit_code"),
                    duration_ms=_ms_since(integration_started_at),
                    log_path=it_result.get("log_path"),
                    log_tail=_read_log_tail(it_result.get("log_path")),
                ),
                settings_path=settings_path,
            )
            emit_workspace_event(
                workspace_id,
                event_types.WORKSPACE_FAILED,
                event_types.workspace_failed_payload(
                    workspace_name=ws.name,
                    tier_count=len(manifest["dag"]["tiers"]),
                    completed_count=sum(
                        1 for c in manifest["children"]
                        if c.get("status") == "completed"
                    ),
                    failed_count=0,
                    duration_ms=_ms_since(resume_started_at),
                ),
                settings_path=settings_path,
            )
            return 1
        elif it_result["status"] == "passed":
            emit_workspace_event(
                workspace_id,
                event_types.WORKSPACE_INTEGRATION_PASSED,
                event_types.workspace_integration_passed_payload(
                    workspace_name=ws.name,
                    duration_ms=_ms_since(integration_started_at),
                    log_path=it_result.get("log_path"),
                ),
                settings_path=settings_path,
            )

    manifest["status"] = WorkspaceStatus.COMPLETED
    write_workspace_manifest(manifest, run_dir)
    print(f"Workspace {workspace_id} resumed successfully.")
    emit_workspace_event(
        workspace_id,
        event_types.WORKSPACE_COMPLETED,
        event_types.workspace_completed_payload(
            workspace_name=ws.name,
            tier_count=len(manifest["dag"]["tiers"]),
            child_count=len(manifest.get("children", [])),
            integration_passed=integration_passed,
            duration_ms=_ms_since(resume_started_at),
            umbrella_issue_url=(
                manifest.get("umbrella_issue", {}).get("url")
                if isinstance(manifest.get("umbrella_issue"), dict)
                else None
            ),
        ),
        settings_path=settings_path,
    )
    return 0


def main(argv=None) -> int:
    """Entry point. Returns exit code."""
    parser = create_parser()
    args = parser.parse_args(argv)

    _install_signal_handlers()

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

    projects_by_name = {p.name: p.path for p in ws.projects}
    guide_paths = [os.path.abspath(g) for g in (args.guide or [])]

    from worca.utils.settings import load_settings
    settings = load_settings(args.settings)
    failure_threshold = settings.get("worca", {}).get("workspace", {}).get("failure_threshold")

    dependency_graph = {p.name: p.depends_on for p in ws.projects}

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
        projects_by_name=projects_by_name,
        dependency_graph=dependency_graph,
        failure_threshold=failure_threshold,
    )

    write_workspace_manifest(manifest, run_dir)

    settings_path = _settings_path_for_workspace(workspace_root, args.settings)
    workspace_started_at = manifest["created_at"]

    _register_active_run(
        workspace_id=ws_id,
        workspace_name=ws.name,
        run_dir=run_dir,
        manifest=manifest,
        settings_path=settings_path,
    )

    emit_workspace_event(
        ws_id,
        event_types.WORKSPACE_LAUNCHED,
        event_types.workspace_launched_payload(
            projects=[p.name for p in ws.projects],
            workspace_name=ws.name,
            branch_template=args.branch,
            guide_attached=bool(guide_paths),
            max_parallel=args.max_parallel,
            skip_planning=args.skip_planning,
            tier_count=len(ws.tiers),
        ),
        settings_path=settings_path,
    )

    try:
        plan_mode = _materialize_plan(
            args, ws, run_dir, manifest, parser,
            workspace_id=ws_id, settings_path=settings_path,
        )
    except WorkspacePlanError as e:
        print(f"error: {e}", file=sys.stderr)
        manifest["status"] = WorkspaceStatus.FAILED
        write_workspace_manifest(manifest, run_dir)
        emit_workspace_event(
            ws_id,
            event_types.WORKSPACE_PLAN_FAILED,
            event_types.workspace_plan_failed_payload(
                workspace_name=ws.name,
                error=str(e),
                error_type=type(e).__name__,
                duration_ms=_ms_since(workspace_started_at),
            ),
            settings_path=settings_path,
        )
        emit_workspace_event(
            ws_id,
            event_types.WORKSPACE_FAILED,
            event_types.workspace_failed_payload(
                workspace_name=ws.name,
                tier_count=len(ws.tiers),
                completed_count=0,
                failed_count=0,
                duration_ms=_ms_since(workspace_started_at),
            ),
            settings_path=settings_path,
        )
        return 1

    if plan_mode == "master":
        print(f"Running workspace planner for {ws.name}...")
        plan_started_at = datetime.now(timezone.utc).isoformat()
        emit_workspace_event(
            ws_id,
            event_types.WORKSPACE_PLAN_STARTED,
            event_types.workspace_plan_started_payload(
                workspace_name=ws.name,
                project_count=len(ws.projects),
            ),
            settings_path=settings_path,
        )

        project_contexts = gather_project_context(ws, workspace_root)
        planner_prompt = build_planner_prompt(
            ws, args.prompt or "", project_contexts, guide_paths,
        )

        try:
            plan = run_workspace_planner(planner_prompt, run_dir)
        except Exception as e:
            print(f"error: workspace planner failed: {e}", file=sys.stderr)
            manifest["status"] = WorkspaceStatus.FAILED
            write_workspace_manifest(manifest, run_dir)
            emit_workspace_event(
                ws_id,
                event_types.WORKSPACE_PLAN_FAILED,
                event_types.workspace_plan_failed_payload(
                    workspace_name=ws.name,
                    error=str(e),
                    error_type=type(e).__name__,
                    duration_ms=_ms_since(plan_started_at),
                ),
                settings_path=settings_path,
            )
            emit_workspace_event(
                ws_id,
                event_types.WORKSPACE_FAILED,
                event_types.workspace_failed_payload(
                    workspace_name=ws.name,
                    tier_count=len(ws.tiers),
                    completed_count=0,
                    failed_count=0,
                    duration_ms=_ms_since(workspace_started_at),
                ),
                settings_path=settings_path,
            )
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
            err_msg = "; ".join(errors)
            emit_workspace_event(
                ws_id,
                event_types.WORKSPACE_PLAN_FAILED,
                event_types.workspace_plan_failed_payload(
                    workspace_name=ws.name,
                    error=err_msg,
                    error_type="ValidationError",
                    duration_ms=_ms_since(plan_started_at),
                ),
                settings_path=settings_path,
            )
            emit_workspace_event(
                ws_id,
                event_types.WORKSPACE_FAILED,
                event_types.workspace_failed_payload(
                    workspace_name=ws.name,
                    tier_count=len(ws.tiers),
                    completed_count=0,
                    failed_count=0,
                    duration_ms=_ms_since(workspace_started_at),
                ),
                settings_path=settings_path,
            )
            return 1

        project_plan_paths = write_workspace_plan_files(plan, run_dir)
        manifest["plan"] = {
            "workspace_plan_path": os.path.join(run_dir, "workspace-plan.json"),
            "project_plans": project_plan_paths,
        }
        print(f"Workspace plan written: {len(project_plan_paths)} project plan(s)")
        emit_workspace_event(
            ws_id,
            event_types.WORKSPACE_PLAN_COMPLETED,
            event_types.workspace_plan_completed_payload(
                workspace_name=ws.name,
                project_count=len(project_plan_paths),
                skipped_count=len(ws.projects) - len(project_plan_paths),
                duration_ms=_ms_since(plan_started_at),
            ),
            settings_path=settings_path,
        )
    elif plan_mode in ("existing", "per-repo"):
        project_plan_paths = manifest.get("plan", {}).get("project_plans", {})
        print(f"Plan loaded ({plan_mode}): {len(project_plan_paths)} project plan(s)")

    # Persist the resolved planning mode so the UI plan-mode badge has a
    # source of truth. The server seeds manifest["plan_mode"] before spawning
    # this process, but create_workspace_manifest() rebuilds the manifest from
    # scratch and write_workspace_manifest() below overwrites the same file —
    # without this line the server's value is clobbered and the badge always
    # falls back to "master".
    manifest["plan_mode"] = plan_mode
    manifest["status"] = WorkspaceStatus.RUNNING
    write_workspace_manifest(manifest, run_dir)

    from worca.workspace.dag_executor import DagExecutor
    from worca.workspace.integration_test import run_integration_test

    print(f"Workspace run {ws_id} — dispatching {len(ws.projects)} project(s)")

    executor = DagExecutor(manifest, run_dir, settings_path=settings_path)
    result = executor.execute()

    if result["status"] == "halted":
        # DagExecutor already emitted circuit_breaker.tripped + halted.
        print("Workspace dispatch halted.")
        return 1

    if result["status"] != "completed":
        # Tier-level failures already emitted workspace.tier.failed. Wrap
        # with the workspace-level workspace.failed terminal event.
        print(f"Workspace dispatch {result['status']}.")
        completed_count = sum(
            1 for c in manifest["children"] if c.get("status") == "completed"
        )
        failed_count = sum(
            1 for c in manifest["children"]
            if c.get("status") in ("failed", "blocked", "setup_failed")
        )
        failed_projects = [
            c["project"] for c in manifest["children"]
            if c.get("status") in ("failed", "blocked", "setup_failed")
        ]
        emit_workspace_event(
            ws_id,
            event_types.WORKSPACE_FAILED,
            event_types.workspace_failed_payload(
                workspace_name=ws.name,
                tier_count=len(ws.tiers),
                completed_count=completed_count,
                failed_count=failed_count,
                duration_ms=_ms_since(workspace_started_at),
                failed_projects=failed_projects,
            ),
            settings_path=settings_path,
        )
        return 1

    integration_passed = True
    if not args.skip_integration:
        manifest["status"] = WorkspaceStatus.INTEGRATION_TESTING
        write_workspace_manifest(manifest, run_dir)

        integration_started_at = None
        if ws.integration_test is not None:
            integration_started_at = datetime.now(timezone.utc).isoformat()
            emit_workspace_event(
                ws_id,
                event_types.WORKSPACE_INTEGRATION_STARTED,
                event_types.workspace_integration_started_payload(
                    workspace_name=ws.name,
                    command=ws.integration_test.command,
                    working_dir=ws.integration_test.working_dir,
                ),
                settings_path=settings_path,
            )

        it_result = run_integration_test(manifest, ws, run_dir)
        manifest["integration_test"] = it_result

        if it_result["status"] == "failed":
            integration_passed = False
            manifest["status"] = WorkspaceStatus.INTEGRATION_FAILED
            write_workspace_manifest(manifest, run_dir)
            print("Integration test failed.")
            log_tail = _read_log_tail(it_result.get("log_path"))
            emit_workspace_event(
                ws_id,
                event_types.WORKSPACE_INTEGRATION_FAILED,
                event_types.workspace_integration_failed_payload(
                    workspace_name=ws.name,
                    exit_code=it_result.get("exit_code"),
                    duration_ms=_ms_since(integration_started_at),
                    log_path=it_result.get("log_path"),
                    log_tail=log_tail,
                ),
                settings_path=settings_path,
            )
            emit_workspace_event(
                ws_id,
                event_types.WORKSPACE_FAILED,
                event_types.workspace_failed_payload(
                    workspace_name=ws.name,
                    tier_count=len(ws.tiers),
                    completed_count=sum(
                        1 for c in manifest["children"]
                        if c.get("status") == "completed"
                    ),
                    failed_count=0,
                    duration_ms=_ms_since(workspace_started_at),
                ),
                settings_path=settings_path,
            )
            return 1
        elif it_result["status"] == "passed":
            emit_workspace_event(
                ws_id,
                event_types.WORKSPACE_INTEGRATION_PASSED,
                event_types.workspace_integration_passed_payload(
                    workspace_name=ws.name,
                    duration_ms=_ms_since(integration_started_at),
                    log_path=it_result.get("log_path"),
                ),
                settings_path=settings_path,
            )

    manifest["status"] = WorkspaceStatus.COMPLETED
    write_workspace_manifest(manifest, run_dir)
    print(f"Workspace {ws_id} completed successfully.")
    emit_workspace_event(
        ws_id,
        event_types.WORKSPACE_COMPLETED,
        event_types.workspace_completed_payload(
            workspace_name=ws.name,
            tier_count=len(ws.tiers),
            child_count=len(manifest.get("children", [])),
            integration_passed=integration_passed,
            duration_ms=_ms_since(workspace_started_at),
            umbrella_issue_url=(
                manifest.get("umbrella_issue", {}).get("url")
                if isinstance(manifest.get("umbrella_issue"), dict)
                else None
            ),
        ),
        settings_path=settings_path,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
