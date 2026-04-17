# /// script
# requires-python = ">=3.8"
# ///
"""SubagentStart hook: enforces agent dispatch rules."""
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from worca.hooks.tracking import check_dispatch

try:
    from worca.events.hook_emitter import emit_from_hook
except ImportError:
    emit_from_hook = None


def _role_from_worca_agent(raw: str) -> str:
    """Extract the bare agent role from a WORCA_AGENT env value.

    The env value is "{stage}-{agent}-iter-{N}" (e.g. "implement-implementer-iter-2").
    Mirrors the helper in worca.hooks.guard. Without this normalization, the
    dispatch-rule lookup fails because rules are keyed on bare agent names.
    """
    if not raw:
        return ""
    base = raw.rsplit("-iter-", 1)[0] if "-iter-" in raw else raw
    parts = base.split("-")
    return parts[-1] if parts else raw


def main():
    data = json.load(sys.stdin)
    parent = _role_from_worca_agent(os.environ.get("WORCA_AGENT", ""))
    child = data.get("agent_type", "")

    code, reason = check_dispatch(parent, child)
    if code != 0:
        if emit_from_hook:
            emit_from_hook("pipeline.hook.dispatch_blocked", {
                "agent": parent,
                "subagent_type": child,
                "reason": reason,
            })
        print(reason, file=sys.stderr)
    elif parent and emit_from_hook:
        emit_from_hook("pipeline.hook.dispatch_allowed", {
            "agent": parent,
            "subagent_type": child,
        })
    sys.exit(code)


if __name__ == "__main__":
    main()
