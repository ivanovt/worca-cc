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

_DISPATCH_DEFAULTS = {
    "tools": {
        "always_disallowed": ["EnterPlanMode", "EnterWorktree", "TodoWrite"],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["*"]},
    },
    "skills": {
        "always_disallowed": [
            "batch",
            "fewer-permission-prompts",
            "loop",
            "schedule",
            "worca-*",
            "update-config",
            "hookify:hookify",
            "hookify:configure",
            "hookify:list",
            "hookify:writing-rules",
            "init",
        ],
        "default_denied": [
            "claude-api",
            "debug",
            "review",
            "security-review",
            "simplify",
            "feature-dev:feature-dev",
            "claude-md-management:revise-claude-md",
            "claude-md-management:claude-md-improver",
        ],
        "per_agent_allow": {
            "_defaults": ["*"],
            "implementer": ["*", "simplify", "claude-api"],
            "tester": ["*", "debug"],
            "reviewer": ["*", "review", "security-review"],
            "learner": [
                "*",
                "claude-md-management:revise-claude-md",
                "claude-md-management:claude-md-improver",
            ],
        },
    },
    "subagents": {
        "always_disallowed": ["general-purpose"],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["*"]},
    },
}

# Cache is process-lifetime, keyed by section. Hook subprocesses are short-lived
# so staleness is not a concern in today's usage. If this module is ever imported
# from a long-running process (e.g. a daemon), call _reset_dispatch_cache() when
# settings.json changes or pass settings_override on every read (which bypasses
# the cache).
_cached_sections: dict[str, dict] = {}


def _reset_dispatch_cache() -> None:
    """Reset the cached dispatch sections (used in tests and after config changes)."""
    _cached_sections.clear()


def _load_subagent_dispatch(settings_override: dict | None = None) -> dict:
    """Back-compat shim for the legacy subagent-only dispatch loader.

    The current implementation routes everything through ``_load_dispatch_section``
    + ``check_allowed``. This helper is kept so older imports and tests still
    work; it returns ``{agent_role: set(allowed_subagents)}`` derived from the
    `subagents` section's `per_agent_allow` plus `DEFAULT_SUBAGENT_DISPATCH`
    fallback for any role the user hasn't enumerated.

    Accepts both the legacy ``governance.subagent_dispatch`` shape and the
    current ``governance.dispatch.subagents.per_agent_allow`` shape so callers
    that still hand-build settings dicts don't have to migrate.
    """
    rules = {agent: set(allowed) for agent, allowed in DEFAULT_SUBAGENT_DISPATCH.items()}

    try:
        raw_settings = (
            settings_override if settings_override is not None else _load_settings()
        )
    except FileNotFoundError:
        return rules  # settings.json is optional; defaults apply silently

    try:
        legacy = (
            raw_settings.get("worca", {})
            .get("governance", {})
            .get("subagent_dispatch", {})
        )
        if not isinstance(legacy, dict):
            raise TypeError(f"subagent_dispatch must be a dict, got {type(legacy).__name__}")

        if legacy:
            translated = {
                "worca": {
                    "governance": {
                        "dispatch": {
                            "subagents": {"per_agent_allow": legacy},
                        },
                    },
                },
            }
            cfg = _load_dispatch_section("subagents", translated)
        else:
            cfg = _load_dispatch_section("subagents", settings_override)

        for agent, allowed_list in cfg["per_agent_allow"].items():
            if agent == "_defaults":
                continue
            try:
                allowed = {x for x in allowed_list if x != "*"}
            except TypeError as e:
                print(
                    f"[tracking] Warning: malformed allowed list for {agent} "
                    f"({type(e).__name__}: {e}); falling back to defaults",
                    file=sys.stderr,
                )
                continue
            denied = allowed & _SUBAGENT_DENYLIST
            if denied:
                print(
                    f"[tracking] Warning: stripped denied subagent(s) {denied} "
                    f"from {agent} dispatch config",
                    file=sys.stderr,
                )
                allowed -= denied
            rules[agent] = allowed
    except (json.JSONDecodeError, KeyError, TypeError, AttributeError) as e:
        print(
            f"[tracking] Warning: failed to load subagent_dispatch from settings "
            f"({type(e).__name__}: {e}); falling back to defaults",
            file=sys.stderr,
        )

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


def _matches_any(candidate: str, patterns: list[str]) -> bool:
    """Check if candidate matches any pattern in the list.

    Supported: exact match, trailing-* prefix glob, bare '*' (matches all).
    """
    for pattern in patterns:
        if pattern == candidate:
            return True
        if pattern == "*":
            return True
        if pattern.endswith("*") and len(pattern) > 1 and candidate.startswith(pattern[:-1]):
            return True
    return False


def _load_dispatch_section(section: str, settings_override: dict | None = None) -> dict:
    """Load worca.governance.dispatch.{tools,skills,subagents}.

    Returns the normalized section dict with all three tiers populated.

    Results are cached process-lifetime per section. The cache is bypassed
    when ``settings_override`` is supplied (used by tests and any caller that
    needs a fresh read against a synthetic config).
    """
    if settings_override is None and section in _cached_sections:
        return _cached_sections[section]

    settings = settings_override if settings_override is not None else _load_settings()
    raw = (
        settings
        .get("worca", {})
        .get("governance", {})
        .get("dispatch", {})
        .get(section, {})
    )
    defaults = _DISPATCH_DEFAULTS[section]
    resolved = {
        "always_disallowed": list(raw.get("always_disallowed", defaults["always_disallowed"])),
        "default_denied": list(raw.get("default_denied", defaults["default_denied"])),
        "per_agent_allow": {**defaults["per_agent_allow"], **raw.get("per_agent_allow", {})},
    }

    if settings_override is None:
        _cached_sections[section] = resolved
    return resolved


def check_allowed(
    section: str,
    agent: str,
    candidate: str,
    *,
    settings_override: dict | None = None,
) -> tuple:
    """Returns (allowed: bool, reason: str, via: 'wildcard'|'explicit'|None)."""
    if not agent:
        return (True, "ok", None)

    cfg = _load_dispatch_section(section, settings_override)

    if _matches_any(candidate, cfg["always_disallowed"]):
        return (False, "always_disallowed", None)

    entry = cfg["per_agent_allow"].get(
        agent, cfg["per_agent_allow"].get("_defaults", []),
    )
    has_wildcard = "*" in entry
    explicit = {x for x in entry if x != "*"}

    if has_wildcard:
        if candidate in explicit:
            return (True, "ok", "explicit")
        if _matches_any(candidate, cfg["default_denied"]):
            return (False, "default_denied", None)
        return (True, "ok", "wildcard")
    else:
        if candidate in explicit:
            return (True, "ok", "explicit")
        return (False, "not_in_allow_list", None)


def check_dispatch(parent_agent: str, child_agent: str) -> tuple:
    """Check if parent_agent is allowed to dispatch child_agent.

    Returns (0, "") for allowed, (2, reason) for blocked.
    Thin shim over check_allowed('subagents', ...).
    """
    if not parent_agent:
        return (0, "")

    allowed, reason, via = check_allowed("subagents", parent_agent, child_agent)
    if allowed:
        return (0, "")
    if reason == "always_disallowed":
        return (2, f"Blocked: {child_agent} is on the subagent denylist")
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
