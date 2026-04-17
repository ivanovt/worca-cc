"""Tests for agent dispatch rules and Beads task sync hooks."""

from io import StringIO
from unittest.mock import patch
import pytest
from worca.hooks.tracking import (
    check_dispatch,
    handle_agent_stop,
    DEFAULT_SUBAGENT_DISPATCH,
    _load_subagent_dispatch,
    _reset_dispatch_cache,
)


@pytest.fixture(autouse=True)
def reset_cache():
    """Reset dispatch cache before and after each test for isolation."""
    _reset_dispatch_cache()
    yield
    _reset_dispatch_cache()


# --- check_dispatch tests ---


def test_blocks_implementer_dispatching_planner():
    code, reason = check_dispatch("implementer", "planner")
    assert code == 2
    assert "Blocked" in reason


def test_allows_planner_dispatching_explore():
    code, reason = check_dispatch("planner", "Explore")
    assert code == 0
    assert reason == ""


def test_allows_implementer_dispatching_explore():
    code, reason = check_dispatch("implementer", "Explore")
    assert code == 0


def test_blocks_coordinator_dispatching_anything():
    code, reason = check_dispatch("coordinator", "Explore")
    assert code == 2


def test_allows_tester_dispatching_explore():
    """tester can now dispatch explore (W-038)."""
    code, reason = check_dispatch("tester", "Explore")
    assert code == 0


def test_allows_guardian_dispatching_explore():
    code, reason = check_dispatch("guardian", "Explore")
    assert code == 0


def test_blocks_guardian_dispatching_implementer():
    code, reason = check_dispatch("guardian", "implementer")
    assert code == 2


def test_allows_all_in_interactive_mode():
    code, reason = check_dispatch("", "planner")
    assert code == 0


def test_allows_all_in_interactive_mode_any_agent():
    code, reason = check_dispatch("", "implementer")
    assert code == 0


def test_blocks_unknown_parent_dispatching():
    code, reason = check_dispatch("unknown_agent", "Explore")
    assert code == 2


def test_plan_reviewer_in_default_dispatch():
    """plan_reviewer must appear in DEFAULT_SUBAGENT_DISPATCH."""
    assert "plan_reviewer" in DEFAULT_SUBAGENT_DISPATCH


def test_plan_reviewer_dispatch_allows_explore():
    """plan_reviewer now allows explore for codebase verification (W-038)."""
    assert DEFAULT_SUBAGENT_DISPATCH["plan_reviewer"] == {"Explore"}


def test_allows_plan_reviewer_dispatching_explore():
    """plan_reviewer can dispatch explore (W-038)."""
    code, reason = check_dispatch("plan_reviewer", "Explore")
    assert code == 0


def test_blocks_plan_reviewer_dispatching_implementer():
    code, reason = check_dispatch("plan_reviewer", "implementer")
    assert code == 2


# --- New tests per plan §5.2-5.3 ---


def test_reviewer_dispatching_explore():
    """W-037 gap fix: reviewer can dispatch explore."""
    code, reason = check_dispatch("reviewer", "Explore")
    assert code == 0


def test_learner_default_allows_explore():
    """learner can dispatch Explore by default (consistency with other read-heavy stages)."""
    assert "learner" in DEFAULT_SUBAGENT_DISPATCH
    assert DEFAULT_SUBAGENT_DISPATCH["learner"] == {"Explore"}


def test_allows_learner_dispatching_explore():
    code, _reason = check_dispatch("learner", "Explore")
    assert code == 0


def test_denylist_blocks_general_purpose():
    """general-purpose is blocked by denylist even when parent has no dispatch rules."""
    code, reason = check_dispatch("coordinator", "general-purpose")
    assert code == 2
    assert "denylist" in reason.lower() or "Blocked" in reason


def test_denylist_blocks_general_purpose_even_if_configured():
    """User config with general-purpose is stripped; the denylist wins."""
    settings = {
        "worca": {
            "governance": {
                "subagent_dispatch": {
                    "implementer": ["Explore", "general-purpose"],
                }
            }
        }
    }
    stderr_capture = StringIO()
    with patch("sys.stderr", stderr_capture):
        rules = _load_subagent_dispatch(settings_override=settings)

    assert "general-purpose" not in rules.get("implementer", set())
    warning = stderr_capture.getvalue()
    assert "general-purpose" in warning


def test_config_replaces_defaults_per_agent():
    """User config implementer: ["Explore", "foo"] fully replaces that agent's defaults."""
    settings = {
        "worca": {
            "governance": {
                "subagent_dispatch": {
                    "implementer": ["Explore", "foo"],
                }
            }
        }
    }
    rules = _load_subagent_dispatch(settings_override=settings)
    assert rules["implementer"] == {"Explore", "foo"}
    # Other agents still have their defaults
    assert rules["planner"] == DEFAULT_SUBAGENT_DISPATCH["planner"]
    assert rules["tester"] == DEFAULT_SUBAGENT_DISPATCH["tester"]


def test_config_fallback_for_missing_agent():
    """Agents not in user config fall back to DEFAULT_SUBAGENT_DISPATCH."""
    settings = {
        "worca": {
            "governance": {
                "subagent_dispatch": {
                    "implementer": ["Explore", "extra"],
                }
            }
        }
    }
    rules = _load_subagent_dispatch(settings_override=settings)
    # guardian not configured by user → gets default
    assert rules["guardian"] == DEFAULT_SUBAGENT_DISPATCH["guardian"]
    assert rules["coordinator"] == DEFAULT_SUBAGENT_DISPATCH["coordinator"]


def test_config_empty_list_removes_all():
    """User config planner: [] removes all explore access for planner."""
    settings = {
        "worca": {
            "governance": {
                "subagent_dispatch": {
                    "planner": [],
                }
            }
        }
    }
    rules = _load_subagent_dispatch(settings_override=settings)
    assert rules["planner"] == set()


def test_default_constant_matches_settings_json():
    """DEFAULT_SUBAGENT_DISPATCH keys/values must match src/worca/settings.json defaults."""
    import json
    import os

    settings_path = os.path.join(
        os.path.dirname(__file__), "..", "src", "worca", "settings.json"
    )
    with open(settings_path) as f:
        raw = json.load(f)

    json_dispatch = raw.get("worca", {}).get("governance", {}).get("subagent_dispatch", {})

    for agent, allowed_list in json_dispatch.items():
        assert agent in DEFAULT_SUBAGENT_DISPATCH, f"{agent} missing from DEFAULT_SUBAGENT_DISPATCH"
        assert DEFAULT_SUBAGENT_DISPATCH[agent] == set(allowed_list), (
            f"Mismatch for {agent}: constant={DEFAULT_SUBAGENT_DISPATCH[agent]} json={set(allowed_list)}"
        )

    for agent in DEFAULT_SUBAGENT_DISPATCH:
        assert agent in json_dispatch, f"{agent} missing from settings.json subagent_dispatch"


def test_cache_reset_between_config_changes():
    """After _reset_dispatch_cache(), a new settings_override is honoured."""
    settings_a = {
        "worca": {"governance": {"subagent_dispatch": {"planner": []}}}
    }
    settings_b = {
        "worca": {"governance": {"subagent_dispatch": {"planner": ["Explore"]}}}
    }
    rules_a = _load_subagent_dispatch(settings_override=settings_a)
    assert rules_a["planner"] == set()

    _reset_dispatch_cache()

    rules_b = _load_subagent_dispatch(settings_override=settings_b)
    assert rules_b["planner"] == {"Explore"}


def test_warns_on_malformed_settings_shape():
    """Malformed settings shape (non-dict subagent_dispatch) logs a warning and falls back to defaults."""
    # TypeError: .items() on a non-dict
    settings = {
        "worca": {"governance": {"subagent_dispatch": "not-a-dict"}}
    }
    stderr_capture = StringIO()
    with patch("sys.stderr", stderr_capture):
        rules = _load_subagent_dispatch(settings_override=settings)

    assert rules == {
        agent: set(allowed) for agent, allowed in DEFAULT_SUBAGENT_DISPATCH.items()
    }
    warning = stderr_capture.getvalue()
    assert "Warning" in warning
    assert "falling back to defaults" in warning


def test_warns_on_malformed_allowed_list():
    """Non-iterable allowed list surfaces a warning instead of failing silently."""
    # set(12345) raises TypeError — caught by our narrower except clause.
    settings = {
        "worca": {"governance": {"subagent_dispatch": {"planner": 12345}}}
    }
    stderr_capture = StringIO()
    with patch("sys.stderr", stderr_capture):
        rules = _load_subagent_dispatch(settings_override=settings)

    # planner should fall back to the default value
    assert rules["planner"] == DEFAULT_SUBAGENT_DISPATCH["planner"]
    warning = stderr_capture.getvalue()
    assert "Warning" in warning


def test_missing_settings_file_is_silent():
    """FileNotFoundError during _load_settings() does not produce a warning."""
    import worca.hooks.tracking as tracking

    stderr_capture = StringIO()
    # Simulate _load_settings raising FileNotFoundError
    with patch.object(
        tracking, "_load_settings", side_effect=FileNotFoundError("no file")
    ):
        with patch("sys.stderr", stderr_capture):
            rules = _load_subagent_dispatch()

    assert rules == {
        agent: set(allowed) for agent, allowed in DEFAULT_SUBAGENT_DISPATCH.items()
    }
    # FileNotFoundError is a normal case — no noise.
    assert stderr_capture.getvalue() == ""


# --- handle_agent_stop tests ---


def test_closes_bead_on_success():
    with patch("worca.utils.beads.bd_close") as mock_close:
        handle_agent_stop("implementer", "bd-123", True)
    mock_close.assert_called_once_with("bd-123")


def test_no_close_on_failure():
    with patch("worca.utils.beads.bd_close") as mock_close:
        handle_agent_stop("implementer", "bd-123", False)
    mock_close.assert_not_called()


def test_no_close_when_no_bead_id():
    with patch("worca.utils.beads.bd_close") as mock_close:
        handle_agent_stop("implementer", None, True)
    mock_close.assert_not_called()


def test_no_close_on_failure_without_bead():
    with patch("worca.utils.beads.bd_close") as mock_close:
        handle_agent_stop("tester", None, False)
    mock_close.assert_not_called()
