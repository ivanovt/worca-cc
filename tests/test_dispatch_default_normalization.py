"""Tests for the W-054 follow-up dispatch-default normalization.

Covers both the pure helpers in ``worca.hooks.tracking`` and the migration
entry point ``worca.cli.init._migrate_dispatch_governance``. The fixtures here
deliberately mirror the JS cases in
``worca-ui/server/dispatch-migration.test.js`` so the two implementations stay
in parity (same inputs → same outputs).
"""

import copy

from worca.cli.init import _migrate_dispatch_governance
from worca.hooks.tracking import (
    DISPATCH_MIGRATION_VERSION,
    _DISPATCH_DEFAULTS,
    adopt_narrowed_skills_denylist,
    adopt_stale_subagent_default,
    normalize_dispatch_defaults,
)

# The legacy (W-038-era) Explore-only subagent default, as it survives a W-054
# migration into per_agent_allow (plus the seeded _defaults wildcard).
_STALE_SUBAGENTS = {
    "planner": ["Explore"],
    "coordinator": [],
    "implementer": ["Explore"],
    "tester": ["Explore"],
    "guardian": ["Explore"],
    "reviewer": ["Explore"],
    "plan_reviewer": ["Explore"],
    "learner": ["Explore"],
    "_defaults": ["*"],
}

_LEGACY_SKILLS_DENYLIST = [
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
]


def _pop1_config():
    """A config already on the W-054 nested shape but pinned to the stale
    Explore-only subagent default + broad worca-* skills glob, no version stamp.
    """
    return {
        "dispatch": {
            "subagents": {
                "per_agent_allow": copy.deepcopy(_STALE_SUBAGENTS),
                "always_disallowed": ["general-purpose"],
                "default_denied": [],
            },
            "skills": {
                "always_disallowed": list(_LEGACY_SKILLS_DENYLIST),
                "default_denied": [],
                "per_agent_allow": {"_defaults": ["*"]},
            },
            "tools": {
                "always_disallowed": [],
                "default_denied": [],
                "per_agent_allow": {"_defaults": ["*"]},
            },
        }
    }


# --- Default-content guards --------------------------------------------------


def test_default_skills_denylist_drops_glob_keeps_dangerous():
    denylist = _DISPATCH_DEFAULTS["skills"]["always_disallowed"]
    assert "worca-*" not in denylist
    for must_deny in (
        "worca-release",
        "worca-rc",
        "worca-pr-prep",
        "worca-install",
        "worca-sync",
        "worca-agent-override",
        "worca-analyze",
        "worca-plan-new",
    ):
        assert must_deny in denylist
    # Useful dev skills are NOT hard-denied any more.
    for allowed in ("worca-dev-precommit", "worca-coverage", "worca-ui-add-card"):
        assert allowed not in denylist


# --- adopt_stale_subagent_default --------------------------------------------


def test_adopt_collapses_stale_explore_default():
    cfg = {"per_agent_allow": copy.deepcopy(_STALE_SUBAGENTS)}
    assert adopt_stale_subagent_default(cfg) is True
    assert cfg["per_agent_allow"] == {"_defaults": ["*"]}


def test_adopt_preserves_customized_shape():
    cfg = {
        "per_agent_allow": {
            "planner": ["Explore"],
            "implementer": ["Explore", "feature-dev:code-reviewer"],
            "_defaults": ["*"],
        }
    }
    assert adopt_stale_subagent_default(cfg) is False
    assert cfg["per_agent_allow"]["implementer"] == [
        "Explore",
        "feature-dev:code-reviewer",
    ]


def test_adopt_preserves_customized_defaults():
    pa = copy.deepcopy(_STALE_SUBAGENTS)
    pa["_defaults"] = ["Explore"]  # operator touched _defaults
    cfg = {"per_agent_allow": pa}
    assert adopt_stale_subagent_default(cfg) is False


# --- adopt_narrowed_skills_denylist ------------------------------------------


def test_adopt_narrows_legacy_skills_denylist():
    cfg = {"always_disallowed": list(_LEGACY_SKILLS_DENYLIST)}
    assert adopt_narrowed_skills_denylist(cfg) is True
    assert "worca-*" not in cfg["always_disallowed"]
    assert "worca-release" in cfg["always_disallowed"]


def test_adopt_preserves_customized_skills_denylist():
    cfg = {"always_disallowed": [*_LEGACY_SKILLS_DENYLIST, "custom-skill"]}
    assert adopt_narrowed_skills_denylist(cfg) is False
    assert "worca-*" in cfg["always_disallowed"]


# --- normalize_dispatch_defaults (Pop 1) -------------------------------------


def test_normalize_pop1_collapses_and_narrows_and_stamps():
    gov = _pop1_config()
    changes = normalize_dispatch_defaults(gov)
    assert len(changes) == 2
    assert gov["dispatch"]["subagents"]["per_agent_allow"] == {"_defaults": ["*"]}
    assert "worca-*" not in gov["dispatch"]["skills"]["always_disallowed"]
    assert "worca-release" in gov["dispatch"]["skills"]["always_disallowed"]
    assert gov["dispatch_migration_version"] == DISPATCH_MIGRATION_VERSION


def test_normalize_is_idempotent():
    gov = _pop1_config()
    normalize_dispatch_defaults(gov)
    snapshot = copy.deepcopy(gov)
    changes2 = normalize_dispatch_defaults(gov)
    assert changes2 == []
    assert gov == snapshot


def test_normalize_skips_already_stamped_config():
    gov = _pop1_config()
    gov["dispatch_migration_version"] = DISPATCH_MIGRATION_VERSION
    changes = normalize_dispatch_defaults(gov)
    assert changes == []
    # Stamp present → the operator's (stale-looking) values are left intact.
    assert gov["dispatch"]["subagents"]["per_agent_allow"]["planner"] == ["Explore"]
    assert "worca-*" in gov["dispatch"]["skills"]["always_disallowed"]


def test_normalize_noop_without_dispatch_block():
    gov = {"guards": {"block_rm_rf": True}}
    assert normalize_dispatch_defaults(gov) == []
    assert "dispatch_migration_version" not in gov


# --- Pop 2: legacy subagent_dispatch through the migration entry point --------


def test_migrate_pop2_subagent_dispatch_collapses_to_new_default():
    gov = {
        "subagent_dispatch": {
            "planner": ["Explore"],
            "coordinator": [],
            "implementer": ["Explore"],
            "tester": ["Explore"],
            "guardian": ["Explore"],
            "reviewer": ["Explore"],
            "plan_reviewer": ["Explore"],
            "learner": ["Explore"],
        }
    }
    _migrate_dispatch_governance(gov, [])
    pa = gov["dispatch"]["subagents"]["per_agent_allow"]
    assert pa == {"_defaults": ["*"]}
    assert gov["dispatch_migration_version"] == DISPATCH_MIGRATION_VERSION


def test_migrate_pop2_preserves_customized_subagent_dispatch():
    gov = {
        "subagent_dispatch": {
            "planner": ["Explore"],
            "implementer": ["Explore", "feature-dev:code-reviewer"],
            "tester": ["Explore"],
            "guardian": ["Explore"],
            "reviewer": ["Explore"],
            "plan_reviewer": ["Explore"],
            "learner": ["Explore"],
        }
    }
    _migrate_dispatch_governance(gov, [])
    pa = gov["dispatch"]["subagents"]["per_agent_allow"]
    assert pa["implementer"] == ["Explore", "feature-dev:code-reviewer"]
