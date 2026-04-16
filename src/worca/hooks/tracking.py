"""Agent dispatch rules and Beads task sync for SubagentStart/Stop events.

Reads JSON from stdin with an event field.
- subagent_start: checks dispatch rules, exit code 0 = allow, 2 = block.
- subagent_stop: closes bead on success if bead_id is provided.
"""

import json
import os
import sys

DEFAULT_SUBAGENT_DISPATCH = {
    "planner": {"Explore"},
    "coordinator": set(),
    "implementer": {"Explore"},
    "tester": {"Explore"},
    "guardian": {"Explore"},
    "reviewer": {"Explore"},
    "plan_reviewer": {"Explore"},
    "learner": {"Explore"},
}

# Keep in sync with SUBAGENT_DENYLIST in
# worca-ui/app/views/dispatch-tag-state.js — the UI mirrors this to block the
# same types from being added via the settings editor.
_SUBAGENT_DENYLIST = frozenset({"general-purpose"})

# Cache is process-lifetime. Hook subprocesses are short-lived so staleness is
# not a concern in today's usage. If this module is ever imported from a
# long-running process (e.g. a daemon), call _reset_dispatch_cache() when
# settings.json changes or pass settings_override on every read.
_cached_rules: dict | None = None


def _reset_dispatch_cache() -> None:
    """Reset the cached dispatch rules (used in tests and after config changes)."""
    global _cached_rules
    _cached_rules = None


def _load_subagent_dispatch(settings_override: dict | None = None) -> dict:
    """Load subagent dispatch rules from settings, with default fallback.

    Args:
        settings_override: If provided, use this dict instead of loading from disk.
            The cache is bypassed when an override is given.
    """
    global _cached_rules
    if _cached_rules is not None and settings_override is None:
        return _cached_rules

    rules = {agent: set(allowed) for agent, allowed in DEFAULT_SUBAGENT_DISPATCH.items()}

    try:
        if settings_override is not None:
            raw_settings = settings_override
        else:
            raw_settings = _load_settings()

        user_dispatch = (
            raw_settings.get("worca", {})
            .get("governance", {})
            .get("subagent_dispatch", {})
        )

        for agent, allowed_list in user_dispatch.items():
            allowed = set(allowed_list)
            denied = allowed & _SUBAGENT_DENYLIST
            if denied:
                print(
                    f"[tracking] Warning: stripped denied subagent(s) {denied} "
                    f"from {agent} dispatch config",
                    file=sys.stderr,
                )
                allowed -= denied
            rules[agent] = allowed  # full replace per-agent key
    except FileNotFoundError:
        pass  # settings.json is optional; defaults apply silently
    except (json.JSONDecodeError, KeyError, TypeError, AttributeError) as e:
        print(
            f"[tracking] Warning: failed to load subagent_dispatch from settings "
            f"({type(e).__name__}: {e}); falling back to defaults",
            file=sys.stderr,
        )

    if settings_override is None:
        _cached_rules = rules
    return rules


def _load_settings() -> dict:
    """Load settings.json from the project root."""
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
    if not project_dir:
        import subprocess

        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            project_dir = result.stdout.strip()
    if not project_dir:
        return {}
    settings_path = os.path.join(project_dir, ".claude", "settings.json")
    if not os.path.exists(settings_path):
        return {}
    with open(settings_path) as f:
        return json.load(f)


def check_dispatch(parent_agent: str, child_agent: str) -> tuple:
    """Check if parent_agent is allowed to dispatch child_agent.

    Returns (0, "") for allowed, (2, reason) for blocked.
    Interactive mode (empty parent) allows all dispatches.
    Denylist check happens first — cannot be bypassed by config.
    """
    if not parent_agent:
        return (0, "")  # interactive mode, allow all

    if child_agent in _SUBAGENT_DENYLIST:
        return (2, f"Blocked: {child_agent} is on the subagent denylist")

    rules = _load_subagent_dispatch()
    allowed = rules.get(parent_agent, set())
    if child_agent in allowed:
        return (0, "")
    return (2, f"Blocked: {parent_agent} cannot dispatch {child_agent}")


def handle_agent_stop(agent_type: str, bead_id: str | None, success: bool) -> None:
    """Handle agent stop event. Close bead on success if bead_id is provided."""
    if success and bead_id:
        from worca.utils.beads import bd_close

        bd_close(bead_id)


def main():
    data = json.load(sys.stdin)
    event = data.get("event", "")
    if event == "subagent_start":
        parent = os.environ.get("WORCA_AGENT", "")
        child = data.get("agent_type", "")
        code, reason = check_dispatch(parent, child)
        if code != 0:
            print(reason, file=sys.stderr)
        sys.exit(code)
    elif event == "subagent_stop":
        agent_type = data.get("agent_type", "")
        bead_id = data.get("bead_id")
        success = data.get("success", False)
        handle_agent_stop(agent_type, bead_id, success)


if __name__ == "__main__":
    main()
