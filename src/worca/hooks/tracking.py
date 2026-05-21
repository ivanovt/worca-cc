"""Agent dispatch rules and Beads task sync for SubagentStart/Stop events.

Reads JSON from stdin with an event field.
- subagent_start: checks dispatch rules, exit code 0 = allow, 2 = block.
- subagent_stop: closes bead on success if bead_id is provided.
"""

import json
import os
import sys

# Literal sentinel that means "lock this agent out — allow nothing".
# Used as the sole entry of a per_agent_allow list, e.g. ["none"]. Any other
# combination treats "none" as just a tool/skill/subagent name (it won't match
# anything real). Empty list [] falls through to _defaults instead.
LOCKDOWN_SENTINEL = "none"

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

# In-process cache for resolved dispatch sections. Each entry is keyed by section
# and stores (resolved_dict, settings_mtime). On every read we re-stat
# settings.json — if its mtime changed the cache is invalidated automatically.
# This keeps the cache useful for repeated reads in a single process while
# never serving stale config to long-running orchestrator runs that span a
# settings.json edit.
_cached_sections: dict[str, tuple[dict, float | None]] = {}


def _reset_dispatch_cache() -> None:
    """Reset the cached dispatch sections (used in tests and after config changes)."""
    _cached_sections.clear()


def _settings_path() -> str | None:
    """Return the absolute path to settings.json, or None if it can't be located."""
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
        return None
    return os.path.join(project_dir, ".claude", "settings.json")


def _load_settings() -> dict:
    """Load settings.json from the project root."""
    path = _settings_path()
    if not path or not os.path.exists(path):
        return {}
    with open(path) as f:
        return json.load(f)


def _settings_mtime() -> float | None:
    """Return settings.json mtime, or None if not stat-able. Used for cache invalidation."""
    path = _settings_path()
    if not path:
        return None
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


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

    Results are cached in-process per section, keyed by settings.json mtime —
    if the file changes on disk the next read transparently picks up the new
    config. ``settings_override`` bypasses the cache (used by tests and any
    caller that needs a fresh read against a synthetic config).
    """
    if settings_override is None:
        cached = _cached_sections.get(section)
        current_mtime = _settings_mtime()
        if cached is not None and cached[1] == current_mtime:
            return cached[0]

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
        _cached_sections[section] = (resolved, _settings_mtime())
    return resolved


def resolve_per_agent_entry(cfg: dict, agent: str) -> list[str]:
    """Resolve the effective per_agent_allow entry for an agent.

    Fall-through rules:
      * Missing key for ``agent``     → use ``_defaults``.
      * Empty list ``[]`` for ``agent`` → fall through to ``_defaults`` too,
        because clearing the chip list in the UI shouldn't silently brick
        an agent. To express lockdown, set the entry to ``[LOCKDOWN_SENTINEL]``.

    The returned list may still contain ``"*"``, named entries, or be
    ``[LOCKDOWN_SENTINEL]`` — callers interpret those.
    """
    entry = cfg["per_agent_allow"].get(agent)
    if not entry:  # None or [] both fall through
        entry = list(cfg["per_agent_allow"].get("_defaults", []))
    return list(entry)


def is_lockdown(entry: list[str]) -> bool:
    """True iff ``entry`` is the lockdown sentinel (exactly ``[LOCKDOWN_SENTINEL]``)."""
    return entry == [LOCKDOWN_SENTINEL]


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

    entry = resolve_per_agent_entry(cfg, agent)

    if is_lockdown(entry):
        return (False, "lockdown", None)

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
