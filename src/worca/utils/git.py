"""Git and worktree operations. All functions run git as a subprocess."""

import os
import subprocess

from worca.utils.beads import bd_init
from worca.utils.env import get_env


def _run_git(*args: str) -> subprocess.CompletedProcess:
    """Run a git command and return the CompletedProcess."""
    return subprocess.run(["git", *args], capture_output=True, text=True, env=get_env())


def create_branch(name: str) -> bool:
    """Create and switch to a new branch.

    Runs: git checkout -b {name}
    Returns True on success, False on failure.
    """
    result = _run_git("checkout", "-b", name)
    return result.returncode == 0


def create_worktree(path: str, branch: str) -> bool:
    """Create a new git worktree with a new branch.

    Runs: git worktree add {path} -b {branch}
    Returns True on success, False on failure.
    """
    result = _run_git("worktree", "add", path, "-b", branch)
    return result.returncode == 0


def remove_worktree(path: str) -> bool:
    """Remove a git worktree.

    Runs: git worktree remove {path}
    Returns True on success, False on failure.
    """
    result = _run_git("worktree", "remove", path)
    return result.returncode == 0


def current_branch() -> str:
    """Get the current branch name.

    Runs: git rev-parse --abbrev-ref HEAD
    Returns the branch name string.
    """
    result = _run_git("rev-parse", "--abbrev-ref", "HEAD")
    return result.stdout.strip()


def get_current_git_head() -> str:
    """Get the current git HEAD commit SHA.

    Runs: git rev-parse HEAD
    Returns the full SHA string, or empty string on failure.
    """
    result = _run_git("rev-parse", "HEAD")
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def detect_default_branch() -> str:
    """Return the repo's default branch.

    Probes in order:
    1. `git symbolic-ref refs/remotes/origin/HEAD` (the upstream-configured
       default — the canonical answer for any cloned repo).
    2. `git rev-parse --abbrev-ref HEAD` (the current local branch — covers
       repos with no upstream, e.g. fresh `git init`).
    3. The literal string "HEAD" — never errors when passed to
       `git worktree add`, lets git itself choose the working tree's commit.
    """
    result = _run_git("symbolic-ref", "refs/remotes/origin/HEAD")
    if result.returncode == 0:
        ref = result.stdout.strip()
        prefix = "refs/remotes/origin/"
        if ref.startswith(prefix):
            return ref[len(prefix):]

    result = _run_git("rev-parse", "--abbrev-ref", "HEAD")
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()

    return "HEAD"


def branch_exists(ref: str) -> bool:
    """True when `ref` resolves to a commit in the current repo.

    Cheap existence check via `git rev-parse --verify --quiet`; returns
    False for empty/None input without invoking git.
    """
    if not ref:
        return False
    result = _run_git("rev-parse", "--verify", "--quiet", ref)
    return result.returncode == 0


def create_pipeline_worktree(
    run_id: str,
    slug: str,
    base_branch: str = "HEAD",
    base_dir: str = ".worktrees",
) -> str:
    """Create a worktree for a pipeline run.

    Creates worktree at {base_dir}/pipeline-{run_id} with branch
    worca/{slug}-{run_id}, based on the given base_branch.

    base_dir defaults to ".worktrees" (in-repo). Absolute paths and
    paths starting with "~" are accepted; relative paths resolve from
    the current working directory (the project root).

    Returns the absolute worktree path on success, empty string on failure.
    """
    branch = f"worca/{slug}-{run_id}"
    base = os.path.expanduser(base_dir)
    path = os.path.join(base, f"pipeline-{run_id}")
    if os.path.isabs(base):
        os.makedirs(base, exist_ok=True)
    result = _run_git("worktree", "add", "-b", branch, path, base_branch)
    if result.returncode != 0:
        return ""
    return os.path.abspath(path)


def remove_pipeline_worktree(worktree_path: str) -> bool:
    """Remove a pipeline worktree and delete its associated branch.

    Detects the branch from the worktree, removes the worktree with --force,
    then deletes the branch with git branch -D.

    Returns True if both operations succeed, False otherwise.
    """
    # Detect branch from worktree HEAD before removal
    branch = ""
    head_path = os.path.join(worktree_path, ".git")
    if os.path.isfile(head_path):
        # Worktree .git is a file pointing to the main repo's worktree dir.
        # Use rev-parse inside the worktree to find the branch.
        rev_result = subprocess.run(
            ["git", "-C", worktree_path, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, env=get_env(),
        )
        if rev_result.returncode == 0:
            branch = rev_result.stdout.strip()

    # Remove the worktree
    result = _run_git("worktree", "remove", "--force", worktree_path)
    if result.returncode != 0:
        return False

    # Delete the branch
    if branch and branch != "HEAD":
        br_result = _run_git("branch", "-D", branch)
        if br_result.returncode != 0:
            return False

    return True


def _is_pipeline_worktree(entry: dict) -> bool:
    """True when a `git worktree list` entry was created by run_worktree.py.

    Identified by `pipeline-` basename or `worca/` branch prefix — covers
    both the default `.worktrees/` location and any user-configured
    worktree base dir.
    """
    path = entry.get("path", "")
    if os.path.basename(path).startswith("pipeline-"):
        return True
    branch = entry.get("branch", "")
    return branch.startswith("worca/")


def list_pipeline_worktrees() -> list[dict]:
    """List pipeline worktrees from git worktree list --porcelain.

    Returns a list of dicts with keys: path, branch, commit.
    Includes any worktree created by run_worktree.py regardless of the
    configured worktree base dir (matches `pipeline-<runid>` basename
    or `worca/...` branch).
    """
    result = _run_git("worktree", "list", "--porcelain")
    if result.returncode != 0:
        return []

    worktrees: list[dict] = []
    current: dict = {}
    for line in result.stdout.splitlines():
        if line.startswith("worktree "):
            current = {"path": line[len("worktree "):]}
        elif line.startswith("HEAD "):
            current["commit"] = line[len("HEAD "):]
        elif line.startswith("branch "):
            # refs/heads/worca/slug-runid -> worca/slug-runid
            ref = line[len("branch "):]
            if ref.startswith("refs/heads/"):
                ref = ref[len("refs/heads/"):]
            current["branch"] = ref
        elif line == "":
            if current and "path" in current and _is_pipeline_worktree(current):
                worktrees.append(current)
            current = {}
    # Handle trailing entry without final blank line
    if current and "path" in current and _is_pipeline_worktree(current):
        worktrees.append(current)

    return worktrees


def diff_stat(base: str = "main") -> str:
    """Get diff stat between base branch and HEAD.

    Runs: git diff --stat {base}..HEAD
    Returns the diff stat output string.
    """
    result = _run_git("diff", "--stat", f"{base}..HEAD")
    return result.stdout


def init_worktree_beads(worktree_path: str) -> bool:
    """Initialize beads in a worktree directory.

    Convenience function that runs `bd init` inside the given worktree path.
    Intended to be called after worktree creation to set up per-worktree
    beads tracking.

    Returns True on success, False on failure.
    """
    return bd_init(cwd=worktree_path)
