"""The shipped permissions.allow list must grant the native Glob/Grep tools.

The allowlist has always carried the Bash equivalents (Bash(grep:*), Bash(rg:*),
Bash(find:*)) and Read(*), but omitted the native Glob/Grep tools. Top-level
agents run with --dangerously-skip-permissions so they never hit it, but
dispatched subagents do NOT inherit that bypass — they are bound by
permissions.allow, so their Glob/Grep calls are denied while Read + Bash(grep/
find) still work. A planner that delegates codebase research to a subagent then
watches it limp (Glob/Grep denied) and thrashes. This test ties the shipped
allowlist to the native search tools so the gap can't silently reopen.
"""
import json
import os

import worca

SETTINGS_PATH = os.path.join(os.path.dirname(worca.__file__), "settings.json")


def _allow_list():
    with open(SETTINGS_PATH, encoding="utf-8") as f:
        settings = json.load(f)
    return settings.get("permissions", {}).get("allow", [])


def test_permissions_allow_includes_native_glob():
    allow = _allow_list()
    assert "Glob" in allow, (
        "permissions.allow does not grant the native Glob tool; subagents bound "
        f"by the allowlist get Glob denied. allow={allow}"
    )


def test_permissions_allow_includes_native_grep():
    allow = _allow_list()
    assert "Grep" in allow, (
        "permissions.allow does not grant the native Grep tool; subagents bound "
        f"by the allowlist get Grep denied. allow={allow}"
    )


def test_permissions_allow_keeps_read_and_bash_search():
    # The Bash equivalents and Read(*) must remain — they are the reason
    # subagents degrade rather than fully fail when Glob/Grep are missing.
    allow = _allow_list()
    assert any("Read" in a for a in allow)
    assert "Bash(grep:*)" in allow
    assert "Bash(find:*)" in allow
