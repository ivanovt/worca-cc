"""Tests for settings migration logic in src/worca/cli/init.py.

Focused on governance.dispatch → governance.subagent_dispatch migration (§5.4).
"""

from worca.cli.init import _migrate_settings_paths


_NEW_DEFAULTS = {
    "planner": ["explore"],
    "coordinator": [],
    "implementer": ["explore"],
    "tester": ["explore"],
    "guardian": ["explore"],
    "reviewer": ["explore"],
    "plan_reviewer": ["explore"],
    "learner": [],
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
        "planner": ["explore"],
        "implementer": ["explore", "feature-dev:code-reviewer"],
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
