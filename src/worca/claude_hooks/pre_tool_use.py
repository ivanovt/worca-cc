# /// script
# requires-python = ">=3.8"
# ///
"""PreToolUse hook: runs guard and plan_check."""
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

try:
    from worca.hooks.guard import check_guard
    from worca.hooks.plan_check import check_plan
    from worca.hooks.graphify_nudge import graphify_nudge_context
except ImportError:
    # Worca package not available — allow all operations
    sys.exit(0)

try:
    from worca.events.hook_emitter import emit_from_hook
except ImportError:
    emit_from_hook = None


def _needs_cwd_fix(tool_name, tool_input):
    """Check if this Bash command needs a project root cd prefix.

    Returns the modified command string, or None if no fix needed.
    When WORCA_PROJECT_ROOT is set (by the pipeline runner), every Bash
    command is prefixed with `cd $root &&` so that agent `cd` commands
    cannot permanently shift the working directory and break subsequent
    commands and hooks.
    """
    if tool_name != "Bash":
        return None
    project_root = os.environ.get("WORCA_PROJECT_ROOT")
    if not project_root:
        return None
    command = tool_input.get("command", "")
    if not command:
        return None
    # Don't double-prefix if already starts with cd to the project root
    if command.startswith(f"cd {project_root}"):
        return None
    return f"cd {project_root} && {command}"


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})

    command_modified = False

    # Check if we need to fix the cwd for this command
    fixed_command = _needs_cwd_fix(tool_name, tool_input)
    if fixed_command is not None:
        tool_input["command"] = fixed_command
        command_modified = True

    # Guard check first
    code, reason = check_guard(tool_name, tool_input)
    if code != 0:
        if emit_from_hook:
            emit_from_hook("pipeline.hook.blocked", {
                "agent": os.environ.get("WORCA_AGENT", ""),
                "tool": tool_name,
                "reason": reason,
            })
        print(reason, file=sys.stderr)
        sys.exit(code)

    # Plan check second
    code, reason = check_plan(tool_name, tool_input)
    if code != 0:
        print(reason, file=sys.stderr)
        sys.exit(code)

    # Advisory, non-blocking graphify nudge: when an agent runs a broad code
    # search and a graph is ready, suggest a scoped `graphify query` instead.
    try:
        nudge = graphify_nudge_context(tool_name, tool_input)
    except Exception:
        nudge = None

    # Emit a single PreToolUse decision carrying any cwd-fix (updatedInput)
    # and/or the nudge (additionalContext). Both are "allow".
    if command_modified or nudge:
        hook_output = {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
        }
        if command_modified:
            hook_output["updatedInput"] = {"command": tool_input["command"]}
        if nudge:
            hook_output["additionalContext"] = nudge
        print(json.dumps({"hookSpecificOutput": hook_output}))

    sys.exit(0)


if __name__ == "__main__":
    main()
