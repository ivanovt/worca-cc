"""Tier-based DAG executor for workspace pipelines (W-047 §3).

Dispatches child pipelines via run_worktree.py in topological tier order.
Repos within a tier run in parallel via ThreadPoolExecutor; tiers execute
sequentially. Each child receives --workspace-id (not --fleet-id) and
per-child env vars WORCA_WORKSPACE_ID, WORCA_WORKSPACE_NAME, WORCA_DEFER_PR=1.

Between tiers, context artifacts (git diff --stat + targeted file-level diffs)
are extracted from completed children, written to {run_dir}/context/{repo}-diff.md,
and injected into the next tier's children via --guide (W-047 §4).
"""
from __future__ import annotations

import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

from worca.state.status import WorkspaceStatus


CONTEXT_CAP_BYTES = 8192

_API_SURFACE_DIRS = frozenset({"types", "api", "schemas"})

_SCRUB_KEYS = frozenset({
    "WORCA_AGENT",
    "WORCA_STAGE",
    "WORCA_RUN_ID",
    "WORCA_PROJECT_ROOT",
    "CLAUDECODE",
})
_SCRUB_PREFIXES = ("WORCA_",)


def _build_child_env(
    base_env: dict,
    *,
    workspace_id: str,
    workspace_name: str,
) -> dict:
    result = {}
    for key, value in base_env.items():
        if key in _SCRUB_KEYS:
            continue
        if any(key.startswith(prefix) for prefix in _SCRUB_PREFIXES):
            continue
        result[key] = value

    result["WORCA_WORKSPACE_ID"] = workspace_id
    result["WORCA_WORKSPACE_NAME"] = workspace_name
    result["WORCA_DEFER_PR"] = "1"
    return result


def _build_child_cmd(
    *,
    workspace_id: str,
    prompt: str,
    guide_paths: list[str],
    plan_path: str | None,
) -> list[str]:
    run_worktree = os.path.join(
        os.path.dirname(os.path.dirname(__file__)), "scripts", "run_worktree.py"
    )
    cmd = [sys.executable, run_worktree]
    cmd.extend(["--prompt", prompt])
    cmd.extend(["--workspace-id", workspace_id])

    for g in guide_paths:
        cmd.extend(["--guide", g])

    if plan_path:
        cmd.extend(["--plan", plan_path])

    return cmd


def _parse_run_id_from_stdout(stdout_str: str) -> str | None:
    if not stdout_str:
        return None
    first = stdout_str.strip().split("\n", 1)[0].strip()
    if not first or "/" in first or " " in first:
        return None
    return first


def _parse_worktree_from_stdout(stdout_str: str) -> str | None:
    if not stdout_str:
        return None
    lines = stdout_str.strip().split("\n")
    if len(lines) < 2:
        return None
    return lines[1].strip()


def _run_git(args: list[str], cwd: str) -> str:
    proc = subprocess.run(
        ["git"] + args, cwd=cwd, capture_output=True, text=True,
    )
    return proc.stdout if proc.returncode == 0 else ""


def _parse_diff_into_files(diff_text: str) -> list[tuple[str, str]]:
    """Split unified diff into (filepath, section_text) pairs."""
    files: list[tuple[str, str]] = []
    current_path: str | None = None
    current_lines: list[str] = []

    for line in diff_text.split("\n"):
        if line.startswith("diff --git "):
            if current_path is not None:
                files.append((current_path, "\n".join(current_lines)))
            parts = line.split(" b/", 1)
            current_path = parts[1] if len(parts) > 1 else ""
            current_lines = [line]
        elif current_path is not None:
            current_lines.append(line)

    if current_path is not None:
        files.append((current_path, "\n".join(current_lines)))

    return files


def _is_api_surface(filepath: str) -> bool:
    parts = filepath.replace("\\", "/").split("/")
    if any(p in _API_SURFACE_DIRS for p in parts):
        return True
    basename = parts[-1] if parts else ""
    return basename.startswith("index.")


def _prioritize_files(
    files: list[tuple[str, str]],
) -> list[tuple[str, str]]:
    api = [(p, s) for p, s in files if _is_api_surface(p)]
    rest = [(p, s) for p, s in files if not _is_api_surface(p)]
    return api + rest


def _assemble_context(stat: str, full_diff: str, cap_bytes: int) -> str:
    """Format stat + prioritized diff sections within cap_bytes budget."""
    header = f"### Changes summary\n```\n{stat.rstrip()}\n```\n\n"

    if not full_diff.strip():
        return header

    files = _parse_diff_into_files(full_diff)
    files = _prioritize_files(files)

    diff_prefix = "### Diff\n```diff\n"
    diff_suffix = "```\n"
    overhead = len(header.encode()) + len(diff_prefix.encode()) + len(diff_suffix.encode())
    budget = cap_bytes - overhead

    if budget <= 0:
        return header

    included: list[str] = []
    total_remaining_lines = 0
    budget_exhausted = False

    for _filepath, section in files:
        if budget_exhausted:
            total_remaining_lines += section.count("\n") + 1
            continue

        section_bytes = len(section.encode())
        if section_bytes <= budget:
            included.append(section)
            budget -= section_bytes + 1
        else:
            section_lines = section.split("\n")
            file_header = "\n".join(section_lines[:4])
            rest_count = len(section_lines) - 4
            marker = f"\n[truncated — {rest_count} lines remaining]"
            candidate = file_header + marker

            if len(candidate.encode()) <= budget:
                included.append(candidate)
            else:
                total_remaining_lines += len(section_lines)

            budget_exhausted = True

    body = "\n".join(included)
    if total_remaining_lines > 0 and not any("[truncated" in s for s in included):
        body += f"\n[truncated — {total_remaining_lines} lines remaining]"

    return header + diff_prefix + body + "\n" + diff_suffix


def _detect_base_ref(worktree_path: str) -> str:
    upstream = _run_git(["rev-parse", "--abbrev-ref", "@{upstream}"], worktree_path).strip()
    if upstream:
        return upstream
    for candidate in ("main", "master", "develop"):
        if _run_git(["rev-parse", "--verify", f"refs/heads/{candidate}"], worktree_path).strip():
            return candidate
        if _run_git(["rev-parse", "--verify", f"refs/remotes/origin/{candidate}"], worktree_path).strip():
            return f"origin/{candidate}"
    return "HEAD~1"


def _extract_repo_context(
    worktree_path: str, cap_bytes: int = CONTEXT_CAP_BYTES,
) -> str:
    base = _detect_base_ref(worktree_path)
    stat = _run_git(["diff", f"{base}..HEAD", "--stat"], worktree_path)
    full_diff = _run_git(["diff", f"{base}..HEAD"], worktree_path)
    return _assemble_context(stat, full_diff, cap_bytes)


def _write_context_file(run_dir: str, repo: str, content: str) -> str:
    context_dir = os.path.join(run_dir, "context")
    os.makedirs(context_dir, exist_ok=True)
    path = os.path.join(context_dir, f"{repo}-diff.md")
    with open(path, "w") as f:
        f.write(f"## Dependency Context: {repo}\n\n{content}")
    return path


class DagExecutor:
    """Dispatch workspace children in tier order via ThreadPoolExecutor."""

    def __init__(self, manifest: dict, run_dir: str):
        self._manifest = manifest
        self._run_dir = run_dir
        self._workspace_id = manifest["workspace_id"]
        self._workspace_name = manifest["workspace_name"]
        self._workspace_root = manifest["workspace_root"]
        self._max_parallel = manifest.get("max_parallel", 5)
        self._prompt = manifest["work_request"]["description"]
        self._guide_paths = manifest.get("guide", {}).get("paths", [])
        self._repo_plans = manifest.get("plan", {}).get("repo_plans", {}) or {}
        self._repos_by_name = manifest.get("repos_by_name") or {}
        self._dependency_graph = manifest.get("dag", {}).get("dependency_graph") or {}
        self._context_paths: dict[str, str] = {}
        self._current_tier = -1
        self._failed_repos: set[str] = set()
        self._failure_threshold = manifest.get("failure_threshold")
        self._total_repos = sum(len(t["repos"]) for t in manifest["dag"]["tiers"])
        self._terminal_count = 0
        self._failed_count = 0

        self._completed_repos: dict[str, dict] = {}
        for child in manifest.get("children", []):
            if child.get("status") == "completed":
                self._completed_repos[child["repo"]] = child

    def execute(self) -> dict:
        tiers = self._manifest["dag"]["tiers"]

        for i, tier_info in enumerate(tiers):
            tier_idx = tier_info["tier"]
            repos = tier_info["repos"]
            self._current_tier = tier_idx

            if tier_info["status"] == "completed":
                if self._dependency_graph and i < len(tiers) - 1:
                    self._regenerate_tier_context(repos)
                continue

            if self._check_circuit_breaker():
                self._halt_remaining_tiers(tiers[i:])
                return {"status": "halted"}

            already_done = [r for r in repos if r in self._completed_repos]
            need_dispatch = [r for r in repos if r not in self._completed_repos]

            blocked, runnable = self._partition_repos(need_dispatch)

            for repo in blocked:
                repo_path = self._repos_by_name.get(repo, repo)
                self._manifest["children"].append({
                    "repo": repo,
                    "run_id": None,
                    "worktree_path": None,
                    "project_path": os.path.join(self._workspace_root, repo_path),
                    "status": "blocked",
                    "tier": tier_idx,
                })
                self._failed_repos.add(repo)
                self._terminal_count += 1
                self._failed_count += 1

            if runnable:
                tier_info["status"] = "running"
                self._write_manifest()

                results = self._dispatch_tier(runnable)

                has_failed = any(r["status"] == "failed" for r in results.values())
                has_blocked = len(blocked) > 0
                if has_failed or has_blocked:
                    tier_info["status"] = "failed"
                else:
                    tier_info["status"] = "completed"

                for repo, result in results.items():
                    repo_path = self._repos_by_name.get(repo, repo)
                    self._manifest["children"].append({
                        "repo": repo,
                        "run_id": result.get("run_id"),
                        "worktree_path": result.get("worktree_path"),
                        "project_path": os.path.join(self._workspace_root, repo_path),
                        "status": result["status"],
                        "tier": tier_idx,
                    })
                    self._terminal_count += 1
                    if result["status"] == "failed":
                        self._failed_repos.add(repo)
                        self._failed_count += 1
                    elif result["status"] == "completed":
                        self._completed_repos[repo] = result
            elif not already_done:
                tier_info["status"] = "failed"
            else:
                tier_info["status"] = "completed"

            self._write_manifest()

            if self._check_circuit_breaker() and i < len(tiers) - 1:
                self._halt_remaining_tiers(tiers[i + 1:])
                return {"status": "halted"}

            if self._dependency_graph and i < len(tiers) - 1:
                completed_this_tier = {}
                if runnable:
                    completed_this_tier = {
                        repo: r for repo, r in results.items()
                        if r["status"] == "completed"
                    }
                for repo in already_done:
                    child_info = self._completed_repos[repo]
                    completed_this_tier[repo] = {
                        "status": "completed",
                        "worktree_path": child_info.get("worktree_path"),
                    }
                if completed_this_tier:
                    self._extract_tier_context(completed_this_tier)

        has_failures = self._failed_repos or self._failed_count > 0
        if self._check_circuit_breaker():
            self._manifest["status"] = WorkspaceStatus.HALTED
            self._manifest["halt_reason"] = "circuit_breaker"
            self._write_manifest()
            return {"status": "halted"}
        if has_failures:
            self._manifest["status"] = WorkspaceStatus.FAILED
            self._write_manifest()
            return {"status": "failed"}

        self._manifest["status"] = WorkspaceStatus.COMPLETED
        self._write_manifest()
        return {"status": "completed"}

    def _partition_repos(self, repos: list[str]) -> tuple[list[str], list[str]]:
        blocked = []
        runnable = []
        for repo in repos:
            deps = self._dependency_graph.get(repo, [])
            if any(dep in self._failed_repos for dep in deps):
                blocked.append(repo)
            else:
                runnable.append(repo)
        return blocked, runnable

    def _check_circuit_breaker(self) -> bool:
        if self._failure_threshold is None:
            return False
        min_terminal = min(3, self._total_repos)
        if self._terminal_count < min_terminal:
            return False
        return self._failed_count / self._terminal_count >= self._failure_threshold

    def _halt_remaining_tiers(self, remaining_tiers: list[dict]) -> None:
        for tier_info in remaining_tiers:
            tier_info["status"] = "halted"
            for repo in tier_info["repos"]:
                repo_path = self._repos_by_name.get(repo, repo)
                self._manifest["children"].append({
                    "repo": repo,
                    "run_id": None,
                    "worktree_path": None,
                    "project_path": os.path.join(self._workspace_root, repo_path),
                    "status": "halted",
                    "tier": tier_info["tier"],
                })
        self._manifest["status"] = WorkspaceStatus.HALTED
        self._manifest["halt_reason"] = "circuit_breaker"
        self._write_manifest()

    def _dispatch_tier(self, repos: list[str]) -> dict:
        results = {}

        with ThreadPoolExecutor(max_workers=self._max_parallel) as pool:
            futures = {
                pool.submit(self._run_child, repo): repo for repo in repos
            }
            for future in futures:
                repo = futures[future]
                results[repo] = future.result()

        return results

    def _regenerate_tier_context(self, repos: list[str]) -> None:
        """Re-extract context from already-completed repos in a skipped tier."""
        for repo in repos:
            child = self._completed_repos.get(repo)
            if not child:
                continue
            worktree_path = child.get("worktree_path")
            if not worktree_path:
                continue
            content = _extract_repo_context(worktree_path)
            if not content.strip():
                continue
            path = _write_context_file(self._run_dir, repo, content)
            self._context_paths[repo] = path

    def _extract_tier_context(self, results: dict) -> None:
        for repo, result in results.items():
            if result["status"] != "completed":
                continue
            worktree_path = result.get("worktree_path")
            if not worktree_path:
                continue
            content = _extract_repo_context(worktree_path)
            if not content.strip():
                continue
            path = _write_context_file(self._run_dir, repo, content)
            self._context_paths[repo] = path

    def _run_child(self, repo: str) -> dict:
        env = _build_child_env(
            os.environ.copy(),
            workspace_id=self._workspace_id,
            workspace_name=self._workspace_name,
        )

        deps = self._dependency_graph.get(repo, [])
        context_guides = [
            self._context_paths[dep] for dep in deps if dep in self._context_paths
        ]

        plan_path = self._repo_plans.get(repo)
        cmd = _build_child_cmd(
            workspace_id=self._workspace_id,
            prompt=self._prompt,
            guide_paths=self._guide_paths + context_guides,
            plan_path=plan_path,
        )

        repo_path = self._repos_by_name.get(repo, repo)
        cwd = os.path.join(self._workspace_root, repo_path)

        proc = subprocess.run(
            cmd,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
        )

        if proc.returncode != 0:
            return {"status": "failed", "run_id": None, "worktree_path": None}

        run_id = _parse_run_id_from_stdout(proc.stdout)
        worktree_path = _parse_worktree_from_stdout(proc.stdout)
        return {
            "status": "completed",
            "run_id": run_id,
            "worktree_path": worktree_path,
        }

    def _write_manifest(self) -> None:
        from worca.scripts.run_workspace import write_workspace_manifest
        write_workspace_manifest(self._manifest, self._run_dir)
