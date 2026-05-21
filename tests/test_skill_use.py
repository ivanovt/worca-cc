"""Tests for the Skill PreToolUse hook and shared agent_role helper."""

import json
import os
from io import StringIO
from unittest.mock import patch, MagicMock

import pytest

from worca.hooks.agent_role import role_from_worca_agent
from worca.hooks.tracking import ConfigUnreadable, check_allowed, _reset_dispatch_cache
from worca.claude_hooks.skill_use import _extract_skill_name


@pytest.fixture(autouse=True)
def reset_cache():
    _reset_dispatch_cache()
    yield
    _reset_dispatch_cache()


def _skills_settings(skills_config):
    """Build a settings dict scoped to dispatch.skills."""
    return {"worca": {"governance": {"dispatch": {"skills": skills_config}}}}


# ── role_from_worca_agent (shared helper) ──────────────────────────


def test_role_extracts_from_full_format():
    assert role_from_worca_agent("implement-implementer-iter-2") == "implementer"


def test_role_bare_name():
    assert role_from_worca_agent("guardian") == "guardian"


def test_role_empty_string():
    assert role_from_worca_agent("") == ""


def test_role_plan_reviewer_underscored():
    assert role_from_worca_agent("plan_review-plan_reviewer-iter-2") == "plan_reviewer"


def test_role_bare_hyphenated_name_passes_through():
    """Bare names with hyphens must pass through unchanged.

    Without this guard, ``split('-')[-1]`` truncates any hyphenated bare
    name to its last segment — silently misrouting per_agent_allow lookups
    for a future role like ``workspace-planner`` (would land on
    ``_defaults`` instead of its own entry).
    """
    assert role_from_worca_agent("workspace-planner") == "workspace-planner"
    assert role_from_worca_agent("plan-reviewer") == "plan-reviewer"
    assert role_from_worca_agent("my-cool-agent") == "my-cool-agent"


# ── _extract_skill_name ────────────────────────────────────────────


def test_extract_skill_name_from_skill_field():
    """Claude Code 2.1.x payload — observed live."""
    assert _extract_skill_name({"skill": "ascii-banner", "args": "CALC calc.js"}) == "ascii-banner"


def test_extract_skill_name_from_skill_name_field():
    """Defensive fallback — pre-2.1.x or future renames."""
    assert _extract_skill_name({"skill_name": "worca-install"}) == "worca-install"


def test_extract_skill_name_from_name_field():
    """Defensive fallback — pre-2.1.x or future renames."""
    assert _extract_skill_name({"name": "review"}) == "review"


def test_extract_skill_name_prefers_skill_over_others():
    """When multiple fields are present, the verified 2.1.x key wins."""
    assert _extract_skill_name({"skill": "a", "skill_name": "b", "name": "c"}) == "a"


def test_extract_skill_name_prefers_skill_name_over_name():
    """Fallback ordering: skill_name preferred over name."""
    assert _extract_skill_name({"skill_name": "a", "name": "b"}) == "a"


def test_extract_skill_name_empty_when_missing():
    assert _extract_skill_name({}) == ""


# ── Skill hook integration (check_allowed for skills) ─────────────


def test_skill_allowed_via_wildcard():
    """Default skills config uses '*' — any non-denied skill is allowed."""
    cfg = _skills_settings({
        "always_disallowed": [],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["*"]},
    })
    allowed, reason, via = check_allowed(
        "skills", "implementer", "my-custom-skill", settings_override=cfg,
    )
    assert allowed is True
    assert via == "wildcard"


def test_skill_blocked_by_always_disallowed():
    """Skills in always_disallowed cannot be used, even with '*'."""
    cfg = _skills_settings({
        "always_disallowed": ["worca-*"],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["*"]},
    })
    allowed, reason, via = check_allowed(
        "skills", "implementer", "worca-install", settings_override=cfg,
    )
    assert allowed is False
    assert reason == "always_disallowed"


def test_skill_blocked_by_default_denied():
    """Skills in default_denied are excluded from '*' wildcard."""
    cfg = _skills_settings({
        "always_disallowed": [],
        "default_denied": ["review", "security-review"],
        "per_agent_allow": {"_defaults": ["*"]},
    })
    allowed, reason, via = check_allowed(
        "skills", "tester", "review", settings_override=cfg,
    )
    assert allowed is False
    assert reason == "default_denied"


def test_skill_allowed_via_mixed_form():
    """'["*", "review"]' opts in a default_denied skill explicitly."""
    cfg = _skills_settings({
        "always_disallowed": [],
        "default_denied": ["review", "security-review"],
        "per_agent_allow": {
            "_defaults": ["*"],
            "reviewer": ["*", "review"],
        },
    })
    allowed, reason, via = check_allowed(
        "skills", "reviewer", "review", settings_override=cfg,
    )
    assert allowed is True
    assert via == "explicit"


def test_skill_interactive_mode_allows_all():
    """Empty agent (no WORCA_AGENT) bypasses skill governance."""
    cfg = _skills_settings({
        "always_disallowed": ["worca-*"],
        "default_denied": ["review"],
        "per_agent_allow": {"_defaults": []},
    })
    allowed, reason, via = check_allowed(
        "skills", "", "worca-install", settings_override=cfg,
    )
    assert allowed is True


# ── Skill hook main() exit codes ───────────────────────────────────


def _run_skill_main(tool_input, env_agent="", settings_override=None, emit_mock=None):
    """Run skill_use.main() with synthetic stdin and env, return exit code."""
    import worca.claude_hooks.skill_use as skill_mod

    stdin_payload = json.dumps({"tool_name": "Skill", "tool_input": tool_input})
    mock_stdin = StringIO(stdin_payload)

    patches = [
        patch.dict(os.environ, {"WORCA_AGENT": env_agent} if env_agent else {}, clear=False),
        patch("sys.stdin", mock_stdin),
    ]
    if not env_agent:
        patches.append(patch.dict(os.environ, {}, clear=False))
        if "WORCA_AGENT" in os.environ:
            patches.append(patch.dict(os.environ, {"WORCA_AGENT": ""}, clear=False))

    if settings_override is not None:
        patches.append(
            patch.object(skill_mod, "check_allowed",
                         wraps=lambda section, agent, candidate, **kw:
                         check_allowed(section, agent, candidate,
                                       settings_override=settings_override))
        )

    if emit_mock is not None:
        patches.append(patch.object(skill_mod, "emit_from_hook", emit_mock))

    with pytest.raises(SystemExit) as exc:
        for p in patches:
            p.__enter__()
        try:
            skill_mod.main()
        finally:
            for p in reversed(patches):
                p.__exit__(None, None, None)

    return exc.value.code


def test_main_exits_0_when_allowed():
    cfg = _skills_settings({
        "always_disallowed": [],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["*"]},
    })
    code = _run_skill_main(
        {"skill_name": "my-skill"},
        env_agent="implement-implementer-iter-1",
        settings_override=cfg,
    )
    assert code == 0


def test_main_exits_0_with_claude_code_skill_payload():
    """End-to-end: Claude Code 2.1.x sends `tool_input.skill` — the hook
    must extract it and resolve allow/deny correctly. Regression guard
    against the original W-054 ship where the extractor only checked
    `skill_name`/`name` and fail-closed-blocked every real Skill call.
    """
    cfg = _skills_settings({
        "always_disallowed": [],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["*"]},
    })
    code = _run_skill_main(
        {"skill": "ascii-banner", "args": "CALC calc.js"},
        env_agent="implement-implementer-iter-1",
        settings_override=cfg,
    )
    assert code == 0


def test_main_exits_2_when_blocked():
    cfg = _skills_settings({
        "always_disallowed": ["worca-*"],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["*"]},
    })
    code = _run_skill_main(
        {"skill_name": "worca-install"},
        env_agent="implement-implementer-iter-1",
        settings_override=cfg,
    )
    assert code == 2


def test_main_exits_0_interactive_mode():
    """No WORCA_AGENT set → allow all skills."""
    env = os.environ.copy()
    env.pop("WORCA_AGENT", None)

    import worca.claude_hooks.skill_use as skill_mod

    stdin_payload = json.dumps({"tool_name": "Skill", "tool_input": {"skill_name": "worca-install"}})

    with patch.dict(os.environ, env, clear=True), \
         patch("sys.stdin", StringIO(stdin_payload)):
        with pytest.raises(SystemExit) as exc:
            skill_mod.main()

    assert exc.value.code == 0


def test_main_emits_dispatch_allowed_with_via():
    """When allowed, emits the unified pipeline.hook.dispatch_allowed event."""
    cfg = _skills_settings({
        "always_disallowed": [],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["*"]},
    })
    emit = MagicMock()
    code = _run_skill_main(
        {"skill_name": "my-skill"},
        env_agent="implement-implementer-iter-1",
        settings_override=cfg,
        emit_mock=emit,
    )
    assert code == 0
    emit.assert_called_once()
    event_name, payload = emit.call_args[0]
    assert event_name == "pipeline.hook.dispatch_allowed"
    assert payload["section"] == "skills"
    assert payload["candidate"] == "my-skill"
    assert payload["via"] == "wildcard"
    assert payload["agent"] == "implementer"


def test_main_emits_dispatch_blocked():
    """When blocked, emits the unified pipeline.hook.dispatch_blocked event."""
    cfg = _skills_settings({
        "always_disallowed": ["worca-*"],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["*"]},
    })
    emit = MagicMock()
    code = _run_skill_main(
        {"skill_name": "worca-install"},
        env_agent="implement-implementer-iter-1",
        settings_override=cfg,
        emit_mock=emit,
    )
    assert code == 2
    emit.assert_called_once()
    event_name, payload = emit.call_args[0]
    assert event_name == "pipeline.hook.dispatch_blocked"
    assert payload["section"] == "skills"
    assert payload["candidate"] == "worca-install"
    assert payload["agent"] == "implementer"
    assert "reason" in payload


def test_main_fail_closed_when_skill_name_unresolvable():
    """If the PreToolUse payload has no skill_name/name field (e.g. Claude
    Code renamed the field), governed agents must be blocked. Otherwise an
    empty candidate would pass through the wildcard branch and silently
    allow everything.
    """
    cfg = _skills_settings({
        "always_disallowed": [],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["*"]},
    })
    emit = MagicMock()
    code = _run_skill_main(
        {"unknown_field": "my-skill"},  # neither skill_name nor name
        env_agent="implement-implementer-iter-1",
        settings_override=cfg,
        emit_mock=emit,
    )
    assert code == 2
    emit.assert_called_once()
    event_name, payload = emit.call_args[0]
    assert event_name == "pipeline.hook.dispatch_blocked"
    assert payload["reason"] == "skill_name_unresolved"


def test_main_fail_closed_does_not_fire_in_interactive_mode():
    """Interactive runs (no WORCA_AGENT) keep their current pass-through behavior
    even when the skill name is unresolvable — governance only applies to
    pipeline agents.
    """
    env = os.environ.copy()
    env.pop("WORCA_AGENT", None)

    import worca.claude_hooks.skill_use as skill_mod

    stdin_payload = json.dumps({"tool_name": "Skill", "tool_input": {}})

    with patch.dict(os.environ, env, clear=True), \
         patch("sys.stdin", StringIO(stdin_payload)):
        with pytest.raises(SystemExit) as exc:
            skill_mod.main()

    assert exc.value.code == 0


def test_main_fail_closed_on_config_unreadable():
    """When settings.json is malformed, the hook MUST exit 2 (block), not 1 (crash).

    Claude Code treats exit 1 from a hook as a non-blocking error — the
    Skill call would proceed, silently bypassing dispatch governance.
    Exit 2 is the only code that actually blocks the call.
    """
    import worca.claude_hooks.skill_use as skill_mod

    def raise_unreadable(*args, **kwargs):
        raise ConfigUnreadable("/fake/path/settings.json: invalid JSON (truncated)")

    emit = MagicMock()
    stdin_payload = json.dumps({"tool_name": "Skill", "tool_input": {"skill_name": "review"}})

    with patch.dict(os.environ, {"WORCA_AGENT": "implement-implementer-iter-1"}, clear=False), \
         patch("sys.stdin", StringIO(stdin_payload)), \
         patch.object(skill_mod, "check_allowed", side_effect=raise_unreadable), \
         patch.object(skill_mod, "emit_from_hook", emit):
        with pytest.raises(SystemExit) as exc:
            skill_mod.main()

    assert exc.value.code == 2, "fail-closed: exit 2 (block), not 1 (crash → fail-open)"
    emit.assert_called_once()
    event_name, payload = emit.call_args[0]
    assert event_name == "pipeline.hook.dispatch_blocked"
    assert payload["reason"] == "config_unreadable"
    assert payload["section"] == "skills"


def test_main_no_longer_emits_legacy_skill_event_names():
    """PR D: hooks must NOT emit pipeline.hook.skill_{allowed,blocked} anymore."""
    cfg = _skills_settings({
        "always_disallowed": ["worca-*"],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["*"]},
    })
    emit = MagicMock()
    _run_skill_main(
        {"skill_name": "worca-install"},
        env_agent="implement-implementer-iter-1",
        settings_override=cfg,
        emit_mock=emit,
    )
    for call in emit.call_args_list:
        event_name = call[0][0]
        assert not event_name.startswith("pipeline.hook.skill_"), (
            f"Legacy event name still emitted: {event_name}"
        )
