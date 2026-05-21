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
from worca.hooks.tracking import ConfigUnreadable, check_allowed

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

    # Fail closed on unresolvable skill name (only for governed agents).
    # If the Claude Code PreToolUse payload schema ever renames the skill
    # field, _extract_skill_name returns "" and check_allowed under a
    # wildcard would otherwise *allow* an unknown skill — the opposite of
    # what governance is meant to do. Interactive (no WORCA_AGENT) passes
    # through.
    if parent and not skill:
        if emit_from_hook:
            emit_from_hook("pipeline.hook.dispatch_blocked", {
                "agent": parent,
                "section": "skills",
                "candidate": "",
                "reason": "skill_name_unresolved",
            })
        print(
            "Blocked: could not extract skill name from PreToolUse payload — "
            "fail-closed (check Claude Code Skill payload schema)",
            file=sys.stderr,
        )
        sys.exit(2)

    try:
        allowed, reason, via = check_allowed("skills", parent, skill)
    except ConfigUnreadable as e:
        # Fail-closed: settings.json present but unparseable. Falling back to
        # defaults would silently widen permissions under the new dispatch
        # model (defaults are wildcard-allow). Block the dispatch instead.
        if emit_from_hook:
            emit_from_hook("pipeline.hook.dispatch_blocked", {
                "agent": parent,
                "section": "skills",
                "candidate": skill,
                "reason": "config_unreadable",
            })
        print(
            f"Blocked: settings.json malformed — pipeline runtime cannot "
            f"evaluate dispatch governance. Fix and retry. ({e})",
            file=sys.stderr,
        )
        sys.exit(2)
    if not allowed:
        if emit_from_hook:
            emit_from_hook("pipeline.hook.dispatch_blocked", {
                "agent": parent,
                "section": "skills",
                "candidate": skill,
                "reason": reason,
            })
        print(f"Blocked: skill '{skill}' is not allowed for {parent or 'this agent'} ({reason})",
              file=sys.stderr)
        sys.exit(2)

    if parent and emit_from_hook:
        emit_from_hook("pipeline.hook.dispatch_allowed", {
            "agent": parent,
            "section": "skills",
            "candidate": skill,
            "via": via,
        })
    sys.exit(0)


if __name__ == "__main__":
    main()
