#!/usr/bin/env python3
"""Sync a GitHub PR into a target worca-cc repo and start a project-scoped UI.

Usage:
    python sync_pr.py /path/to/target 43
    python sync_pr.py /path/to/target gh:pr:43
    python sync_pr.py /path/to/target https://github.com/owner/repo/pull/43
    python sync_pr.py /path/to/target 43 --clean
"""
import argparse
import os
import re
import subprocess
import sys
from pathlib import Path


def parse_pr_ref(ref: str) -> str:
    """Extract PR number from various formats.

    Accepts: '43', '#43', 'gh:pr:43', 'https://github.com/owner/repo/pull/43'
    Returns the bare number as a string.
    """
    ref = ref.strip()

    # Full GitHub URL
    m = re.match(r"https?://github\.com/[^/]+/[^/]+/pull/(\d+)", ref)
    if m:
        return m.group(1)

    # gh:pr:N
    m = re.match(r"gh:pr:(\d+)", ref)
    if m:
        return m.group(1)

    # #N or bare N
    m = re.match(r"#?(\d+)$", ref)
    if m:
        return m.group(1)

    print(f"error: cannot parse PR reference: {ref}", file=sys.stderr)
    print("  accepted formats: 43, #43, gh:pr:43, https://github.com/.../pull/43", file=sys.stderr)
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
        description="Sync a GitHub PR into a target repo and start project-scoped worca-ui",
    )
    parser.add_argument("target", help="Path to target worca-cc repo")
    parser.add_argument("pr", help="PR reference (43, #43, gh:pr:43, or full GitHub URL)")
    parser.add_argument("--clean", action="store_true",
                        help="Discard local changes in target before checkout")
    args = parser.parse_args()

    target = Path(args.target).resolve()
    pr_number = parse_pr_ref(args.pr)

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

    # --- Step 3: Checkout the PR ---
    print(f"\n[3/6] Checking out PR #{pr_number}")
    run(["gh", "pr", "checkout", pr_number], cwd=str(target))

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
    branch = subprocess.run(
        ["git", "-C", str(target), "branch", "--show-current"],
        capture_output=True, text=True,
    )
    print(f"\n{'=' * 60}")
    print(f"  PR:      #{pr_number}")
    print(f"  Branch:  {branch.stdout.strip()}")
    print(f"  Target:  {target}")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
