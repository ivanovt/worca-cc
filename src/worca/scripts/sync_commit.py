#!/usr/bin/env python3
"""Sync a specific commit or branch into a target worca-cc repo and start a project-scoped UI.

Usage:
    python sync_commit.py /path/to/target abc1234          # specific commit
    python sync_commit.py /path/to/target master           # latest on branch
    python sync_commit.py /path/to/target feature/foo      # latest on branch
    python sync_commit.py /path/to/target abc1234 --clean
"""
import argparse
import os
import re
import subprocess
import sys
from pathlib import Path


def is_sha(ref: str) -> bool:
    """Check if ref looks like a hex SHA (7-40 chars)."""
    return bool(re.fullmatch(r"[0-9a-fA-F]{7,40}", ref))


def validate_ref(ref: str, target: str) -> tuple[str, bool]:
    """Validate a commit-ish reference against the target repo.

    Returns (ref, is_branch) where is_branch is True if ref is a branch name.
    """
    ref = ref.strip()

    if is_sha(ref):
        # Verify the commit exists in the repo
        result = subprocess.run(
            ["git", "-C", target, "cat-file", "-t", ref],
            capture_output=True, text=True,
        )
        if result.returncode != 0 or result.stdout.strip() != "commit":
            print(f"error: commit {ref} not found in {target}", file=sys.stderr)
            print("  try running 'git fetch' in the target repo first", file=sys.stderr)
            raise SystemExit(1)
        return ref, False

    # Treat as branch name — verify it exists
    result = subprocess.run(
        ["git", "-C", target, "rev-parse", "--verify", f"refs/heads/{ref}"],
        capture_output=True, text=True,
    )
    if result.returncode == 0:
        return ref, True

    print(f"error: '{ref}' is not a valid commit SHA or local branch name", file=sys.stderr)
    print("  accepted formats: commit SHA (abc1234) or branch name (master, feature/foo)", file=sys.stderr)
    raise SystemExit(1)


def run(cmd: list[str], cwd: str | None = None, check: bool = True,
        env: dict | None = None) -> subprocess.CompletedProcess:
    """Run a command, printing it first."""
    print(f"  $ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=env)
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.returncode != 0 and check:
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)
        print(f"error: command failed with exit code {result.returncode}", file=sys.stderr)
        raise SystemExit(result.returncode)
    return result


def main():
    parser = argparse.ArgumentParser(
        description="Sync a specific commit into a target repo and start project-scoped worca-ui",
    )
    parser.add_argument("target", help="Path to target worca-cc repo")
    parser.add_argument("ref", help="Commit SHA (abc1234) or branch name (master, feature/foo)")
    parser.add_argument("--clean", action="store_true",
                        help="Discard local changes in target before checkout")
    args = parser.parse_args()

    target = Path(args.target).resolve()

    # --- Step 1: Validate target ---
    print(f"\n[1/6] Validating target: {target}")
    if not target.is_dir():
        print(f"error: target directory does not exist: {target}", file=sys.stderr)
        raise SystemExit(1)

    result = subprocess.run(
        ["git", "-C", str(target), "rev-parse", "--show-toplevel"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"error: target is not a git repository: {target}", file=sys.stderr)
        raise SystemExit(1)
    print(f"  target OK: {target}")

    # --- Step 2: Check git state / clean ---
    print("\n[2/6] Checking git state")
    status = subprocess.run(
        ["git", "-C", str(target), "status", "--porcelain"],
        capture_output=True, text=True,
    )
    dirty = status.stdout.strip()
    if dirty:
        if args.clean:
            print("  dirty working tree — cleaning (--clean)")
            run(["git", "checkout", "."], cwd=str(target))
            run(["git", "clean", "-fd"], cwd=str(target))
        else:
            print("error: target has uncommitted changes:", file=sys.stderr)
            print(dirty, file=sys.stderr)
            print("\nuse --clean to discard them", file=sys.stderr)
            raise SystemExit(1)
    else:
        print("  working tree clean")

    # --- Step 3: Validate ref & checkout ---
    ref, is_branch = validate_ref(args.ref, str(target))

    if is_branch:
        print(f"\n[3/6] Checking out branch: {ref}")
        run(["git", "checkout", ref], cwd=str(target))
    else:
        print(f"\n[3/6] Checking out commit {ref}")
        # Find branches containing this commit
        branch_result = subprocess.run(
            ["git", "-C", str(target), "branch", "--contains", ref, "--format=%(refname:short)"],
            capture_output=True, text=True,
        )
        branch_name = None
        if branch_result.returncode == 0 and branch_result.stdout.strip():
            candidates = [b.strip() for b in branch_result.stdout.strip().splitlines() if b.strip()]
            if len(candidates) == 1:
                branch_name = candidates[0]
            elif len(candidates) > 1:
                print("  commit exists on multiple branches:")
                for i, b in enumerate(candidates, 1):
                    print(f"    {i}) {b}")
                print(f"    {len(candidates) + 1}) detached HEAD (no branch)")
                try:
                    choice = input(f"  pick a branch [1-{len(candidates) + 1}]: ").strip()
                    idx = int(choice) - 1
                    if 0 <= idx < len(candidates):
                        branch_name = candidates[idx]
                    elif idx == len(candidates):
                        branch_name = None
                    else:
                        print("  invalid choice, falling back to detached HEAD")
                except (ValueError, EOFError):
                    print("  no input, falling back to detached HEAD")

        if branch_name:
            print(f"  checking out branch: {branch_name}")
            run(["git", "checkout", branch_name], cwd=str(target))
        else:
            print("  checking out in detached HEAD")
            run(["git", "checkout", ref], cwd=str(target))

    # --- Step 4: Build worca-ui ---
    print("\n[4/6] Building worca-ui")
    ui_dir = target / "worca-ui"
    if not ui_dir.is_dir():
        print(f"  warning: {ui_dir} not found, skipping UI build")
    else:
        run(["npm", "run", "build"], cwd=str(ui_dir))

    # --- Step 5: Sync Python runtime ---
    print("\n[5/6] Syncing Python runtime (worca init --upgrade)")
    init_env = {**os.environ, "PYTHONPATH": str(target / "src")}
    run(
        [sys.executable, "-m", "worca.cli.main", "init", "--upgrade", "--source", str(target)],
        cwd=str(target),
        env=init_env,
    )

    # --- Step 6: Start project-scoped worca-ui ---
    print("\n[6/6] Starting project-scoped worca-ui")
    ui_bin = target / "worca-ui" / "bin" / "worca-ui.js"
    if not ui_bin.is_file():
        print(f"  warning: {ui_bin} not found, skipping UI start")
    else:
        run(["node", str(ui_bin), "start", "--project", str(target), "--open"])

    # --- Summary ---
    current_branch = subprocess.run(
        ["git", "-C", str(target), "branch", "--show-current"],
        capture_output=True, text=True,
    )
    head_rev = subprocess.run(
        ["git", "-C", str(target), "rev-parse", "--short", "HEAD"],
        capture_output=True, text=True,
    )
    print(f"\n{'=' * 60}")
    print(f"  Ref:     {ref}")
    print(f"  HEAD:    {head_rev.stdout.strip()}")
    branch_str = current_branch.stdout.strip()
    if branch_str:
        print(f"  Branch:  {branch_str}")
    else:
        print("  Note:    repo is in detached HEAD state")
    print(f"  Target:  {target}")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
