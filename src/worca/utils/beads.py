"""Wrapper for the bd (beads) CLI. All functions run bd as a subprocess."""

import logging
import os
import re
import signal
import subprocess
import time
from pathlib import Path
from typing import Optional

from worca.utils.env import get_env

logger = logging.getLogger(__name__)

# Polling budget for waiting on SIGTERM'd daemon to exit before falling
# through (or escalating in the future).  ~1s total, 50ms granularity.
_SIGTERM_WAIT_INTERVAL_S = 0.05
_SIGTERM_WAIT_ITERATIONS = 20

_DAEMON_STOPPED_SENTINEL = "daemon.stopped"


def _write_stop_sentinel(beads_dir: str) -> None:
    """Best-effort write of the deliberate-stop sentinel."""
    try:
        Path(beads_dir, _DAEMON_STOPPED_SENTINEL).touch()
    except OSError:
        pass


def _resolve_workspace_dir(beads_dir: str) -> str:
    workspace_dir = os.path.dirname(beads_dir) or beads_dir
    if not os.path.isdir(workspace_dir):
        workspace_dir = beads_dir
    return workspace_dir


def _wait_for_pid_exit(pid: int) -> bool:
    """Poll os.kill(pid, 0) until ProcessLookupError or budget exhausted.

    Returns True if the process exited within the budget, False otherwise.
    """
    for _ in range(_SIGTERM_WAIT_ITERATIONS):
        try:
            os.kill(pid, 0)
        except (ProcessLookupError, ValueError):
            return True
        except PermissionError:
            # PID was reused by another user — treat as gone.
            return True
        time.sleep(_SIGTERM_WAIT_INTERVAL_S)
    return False


def _run_bd(*args: str, beads_dir: Optional[str] = None, cwd: Optional[str] = None) -> subprocess.CompletedProcess:
    """Run a bd CLI command and return the CompletedProcess."""
    overrides = {"BEADS_DIR": beads_dir} if beads_dir else {}
    return subprocess.run(["bd", *args], capture_output=True, text=True, env=get_env(**overrides), cwd=cwd)


def bd_create(title: str, task_type: str = "task", priority: int = 2) -> str:
    """Create a new bead/issue via bd create.

    Returns the created issue ID parsed from stdout.
    Raises RuntimeError on failure.
    """
    result = _run_bd(
        "create",
        f"--title={title}",
        f"--type={task_type}",
        f"--priority={priority}",
    )
    if result.returncode != 0:
        raise RuntimeError(f"bd create failed: {result.stderr}")
    # Parse issue ID from output like "Created ccexperiments-abc: My task"
    match = re.search(r"Created\s+(\S+):", result.stdout)
    if not match:
        raise RuntimeError(f"Could not parse issue ID from: {result.stdout}")
    return match.group(1)


def bd_ready(label: str | None = None) -> list[dict]:
    """List ready issues via bd ready.

    Parses numbered-list output like:
        📋 Ready work (1 issues with no blockers):
        1. [● P4] [task] worca-cc-a27: test parsing output

    Args:
        label: If provided, pass --label to scope results (e.g. "run:xxx").

    Returns list of dicts with id, title, priority, type.
    """
    args = ["ready"]
    if label:
        args.extend(["--label", label])
    result = _run_bd(*args)
    if not result.stdout.strip():
        return []
    items = []
    # Match lines like: 1. [● P2] [task] worca-cc-744: Server: add queries
    pattern = re.compile(
        r'^\s*\d+\.\s+'           # row number: "1. "
        r'\[[^\]]*P(\d+)\]\s+'    # priority bracket: "[● P2] "
        r'\[(\w+)\]\s+'           # type bracket: "[task] "
        r'(\S+?):\s+'             # bead ID up to colon: "worca-cc-a27: "
        r'(.+)$'                  # title (rest of line)
    )
    for line in result.stdout.strip().split("\n"):
        m = pattern.match(line)
        if m:
            items.append({
                "id": m.group(3),
                "title": m.group(4).strip(),
                "priority": m.group(1),
                "type": m.group(2),
            })
    return items


def bd_show(issue_id: str) -> dict:
    """Fetch full details for a bead via bd show.

    Parses bd show output to extract title, description, priority, type, and status.
    Returns a dict with those fields. Raises RuntimeError on failure.
    """
    result = _run_bd("show", issue_id)
    if result.returncode != 0:
        raise RuntimeError(f"bd show failed for {issue_id}: {result.stderr}")
    output = result.stdout
    info: dict = {"id": issue_id, "title": "", "description": "", "priority": "", "type": "", "status": ""}

    # Parse title from header line like: "○ worca-cc-a27 · test parsing output   [● P4 · OPEN]"
    header_match = re.search(r'·\s+(.+?)\s+\[', output)
    if header_match:
        info["title"] = header_match.group(1).strip()

    # Parse priority from bracket like "[● P2 · OPEN]"
    prio_match = re.search(r'\[.*?P(\d+).*?\]', output)
    if prio_match:
        info["priority"] = prio_match.group(1)

    # Parse status from bracket like "[● P2 · OPEN]" or "[● P2 · IN_PROGRESS]"
    status_match = re.search(r'·\s+(\w+)\s*\]', output)
    if status_match:
        info["status"] = status_match.group(1).lower()

    # Parse DESCRIPTION section: everything between "DESCRIPTION" line and next section header or end
    desc_match = re.search(r'^DESCRIPTION\s*\n(.*?)(?=^[A-Z]{2,}\s*$|\Z)', output, re.DOTALL | re.MULTILINE)
    if desc_match:
        info["description"] = desc_match.group(1).strip()

    return info


def bd_close(issue_id: str, reason: str = "") -> bool:
    """Close an issue via bd close.

    Returns True on success, False on failure.
    """
    args = ["close", issue_id]
    if reason:
        args.append(f"--reason={reason}")
    result = _run_bd(*args)
    return result.returncode == 0


def bd_update(issue_id: str, **kwargs) -> bool:
    """Update an issue via bd update with kwargs as flags.

    Returns True on success, False on failure.
    """
    args = ["update", issue_id]
    for key, value in kwargs.items():
        args.append(f"--{key}={value}")
    result = _run_bd(*args)
    return result.returncode == 0


def bd_label_add(issue_ids: list[str], label: str) -> bool:
    """Add a label to one or more issues via bd label add.

    Returns True on success, False on failure.
    """
    if not issue_ids:
        return True
    result = _run_bd("label", "add", *issue_ids, label)
    return result.returncode == 0


def bd_dep_add(issue_id: str, depends_on: str) -> bool:
    """Add a dependency via bd dep add.

    Returns True on success, False on failure.
    """
    result = _run_bd("dep", "add", issue_id, depends_on)
    return result.returncode == 0


def bd_daemon_stop(beads_dir: str, timeout: float = 2.0) -> bool:
    """Stop the bd daemon for the given beads_dir.

    Two-phase stop:
    1. Run `bd daemon stop` with cwd=beads_dir's parent so bd resolves the
       worktree's workspace (BEADS_DIR alone is unreliable; bd resolves the
       "current workspace" from cwd).  Bounded by `timeout` seconds.
    2. On timeout or non-zero exit, fall back to SIGTERM via daemon.pid.
       Probes the recorded PID is alive before signalling (PID reuse guard),
       then polls briefly for exit so callers can rely on FDs being released
       before they touch the worktree (e.g. git worktree remove).

    All failures are best-effort — logged and swallowed. Returns True if the
    daemon was stopped (either phase succeeded), False otherwise.
    """
    # Phase 1: bd daemon stop, scoped to the worktree via cwd.  We point cwd
    # at the parent of .beads/ (the workspace root) since `bd` walks up from
    # cwd to locate the workspace.  Fall back to beads_dir itself if the
    # parent is missing (defensive — should not happen in practice).
    workspace_dir = _resolve_workspace_dir(beads_dir)
    try:
        result = subprocess.run(
            ["bd", "daemon", "stop"],
            capture_output=True,
            text=True,
            env=get_env(BEADS_DIR=beads_dir),
            cwd=workspace_dir,
            timeout=timeout,
        )
        if result.returncode == 0:
            _write_stop_sentinel(beads_dir)
            return True
    except subprocess.TimeoutExpired:
        logger.warning("bd daemon stop timed out for %s, falling back to SIGTERM", beads_dir)
    except OSError as exc:
        logger.warning("bd daemon stop OSError for %s: %s", beads_dir, exc)

    # Phase 2: SIGTERM from pidfile.  Probe liveness first so we don't
    # deliver SIGTERM to an unrelated process that has reused the PID.
    pidfile = os.path.join(beads_dir, "daemon.pid")
    try:
        with open(pidfile, encoding="utf-8") as fh:
            pid = int(fh.read().strip())
    except (FileNotFoundError, ValueError):
        logger.warning("No daemon pidfile at %s", pidfile)
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        logger.warning("bd daemon PID already dead (pidfile: %s)", pidfile)
        return False
    except OSError as exc:
        # Includes PermissionError (PID owned by another user) and other
        # platform-specific failures.  We cannot signal it; give up.
        logger.warning(
            "bd daemon PID %d not signallable (pidfile: %s, err: %s)", pid, pidfile, exc
        )
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except (ProcessLookupError, ValueError):
        # Race: process exited between liveness probe and SIGTERM,
        # or signal unsupported on this platform (Windows).
        _write_stop_sentinel(beads_dir)
        return True
    except OSError as exc:
        logger.warning("SIGTERM to bd daemon failed for %s: %s", beads_dir, exc)
        return False
    # Wait briefly for the daemon to release its FDs before returning.
    # Caller (e.g. remove_pipeline_worktree) immediately invokes git worktree
    # remove --force afterwards; without this poll we race the daemon's
    # shutdown and may keep deleted-file handles around.
    if not _wait_for_pid_exit(pid):
        logger.warning("bd daemon PID %d did not exit within wait budget", pid)
    _write_stop_sentinel(beads_dir)
    return True


def bd_daemon_status(beads_dir: str) -> bool | None:
    """Check if the bd daemon is running for the given beads_dir.

    Returns True if running, False if not running, None on error.
    """
    workspace_dir = _resolve_workspace_dir(beads_dir)
    try:
        result = subprocess.run(
            ["bd", "daemon", "status"],
            capture_output=True,
            text=True,
            env=get_env(BEADS_DIR=beads_dir),
            cwd=workspace_dir,
            timeout=5.0,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        return None


def bd_daemon_start(beads_dir: str, timeout: float = 5.0) -> bool:
    """Start the bd daemon for the given beads_dir.

    Clears any deliberate-stop sentinel so bd_daemon_ensure will keep
    the daemon alive on subsequent calls.

    Returns True on success, False on failure.
    """
    sentinel = os.path.join(beads_dir, _DAEMON_STOPPED_SENTINEL)
    try:
        os.remove(sentinel)
    except FileNotFoundError:
        pass

    workspace_dir = _resolve_workspace_dir(beads_dir)
    try:
        result = subprocess.run(
            ["bd", "daemon", "start"],
            capture_output=True,
            text=True,
            env=get_env(BEADS_DIR=beads_dir),
            cwd=workspace_dir,
            timeout=timeout,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.warning("bd daemon start failed for %s: %s", beads_dir, exc)
        return False


def bd_daemon_ensure(beads_dir: str) -> bool:
    """Ensure the bd daemon is running, unless it was deliberately stopped.

    Probes `bd daemon status` first. The sentinel file written by
    bd_daemon_stop only blocks auto-start; if the daemon is already running
    (e.g. started manually outside worca after a previous stop), this
    reports it as up regardless of the sentinel.

    Returns True if the daemon is running, False otherwise.
    """
    status = bd_daemon_status(beads_dir)
    if status is True:
        return True
    if status is None:
        return False

    sentinel = os.path.join(beads_dir, _DAEMON_STOPPED_SENTINEL)
    if os.path.exists(sentinel):
        return False

    return bd_daemon_start(beads_dir)


_EFFORT_LEVELS = frozenset({"low", "medium", "high", "xhigh", "max"})
_EFFORT_LABEL_PREFIX = "worca-effort:"


def bd_get_effort_label(bead_id: str) -> Optional[str]:
    """Extract the effort level from a bead's worca-effort:* label.

    Returns the level string (e.g. "high") or None if missing/invalid.
    """
    result = _run_bd("show", bead_id)
    if result.returncode != 0:
        return None
    label_match = re.search(r'^LABELS:\s*(.+)$', result.stdout, re.MULTILINE)
    if not label_match:
        return None
    for label in label_match.group(1).split(","):
        label = label.strip()
        if label.startswith(_EFFORT_LABEL_PREFIX):
            level = label[len(_EFFORT_LABEL_PREFIX):]
            if level in _EFFORT_LEVELS:
                return level
    return None


def bd_init(cwd: Optional[str] = None) -> bool:
    """Initialize beads in a directory via bd init.

    Runs `bd init` in the specified working directory (or current dir if None).
    Returns True on success, False on failure.
    Catches subprocess errors gracefully (e.g. bd not on PATH, invalid cwd).
    """
    try:
        result = _run_bd("init", cwd=cwd)
        return result.returncode == 0
    except (subprocess.SubprocessError, OSError):
        return False
