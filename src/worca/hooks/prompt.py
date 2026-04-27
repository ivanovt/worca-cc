"""UserPromptSubmit hook: Milestone approval gates.

Checks pipeline status to determine if approval is needed before proceeding.
Reads status from WORCA_STATUS_FILE env var (default: .worca/status.json).
Exit code 0 = pass through. Prints approval prompt to stdout when gate is active.
"""
import json
import sys
import os

# Cache: pid → status_path. Avoids rescanning on every tool call (hot path).
_pid_cache: dict = {}


def _find_status_by_pid(worca_dir: str = ".worca") -> str | None:
    """Return the status.json path whose pipeline.pid matches the current PID.

    Results are cached by PID so repeated calls within the same process skip
    the directory scan entirely.
    """
    pid = os.getpid()
    if pid in _pid_cache:
        return _pid_cache[pid]
    runs_dir = os.path.join(worca_dir, "runs")
    if not os.path.isdir(runs_dir):
        return None
    for run_id in os.listdir(runs_dir):
        pid_file = os.path.join(runs_dir, run_id, "pipeline.pid")
        try:
            with open(pid_file) as f:
                stored_pid = int(f.read().strip())
            if stored_pid == pid:
                status_path = os.path.join(runs_dir, run_id, "status.json")
                _pid_cache[pid] = status_path
                return status_path
        except (OSError, ValueError):
            continue
    return None


def load_status() -> dict | None:
    """Load pipeline status from the status file.

    Tries PID matching against runs/*/pipeline.pid first (cached), then falls
    back to WORCA_STATUS_FILE env var or .worca/status.json.
    Returns the parsed status dict, or None if the file doesn't exist.
    """
    status_path = _find_status_by_pid()
    if status_path and os.path.exists(status_path):
        try:
            with open(status_path) as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            pass

    # Fall back to env var or default
    status_file = os.environ.get("WORCA_STATUS_FILE", ".worca/status.json")
    if not os.path.exists(status_file):
        return None
    try:
        with open(status_file, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def check_milestone(status: dict | None) -> tuple:
    """Check if a milestone gate should inject an approval prompt.

    Returns (exit_code, message). exit_code is always 0.
    message is non-empty when a gate is active.
    """
    if status is None:
        return (0, "")

    stage = status.get("stage", "")
    milestones = status.get("milestones", {})

    if stage == "plan" and milestones.get("plan_approved") is None:
        plan_file = status.get("plan_file", "MASTER_PLAN.md")
        return (0, "MILESTONE GATE: Review {} and approve the plan before implementation begins.".format(plan_file))

    if stage == "review" and milestones.get("pr_approved") is None:
        return (0, "MILESTONE GATE: Review the PR and approve before merge.")

    return (0, "")


def main():
    status = load_status()
    code, message = check_milestone(status)
    if message:
        print(message)
    sys.exit(code)


if __name__ == "__main__":
    main()
