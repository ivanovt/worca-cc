"""worca pr — PR lifecycle commands.

Subcommands:
  create <run-id> [--project <path>] [--dry-run]
      Promote a deferred PR run to an open GitHub PR.

Algorithm (§4 of W-065):
  1. Resolve run worktree + status.json from the run-id.
  2. Validate deferred:true + required fields; idempotent exit if pr_url set.
  3. Check pr_creation lock staleness (5-min threshold).
  4. Reconcile via gh pr list --head <branch>.
  5. Claim lock + gh pr create from worktree (if no existing PR).
  6. Write pr_creation block + top-level pr_url on success.
  7. Write error on failure.
  8. Fire pipeline.git.pr_created event.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from worca.orchestrator.registry import get_pipeline

_LOCK_STALE_SECONDS = 300  # 5 minutes


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(ts: str) -> Optional[datetime]:
    try:
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def _load_status(status_path: str) -> dict:
    p = Path(status_path)
    if not p.exists():
        return {}
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def _save_status(status: dict, status_path: str) -> None:
    import tempfile

    p = Path(status_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".tmp_", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(status, f, indent=2)
            f.write("\n")
        os.replace(tmp, status_path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _resolve_status_path(worktree_path: str, run_id: Optional[str] = None) -> str:
    """Resolve status.json path for a worktree.

    Prefers the per-run path (<worca>/runs/<run_id>/status.json) when run_id
    is known — that is where the runner writes the final state. Falls back to
    the legacy flat path (<worca>/status.json) for older layouts.
    """
    worca_dir = os.path.join(worktree_path, ".worca")
    if run_id:
        candidate = os.path.join(worca_dir, "runs", run_id, "status.json")
        if os.path.exists(candidate):
            return candidate
    return os.path.join(worca_dir, "status.json")


def _run_pr_create(
    run_id: str,
    project: Optional[str],
    dry_run: bool,
    status_path: Optional[str] = None,
) -> int:
    """Core logic for `worca pr create`. Returns exit code (0 = success)."""
    # 1. Resolve run worktree and status.json
    base = os.path.join(project, ".worca") if project else None
    entry = get_pipeline(run_id, base=base) if base else get_pipeline(run_id)
    if not entry:
        print(f"error: run {run_id!r} not found in registry", file=sys.stderr)
        return 1

    worktree_path = entry.get("worktree_path") or project or "."
    if status_path is None:
        status_path = _resolve_status_path(worktree_path, run_id)

    status = _load_status(status_path)

    # 2a. Idempotent: pr_url already set
    if status.get("pr_url"):
        print(f"PR already exists: {status['pr_url']}")
        return 0

    # 2b. Validate deferred output
    pr_stage = status.get("stages", {}).get("pr", {})
    if not pr_stage.get("deferred"):
        print(
            f"error: run {run_id} does not have a deferred PR "
            "(stages.pr.deferred is not true)",
            file=sys.stderr,
        )
        return 1

    pr_title = pr_stage.get("pr_title", "")
    pr_body = pr_stage.get("pr_body", "")
    base_branch = pr_stage.get("base_branch", "")
    head_branch = pr_stage.get("source_branch") or status.get("branch", "")

    if not head_branch:
        print("error: cannot determine head branch from status.json", file=sys.stderr)
        return 1

    # 3. Check pr_creation lock staleness
    pr_creation = status.get("pr_creation") or {}
    if pr_creation.get("state") == "in_progress":
        started_at = _parse_iso(pr_creation.get("started_at", ""))
        if started_at is not None:
            age = datetime.now(timezone.utc) - started_at
            if age.total_seconds() < _LOCK_STALE_SECONDS:
                print(
                    f"error: PR creation already in_progress (started at "
                    f"{pr_creation['started_at']})",
                    file=sys.stderr,
                )
                return 1
        # stale lock — fall through and reclaim

    if dry_run:
        print("[dry-run] would create PR:")
        print(f"  base: {base_branch}")
        print(f"  head: {head_branch}")
        print(f"  title: {pr_title}")
        return 0

    # 4. Reconcile: check if PR already exists for this branch
    existing_url: Optional[str] = None
    existing_number: Optional[int] = None
    try:
        r = subprocess.run(
            ["gh", "pr", "list", "--head", head_branch, "--json", "number,url", "--limit", "1"],
            capture_output=True,
            text=True,
            cwd=worktree_path,
        )
        if r.returncode == 0 and r.stdout.strip():
            items = json.loads(r.stdout)
            if items:
                existing_url = items[0].get("url")
                existing_number = items[0].get("number")
    except (OSError, json.JSONDecodeError):
        pass  # gh not available or parse error; proceed to create

    started_at = _now_iso()

    if existing_url:
        # Reconcile — PR already exists, skip gh pr create
        pr_url = existing_url
        pr_number = existing_number
    else:
        # 5. Claim lock
        status["pr_creation"] = {"state": "in_progress", "started_at": started_at}
        _save_status(status, status_path)

        # Run gh pr create
        cmd = ["gh", "pr", "create", "--base", base_branch, "--head", head_branch,
               "--title", pr_title, "--body", pr_body]
        result = subprocess.run(cmd, capture_output=True, text=True, cwd=worktree_path)

        if result.returncode != 0:
            # 7. Write error
            status["pr_creation"] = {
                "state": "failed",
                "started_at": started_at,
                "completed_at": _now_iso(),
                "error": result.stderr.strip(),
            }
            _save_status(status, status_path)
            print(f"error: gh pr create failed:\n{result.stderr}", file=sys.stderr)
            return 1

        pr_url = result.stdout.strip()
        # Parse pr number from URL
        try:
            pr_number = int(pr_url.rstrip("/").rsplit("/", 1)[-1])
        except (ValueError, IndexError):
            pr_number = None

    # 6. Write success
    completed_at = _now_iso()

    # Provider parsed from the PR URL (github / gitlab / bitbucket / other).
    from worca.utils.pr_url import parse_pr_url

    provider = parse_pr_url(pr_url).get("provider")

    # Commit SHA: prefer the value the deferred stage recorded; otherwise read
    # the head branch tip from the worktree. The production deferred write does
    # not persist commit_sha to stages.pr, so the git fallback is the common
    # path here. Best-effort — an empty SHA just omits the Commit chip.
    commit_sha = pr_stage.get("commit_sha")
    if not commit_sha:
        try:
            r = subprocess.run(
                ["git", "-C", worktree_path, "rev-parse", head_branch],
                capture_output=True,
                text=True,
            )
            if r.returncode == 0:
                commit_sha = r.stdout.strip() or None
        except OSError:
            commit_sha = None

    status["pr_creation"] = {
        "state": "done",
        "started_at": started_at,
        "completed_at": completed_at,
        "pr_url": pr_url,
    }
    status["pr_url"] = pr_url
    # Populate the rich pr object the UI's run-detail strip reads (run.pr.*),
    # mirroring the normal guardian path in runner.py. Without this a deferred
    # PR created here renders a sparse 'PR' link with no number / provider /
    # commit / branch metadata. review_status is None — a freshly created PR
    # has no review yet (matches the normal path at creation time).
    status["pr"] = {
        "url": pr_url,
        "number": pr_number,
        "commit_sha": commit_sha,
        "source_branch": head_branch,
        "target_branch": base_branch,
        "provider": provider,
        "review_status": None,
    }
    _save_status(status, status_path)

    print(f"PR created: {pr_url}")

    # 8. Fire pipeline.git.pr_created event (best-effort)
    try:
        from worca.events.types import GIT_PR_CREATED, git_pr_created_payload
        from worca.events.emitter import EventContext, emit_event

        ctx = EventContext(
            run_id=run_id,
            log_path=os.path.join(worktree_path, ".worca", "events.jsonl"),
            project_path=worktree_path,
        )
        emit_event(
            ctx,
            GIT_PR_CREATED,
            git_pr_created_payload(
                pr_url=pr_url,
                pr_number=pr_number or 0,
                title=pr_title,
                commit_sha=commit_sha,
                source_branch=head_branch,
                target_branch=base_branch,
                provider=provider,
            ),
        )
    except Exception:
        pass  # event emission is best-effort; don't fail PR creation

    return 0


def cmd_pr(args) -> None:
    """Dispatch pr subcommands."""
    if args.pr_command == "create":
        rc = _run_pr_create(
            run_id=args.run_id,
            project=getattr(args, "project", None),
            dry_run=getattr(args, "dry_run", False),
        )
        raise SystemExit(rc)
    else:
        print("error: specify a subcommand, e.g. 'worca pr create <run-id>'", file=sys.stderr)
        raise SystemExit(1)


def register_subcommand(sub) -> None:
    """Register 'pr' subcommand group with 'create' verb."""
    pr_parser = sub.add_parser("pr", help="PR lifecycle commands")
    pr_sub = pr_parser.add_subparsers(dest="pr_command")

    create_parser = pr_sub.add_parser("create", help="Create a deferred PR")
    create_parser.add_argument("run_id", help="Run ID")
    create_parser.add_argument("--project", default=None, help="Project path")
    create_parser.add_argument(
        "--dry-run", action="store_true", default=False,
        help="Print what would happen without running gh"
    )
