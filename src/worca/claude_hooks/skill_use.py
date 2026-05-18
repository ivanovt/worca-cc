# /// script
# requires-python = ">=3.8"
# ///
"""PreToolUse hook for Skill: enforces skill dispatch governance.

Exit code 0 = allow, exit code 2 = block (reason on stderr).
"""
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from worca.hooks.agent_role import role_from_worca_agent
from worca.hooks.tracking import check_allowed

try:
    from worca.events.hook_emitter import emit_from_hook
except ImportError:
    emit_from_hook = None


def _extract_skill_name(tool_input: dict) -> str:
    """Extract skill name from tool_input, checking skill_name then name."""
    return tool_input.get("skill_name") or tool_input.get("name") or ""


def main():
    data = json.load(sys.stdin)
    tool_input = data.get("tool_input", {})
    skill = _extract_skill_name(tool_input)
    parent = role_from_worca_agent(os.environ.get("WORCA_AGENT", ""))

    allowed, reason, via = check_allowed("skills", parent, skill)
    if not allowed:
        if emit_from_hook:
            emit_from_hook("pipeline.hook.skill_blocked", {
                "agent": parent,
                "skill": skill,
                "reason": reason,
            })
        print(f"Blocked: skill '{skill}' is not allowed for {parent or 'this agent'} ({reason})",
              file=sys.stderr)
        sys.exit(2)

    if parent and emit_from_hook:
        emit_from_hook("pipeline.hook.skill_allowed", {
            "agent": parent,
            "skill": skill,
            "via": via,
        })
    sys.exit(0)


if __name__ == "__main__":
    main()
