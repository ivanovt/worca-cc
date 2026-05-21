# /// script
# requires-python = ">=3.8"
# ///
"""SubagentStart hook: enforces agent dispatch rules."""
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


def main():
    data = json.load(sys.stdin)
    parent = role_from_worca_agent(os.environ.get("WORCA_AGENT", ""))
    child = data.get("agent_type", "")

    try:
        allowed, reason, via = check_allowed("subagents", parent, child)
    except ConfigUnreadable as e:
        # Fail-closed: settings.json present but unparseable. Falling back to
        # defaults would silently widen permissions under the new dispatch
        # model (defaults are wildcard-allow). Block the dispatch instead.
        if emit_from_hook:
            emit_from_hook("pipeline.hook.dispatch_blocked", {
                "agent": parent,
                "section": "subagents",
                "candidate": child,
                "reason": "config_unreadable",
            })
        print(
            f"Blocked: settings.json malformed — pipeline runtime cannot "
            f"evaluate dispatch governance. Fix and retry. ({e})",
            file=sys.stderr,
        )
        sys.exit(2)
    if not allowed:
        if reason == "always_disallowed":
            msg = f"Blocked: {child} is on the subagent denylist"
        else:
            msg = f"Blocked: {parent} cannot dispatch {child}"
        if emit_from_hook:
            emit_from_hook("pipeline.hook.dispatch_blocked", {
                "agent": parent,
                "section": "subagents",
                "candidate": child,
                "reason": msg,
            })
        print(msg, file=sys.stderr)
        sys.exit(2)
    else:
        if parent and emit_from_hook:
            payload = {
                "agent": parent,
                "section": "subagents",
                "candidate": child,
            }
            if via:
                payload["via"] = via
            emit_from_hook("pipeline.hook.dispatch_allowed", payload)
        sys.exit(0)


if __name__ == "__main__":
    main()
