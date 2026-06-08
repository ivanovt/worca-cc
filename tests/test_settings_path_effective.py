"""WORCA_SETTINGS_PATH pins the effective settings file for dispatch resolution.

Regression coverage for the "on-disk project settings silently override a
template's governance.dispatch" bug. The dispatch hooks (subagent_start /
skill_use) and the --tools/--disallowedTools CLI-flag resolution both read
settings from disk via tracking._settings_path(). The runner resolves the rest
of its config from the template-merged + stripped effective settings; without a
pin, the dispatch consumers fell back to the raw on-disk project settings.json
and ignored the template's governance.dispatch entirely.

The fix: the runner exports WORCA_SETTINGS_PATH pointing at the effective
settings file; _settings_path() prefers it. This module covers both the path
resolver and the runner-side pin, plus an end-to-end _resolve_tool_args check
that the planner is no longer stripped of file tools by a leftover project
dispatch entry once a template's effective config is pinned.
"""
import json
import os

import pytest

from worca.hooks.tracking import _reset_dispatch_cache, _settings_path, check_allowed
from worca.orchestrator.runner import _pin_effective_settings_path
from worca.utils.claude_cli import _resolve_tool_args


@pytest.fixture(autouse=True)
def _clean_dispatch_state(monkeypatch):
    """Each test starts with no pin and a cold dispatch cache."""
    monkeypatch.delenv("WORCA_SETTINGS_PATH", raising=False)
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
    _reset_dispatch_cache()
    yield
    _reset_dispatch_cache()


# ── _settings_path() resolution order ──────────────────────────────


def test_settings_path_prefers_worca_settings_path(tmp_path, monkeypatch):
    effective = tmp_path / "effective.json"
    effective.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("WORCA_SETTINGS_PATH", str(effective))
    # Even with CLAUDE_PROJECT_DIR set, the pin wins.
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path / "proj"))
    assert _settings_path() == str(effective)


def test_settings_path_ignores_missing_pin(tmp_path, monkeypatch):
    """A pin pointing at a non-existent file falls through to the next source."""
    monkeypatch.setenv("WORCA_SETTINGS_PATH", str(tmp_path / "gone.json"))
    proj = tmp_path / "proj"
    (proj / ".claude").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(proj))
    assert _settings_path() == os.path.join(str(proj), ".claude", "settings.json")


def test_settings_path_falls_back_to_project_dir_when_unpinned(tmp_path, monkeypatch):
    proj = tmp_path / "proj"
    (proj / ".claude").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(proj))
    assert _settings_path() == os.path.join(str(proj), ".claude", "settings.json")


# ── _pin_effective_settings_path() ─────────────────────────────────


def test_pin_sets_absolute_path(monkeypatch):
    monkeypatch.delenv("WORCA_SETTINGS_PATH", raising=False)
    _pin_effective_settings_path(".claude/settings.json")
    pinned = os.environ.get("WORCA_SETTINGS_PATH")
    assert pinned == os.path.abspath(".claude/settings.json")
    assert os.path.isabs(pinned)


def test_pin_noop_on_empty_path(monkeypatch):
    monkeypatch.delenv("WORCA_SETTINGS_PATH", raising=False)
    _pin_effective_settings_path(None)
    assert "WORCA_SETTINGS_PATH" not in os.environ
    _pin_effective_settings_path("")
    assert "WORCA_SETTINGS_PATH" not in os.environ


# ── End-to-end: dispatch resolution honors the pin ─────────────────


def _write(path, settings):
    path.write_text(json.dumps(settings), encoding="utf-8")


def _project_with_planner_marker():
    """Raw project settings whose planner tool allowlist is a leftover marker
    (no '*'), i.e. the planner would be stripped of Read/Glob/Grep/Bash."""
    return {
        "worca": {
            "governance": {
                "dispatch": {
                    "tools": {
                        "always_disallowed": ["EnterPlanMode"],
                        "default_denied": [],
                        "per_agent_allow": {
                            "_defaults": ["*"],
                            "planner": ["BogusSettingsMarker"],
                        },
                    }
                }
            }
        }
    }


def _effective_template_stripped():
    """The effective config a template run produces: governance.dispatch is a
    template-owned key, stripped from the project merge base, so the planner
    falls through to the wildcard _defaults."""
    return {"worca": {"governance": {"dispatch": {}}}}


def test_resolve_tools_reads_raw_project_without_pin(tmp_path, monkeypatch):
    """Baseline (the bug): pointed at raw project settings, the planner is
    stripped to its marker + the auto-included meta tools."""
    proj = tmp_path / "proj"
    (proj / ".claude").mkdir(parents=True)
    _write(proj / ".claude" / "settings.json", _project_with_planner_marker())
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(proj))
    _reset_dispatch_cache()

    _disallow, tools = _resolve_tool_args("plan-planner-iter-1")
    # Sorted, with Skill/Agent auto-added so governance hooks still fire.
    assert tools == "Agent,BogusSettingsMarker,Skill"


def test_resolve_tools_honors_effective_pin(tmp_path, monkeypatch):
    """The fix: with WORCA_SETTINGS_PATH pinned at the template-stripped
    effective config, the leftover project marker no longer reaches the planner
    — it resolves to the wildcard 'default'."""
    proj = tmp_path / "proj"
    (proj / ".claude").mkdir(parents=True)
    _write(proj / ".claude" / "settings.json", _project_with_planner_marker())
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(proj))

    effective = tmp_path / "effective.json"
    _write(effective, _effective_template_stripped())
    monkeypatch.setenv("WORCA_SETTINGS_PATH", str(effective))
    _reset_dispatch_cache()

    _disallow, tools = _resolve_tool_args("plan-planner-iter-1")
    assert tools == "default"


def _project_locking_down_subagents():
    """Raw project settings that lock the planner out of all subagents."""
    return {
        "worca": {
            "governance": {
                "dispatch": {
                    "subagents": {
                        "always_disallowed": [],
                        "default_denied": [],
                        "per_agent_allow": {
                            "_defaults": ["*"],
                            "planner": ["none"],
                        },
                    }
                }
            }
        }
    }


def test_check_allowed_reads_raw_project_without_pin(tmp_path, monkeypatch):
    """Baseline: pointed at raw project settings, the planner is locked out of
    dispatching the Explore subagent (the lockdown sentinel)."""
    proj = tmp_path / "proj"
    (proj / ".claude").mkdir(parents=True)
    _write(proj / ".claude" / "settings.json", _project_locking_down_subagents())
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(proj))
    _reset_dispatch_cache()

    allowed, _reason, _via = check_allowed("subagents", "planner", "Explore")
    assert allowed is False


def test_check_allowed_honors_effective_pin(tmp_path, monkeypatch):
    """The fix extends to the hook-side consumers (subagents/skills tiers): with
    the template-stripped effective config pinned, the project lockdown no longer
    reaches the planner and the Explore dispatch is allowed via the wildcard."""
    proj = tmp_path / "proj"
    (proj / ".claude").mkdir(parents=True)
    _write(proj / ".claude" / "settings.json", _project_locking_down_subagents())
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(proj))

    effective = tmp_path / "effective.json"
    _write(effective, {"worca": {"governance": {"dispatch": {}}}})
    monkeypatch.setenv("WORCA_SETTINGS_PATH", str(effective))
    _reset_dispatch_cache()

    allowed, _reason, via = check_allowed("subagents", "planner", "Explore")
    assert allowed is True
    assert via == "wildcard"
