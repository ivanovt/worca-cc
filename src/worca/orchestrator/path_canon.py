"""Path canonicalization and git oracle for file access telemetry.

Layer 1: canonicalize(raw, root) -> str | None
  Pure path math: realpath both sides, relpath + containment check, PurePath.as_posix().
  No git, deterministic, OS-critical for cross-platform consistency.

Layer 2: GitPathOracle
  Reads oracle from 'git ls-files -z'; writes oracle from 'git status --porcelain=v1 -z'.
  respell_read/respell_write: exact match → adopt git spelling, unique case-insensitive
  match → adopt + case_remapped flag, gitignored (writes only) → drop, untracked → keep + flag.
  Graceful degradation on git failure (oracle='degraded').
"""

import os
import subprocess
from pathlib import PurePath
from typing import Optional


def canonicalize(raw: str, root: str) -> Optional[str]:
    """Canonicalize a file path to repo-relative form.

    Layer 1: pure path math, deterministic, no git.
    - realpath() both sides (cancels symlinked repo root from common prefix)
    - relpath() + '..' check (repo containment test)
    - PurePath.as_posix() (normalize separators, preserve case)

    Args:
        raw: raw path (relative or absolute)
        root: repo root directory

    Returns:
        Canonicalized repo-relative path (forward slashes, posix normalized),
        or None if path is outside repo / different drive (Windows).
    """
    try:
        canonical_root = os.path.realpath(root)
        # Resolve absolute path
        if os.path.isabs(raw):
            abs_path = os.path.realpath(raw)
        else:
            abs_path = os.path.realpath(os.path.join(canonical_root, raw))

        # Compute relative path
        rel = os.path.relpath(abs_path, canonical_root)

        # Check for repo escape
        if rel == "." or rel.startswith(".."):
            return None

        # Normalize to posix format
        return PurePath(rel).as_posix()
    except (ValueError, OSError):
        # ValueError: Windows drive mismatch
        # OSError: path resolution failure
        return None


class GitPathOracle:
    """Layer 2: adopt git's exact spelling and filter to source files.

    Reads oracle from 'git ls-files -z' (all tracked files).
    Writes oracle from 'git status --porcelain=v1 -z' (changed source set).

    Respell rule (same for reads/writes, different oracle):
    1. Exact match → adopt git's spelling.
    2. Miss → unique case-insensitive match → adopt + case_remapped flag.
    3. Still miss → gitignored (writes only) → drop; untracked → keep + flag.

    On git failure, degrade gracefully: oracle='degraded', reads/writes empty.
    """

    def __init__(self, repo_root: str):
        """Initialize oracle by reading git ls-files and status.

        Args:
            repo_root: absolute path to git repository root
        """
        self.repo_root = repo_root
        self.oracle_status = "ok"

        # Maps: path (exact) → canonical git spelling
        self.reads: dict[str, str] = {}
        self.writes: dict[str, str] = {}

        # Maps: path (lowercased) → canonical git spelling (for case-insensitive lookup)
        self.reads_lower: dict[str, str] = {}
        self.writes_lower: dict[str, str] = {}

        # Build the oracles
        self._build_reads_oracle()
        self._build_writes_oracle()

    def _build_reads_oracle(self) -> None:
        """Build reads oracle from 'git ls-files -z'."""
        try:
            result = subprocess.run(
                ["git", "-c", "core.quotepath=false", "ls-files", "-z"],
                cwd=self.repo_root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=5,
            )
            if result.returncode != 0:
                self.oracle_status = "degraded"
                return

            # NUL-separated paths
            for path in result.stdout.split("\0"):
                if path:  # Skip trailing empty string from final NUL
                    self.reads[path] = path
                    lower = path.lower()
                    # Detect case-insensitive collisions: if the lowercased key already exists
                    # with a different exact-case path, mark it as None (collision sentinel)
                    if lower in self.reads_lower and self.reads_lower[lower] != path:
                        self.reads_lower[lower] = None
                    elif lower not in self.reads_lower:
                        self.reads_lower[lower] = path
        except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError):
            self.oracle_status = "degraded"

    def _build_writes_oracle(self) -> None:
        """Build writes oracle from 'git status --porcelain=v1 -z'."""
        try:
            result = subprocess.run(
                ["git", "-c", "core.quotepath=false", "status", "--porcelain=v1", "-z"],
                cwd=self.repo_root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=5,
            )
            if result.returncode != 0:
                self.oracle_status = "degraded"
                return

            # NUL-separated status entries; renames/copies appear as "XY old\0new\0"
            entries = result.stdout.split("\0")
            i = 0
            while i < len(entries):
                entry = entries[i]
                if not entry:
                    i += 1
                    continue

                # Check for rename/copy: "R  " or "C  " at start
                if len(entry) > 3 and entry[0] in ("R", "C") and entry[1:3] == "  ":
                    # Format: "R  old_path\0new_path\0"
                    # The new path is the next entry; store it in the writes oracle
                    if i + 1 < len(entries):
                        new_path = entries[i + 1]
                        if new_path:  # Ensure new_path is not empty
                            self.writes[new_path] = new_path
                            lower = new_path.lower()
                            if lower in self.writes_lower and self.writes_lower[lower] != new_path:
                                self.writes_lower[lower] = None
                            elif lower not in self.writes_lower:
                                self.writes_lower[lower] = new_path
                        i += 2  # Skip both old and new paths
                        continue

                # Regular entry: "XY path" (exactly 3 chars for XY and space, then path)
                if len(entry) > 3:
                    path = entry[3:]
                    self.writes[path] = path
                    lower = path.lower()
                    # Detect case-insensitive collisions: if the lowercased key already exists
                    # with a different exact-case path, mark it as None (collision sentinel)
                    if lower in self.writes_lower and self.writes_lower[lower] != path:
                        self.writes_lower[lower] = None
                    elif lower not in self.writes_lower:
                        self.writes_lower[lower] = path

                i += 1
        except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError):
            self.oracle_status = "degraded"

    def respell_read(self, path: str) -> dict:
        """Re-spell a read path using the reads oracle.

        Returns:
            {
                "path": str | None (canonicalized git spelling or Layer 1 form),
                "case_remapped": bool (True if case-insensitive match was used),
                "untracked": bool (True if path is not in git, kept for reads)
            }
        """
        # Exact match
        if path in self.reads:
            return {
                "path": self.reads[path],
                "case_remapped": False,
                "untracked": False,
            }

        # Case-insensitive match (only if unique: not None sentinel)
        lower = path.lower()
        if lower in self.reads_lower and self.reads_lower[lower] is not None:
            return {
                "path": self.reads_lower[lower],
                "case_remapped": True,
                "untracked": False,
            }

        # Not in git → keep as untracked (reads don't filter)
        return {
            "path": path,
            "case_remapped": False,
            "untracked": True,
        }

    def respell_write(self, path: str) -> dict:
        """Re-spell a write path using the writes oracle (includes gitignore filtering).

        Returns:
            {
                "path": str | None (canonicalized git spelling or Layer 1 form),
                "case_remapped": bool (True if case-insensitive match was used),
                "untracked": bool (True if file is new/untracked),
                "gitignored": bool (True if file matches .gitignore)
            }
        """
        # Exact match
        if path in self.writes:
            return {
                "path": self.writes[path],
                "case_remapped": False,
                "untracked": False,
                "gitignored": False,
            }

        # Case-insensitive match (only if unique: not None sentinel)
        lower = path.lower()
        if lower in self.writes_lower and self.writes_lower[lower] is not None:
            return {
                "path": self.writes_lower[lower],
                "case_remapped": True,
                "untracked": False,
                "gitignored": False,
            }

        # Not in git status → check if gitignored or untracked
        # We distinguish by checking if it's in .gitignore
        is_gitignored = self._is_path_gitignored(path)

        if is_gitignored:
            return {
                "path": None,
                "case_remapped": False,
                "untracked": False,
                "gitignored": True,
            }

        # Untracked new file
        return {
            "path": path,
            "case_remapped": False,
            "untracked": True,
            "gitignored": False,
        }

    def _is_path_gitignored(self, path: str) -> bool:
        """Check if a path matches .gitignore (but is not tracked).

        Uses 'git check-ignore' to determine if a path is ignored.
        """
        try:
            result = subprocess.run(
                ["git", "check-ignore", "-q", path],
                cwd=self.repo_root,
                capture_output=True,
                timeout=5,
            )
            # Exit code 0 means matched gitignore
            return result.returncode == 0
        except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError):
            # If git check-ignore fails, assume not ignored (conservative)
            return False
