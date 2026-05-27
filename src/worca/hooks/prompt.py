"""UserPromptSubmit hook: Milestone approval gates.

Checks pipeline status to determine if approval is needed before proceeding.

Status discovery order:
  1. $WORCA_RUN_DIR/status.json — set by run_pipeline.py for the current run
     (the production path; this is the runner→hook contract since W-048).
  2. $WORCA_STATUS_FILE — explicit override path (used by tests and unusual
     deployments where the runner can't set WORCA_RUN_DIR).

If neither is set or readable, the hook returns no status and no gate fires.
Exit code 0 = pass through. Prints approval prompt to stdout when gate is active.
"""
import json
import sys
import os


def load_status() -> dict | None:
    """Load pipeline status for the run that this hook process belongs to.

    Returns the parsed status dict, or None if no readable status file is found.
    """
    run_dir = os.environ.get("WORCA_RUN_DIR")
    if run_dir:
        path = os.path.join(run_dir, "status.json")
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    return json.load(f)
            except (OSError, json.JSONDecodeError):
                pass

    override = os.environ.get("WORCA_STATUS_FILE")
    if override and os.path.exists(override):
        try:
            with open(override, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return None

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
