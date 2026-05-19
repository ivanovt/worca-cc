"""Tests for agent dispatch rules and Beads task sync hooks."""

from io import StringIO
from unittest.mock import patch
import pytest
from worca.hooks.tracking import (
    check_dispatch,
    check_allowed,
    handle_agent_stop,
    DEFAULT_SUBAGENT_DISPATCH,
    _DISPATCH_DEFAULTS,
    _load_subagent_dispatch,
    _matches_any,
    _reset_dispatch_cache,
)


@pytest.fixture(autouse=True)
def reset_cache():
    """Reset dispatch cache before and after each test for isolation."""
    _reset_dispatch_cache()
    yield
    _reset_dispatch_cache()


# --- check_dispatch tests ---


def test_blocks_implementer_dispatching_planner_under_narrow_default():
    """Under a narrowed _defaults (e.g. ["Explore"]), the implementer can't
    dispatch arbitrary pipeline-stage names. PR B changed the bundled default
    to ["*"], so this only blocks when the project narrows the allow list.
    """
    cfg = {"worca": {"governance": {"dispatch": {"subagents": {
        "always_disallowed": ["general-purpose"],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["Explore"]},
    }}}}}
    allowed, reason, _ = check_allowed(
        "subagents", "implementer", "planner", settings_override=cfg,
    )
    assert allowed is False
    assert reason == "not_in_allow_list"


def test_implementer_dispatching_planner_allowed_under_wildcard_default():
    """PR B: wildcard default allows the implementer to dispatch any
    non-denied subagent — including a project-defined `planner` subagent."""
    code, _ = check_dispatch("implementer", "planner")
    assert code == 0


def test_allows_planner_dispatching_explore():
    code, reason = check_dispatch("planner", "Explore")
    assert code == 0
    assert reason == ""


def test_allows_implementer_dispatching_explore():
    code, reason = check_dispatch("implementer", "Explore")
    assert code == 0


def test_coordinator_gets_explore_via_defaults():
    """W-054 + PR B: coordinator now gets Explore via _defaults wildcard."""
    code, reason = check_dispatch("coordinator", "Explore")
    assert code == 0


def test_allows_tester_dispatching_explore():
    """tester can now dispatch explore (W-038)."""
    code, reason = check_dispatch("tester", "Explore")
    assert code == 0


def test_allows_guardian_dispatching_explore():
    code, reason = check_dispatch("guardian", "Explore")
    assert code == 0


def test_blocks_guardian_dispatching_implementer_under_narrow_default():
    """Under a narrowed _defaults, guardian can't dispatch unrelated names."""
    cfg = {"worca": {"governance": {"dispatch": {"subagents": {
        "always_disallowed": ["general-purpose"],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["Explore"]},
    }}}}}
    allowed, _, _ = check_allowed(
        "subagents", "guardian", "implementer", settings_override=cfg,
    )
    assert allowed is False


def test_allows_all_in_interactive_mode():
    code, reason = check_dispatch("", "planner")
    assert code == 0


def test_allows_all_in_interactive_mode_any_agent():
    code, reason = check_dispatch("", "implementer")
    assert code == 0


def test_unknown_parent_gets_defaults():
    """W-054 + PR B: unknown agents fall through to _defaults: ['*']."""
    code, reason = check_dispatch("unknown_agent", "Explore")
    assert code == 0


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


def test_blocks_plan_reviewer_dispatching_implementer_under_narrow_default():
    """Under a narrowed _defaults, plan_reviewer can't dispatch implementer."""
    cfg = {"worca": {"governance": {"dispatch": {"subagents": {
        "always_disallowed": ["general-purpose"],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["Explore"]},
    }}}}}
    allowed, _, _ = check_allowed(
        "subagents", "plan_reviewer", "implementer", settings_override=cfg,
    )
    assert allowed is False


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
    """settings.json dispatch.subagents shape must match _DISPATCH_DEFAULTS."""
    import json
    import os

    settings_path = os.path.join(
        os.path.dirname(__file__), "..", "src", "worca", "settings.json"
    )
    with open(settings_path) as f:
        raw = json.load(f)

    for section in ("tools", "skills", "subagents"):
        json_section = (
            raw.get("worca", {})
            .get("governance", {})
            .get("dispatch", {})
            .get(section, {})
        )
        defaults_section = _DISPATCH_DEFAULTS[section]
        assert json_section["always_disallowed"] == defaults_section["always_disallowed"], (
            f"{section}.always_disallowed mismatch"
        )
        assert json_section["default_denied"] == defaults_section["default_denied"], (
            f"{section}.default_denied mismatch"
        )


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


# --- Helper ---


def _settings_with_dispatch(section: str, section_config: dict) -> dict:
    """Construct a settings dict for a dispatch section."""
    return {"worca": {"governance": {"dispatch": {section: section_config}}}}


# --- _matches_any tests (W-054 §11) ---


def test_matches_any_exact_match():
    """Exact string match works; different strings don't match."""
    assert _matches_any("hookify:hookify", ["hookify:hookify"]) is True
    assert _matches_any("hookify:list", ["hookify:hookify"]) is False


def test_matches_any_glob_worca_prefix():
    """Trailing-* glob matches prefix; missing separator doesn't match."""
    assert _matches_any("worca-install", ["worca-*"]) is True
    assert _matches_any("worca-release", ["worca-*"]) is True
    assert _matches_any("worca", ["worca-*"]) is False


def test_matches_any_bare_wildcard():
    """Bare '*' matches everything."""
    assert _matches_any("anything", ["*"]) is True
    assert _matches_any("*", ["*"]) is True


def test_matches_any_empty_candidate():
    """Empty string doesn't match a prefix glob."""
    assert _matches_any("", ["worca-*"]) is False


# --- check_allowed tests (W-054 §2.1) ---


def test_check_allowed_wildcard_allows_unknown():
    """'*' allows any candidate not in deny tiers — no all_known needed."""
    cfg = _settings_with_dispatch("subagents", {
        "always_disallowed": [],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["*"]},
    })
    allowed, reason, via = check_allowed(
        "subagents", "planner", "some-new-agent", settings_override=cfg,
    )
    assert allowed is True
    assert via == "wildcard"


def test_check_allowed_mixed_form():
    """'["*", "review"]' includes default_denied 'review' with via='explicit'."""
    cfg = _settings_with_dispatch("skills", {
        "always_disallowed": [],
        "default_denied": ["review", "security-review"],
        "per_agent_allow": {"_defaults": ["*"], "reviewer": ["*", "review"]},
    })
    allowed, reason, via = check_allowed(
        "skills", "reviewer", "review", settings_override=cfg,
    )
    assert allowed is True
    assert via == "explicit"


def test_check_allowed_replace_not_union():
    """Per-agent entry replaces _defaults, does not union."""
    cfg = _settings_with_dispatch("subagents", {
        "always_disallowed": [],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["Explore"], "implementer": ["foo"]},
    })
    allowed, _, _ = check_allowed(
        "subagents", "implementer", "Explore", settings_override=cfg,
    )
    assert allowed is False
    allowed, _, _ = check_allowed(
        "subagents", "implementer", "foo", settings_override=cfg,
    )
    assert allowed is True


def test_check_allowed_always_disallowed_short_circuit():
    """Tier 1 (always_disallowed) wins over '*' and explicit naming."""
    cfg = _settings_with_dispatch("subagents", {
        "always_disallowed": ["general-purpose"],
        "default_denied": [],
        "per_agent_allow": {
            "_defaults": ["*"],
            "implementer": ["*", "general-purpose"],
        },
    })
    allowed, reason, via = check_allowed(
        "subagents", "implementer", "general-purpose", settings_override=cfg,
    )
    assert allowed is False
    assert reason == "always_disallowed"
    assert via is None


def test_check_allowed_default_denied_not_in_wildcard():
    """'*' excludes default_denied items; reason is 'default_denied'."""
    cfg = _settings_with_dispatch("skills", {
        "always_disallowed": [],
        "default_denied": ["review"],
        "per_agent_allow": {"_defaults": ["*"]},
    })
    allowed, reason, via = check_allowed(
        "skills", "implementer", "review", settings_override=cfg,
    )
    assert allowed is False
    assert reason == "default_denied"
    assert via is None


def test_check_allowed_missing_section_uses_defaults():
    """Empty config falls back to _DISPATCH_DEFAULTS.

    PR B: subagent _defaults is now ['*'], so Explore resolves via wildcard.
    """
    allowed, reason, via = check_allowed(
        "subagents", "planner", "Explore", settings_override={},
    )
    assert allowed is True
    assert via == "wildcard"


def test_check_allowed_workspace_planner_falls_back_to_defaults():
    """Agent not in per_agent_allow resolves via _defaults (§1.2 regression fix)."""
    cfg = _settings_with_dispatch("subagents", {
        "always_disallowed": ["general-purpose"],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["Explore"]},
    })
    allowed, reason, via = check_allowed(
        "subagents", "workspace_planner", "Explore", settings_override=cfg,
    )
    assert allowed is True
    assert via == "explicit"


def test_check_allowed_via_field():
    """Returns 'wildcard' when resolved via '*', 'explicit' when named."""
    cfg_wildcard = _settings_with_dispatch("subagents", {
        "always_disallowed": [],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["*"]},
    })
    _, _, via = check_allowed(
        "subagents", "planner", "Explore", settings_override=cfg_wildcard,
    )
    assert via == "wildcard"

    cfg_explicit = _settings_with_dispatch("subagents", {
        "always_disallowed": [],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["Explore"]},
    })
    _, _, via = check_allowed(
        "subagents", "planner", "Explore", settings_override=cfg_explicit,
    )
    assert via == "explicit"


def test_check_allowed_empty_agent_allows_all():
    """Empty agent (interactive mode) allows all dispatches."""
    allowed, reason, via = check_allowed(
        "subagents", "", "anything", settings_override={},
    )
    assert allowed is True


def test_check_allowed_bare_wildcard_in_deny_list_blocks_everything():
    """Footgun: bare '*' in always_disallowed blocks everything."""
    cfg = _settings_with_dispatch("skills", {
        "always_disallowed": ["*"],
        "default_denied": [],
        "per_agent_allow": {"_defaults": ["*"]},
    })
    allowed, reason, _ = check_allowed(
        "skills", "implementer", "any-skill", settings_override=cfg,
    )
    assert allowed is False
    assert reason == "always_disallowed"


# --- PR A: refreshed Claude Code built-in defaults ---


@pytest.mark.parametrize("agent", [
    "planner", "coordinator", "implementer", "tester",
    "guardian", "reviewer", "plan_reviewer", "learner",
])
def test_batch_skill_always_denied_for_every_agent(agent):
    """The bundled /batch skill must be hard-denied — it spawns parallel pipelines."""
    allowed, reason, _ = check_allowed("skills", agent, "batch", settings_override={})
    assert allowed is False
    assert reason == "always_disallowed"


@pytest.mark.parametrize("agent", [
    "planner", "coordinator", "implementer", "tester",
    "guardian", "reviewer", "plan_reviewer", "learner",
])
def test_fewer_permission_prompts_skill_always_denied(agent):
    """fewer-permission-prompts rewrites the project's allowlist — always denied."""
    allowed, reason, _ = check_allowed(
        "skills", agent, "fewer-permission-prompts", settings_override={},
    )
    assert allowed is False
    assert reason == "always_disallowed"


def test_simplify_default_denied_under_wildcard():
    """simplify is in default_denied — agents under _defaults: ["*"] cannot use it."""
    allowed, reason, _ = check_allowed(
        "skills", "planner", "simplify", settings_override={},
    )
    assert allowed is False
    assert reason == "default_denied"


def test_simplify_allowed_for_implementer_opt_in():
    """implementer is opted into simplify via per_agent_allow."""
    allowed, _, via = check_allowed(
        "skills", "implementer", "simplify", settings_override={},
    )
    assert allowed is True
    assert via == "explicit"


def test_debug_default_denied_but_allowed_for_tester():
    """debug is default_denied; only the tester is opted in."""
    allowed, reason, _ = check_allowed(
        "skills", "planner", "debug", settings_override={},
    )
    assert allowed is False
    assert reason == "default_denied"

    allowed, _, via = check_allowed(
        "skills", "tester", "debug", settings_override={},
    )
    assert allowed is True
    assert via == "explicit"


def test_claude_api_default_denied_but_allowed_for_implementer():
    """claude-api is default_denied; the implementer is opted in."""
    allowed, reason, _ = check_allowed(
        "skills", "reviewer", "claude-api", settings_override={},
    )
    assert allowed is False
    assert reason == "default_denied"

    allowed, _, via = check_allowed(
        "skills", "implementer", "claude-api", settings_override={},
    )
    assert allowed is True
    assert via == "explicit"


def test_review_skill_opted_in_for_reviewer():
    """reviewer can dispatch the review and security-review skills."""
    for skill in ("review", "security-review"):
        allowed, _, via = check_allowed(
            "skills", "reviewer", skill, settings_override={},
        )
        assert allowed is True, f"{skill} should be allowed for reviewer"
        assert via == "explicit"


def test_claude_md_management_skills_opted_in_for_learner():
    """learner is opted into claude-md-management:* skills."""
    for skill in (
        "claude-md-management:revise-claude-md",
        "claude-md-management:claude-md-improver",
    ):
        allowed, _, via = check_allowed(
            "skills", "learner", skill, settings_override={},
        )
        assert allowed is True, f"{skill} should be allowed for learner"
        assert via == "explicit"


# --- PR B: subagents _defaults flipped to ["*"] ---


@pytest.mark.parametrize("agent", [
    "planner", "coordinator", "implementer", "tester",
    "guardian", "reviewer", "plan_reviewer", "learner", "workspace_planner",
])
def test_subagents_wildcard_default_allows_any_non_denied(agent):
    """PR B: every pipeline agent dispatches arbitrary subagents via wildcard."""
    allowed, reason, via = check_allowed(
        "subagents", agent, "feature-dev:code-reviewer", settings_override={},
    )
    assert allowed is True, f"{agent} should dispatch via wildcard"
    assert via == "wildcard"


def test_subagents_general_purpose_still_denied_under_wildcard():
    """PR B: general-purpose stays in always_disallowed even with wildcard."""
    allowed, reason, _ = check_allowed(
        "subagents", "implementer", "general-purpose", settings_override={},
    )
    assert allowed is False
    assert reason == "always_disallowed"


def test_subagents_explore_now_via_wildcard():
    """PR B: Explore is no longer enumerated per-agent — it resolves via wildcard."""
    _, _, via = check_allowed(
        "subagents", "planner", "Explore", settings_override={},
    )
    assert via == "wildcard"
