"""Tests for settings migration logic in src/worca/cli/init.py.

Focused on governance.dispatch → governance.subagent_dispatch migration (§5.4).
"""

from worca.cli.init import _migrate_settings_paths


_NEW_DEFAULTS = {
    "planner": ["Explore"],
    "coordinator": [],
    "implementer": ["Explore"],
    "tester": ["Explore"],
    "guardian": ["Explore"],
    "reviewer": ["Explore"],
    "plan_reviewer": ["Explore"],
    "learner": ["Explore"],
}


def test_migrate_dispatch_to_subagent_dispatch():
    """governance.dispatch key is renamed to governance.subagent_dispatch."""
    settings = {
        "worca": {
            "governance": {
                "guards": {"block_rm_rf": True},
                "dispatch": {
                    "planner": [],
                    "coordinator": ["implementer"],
                    "implementer": [],
                    "tester": [],
                    "guardian": [],
                },
            }
        }
    }
    migrated, changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    assert "dispatch" not in governance
    assert "subagent_dispatch" in governance
    assert any("dispatch" in c and "subagent_dispatch" in c for c in changes)


def test_migrate_dispatch_replaces_wrong_values():
    """Old pipeline-agent values are replaced with subagent-type defaults."""
    settings = {
        "worca": {
            "governance": {
                "dispatch": {
                    "planner": [],
                    "coordinator": ["implementer"],
                    "implementer": [],
                    "tester": [],
                    "guardian": [],
                },
            }
        }
    }
    migrated, _changes = _migrate_settings_paths(settings)
    subagent_dispatch = migrated["worca"]["governance"]["subagent_dispatch"]
    assert subagent_dispatch == _NEW_DEFAULTS


def test_migrate_preserves_other_governance_keys():
    """guards, test_gate_strikes and other governance keys are untouched."""
    settings = {
        "worca": {
            "governance": {
                "guards": {
                    "block_rm_rf": True,
                    "block_env_write": True,
                },
                "test_gate_strikes": 2,
                "dispatch": {
                    "planner": [],
                },
            }
        }
    }
    migrated, _changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    assert governance["guards"] == {"block_rm_rf": True, "block_env_write": True}
    assert governance["test_gate_strikes"] == 2


def test_migrate_no_op_when_subagent_dispatch_exists():
    """Already-migrated settings (subagent_dispatch present) are not modified."""
    existing = {
        "planner": ["Explore"],
        "implementer": ["Explore", "feature-dev:code-reviewer"],
    }
    settings = {
        "worca": {
            "governance": {
                "subagent_dispatch": existing,
            }
        }
    }
    migrated, changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    # subagent_dispatch preserved as-is
    assert governance["subagent_dispatch"] == existing
    # no dispatch-rename change recorded
    assert not any("dispatch" in c and "subagent_dispatch" in c for c in changes)


def test_migrate_no_op_when_no_dispatch_key():
    """Settings without any dispatch key pass through unchanged."""
    settings = {
        "worca": {
            "governance": {
                "guards": {"block_rm_rf": True},
                "test_gate_strikes": 3,
            }
        }
    }
    migrated, changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    assert "dispatch" not in governance
    assert "subagent_dispatch" not in governance
    assert governance["test_gate_strikes"] == 3
    # no dispatch-rename change recorded
    assert not any("dispatch" in c for c in changes)


def test_migrate_preserves_old_dispatch_values_at_legacy():
    """Non-trivial old dispatch config is stashed at _dispatch_legacy for review."""
    old_values = {
        "planner": [],
        "coordinator": ["implementer"],
        "implementer": [],
        "tester": [],
        "guardian": [],
    }
    settings = {"worca": {"governance": {"dispatch": old_values}}}
    migrated, changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    assert governance["_dispatch_legacy"] == old_values
    # Change message mentions preservation so the user knows what to look for.
    assert any("_dispatch_legacy" in c for c in changes)


def test_migrate_omits_legacy_when_old_dispatch_empty():
    """Empty old dispatch config is not preserved — keeps settings.json tidy."""
    settings = {
        "worca": {
            "governance": {
                "dispatch": {
                    "planner": [],
                    "coordinator": [],
                    "implementer": [],
                }
            }
        }
    }
    migrated, changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    assert "_dispatch_legacy" not in governance
    assert "subagent_dispatch" in governance
    # No mention of preservation in the change message.
    assert not any("_dispatch_legacy" in c for c in changes)


def test_migrate_omits_legacy_when_old_dispatch_is_empty_dict():
    """dispatch: {} is treated the same as all-empty-values — no legacy stash."""
    settings = {"worca": {"governance": {"dispatch": {}}}}
    migrated, changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    assert "_dispatch_legacy" not in governance
    assert "subagent_dispatch" in governance
    assert not any("_dispatch_legacy" in c for c in changes)


def test_migrate_normalizes_lowercase_explore_to_capitalized():
    """Lowercase "explore" from early W-038 installs is renamed to "Explore"."""
    settings = {
        "worca": {
            "governance": {
                "subagent_dispatch": {
                    "planner": ["explore"],
                    "implementer": ["explore", "feature-dev:code-reviewer"],
                    "coordinator": [],
                }
            }
        }
    }
    migrated, changes = _migrate_settings_paths(settings)
    sd = migrated["worca"]["governance"]["subagent_dispatch"]
    assert sd["planner"] == ["Explore"]
    assert sd["implementer"] == ["Explore", "feature-dev:code-reviewer"]
    assert sd["coordinator"] == []
    assert any('"explore" -> "Explore"' in c for c in changes)


def test_migrate_normalization_no_op_when_already_capitalized():
    """Already-correct "Explore" entries do not trigger a change message."""
    settings = {
        "worca": {
            "governance": {
                "subagent_dispatch": {"planner": ["Explore"]}
            }
        }
    }
    _migrated, changes = _migrate_settings_paths(settings)
    assert not any('"explore" -> "Explore"' in c for c in changes)


def test_migrate_normalization_preserves_other_values():
    """Non-explore entries (plugin subagents, custom names) are left alone."""
    settings = {
        "worca": {
            "governance": {
                "subagent_dispatch": {
                    "planner": ["explore", "feature-dev:code-reviewer", "custom"],
                }
            }
        }
    }
    migrated, _changes = _migrate_settings_paths(settings)
    assert migrated["worca"]["governance"]["subagent_dispatch"]["planner"] == [
        "Explore",
        "feature-dev:code-reviewer",
        "custom",
    ]
