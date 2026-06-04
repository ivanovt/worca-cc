# /// script
# requires-python = ">=3.8"
# ///
"""PostToolUse hook: runs test_gate and links bd create to pipeline runs."""
import json
import re
import subprocess
import sys
import os
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

try:
    from worca.hooks.test_gate import check_test_gate, _state as _test_gate_state
except ImportError:
    sys.exit(0)

try:
    from worca.events.hook_emitter import emit_from_hook
except ImportError:
    emit_from_hook = None

try:
    from worca.utils.settings import load_settings
except ImportError:
    load_settings = None


def _is_file_access_enabled():
    """Check if file access recording is enabled via settings."""
    if not load_settings:
        return True  # Default to enabled if we can't load settings
    project_root = os.environ.get("WORCA_PROJECT_ROOT", ".")
    try:
        settings_path = os.path.join(project_root, ".claude", "settings.json")
        settings = load_settings(settings_path)
        return (
            settings.get("worca", {})
            .get("telemetry", {})
            .get("file_access", {})
            .get("enabled", True)
        )
    except Exception:
        return True  # Default to enabled if we can't load settings


def _get_access_dir():
    """Get the access directory for the current run."""
    run_id = os.environ.get("WORCA_RUN_ID")
    if not run_id:
        return None
    project_root = os.environ.get("WORCA_PROJECT_ROOT", ".")
    return os.path.join(project_root, ".worca", "runs", run_id, "access")


def _count_grep_results(output):
    """Count the number of matching lines in grep output."""
    if not output:
        return 0
    lines = output.strip().split("\n")
    return len([line for line in lines if line.strip()])


def _record_file_access(tool_name, tool_input, tool_response):
    """Record file access for reads, writes, and searches."""
    # Check if file access recording is enabled
    if not _is_file_access_enabled():
        return

    # Only record specific tools
    if tool_name not in ("Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Grep", "Glob"):
        return

    run_id = os.environ.get("WORCA_RUN_ID")
    stage = os.environ.get("WORCA_STAGE")
    iteration = os.environ.get("WORCA_ITERATION")
    bead_id = os.environ.get("WORCA_BEAD_ID")

    # Skip if required env vars are missing
    if not (run_id and stage and iteration):
        return

    access_dir = _get_access_dir()
    if not access_dir:
        return

    # Create the access directory if it doesn't exist
    try:
        Path(access_dir).mkdir(parents=True, exist_ok=True)
    except Exception:
        return

    # Build the filename
    if bead_id:
        filename = f"{stage}-{iteration}-{bead_id}.jsonl"
    else:
        filename = f"{stage}-{iteration}.jsonl"

    filepath = os.path.join(access_dir, filename)

    # Build the record based on tool type
    ts = datetime.utcnow().isoformat() + "Z"
    record = {"ts": ts, "tool": tool_name}

    if tool_name in ("Read",):
        record["op"] = "read"
        record["path"] = tool_input.get("file_path", "")

    elif tool_name in ("Write", "Edit"):
        record["op"] = "write"
        record["path"] = tool_input.get("file_path", "")

    elif tool_name == "MultiEdit":
        record["op"] = "write"
        record["path"] = tool_input.get("file_path", "")

    elif tool_name == "NotebookEdit":
        record["op"] = "write"
        record["path"] = tool_input.get("notebook_path", "")

    elif tool_name in ("Grep", "Glob"):
        record["op"] = "search"
        record["pattern"] = tool_input.get("pattern", "")
        # For Grep, use path; for Glob, use path
        record["scope"] = tool_input.get("path", "")

        # Capture filter dimensions (glob/type for Grep, glob for Glob)
        filter_obj = {}
        if tool_name == "Grep":
            if "glob" in tool_input:
                filter_obj["glob"] = tool_input["glob"]
            if "type" in tool_input:
                filter_obj["type"] = tool_input["type"]
        elif tool_name == "Glob":
            if "glob" in tool_input:
                filter_obj["glob"] = tool_input["glob"]
        if filter_obj:
            record["filter"] = filter_obj

        # Extract result count from response
        if tool_name in ("Grep", "Glob"):
            output = tool_response.get("output", "")
            record["result_count"] = _count_grep_results(output)

    # Append the record to the JSONL file
    try:
        with open(filepath, "a", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(record, separators=(",", ":")) + "\n")
    except Exception:
        pass


def _link_bd_create_to_run(tool_name, tool_input, tool_response):
    """After a successful bd create, add a run label to link it to the current run.

    When WORCA_RUN_ID is set (pipeline is running), any successful `bd create`
    output is parsed for the issue ID, then `bd label add` tags it with
    ``run:<run_id>`` so multiple beads can share the same run reference.
    Also emits a bead.created event via hook_emitter for each created bead.
    """
    if tool_name != "Bash":
        return
    run_id = os.environ.get("WORCA_RUN_ID")
    if not run_id:
        return
    command = tool_input.get("command", "")
    if "bd create" not in command:
        return
    stdout = tool_response.get("stdout", "")
    exit_code = tool_response.get("exit_code", 1)
    if exit_code != 0:
        return
    # Match all created issue IDs (may be multiple in chained commands)
    for match in re.finditer(r"Created issue:\s+(\S+)", stdout):
        issue_id = match.group(1)
        subprocess.run(
            ["bd", "label", "add", issue_id, f"run:{run_id}"],
            capture_output=True, text=True
        )
        try:
            from worca.events.hook_emitter import emit_from_hook
            emit_from_hook("pipeline.bead.created", {"bead_id": issue_id, "run_label": f"run:{run_id}"})
        except Exception:
            pass


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})
    tool_response = data.get("tool_response", {})

    # Record file access (reads, writes, searches)
    _record_file_access(tool_name, tool_input, tool_response)

    # Link bd create issues to the current pipeline run
    _link_bd_create_to_run(tool_name, tool_input, tool_response)

    # Test gate check
    exit_code = tool_response.get("exit_code", data.get("exit_code", 0))
    code, reason = check_test_gate(tool_name, tool_input, exit_code)
    if code != 0:
        if emit_from_hook:
            emit_from_hook("pipeline.hook.test_gate", {
                "agent": os.environ.get("WORCA_AGENT", ""),
                "strike": _test_gate_state["strikes"],
                "action": "block",
            })
        print(reason, file=sys.stderr)
    elif reason:
        print(reason, file=sys.stderr)
    sys.exit(code)


if __name__ == "__main__":
    main()
