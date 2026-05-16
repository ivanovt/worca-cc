"""PR linker — dependency comments + umbrella issue (W-047 §6).

After all children complete and integration tests pass:
1. Validate gh auth status per unique org.
2. Create PRs via gh pr create --repo for each completed child.
3. Post dependency comments on each PR.
4. Create umbrella issue with merge-order checklist.
5. Store PR URLs in workspace manifest.
"""
from __future__ import annotations

import os
import re
import subprocess
from urllib.parse import urlparse

from worca.workspace.manifest import Workspace


def parse_nwo_from_remote(url: str) -> str | None:
    """Parse owner/repo from a git remote URL.

    Handles SSH (git@host:owner/repo.git) and HTTPS (https://host/owner/repo.git).
    """
    url = url.strip().rstrip("/")
    if not url:
        return None

    if url.endswith(".git"):
        url = url[:-4]

    m = re.match(r"^[^@]+@[^:]+:(.+)$", url)
    if m:
        parts = m.group(1).split("/")
        if len(parts) >= 2:
            return f"{parts[-2]}/{parts[-1]}"

    parsed = urlparse(url)
    path = parsed.path.strip("/")
    parts = path.split("/")
    if len(parts) >= 2:
        return f"{parts[0]}/{parts[1]}"

    return None


def resolve_repo_nwo(repo_path: str) -> str | None:
    """Resolve owner/repo from git remote get-url origin."""
    proc = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        cwd=repo_path, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return None
    return parse_nwo_from_remote(proc.stdout)


def resolve_branch(worktree_path: str) -> str | None:
    """Get current branch name from a worktree."""
    proc = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=worktree_path, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout.strip()


def validate_gh_auth(nwos: set[str]) -> list[str]:
    """Check gh auth status. Returns sorted list of orgs with missing auth."""
    orgs = sorted({nwo.split("/")[0] for nwo in nwos if "/" in nwo})
    proc = subprocess.run(
        ["gh", "auth", "status"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return orgs
    return []


def _resolve_all_nwos(workspace: Workspace, workspace_root: str) -> dict[str, str]:
    """Resolve owner/repo for all workspace repos."""
    nwos: dict[str, str] = {}
    for repo in workspace.repos:
        repo_path = os.path.join(workspace_root, repo.path)
        nwo = resolve_repo_nwo(repo_path)
        if nwo:
            nwos[repo.name] = nwo
    return nwos


def _extract_pr_number(url: str) -> int | None:
    m = re.search(r"/pull/(\d+)", url)
    return int(m.group(1)) if m else None


def create_workspace_prs(
    manifest: dict,
    workspace: Workspace,
    nwos: dict[str, str],
    *,
    target_branch: str | None = None,
) -> None:
    """Create PRs for all completed children via gh pr create --repo.

    Mutates manifest children in place, adding pr_number, pr_url, nwo.
    Skips children that already have a PR or are not completed.
    """
    workspace_id = manifest["workspace_id"]
    workspace_name = manifest["workspace_name"]
    work_title = manifest.get("work_request", {}).get("title", "")

    ws_short = workspace_id.rsplit("_", 1)[-1] if "_" in workspace_id else workspace_id
    title = f"[workspace:{ws_short}] {work_title}" if work_title else f"[workspace:{ws_short}]"

    for child in manifest["children"]:
        if child["status"] != "completed":
            continue
        if child.get("pr_number"):
            continue

        repo_name = child["repo"]
        nwo = nwos.get(repo_name)
        if not nwo:
            continue

        worktree_path = child.get("worktree_path")
        if not worktree_path:
            continue

        branch = resolve_branch(worktree_path)
        if not branch:
            continue

        body = f"**Workspace:** {workspace_name} ({workspace_id})."

        cmd = [
            "gh", "pr", "create",
            "--repo", nwo,
            "--head", branch,
            "--title", title,
            "--body", body,
        ]
        if target_branch:
            cmd.extend(["--base", target_branch])

        proc = subprocess.run(
            cmd,
            capture_output=True, text=True,
        )

        if proc.returncode == 0:
            pr_url = proc.stdout.strip()
            child["pr_url"] = pr_url
            child["pr_number"] = _extract_pr_number(pr_url)
            child["nwo"] = nwo


def _invert_dependency_graph(workspace: Workspace) -> dict[str, list[str]]:
    """Build reverse map: repo -> repos that depend on it."""
    dependents: dict[str, list[str]] = {r.name: [] for r in workspace.repos}
    for repo in workspace.repos:
        for dep in repo.depends_on:
            if dep in dependents:
                dependents[dep].append(repo.name)
    return dependents


def build_dependency_comment(
    repo_name: str,
    all_pr_info: dict[str, dict],
    workspace: Workspace,
    workspace_id: str,
) -> str:
    """Build markdown dependency comment for a child PR."""
    dependents_map = _invert_dependency_graph(workspace)
    repo_info = {r.name: r for r in workspace.repos}
    repo = repo_info[repo_name]

    lines = [f"## Workspace: {workspace.name}"]

    if repo.depends_on:
        dep_refs = []
        for dep in repo.depends_on:
            pr = all_pr_info.get(dep)
            if pr and pr.get("nwo") and pr.get("pr_number"):
                dep_refs.append(f"{pr['nwo']}#{pr['pr_number']} (must merge first)")
            else:
                dep_refs.append(f"{dep} (no PR)")
        lines.append(f"**Depends on:** {', '.join(dep_refs)}")

    blocked = dependents_map.get(repo_name, [])
    if blocked:
        blocked_refs = []
        for b in blocked:
            pr = all_pr_info.get(b)
            if pr and pr.get("nwo") and pr.get("pr_number"):
                blocked_refs.append(f"{pr['nwo']}#{pr['pr_number']}")
            else:
                blocked_refs.append(b)
        lines.append(f"**Blocks:** {', '.join(blocked_refs)}")

    lines.append(f"**Workspace run:** `{workspace_id}`")

    return "\n".join(lines)


def post_dependency_comments(manifest: dict, workspace: Workspace) -> None:
    """Post dependency comments on each workspace PR via gh pr comment."""
    workspace_id = manifest["workspace_id"]

    all_pr_info: dict[str, dict] = {}
    for child in manifest["children"]:
        if child.get("pr_number"):
            all_pr_info[child["repo"]] = {
                "pr_number": child["pr_number"],
                "pr_url": child.get("pr_url"),
                "nwo": child.get("nwo"),
            }

    for child in manifest["children"]:
        if not child.get("pr_number") or not child.get("nwo"):
            continue

        comment = build_dependency_comment(
            child["repo"], all_pr_info, workspace, workspace_id,
        )

        subprocess.run(
            [
                "gh", "pr", "comment",
                str(child["pr_number"]),
                "--repo", child["nwo"],
                "--body", comment,
            ],
            capture_output=True, text=True,
        )


def build_umbrella_body(manifest: dict, workspace: Workspace) -> str:
    """Build umbrella issue body with PR checklist in merge order (tier order).

    `workspace` is kept in the signature for API compatibility — callers pass
    it but it's no longer needed since `role` was removed. Could be dropped
    in a follow-up.
    """
    _ = workspace  # unused; kept for callers
    work_title = manifest.get("work_request", {}).get("title", "Workspace changes")

    lines = [f"## Workspace PR Set: {work_title}", ""]

    tiers = manifest.get("dag", {}).get("tiers", [])
    for tier_info in tiers:
        for repo_name in tier_info.get("repos", []):
            child = next(
                (c for c in manifest["children"] if c["repo"] == repo_name),
                None,
            )
            if child and child.get("pr_url") and child.get("nwo") and child.get("pr_number"):
                lines.append(
                    f"- [ ] {child['nwo']}#{child['pr_number']} — {repo_name}"
                )

    return "\n".join(lines)


def create_umbrella_issue(manifest: dict, workspace: Workspace) -> dict | None:
    """Create umbrella issue with PR checklist. Returns {"url": ...} or None."""
    target_repo = workspace.umbrella_repo

    if not target_repo:
        tiers = manifest.get("dag", {}).get("tiers", [])
        if tiers and tiers[0].get("repos"):
            first_repo = tiers[0]["repos"][0]
            child = next(
                (c for c in manifest["children"] if c["repo"] == first_repo),
                None,
            )
            if child and child.get("nwo"):
                target_repo = child["nwo"]

    if not target_repo:
        return None

    work_title = manifest.get("work_request", {}).get("title", "coordinated changes")
    title = f"Workspace: {workspace.name} — {work_title}"
    body = build_umbrella_body(manifest, workspace)

    proc = subprocess.run(
        [
            "gh", "issue", "create",
            "--repo", target_repo,
            "--title", title,
            "--body", body,
        ],
        capture_output=True, text=True,
    )

    if proc.returncode == 0:
        return {"url": proc.stdout.strip()}

    return None


def link_workspace_prs(
    manifest: dict,
    workspace: Workspace,
    run_dir: str,
) -> dict:
    """Full PR linking flow: validate auth, create PRs, post comments, create umbrella.

    Returns the updated manifest with PR URLs and umbrella issue URL.
    Raises RuntimeError if GitHub auth is missing.
    """
    workspace_root = manifest["workspace_root"]

    nwos = _resolve_all_nwos(workspace, workspace_root)

    missing = validate_gh_auth(set(nwos.values()))
    if missing:
        raise RuntimeError(
            f"GitHub auth missing for orgs: {', '.join(missing)}. "
            f"Run: gh auth login"
        )

    target_branch = manifest.get("target_branch")
    create_workspace_prs(manifest, workspace, nwos, target_branch=target_branch)
    post_dependency_comments(manifest, workspace)

    umbrella = create_umbrella_issue(manifest, workspace)
    if umbrella:
        manifest["umbrella_issue"] = umbrella

    return manifest
